import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  defineTool,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { AgentRole, UISubagentTask } from "../shared/protocol.ts";
import {
  ConstraintResolver,
  formatWorkspaceContext,
  getAllRoleDefinitions,
  getRoleConfig,
  PromptAssembler,
  type TaskContract,
  type WorkspaceContextDetails,
} from "./contracts/index.ts";
import { adjustSkillsInBasePrompt } from "./skills.ts";
import { parseModelOverride } from "./subagent-report.ts";
import type { SubagentManager } from "./subagent-manager.ts";
import { resolveProjectRoot } from "./worktree.ts";
import {
  DEFAULT_OUTPUT_BUDGETS,
  persistAndVirtualizeToolResult,
} from "./subagent/output-virtualizer.ts";
import { buildTaskEpisodeCard, buildTaskEpisodeView } from "./subagent/episode-card.ts";
import { trackToolOutputMetadata } from "./subagent/tool-output-metadata.ts";

export const COORDINATOR_EXTENSION_NAME = "pi-coordinator-tools";

/** Keep parent-session investigation output materially below the built-in 50KB limit. */
export const COORDINATOR_TOOL_OUTPUT_LIMIT = DEFAULT_OUTPUT_BUDGETS.coordinator;
/** Task summaries are intentionally compact and never include transcript/log collections. */
export const COORDINATOR_TASK_SUMMARY_LIMIT = 4 * 1024;
export const COORDINATOR_OUTPUT_TRUNCATION_MESSAGE =
  "Output truncated for Coordinator. Use a narrower query or delegate large-volume investigation to a Subagent.";

function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(0, low);
}

function truncateUtf8(
  text: string,
  maxBytes: number,
  marker = "… [truncated]",
): { value: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { value: text, truncated: false };
  }
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const prefix = utf8Prefix(text, Math.max(0, maxBytes - markerBytes));
  return { value: `${prefix}${marker}`, truncated: true };
}

/**
 * Apply the Coordinator-only boundary to read/bash tool results after execution.
 * Non-text blocks are retained; textual output is capped by UTF-8 byte size.
 */
export function truncateCoordinatorToolContent(
  content: readonly any[],
  maxBytes = COORDINATOR_TOOL_OUTPUT_LIMIT,
): { content: any[]; truncated: boolean } {
  const textBlocks = content.filter(
    (block) => block && block.type === "text" && typeof block.text === "string",
  );
  const totalBytes = textBlocks.reduce(
    (total, block) => total + Buffer.byteLength(block.text, "utf8"),
    0,
  );
  if (totalBytes <= maxBytes) {
    return { content: [...content], truncated: false };
  }

  const suffix = `\n\n${COORDINATOR_OUTPUT_TRUNCATION_MESSAGE}`;
  const lastTextIndex = content.reduce(
    (last, block, index) =>
      block && block.type === "text" && typeof block.text === "string" ? index : last,
    -1,
  );
  let remainingBytes = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let suffixAdded = false;

  const bounded = content.map((block, index) => {
    if (!block || block.type !== "text" || typeof block.text !== "string") return block;

    const prefix = utf8Prefix(block.text, remainingBytes);
    remainingBytes -= Buffer.byteLength(prefix, "utf8");
    const mustAddSuffix = !suffixAdded &&
      (prefix.length < block.text.length || index === lastTextIndex);
    if (mustAddSuffix) {
      suffixAdded = true;
      return { ...block, text: `${prefix}${suffix}` };
    }
    return { ...block, text: prefix };
  });

  return { content: bounded, truncated: true };
}

export interface CoordinatorTaskSummary {
  taskId: string;
  status: string;
  role: string;
  agent: string | null;
  error: string | null;
  failureSummary: string | null;
  verificationStatus: string | null;
  lastMeaningfulFailure: string | null;
  resultSummary: string | null;
  truncated: boolean;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function firstFailedVerificationDetail(task: UISubagentTask): string | null {
  const verification = task.verification ?? task.taskResult?.verification;
  if (!verification) return null;

  const checks = [verification.testExecution, verification.scope, verification.diff].filter(Boolean);
  for (const check of checks) {
    if (check && check.status !== "pass") {
      return optionalString(check.detail) ?? `${check.name}: ${check.status}`;
    }
  }

  const failedCommand = [...verification.commands].reverse().find((command) => !command.passed);
  return failedCommand
    ? optionalString(failedCommand.stderrSummary) ??
        optionalString(failedCommand.stdoutSummary) ??
        `Command failed: ${failedCommand.command}`
    : null;
}

function lastFailureLog(task: UISubagentTask): string | null {
  const logs = task.logs ?? [];
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const line = logs[index];
    if (typeof line === "string" && /error|fail|failure|blocked|timeout|truncat|conflict/i.test(line)) {
      const toolEvent = line.match(/\[Tool\]\s+([^\s]+)\s+->\s+(Error|Success)/i);
      if (toolEvent) {
        return `Tool ${toolEvent[1]} reported ${toolEvent[2].toLowerCase()}.`;
      }
      return "A failure-like event was recorded during task execution.";
    }
  }
  return null;
}

