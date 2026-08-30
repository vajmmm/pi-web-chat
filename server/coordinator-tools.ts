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
  getAllRoleDefinitions,
  getPermissionProfile,
  PromptAssembler,
  type DeliverableType,
  type TaskContract,
} from "./contracts/index.ts";
import { getAllRoleConfigs } from "./roles.ts";
import { adjustSkillsInBasePrompt } from "./skills.ts";
import { parseModelOverride } from "./subagent-report.ts";
import type { SubagentManager } from "./subagent-manager.ts";

export const COORDINATOR_EXTENSION_NAME = "pi-coordinator-tools";

export function createCoordinatorExtension(
  subagentManager: SubagentManager,
  getSessionContext: () => {
    parentSessionId: string;
    parentCwd: string;
    parentModel?: { provider: string; id: string } | null;
    activeRole: AgentRole;
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
            const summary = definitions.map((d) => {
              const profile = getPermissionProfile(d.permissionProfileId);
              return {
                role_id: d.id,
                name: d.name,
                description: d.description,
                responsibilities: d.responsibilities,
                strict_prohibitions: d.strictProhibitions,
                allowed_skills: d.allowedSkills ?? [],
                allowed_tools:
                  d.allowedTools && d.allowedTools.length > 0
                    ? d.allowedTools
                    : profile.allowedTools,
                writable_scope: profile.writableScope,
                requires_worktree: profile.requiresWorktree,
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

      // 1. 派发子智能体工具 (spawn_subagent)
      pi.registerTool(
        defineTool({
          name: "spawn_subagent",
          label: "派发子任务",
          description:
            "派发一个结构化契约子智能体任务。后台异步非阻塞执行，自动在独立 Git 分支与 Worktree 目录中隔离运行，完成后子任务会自动向统筹者主动上报成果与验证证据。",
          promptSnippet: "派发一个独立的异步子智能体任务。派发前可调用 list_available_roles 查看可用角色",
          promptGuidelines: [
            "派发子任务前可先调用 list_available_roles 查询系统可用角色与工具权限；",
            "可连续多次调用 spawn_subagent 以并行启动多个独立的子智能体，各子任务互不阻塞并在独立 Worktree 中工作；",
            "支持传入结构化 Task Contract 字段 (如 acceptance_criteria, context_files, scope_include, expected_deliverables)；",
            "派发后无需阻塞等待，子任务完成后系统会自动向你主动汇报执行结果与验证证据。",
            "已经委派给 Subagent 的调查任务，默认不要自己再重复 read/grep；只有协调、结果冲突、证据不足或最终验证时再自行检查。",
            "所有子角色自动继承用户主会话选定的模型与运行环境。",
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
            expected_deliverables: Type.Optional(
              Type.Array(Type.String(), {
                description: "期望产出的交付物类型列表 (如 ['summary', 'changed_files', 'test_report', 'review_verdict', 'deploy_evidence'])",
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
                    text: `[spawn_subagent] 无效的角色标识 "${params.role}"。可用角色列表: ${validRoles.join(", ")}。禁止静默回退，已终止派发。`,
                  },
                ],
              };
            }
            const role = params.role as AgentRole;

            const deliverables: DeliverableType[] = (params.expected_deliverables as DeliverableType[]) ?? (
              role === "reviewer"
                ? ["summary", "review_verdict"]
                : role === "deployer"
                  ? ["summary", "deploy_evidence"]
                  : ["summary", "changed_files", "test_report"]
            );

            const taskContract: TaskContract = {
              taskId: `task-${randomUUID()}`,
              parentSessionId: ctx.parentSessionId,
              role,
              goal: params.goal || params.task_title || params.prompt,
              scope: {
                include: params.scope_include ?? ["*"],
                exclude: params.scope_exclude ?? [],
              },
              contextFiles: params.context_files ?? [],
              acceptanceCriteria: params.acceptance_criteria ?? ["完成指定实现并自测通过"],
              expectedDeliverables: deliverables,
            };

            try {
              const task = await subagentManager.spawn({
                parentSessionId: ctx.parentSessionId,
                role,
                taskTitle: params.task_title,
                taskPrompt: params.prompt,
                preferredBranch: params.branch,
                targetCwd: params.cwd,
                parentCwd: ctx.parentCwd,
                parentModel: ctx.parentModel,
                taskContract,
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
                        status: "spawned",
                        task_id: task.taskId,
                        task_title: task.taskTitle,
                        role: task.role,
                        branch: task.branchName ?? "main_workspace",
                        is_worktree: !!task.worktreePath,
                        target_cwd: task.targetCwd ?? "root",
                        contract: taskContract,
                        message: "结构化契约子任务已成功在后台异步启动，完成后系统将自动上报结果与验证证据。",
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
                    text: JSON.stringify(
                      {
                        status: "error",
                        error: err instanceof Error ? err.message : String(err),
                      },
                      null,
                      2,
                    ),
                  },
                ],
              };
            }
          },
        }),
      );

      // 2. 中断子任务工具 (abort_subagent)
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

      // 3. 拦截 before_agent_start 动态注入当前活跃角色的分层系统提示词
      pi.on("before_agent_start", async (event) => {
        const ctx = getSessionContext();
        const role = ctx.activeRole || "coordinator";

        if (role === "default") {
          const def = getAllRoleDefinitions().find((r) => r.id === "default");
          return {
            systemPrompt: adjustSkillsInBasePrompt(
              event.systemPrompt,
              def?.allowedSkills ?? [],
              ctx.parentCwd,
            ),
          };
        }

        const effectiveContext = ConstraintResolver.resolve({
          role,
          cwd: ctx.parentCwd,
          isGitRepo: true,
          parentModel: ctx.parentModel
            ? { provider: ctx.parentModel.provider, modelId: ctx.parentModel.id }
            : null,
        });

        const assembled = PromptAssembler.assemble(effectiveContext);
        return {
          systemPrompt: assembled.systemPrompt,
        };
      });
    },
  };
}
