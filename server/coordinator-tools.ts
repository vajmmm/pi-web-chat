import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  defineTool,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { AgentRole } from "../shared/protocol.ts";
import {
  ConstraintResolver,
  formatWorkspaceContext,
  getAllRoleDefinitions,
  PromptAssembler,
  type TaskContract,
  type WorkspaceContextDetails,
} from "./contracts/index.ts";
import { adjustSkillsInBasePrompt } from "./skills.ts";
import { parseModelOverride } from "./subagent-report.ts";
import type { SubagentManager } from "./subagent-manager.ts";
import { resolveProjectRoot } from "./worktree.ts";

export const COORDINATOR_EXTENSION_NAME = "pi-coordinator-tools";

export function createCoordinatorExtension(
  subagentManager: SubagentManager,
  getSessionContext: () => {
    parentSessionId: string;
    parentCwd: string;
    parentModel?: { provider: string; id: string } | null;
    activeRole: AgentRole;
    customSession?: any;
    onUpdate?: (task: any) => void;
    onReport?: (task: any, reportText: string) => void;
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
            const summary = definitions.map((d) => ({
              role_id: d.id,
              name: d.name,
              description: d.description,
              responsibilities: d.responsibilities,
              strict_prohibitions: d.strictProhibitions,
              allowed_skills: d.allowedSkills ?? [],
              allowed_tools:
                Array.isArray(d.allowedTools)
                  ? [...d.allowedTools]
                  : ["read", "bash", "edit", "write", "report_blocker"],
              requires_worktree: Boolean(d.requiresWorktree),
            }));
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

      // 1. 派发子智能体工具 (spawn_subagent)
      pi.registerTool(
        defineTool({
          name: "spawn_subagent",
          label: "派发子任务",
          description:
            "派发一个结构化契约子智能体任务。后台异步非阻塞执行（若显式启用 requiresWorktree 则在独立 Git 分支隔离运行，默认在主工作区执行），完成后系统会自动向统筹者主动上报成果。",
          promptSnippet: "派发一个独立的异步子智能体任务。派发前可调用 list_available_roles 查看可用角色",
          promptGuidelines: [
            "派发子任务前可先调用 list_available_roles 查询系统可用角色与工具列表；",
            "【任务粒度与拆分原则】能独立调查、独立验证、独立交付的子目标（如独立子系统、不同配置源、独立调用链或故障域）优先拆成多个 Subagent Task（例如派发给多个 Tester/Developer），避免因复合目标造成不必要的超长上下文和大量低价值重复工具调用；高度耦合需共享深入上下文的子目标保持单任务，不要机械拆分；深度调查与多份文档交付可拆分为调查验证阶段与交付物整理阶段；同一 Task 内通过 Working Memory 保持连贯，跨 Task 则通过 ReusableSubagent Knowledge、context_files 或明确产物传递结论（Working Memory 不跨 Task 自动继承）；",
            "可连续多次调用 spawn_subagent 以并行启动多个独立的子智能体，各子任务异步执行；",
            "支持传入结构化 Task Contract 字段 (如 expected_effects, acceptance_criteria, context_files, scope_include)；",
            "派发任务时，根据任务真实目标填写 expected_effects（例如 Tester 仅运行测试声明 ['test_execution']，Tester 修复测试代码声明 ['code_change']）；",
            "派发后无需阻塞等待，严禁使用 bash (如 sleep、轮询脚本、死循环检查 git log) 阻塞等待子任务！子任务完成后系统会自动向你主动注入汇报结果与产出，并唤醒下一轮对话；",
            "已经委派给 Subagent 的调查任务，默认不要自己再重复 read/grep；只有协调、结果冲突、证据不足或最终验证时再自行检查。",
            "子智能体默认继承主会话模型，除非角色配置或任务执行选项中显式指定了专属模型。",
          ],
          executionMode: "parallel",
          parameters: Type.Object({
            role: Type.String({
              description: "子智能体角色标识（必须从 list_available_roles 获取，例如 'fullstack'、'junior_fe'、'junior_be'、'reviewer'、'tester'、'deployer'，严禁使用 default）",
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
                    "任务预期产出/效果类型列表（如 ['test_execution'] 或 ['code_change']）。派发时请根据真实目标填写，不要仅凭角色猜测（例如：Tester 仅运行测试填 ['test_execution']，Tester 修复测试代码填 ['code_change']）。",
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
            const validRoles: AgentRole[] = [
              "fullstack",
              "junior_fe",
              "junior_be",
              "reviewer",
              "tester",
              "deployer",
            ];
            if (!validRoles.includes(params.role as AgentRole)) {
              return {
                isError: true,
                details: undefined,
                content: [
                  {
                    type: "text",
                    text: `[spawn_subagent] 失败: 非法的子智能体角色 '${params.role}'。当前仅支持 list_available_roles 中的角色。`,
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
                            ? `子任务 [${task.taskId}] 已派发，因前置依赖尚未完成处于 blocked 挂起状态。前置依赖完成后将自动唤醒。`
                            : `子任务 [${task.taskId}] 已成功启动（异步执行中）。执行完毕后系统将自动向你注入成果汇报，请勿使用 bash 轮询等待。`,
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

      // 2. 列出子任务与可复用 Agent 状态工具 (list_subagents)
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

      // 3. 复用已有智能体启动新任务工具 (continue_subagent)
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
              const taskContract: TaskContract = {
                taskId: "",
                parentSessionId: ctx.parentSessionId,
                role: "", // continueAgent 会自动补全为 agent.role
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

      // 4. 中断子智能体工具 (abort_subagent)
      pi.registerTool(
        defineTool({
          name: "abort_subagent",
          label: "中断子任务",
          description: "取消或中断正在后台运行的子智能体任务",
          parameters: Type.Object({
            task_id: Type.String({ description: "要中断的任务ID，如 'task-abc12345'" }),
          }),
          async execute(_toolCallId, params) {
            const success = await subagentManager.abort(params.task_id);
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

      // 5. 拦截 before_agent_start 动态注入当前活跃角色的分层系统提示词与首轮 Workspace Context
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

          const assembled = PromptAssembler.assemble(effectiveContext);
          systemPromptStr = assembled.systemPrompt;
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

        // 检查会话上下文，避免每一轮重复注入 Workspace Context；仅在首轮或 workspace 实际变化时注入
        let shouldInjectWorkspaceMessage = true;
        try {
          const entries = ctx?.sessionManager?.getEntries?.() ?? [];
          for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (
              e.type === "message" &&
              e.message.role === "custom" &&
              e.message.customType === "workspace-context"
            ) {
              const text =
                typeof e.message.content === "string"
                  ? e.message.content
                  : Array.isArray(e.message.content)
                    ? e.message.content.map((c: any) => (c as { text?: string }).text ?? "").join("")
                    : "";
              if (text.includes(`- cwd: ${currentCwd}`)) {
                shouldInjectWorkspaceMessage = false;
                break;
              }
            }
          }
        } catch {
          // If sessionManager entries inspection throws, fallback to injecting
        }

        if (shouldInjectWorkspaceMessage) {
          return {
            systemPrompt: systemPromptStr,
            message: {
              customType: "workspace-context",
              content: wsContent,
              display: false,
            },
          };
        }

        return {
          systemPrompt: systemPromptStr,
        };
      });
    },
  };
}