function summaryField(value: string | null, maxBytes = 320): { value: string | null; truncated: boolean } {
  if (value === null) return { value: null, truncated: false };
  return truncateUtf8(value, maxBytes);
}

export function buildCoordinatorTaskSummary(task: UISubagentTask): CoordinatorTaskSummary {
  const verification = task.verification ?? task.taskResult?.verification;
  const metaError = task.taskResult?.meta?.error;
  const error = optionalString(task.error) ?? optionalString(metaError);
  const verificationFailure = firstFailedVerificationDetail(task);
  const failureSummary = error ?? verificationFailure ??
    (task.review?.verdict === "REQUEST_CHANGES"
      ? optionalString(task.review.findings[0]?.problem)
      : null);
  const lastMeaningfulFailure = lastFailureLog(task) ?? failureSummary;
  const resultSummary = optionalString(task.taskResult?.summary) ?? optionalString(task.summary);

  const fields = {
    taskId: summaryField(task.taskId, 256),
    agent: summaryField(task.agentId ?? null, 160),
    error: summaryField(error),
    failureSummary: summaryField(failureSummary),
    lastMeaningfulFailure: summaryField(lastMeaningfulFailure),
    resultSummary: summaryField(resultSummary),
  };
  return {
    taskId: fields.taskId.value ?? "",
    status: task.status,
    role: task.role,
    agent: fields.agent.value,
    error: fields.error.value,
    failureSummary: fields.failureSummary.value,
    verificationStatus: verification?.overall ?? null,
    lastMeaningfulFailure: fields.lastMeaningfulFailure.value,
    resultSummary: fields.resultSummary.value,
    truncated: Object.values(fields).some((field) => field.truncated),
  };
}

export function serializeCoordinatorTaskSummary(summary: CoordinatorTaskSummary): string {
  const initial = JSON.stringify(summary);
  if (Buffer.byteLength(initial, "utf8") <= COORDINATOR_TASK_SUMMARY_LIMIT) return initial;

  const compacted: CoordinatorTaskSummary = {
    ...summary,
    taskId: truncateUtf8(summary.taskId, 128).value,
    agent: summary.agent ? truncateUtf8(summary.agent, 80).value : null,
    error: summary.error ? truncateUtf8(summary.error, 120).value : null,
    failureSummary: summary.failureSummary ? truncateUtf8(summary.failureSummary, 120).value : null,
    lastMeaningfulFailure: summary.lastMeaningfulFailure
      ? truncateUtf8(summary.lastMeaningfulFailure, 120).value
      : null,
    resultSummary: summary.resultSummary ? truncateUtf8(summary.resultSummary, 120).value : null,
    truncated: true,
  };
  const compactJson = JSON.stringify(compacted);
  if (Buffer.byteLength(compactJson, "utf8") <= COORDINATOR_TASK_SUMMARY_LIMIT) return compactJson;

  return JSON.stringify({
    taskId: truncateUtf8(summary.taskId, 128).value,
    status: truncateUtf8(summary.status, 64).value,
    role: truncateUtf8(summary.role, 64).value,
    agent: null,
    error: null,
    failureSummary: null,
    verificationStatus: summary.verificationStatus,
    lastMeaningfulFailure: null,
    resultSummary: null,
    truncated: true,
  });
}

export function createCoordinatorExtension(
  subagentManager: SubagentManager,
  getSessionContext: () => {
    parentSessionId: string;
    parentCwd: string;
    parentModel?: { provider: string; id: string } | null;
    activeRole: AgentRole;
    customSession?: any;
    onUpdate?: (task: any) => void;
    onReport?: (
      task: any,
      reportText: string,
      metadata?: { kind?: "terminal" | "blocker" },
    ) => void | Promise<void>;
  },
): InlineExtension {
  return {
    name: COORDINATOR_EXTENSION_NAME,
    factory: (pi: ExtensionAPI) => {
      // 0. 查询可用角色列表工具 (list_available_roles)
      pi.registerTool(
        defineTool({
          name: "list_available_roles",
          label: "查询可用子角色",
          description:
            "查询系统当前所有可用的子智能体角色列表、职责定位、严格禁令、能力范围与已授权工具。在调用 spawn_subagent 派发任务前可调用此工具按需发现最合适的角色。",
          promptSnippet: "查询系统当前支持的所有子智能体角色列表、职责与可用工具",
          parameters: Type.Object({}),
          async execute() {
            const definitions = getAllRoleDefinitions().filter(
              (r) => r.id !== "coordinator" && r.id !== "default",
            );
            const summary = definitions.map((d) => {
              const cfg = getRoleConfig(d.id);
              return {
                role_id: d.id,
                name: d.name,
                description: d.description,
                responsibilities: d.responsibilities,
                strict_prohibitions: d.strictProhibitions,
                allowed_skills: d.allowedSkills ?? [],
                allowed_tools: Array.isArray(cfg?.allowedTools) ? [...cfg.allowedTools] : [],
                requires_worktree: Boolean(d.requiresWorktree ?? cfg?.requiresWorktree),
              };
            });
            return {
              details: undefined,
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      available_roles: summary,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          },
        }),
      );

      // 1. 获取单个 Task 的低输出量状态摘要 (get_task_summary)
      pi.registerTool(
        defineTool({
          name: "get_task_summary",
          label: "获取 Task 摘要",
          description:
            "按 taskId 获取一个属于当前 Coordinator 会话的有界 Task 状态视图。终态任务优先返回 Physical/Verification/Artifact Pointers/非权威 Agent 报告，不返回完整消息历史、stdout、JSONL 或 tool call history。",
          promptSnippet: "获取单个 Task 的压缩状态、失败与验证摘要",
          parameters: Type.Object({
            taskId: Type.String({
              description: "要查询的 Task ID",
            }),
          }),
          async execute(_toolCallId, params) {
            const ctx = getSessionContext();
            if (ctx.activeRole !== "coordinator") {
              return {
                isError: true,
                details: undefined,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ error: "tool_not_available_for_role" }),
                  },
                ],
              };
            }

            const task = subagentManager.getTask(params.taskId);
            if (!task || task.parentSessionId !== ctx.parentSessionId) {
              return {
                isError: true,
                details: undefined,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      error: "task_not_found",
                      taskId: truncateUtf8(params.taskId, 256).value,
                    }),
                  },
                ],
              };
            }

            const episode = buildTaskEpisodeCard(task);
            const summary = episode ? null : buildCoordinatorTaskSummary(task);
            return {
              details: undefined,
              content: [
                {
                  type: "text",
                  text: episode
                    ? buildTaskEpisodeView(episode, { maxTotalBytes: COORDINATOR_TASK_SUMMARY_LIMIT })
                    : serializeCoordinatorTaskSummary(summary!),
                },
              ],
            };
          },
        }),
      );

      // 2. 派发子智能体工具 (spawn_subagent)
      pi.registerTool(
        defineTool({
          name: "spawn_subagent",
          label: "派发子任务",
          description:
            "派发一个结构化契约子智能体任务。后台异步非阻塞执行（Developer / Verifier 在独立 Git 分支 Worktree 隔离运行，Researcher 在只读工作区执行）。子任务完成后成果将进入 Coordinator Inbox 暂存，不会打断当前对话，用户确认引导后由系统在后续轮次接入。",
          promptSnippet: "派发一个独立的异步子智能体任务。派发前可调用 list_available_roles 查看可用角色",
          promptGuidelines: [
            "派发子任务前可先调用 list_available_roles 查询系统可用角色与工具列表（核心角色为 developer、verifier、researcher）；",
            "【任务粒度与拆分原则】遵循“Prefer fewer, larger, behavior-complete tasks”，避免机械拆解缺乏独立验证与闭环的微任务。能独立调查、独立验证、独立交付的完整行为闭环拆为 Subagent Task（例如派发给 Developer 或 Researcher）；高度耦合需共享深入上下文的子目标保持单任务，不拆分；跨 Task 通过 TaskEpisodeView、ReusableSubagent Knowledge、context_files 或明确 ArtifactRef 传递结论；",
            "可连续多次调用 spawn_subagent 以并行启动多个独立的子智能体，各子任务异步执行；",
            "支持传入结构化 Task Contract 字段 (如 expected_effects, acceptance_criteria, context_files, scope_include)；",
            "派发任务时，根据任务真实目标填写 expected_effects（例如 Verifier 核查分析填 ['analysis'] 或 ['test_execution']，Developer 实现代码填 ['code_change']）；",
            "【Inbox 暂存与流转】派发后无需阻塞等待，严禁使用 bash (如 sleep、轮询脚本、死循环检查 git log) 阻塞等待子任务！子任务完成后的 report 仅在 Coordinator Inbox 暂存，不自动打断或唤醒 Coordinator；用户可编辑、引导或取消；只有用户在界面点击引导后，才会在合法的下一 Coordinator Turn 注入；",
            "Prefer promotion before the first repository mutation。已经委派给 Subagent 的明确 scope，其 repository mutation ownership 属于该 Subagent；Coordinator 不得再同时对该 scope 做 edit/write。若 Direct Path 已产生 repository mutation，不得把重叠 scope 委派给 isolated Developer Worktree。",
            "子智能体默认继承主会话模型，除非角色配置或任务执行选项中显式指定了专属模型。",
          ],
          executionMode: "parallel",
          parameters: Type.Object({
            role: Type.String({
              description: "子智能体角色标识（必须从 list_available_roles 获取，例如 'developer'、'verifier'、'researcher'，严禁使用 default 或 coordinator）",
            }),
            task_title: Type.String({
              description: "简短明确的任务标题，例如 '实现用户个人资料卡片组件'",
            }),
            prompt: Type.String({
              description: "下发给子智能体的详细任务背景、实现规范、代码约束与自测要求",
            }),
            goal: Type.Optional(
              Type.String({
                description: "任务核心目标定义（若未提供则默认使用 task_title 或 prompt）",
              }),
            ),
            expected_effects: Type.Optional(
              Type.Array(
                Type.Union([
                  Type.Literal("code_change"),
                  Type.Literal("test_execution"),
                  Type.Literal("analysis"),
                  Type.Literal("deployment"),
                  Type.Literal("artifact"),
                ]),
                {
                  description:
                    "任务预期产出/效果类型列表（如 ['test_execution'] 或 ['code_change']）。派发时请根据真实目标填写（例如：Verifier 进行质量核查填 ['analysis'] 或 ['test_execution']，Developer 修改业务代码填 ['code_change']）。",
                },
              ),
            ),
            context_files: Type.Optional(
              Type.Array(Type.String(), {
                description: "推荐重点阅读的参考文件路径列表（只读参考，非修改范围）",
              }),
            ),
            scope_include: Type.Optional(
              Type.Array(Type.String(), {
                description: "明确允许修改的路径范围列表（如 ['src/components/**', 'package.json']）",
              }),
            ),
            scope_exclude: Type.Optional(
              Type.Array(Type.String(), {
                description: "明确禁止修改的路径列表",
              }),
            ),
            acceptance_criteria: Type.Optional(
              Type.Array(Type.String(), {
                description: "验收标准清单（可逐项核对的条件列表）",
              }),
            ),
            branch: Type.Optional(
              Type.String({
                description: "可选的 Git 分支名称，例如 'feat/user-profile-card'。未指定时系统将自动生成",
              }),
            ),
            cwd: Type.Optional(
              Type.String({
                description:
                  "可选的目标子目录路径（例如 './frontend'、'packages/core' 或绝对路径）。未指定时默认基于项目主工作目录执行",
              }),
            ),
            depends_on: Type.Optional(
              Type.Array(Type.String(), {
                description: "前置依赖任务 ID列表。依赖未完成时任务将进入 blocked 状态，依赖全部正常完成 (completed) 后自动启动",
              }),
            ),
            rework_of_task_id: Type.Optional(
              Type.String({
                description:
                  "可选返工关联：仅当本次任务明确用于修复/重做某个历史任务时填写目标 Task ID。未指定则为独立新任务",
              }),
            ),
          }),
          async execute(_toolCallId, params) {
            const ctx = getSessionContext();
            const validRoles = [
              "developer",
              "verifier",
              "researcher",
            ];
            if (!validRoles.includes(params.role)) {
              return {
                isError: true,
                details: undefined,
                content: [
                  {
                    type: "text",
                    text: `[spawn_subagent] 失败: 非法的子智能体角色 '${params.role}'。当前仅支持 list_available_roles 中的角色 (如 'developer', 'verifier', 'researcher')。`,
                  },
                ],
              };
            }

            try {
              const taskContract: TaskContract = {
                taskId: "", // will be generated by subagentManager.spawn
                parentSessionId: ctx.parentSessionId,
                role: params.role as AgentRole,
                goal: params.goal || params.task_title || params.prompt,
                expectedEffects: params.expected_effects,
                contextFiles: params.context_files,
                scope: {
                  include: params.scope_include ?? ["*"],
                  exclude: params.scope_exclude ?? [],
                },
                acceptanceCriteria: params.acceptance_criteria ?? ["完成指定实现并自测通过"],
                dependsOn: params.depends_on,
                reworkOfTaskId: params.rework_of_task_id,
              };

              const task = await subagentManager.spawn({
                parentSessionId: ctx.parentSessionId,
                role: params.role as AgentRole,
                taskTitle: params.task_title,
                taskPrompt: params.prompt,
                preferredBranch: params.branch,
                targetCwd: params.cwd,
                parentCwd: ctx.parentCwd,
                parentModel: ctx.parentModel,
                taskContract,
                customSession: ctx.customSession,
                onUpdate: ctx.onUpdate,
                onReport: ctx.onReport,
              });

              return {
                details: undefined,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        status: task.status,
                        task_id: task.taskId,
                        agent_id: task.agentId,
                        role: task.role,
                        branch: task.branchName,
                        worktree: task.worktreePath ?? null,
                        message:
                          task.status === "blocked"
                            ? `子任务 [${task.taskId}] 已派发，因前置依赖尚未完成处于 blocked 挂起状态。前置依赖全部完成后将自动解除挂起。`
                            : `子任务 [${task.taskId}] 已成功启动（异步执行中）。执行完毕后成果将进入 Coordinator Inbox 暂存，等待用户确认引导后在下一轮次注入，请勿使用 bash 轮询等待。`,
                      },
                      null,
                      2,
                    ),
                  },
                ],
              };
            } catch (err) {
              return {
                isError: true,
                details: undefined,
                content: [
                  {
                    type: "text",
                    text: `[spawn_subagent] 失败: ${String(err instanceof Error ? err.message : err)}`,
                  },
                ],
              };
            }
          },
        }),
      );

      // 3. 列出子任务与可复用 Agent 状态工具 (list_subagents)
      pi.registerTool(
        defineTool({
          name: "list_subagents",
          label: "列出子任务与可复用 Agent",
          description:
            "列出当前主会话下的子任务状态（支持 status / limit 过滤），以及可 continue_subagent 的 Reusable Agents（含 topics / reuseCount / knowledge preview）。复用决策由 Coordinator 显式做出，Runtime 不做自动匹配。",
          promptSnippet: "列出子任务状态（支持 status / limit 过滤）与可复用 Agent",
          parameters: Type.Object({
            status: Type.Optional(
              Type.Union(
                [
                  Type.Literal("all"),
                  Type.Literal("active"),
                  Type.Literal("running"),
                  Type.Literal("completed"),
                  Type.Literal("failed"),
                  Type.Literal("blocked"),
                  Type.Literal("ready"),
                  Type.Literal("conflict"),
                  Type.Literal("aborted"),
                  Type.Literal("interrupted"),
                  Type.Literal("incomplete"),
                ],
                {
                  description:
                    "按任务状态过滤：'all' (全部任务，默认)、'active' (所有进行中与待处理任务: blocked, ready, running, conflict) 或指定状态（如 'running', 'completed', 'failed' 等）",
                },
              ),
            ),
            limit: Type.Optional(
              Type.Integer({
                minimum: 1,
                maximum: 100,
                description: "返回任务的最大数量（按创建时间倒序返回最近 N 条），默认不截断",
              }),
            ),
          }),
          async execute(_toolCallId, params) {
            const ctx = getSessionContext();
            let allTasks = [...subagentManager.getTasksForParent(ctx.parentSessionId)].sort((a, b) => {
              const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
              const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
              return timeB - timeA;
            });

            if (params.status && params.status !== "all") {
              if (params.status === "active") {
                const activeStates = new Set([
                  "blocked",
                  "ready",
                  "running",
                  "conflict",
                ]);
                allTasks = allTasks.filter((t) => activeStates.has(t.status));
              } else {
                allTasks = allTasks.filter((t) => t.status === params.status);
              }
            }

            if (typeof params.limit === "number" && params.limit > 0) {
              allTasks = allTasks.slice(0, params.limit);
            }

            const tasks = allTasks.map((t) => ({
              task_id: t.taskId,
              agent_id: t.agentId ?? null,
              role: t.role,
              task_title: t.taskTitle,
              status: t.status,
              created_at: t.createdAt,
              started_at: t.startedAt ?? null,
              completed_at: t.completedAt ?? null,
              duration_ms: t.durationMs ?? null,
              branch: t.branchName ?? null,
              worktree: t.worktreePath ?? null,
              has_result: Boolean(t.taskResult),
              summary_preview: t.summary ? t.summary.slice(0, 160) : null,
              verification_overall: t.verification?.overall ?? t.taskResult?.verification?.overall ?? null,
              depends_on: t.taskContract?.dependsOn ?? [],
              rework_of_task_id: t.reworkOfTaskId ?? t.taskContract?.reworkOfTaskId ?? null,
              error: t.error ?? null,
            }));
            const reusableSummary = subagentManager.reusableAgents
              .listForParent(ctx.parentSessionId)
              .map((a) => ({
                agent_id: a.agentId,
                role: a.role,
                state: a.state,
                reuse_count: a.reuseCount,
                last_task_id: a.lastTaskId,
                last_task_title: a.lastTaskTitle,
                topics: a.knowledge.topics,
                known_commands_count: a.knowledge.knownCommands.length,
                environment_facts_count: a.knowledge.environmentFacts.length,
                relevant_files_count: a.knowledge.relevantFiles.length,
                failed_approaches_count: a.knowledge.failedApproaches.length,
                knowledge_preview: {
                  known_commands: a.knowledge.knownCommands.slice(0, 5),
                  environment_facts: a.knowledge.environmentFacts.slice(0, 5),
                  relevant_files: a.knowledge.relevantFiles.slice(0, 5),
                  failed_approaches: a.knowledge.failedApproaches.slice(0, 3),
                },
                can_continue: a.state === "idle_reusable",
              }));

            return {
              details: undefined,
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      total: tasks.length,
                      tasks,
                      reusable_agents: reusableSummary,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          },
        }),
      );

      // 4. 复用已有智能体启动新任务工具 (continue_subagent)
      pi.registerTool(
        defineTool({
          name: "continue_subagent",
          label: "复用智能体执行新任务",
          description:
            "复用处于 idle_reusable 状态的 Subagent 知识执行新任务（新 Worktree + 新 Session + Knowledge 注入）。若仅是继续推进相关独立新任务，不要传入 rework_of_task_id；仅当本 Task 明确用于修复/重做某个历史失败 Task 时填写 rework_of_task_id。",
          promptSnippet:
            "复用 idle_reusable Agent 执行新 Task（新 Worktree/Session + 注入短期知识）",
          parameters: Type.Object({
            agent_id: Type.String({
              description: "要复用的 Reusable Agent ID（例如 'agent-fe-01'，从 list_subagents 获取）",
            }),
            task_title: Type.String({
              description: "简短明确的全新任务标题，例如 '完善个人资料卡片的暗黑模式适配'",
            }),
            prompt: Type.String({
              description: "下发给该智能体的新任务背景、实现规范与自测要求",
            }),
            goal: Type.Optional(Type.String({ description: "新任务核心目标定义" })),
            expected_effects: Type.Optional(
              Type.Array(
                Type.Union([
                  Type.Literal("code_change"),
                  Type.Literal("test_execution"),
                  Type.Literal("analysis"),
                  Type.Literal("deployment"),
                  Type.Literal("artifact"),
                ]),
              ),
            ),
            context_files: Type.Optional(Type.Array(Type.String())),
            scope_include: Type.Optional(Type.Array(Type.String())),
            scope_exclude: Type.Optional(Type.Array(Type.String())),
            acceptance_criteria: Type.Optional(Type.Array(Type.String())),
            branch: Type.Optional(Type.String()),
            cwd: Type.Optional(Type.String()),
            depends_on: Type.Optional(Type.Array(Type.String())),
            rework_of_task_id: Type.Optional(
              Type.String({
                description:
                  "可选返工关联：仅当本次任务明确用于修复/重做某个历史任务时填写目标 Task ID。若未显式指定，本次调用仅复用该 Agent 的知识执行一个独立新任务，不建立返工关系",
              }),
            ),
          }),
          async execute(_toolCallId, params) {
            const ctx = getSessionContext();

            try {
              const reworkOfTaskId = params.rework_of_task_id;
              const existingAgent = subagentManager.reusableAgents.get(params.agent_id);
              const targetRole: AgentRole = existingAgent ? existingAgent.role : "developer";
              const taskContract: TaskContract = {
                taskId: "",
                parentSessionId: ctx.parentSessionId,
                role: targetRole,
                goal: params.goal || params.task_title || params.prompt,
                expectedEffects: params.expected_effects,
                contextFiles: params.context_files,
                scope: {
                  include: params.scope_include ?? ["*"],
                  exclude: params.scope_exclude ?? [],
                },
                acceptanceCriteria: params.acceptance_criteria ?? ["完成指定实现并自测通过"],
                dependsOn: params.depends_on,
                reworkOfTaskId,
              };

              const task = await subagentManager.continueAgent({
                agentId: params.agent_id,
                parentSessionId: ctx.parentSessionId,
                taskTitle: params.task_title,
                taskPrompt: params.prompt,
                preferredBranch: params.branch,
                targetCwd: params.cwd,
                parentCwd: ctx.parentCwd,
                parentModel: ctx.parentModel,
                taskContract,
                reworkOfTaskId,
                customSession: ctx.customSession,
                onUpdate: ctx.onUpdate,
                onReport: ctx.onReport,
              });

              return {
                details: undefined,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        status: "continued",
                        task_id: task.taskId,
                        agent_id: task.agentId,
                        role: task.role,
                        branch: task.branchName,
                        worktree: task.worktreePath ?? null,
                        message: `已复用 Agent [${task.agentId}] 启动新任务 [${task.taskId}]（新 Worktree + 新 Session + Knowledge 注入）。`,
                      },
                      null,
                      2,
                    ),
                  },
                ],
              };
            } catch (err) {
              return {
                isError: true,
                details: undefined,
                content: [
                  {
                    type: "text",
                    text: `[continue_subagent] 失败: ${String(err instanceof Error ? err.message : err)}`,
                  },
                ],
              };
            }
          },
        }),
      );

      // 5. 中断子智能体工具 (abort_subagent)
      pi.registerTool(
        defineTool({
          name: "abort_subagent",
          label: "中断子任务",
          description: "取消或中断正在后台运行的子智能体任务",
          parameters: Type.Object({
            task_id: Type.String({ description: "要中断的任务ID，如 'task-abc12345'" }),
          }),
          async execute(_toolCallId, params) {
            const success = await subagentManager.abort(params.task_id, { source: "coordinator" });
            return {
              details: undefined,
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      status: success ? "aborted" : "not_found",
                      task_id: params.task_id,
                      message: success ? "已成功中断子任务" : "未找到运行中的子任务或该任务已结束",
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          },
        }),
      );

      // 6. Coordinator 输出同样遵循 raw-first：先持久化，再投影有界 preview。
      const takeMetadata = trackToolOutputMetadata(pi);
      pi.on("tool_result", async (event) => {
        const details = takeMetadata(event.toolCallId, event.details);
        const { activeRole, parentSessionId } = getSessionContext();
        if (activeRole !== "coordinator" || (event.toolName !== "read" && event.toolName !== "bash")) {
          return;
        }
        const projected = persistAndVirtualizeToolResult({
          runId: parentSessionId || "coordinator",
          taskId: "coordinator",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          content: event.content,
          details,
          input: event.input,
          isError: event.isError,
          maxBytes: COORDINATOR_TOOL_OUTPUT_LIMIT,
        });
        if (!projected.virtualized) return;
        return {
          content: projected.content,
          details: {
            ...(details && typeof details === "object" ? details : {}),
            artifactRef: projected.pointer.artifactRef,
            completeness: projected.pointer.completeness,
          },
          isError: event.isError,
        };
      });

      // 7. 拦截 before_agent_start 动态注入当前活跃角色的分层系统提示词与首轮 Workspace Context
      pi.on("before_agent_start", async (event, ctx) => {
        const sessionCtx = getSessionContext();
        const role = sessionCtx.activeRole || "coordinator";
        const currentCwd = sessionCtx.parentCwd || ctx.cwd;

        let systemPromptStr: string;

        if (role === "default") {
          const def = getAllRoleDefinitions().find((r) => r.id === "default");
          const behaviorPrompt = def?.instructions?.trim() || "";
          let nativePrompt = event.systemPrompt || "";
          if (behaviorPrompt && nativePrompt.startsWith(behaviorPrompt)) {
            nativePrompt = nativePrompt.slice(behaviorPrompt.length).trimStart();
          }
          const adjustedNativePrompt = adjustSkillsInBasePrompt(
            nativePrompt,
            def?.allowedSkills ?? [],
            currentCwd,
          );
          systemPromptStr = behaviorPrompt
            ? `${behaviorPrompt}\n\n${adjustedNativePrompt}`
            : adjustedNativePrompt;
        } else {
          const effectiveContext = ConstraintResolver.resolve({
            role,
            cwd: currentCwd,
            isGitRepo: true,
            parentModel: sessionCtx.parentModel
              ? { provider: sessionCtx.parentModel.provider, modelId: sessionCtx.parentModel.id }
              : null,
          });

          const runtimeModel = sessionCtx.parentModel
            ? { provider: sessionCtx.parentModel.provider, id: sessionCtx.parentModel.id }
            : undefined;
          const assembled = PromptAssembler.assemble(effectiveContext, { runtimeModel });
          systemPromptStr = assembled.systemPrompt;
        }

        return {
          systemPrompt: systemPromptStr,
        };
      });

      // 8. 拦截 context 事件：在 LLM 发送前动态将权威 Workspace Context 前置拼入首条用户消息开头（严格仅在第一条消息，不生成单独条目，UI保持静默）
      pi.on("context", async (event, ctx) => {
        const sessionCtx = getSessionContext();
        const role = sessionCtx.activeRole || "coordinator";
        const currentCwd = sessionCtx.parentCwd || ctx.cwd;

        if (!event.messages || event.messages.length === 0) {
          return;
        }

        // 严格仅在整个会话的第一条用户消息中插入
        const firstUserIndex = event.messages.findIndex((m) => m.role === "user");
        if (firstUserIndex === -1) {
          return;
        }

        // 检查首条用户消息是否已经包含 Workspace Context
        const firstUserMsg = event.messages[firstUserIndex] as { role: string; content?: unknown };
        let alreadyHasWsContext = false;
        if (typeof firstUserMsg.content === "string") {
          alreadyHasWsContext = firstUserMsg.content.includes("## Workspace Context");
        } else if (Array.isArray(firstUserMsg.content)) {
          alreadyHasWsContext = firstUserMsg.content.some(
            (b: any) => b && typeof b.text === "string" && b.text.includes("## Workspace Context"),
          );
        }

        if (alreadyHasWsContext) {
          return;
        }

        // 解析工作区环境动态上下文
        const projectInfo = await resolveProjectRoot(currentCwd);
        const wsDetails: WorkspaceContextDetails = {
          cwd: currentCwd,
          projectRoot: projectInfo.projectRoot,
          workspaceType: projectInfo.isWorktree
            ? "isolated_worktree"
            : role === "coordinator"
              ? "coordinator_workspace"
              : "main_project",
          gitBranch: projectInfo.branch ?? undefined,
          isWorktree: projectInfo.isWorktree,
        };
        const wsContent = formatWorkspaceContext(wsDetails);

        const newMessages = structuredClone(event.messages);
        const modMsg = newMessages[firstUserIndex] as { role: string; content?: unknown };
        if (typeof modMsg.content === "string") {
          modMsg.content = `${wsContent}\n\n${modMsg.content}`;
        } else if (Array.isArray(modMsg.content)) {
          const firstText = modMsg.content.find((b: any) => b && b.type === "text") as
            | { type: "text"; text: string }
            | undefined;
          if (firstText) {
            firstText.text = `${wsContent}\n\n${firstText.text || ""}`;
          } else {
            modMsg.content.unshift({ type: "text", text: wsContent });
          }
        }

        return { messages: newMessages };
      });
    },
  };
}
