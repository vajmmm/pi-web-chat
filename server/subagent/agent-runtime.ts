import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentRole } from "../../shared/protocol.ts";
import {
  PromptAssembler,
  type EffectiveContext,
} from "../contracts/index.ts";
import { installTurnRecorderOnSession } from "../turn-recorder.ts";
import {
  createTaskMemoryExtension,
  writeWorkingMemory,
  appendProcessJournal,
} from "../task-memory.ts";

export interface CreateSubagentRuntimeOptions {
  taskId: string;
  role: AgentRole;
  effectiveCwd: string;
  effectiveContext: EffectiveContext;
  modelRuntime: ModelRuntime;
  parentModel?: { provider: string; id: string } | null;
  customSession?: any;
  onReportBlocker?: (message: string, severity?: string, context?: string) => void;
}

export async function createSubagentSessionRuntime(options: CreateSubagentRuntimeOptions): Promise<{
  runtime: any;
  session: any;
  resolvedModelDetails?: { provider: string; id: string; name?: string };
}> {
  const {
    taskId,
    role,
    effectiveCwd,
    effectiveContext,
    modelRuntime,
    parentModel,
    customSession,
    onReportBlocker,
  } = options;

  const customTools: any[] = [];
  if (effectiveContext.runtime.activeTools.includes("report_blocker")) {
    customTools.push(
      defineTool({
        name: "report_blocker",
        label: "报告阻塞情况",
        description:
          "向 Coordinator 报告当前遇到的关键阻塞、需求冲突或重大风险。此上报为单向记录，不会中断或挂起子智能体。",
        promptSnippet: "向 Coordinator 报告重大阻塞、冲突或风险",
        parameters: Type.Object({
          message: Type.String({ description: "描述遇到的具体阻塞问题、冲突或风险情况" }),
          severity: Type.Optional(
            Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("blocking")], {
              description: "阻塞严重程度",
            }),
          ),
          context: Type.Optional(Type.String({ description: "相关背景、错误日志或冲突文件路径" })),
        }),
        async execute(_toolCallId, params) {
          if (onReportBlocker) {
            onReportBlocker(params.message, params.severity, params.context);
          }
          return {
            content: [
              {
                type: "text",
                text: "The issue has been reported to the coordinator. Continue if a safe path remains; otherwise stop and explain the blocker in your final report.",
              },
            ],
            details: { reported: true },
          };
        },
      }),
    );
  }

  customTools.push(
    defineTool({
      name: "update_working_memory",
      label: "更新工作记忆",
      description:
        "滚动更新当前任务的工作记忆状态快照 (working-memory.md)。用于保存当前阶段、已验证事实、重要文件、排除路线与下一步计划。该状态在 context compaction 后会自动重新注入，请保持短小精炼（建议 5000 tokens 以内），区分已验证事实与待验证假设。",
      promptSnippet: "滚动更新任务工作记忆快照 (working-memory.md)",
      parameters: Type.Object({
        content: Type.String({
          description: "完整的 Markdown 格式工作记忆快照（覆盖更新当前最小充分状态）",
        }),
      }),
      async execute(_toolCallId, params) {
        const res = writeWorkingMemory(taskId, params.content);
        if (!res.success) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `[update_working_memory] 更新失败: ${res.error}`,
              },
            ],
            details: { taskId, characterCount: 0 },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `[update_working_memory] 成功更新 Working Memory (${res.characterCount} 字符)。在 context compaction 后将自动注入此最新快照。`,
            },
          ],
          details: { taskId, characterCount: res.characterCount },
        };
      },
    }),
  );

  customTools.push(
    defineTool({
      name: "append_process_journal",
      label: "追加过程日志",
      description:
        "向当前任务的过程日志 (process-journal.md) 追加重要调查历史、验证证据或被推翻的假设。请仅在重要阶段结束、关键结论产生或方案被证伪时记录，不要频繁记录每个小操作。",
      promptSnippet: "向任务过程日志 (process-journal.md) 追加重要历史记录",
      parameters: Type.Object({
        entry: Type.String({
          description: "要追加的过程日志内容（调查过程、证据、假设、结论）",
        }),
        title: Type.Optional(
          Type.String({
            description: "简短标题（例如 'Investigate premature completion'）",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const res = appendProcessJournal(taskId, params.entry, params.title);
        if (!res.success) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `[append_process_journal] 追加失败: ${res.error}`,
              },
            ],
            details: { taskId },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `[append_process_journal] 成功追加到 process-journal.md。此文件保存在磁盘供后续按需检索，不会在 compaction 后全量注入。`,
            },
          ],
          details: { taskId },
        };
      },
    }),
  );

  const resolvedCustomSession =
    typeof customSession === "function" ? await customSession() : customSession;
  const runtime = resolvedCustomSession
    ? {
        session: resolvedCustomSession.session || resolvedCustomSession,
        dispose: async () => {
          if (typeof resolvedCustomSession.dispose === "function") {
            await resolvedCustomSession.dispose();
          } else if (typeof resolvedCustomSession.session?.dispose === "function") {
            await resolvedCustomSession.session.dispose();
          }
        },
      }
    : await createAgentSessionRuntime(
        async ({ cwd, sessionManager, sessionStartEvent }) => {
          const services = await createAgentSessionServices({
            cwd,
            resourceLoaderOptions: {
              systemPromptOverride: () => {
                const assembled = PromptAssembler.assemble(effectiveContext);
                return assembled.systemPrompt;
              },
              appendSystemPromptOverride: () => [],
              extensionFactories: [createTaskMemoryExtension(taskId, () => session)],
            },
          });
          return {
            ...(await createAgentSessionFromServices({
              services,
              sessionManager,
              sessionStartEvent,
              customTools: customTools.length > 0 ? (customTools as any) : undefined,
            })),
            services,
            diagnostics: services.diagnostics,
          };
        },
        {
          cwd: effectiveCwd,
          agentDir: getAgentDir(),
          sessionManager: SessionManager.inMemory(effectiveCwd),
        },
      );

  const session = runtime.session;
  (session as any).__taskId = taskId;

  const resolvedModel = effectiveContext.runtime.model;
  if (resolvedModel?.modelId && resolvedModel.modelId !== "inherit") {
    const provider = resolvedModel.provider ?? parentModel?.provider ?? "anthropic";
    const model = modelRuntime.getModel(provider, resolvedModel.modelId);
    if (model) {
      await session.setModel(model);
    } else {
      console.warn(
        `[SubagentManager] Model not found: ${provider}/${resolvedModel.modelId} for role ${role}; using session default`,
      );
    }
  }
  if (resolvedModel?.thinkingLevel) {
    session.setThinkingLevel(resolvedModel.thinkingLevel);
  }

  if (typeof session.setActiveToolsByName === "function") {
    session.setActiveToolsByName([
      ...effectiveContext.runtime.activeTools,
      "update_working_memory",
      "append_process_journal",
    ]);
  }

  installTurnRecorderOnSession(session, () => taskId);

  const resolvedModelDetails = session.model
    ? {
        provider: session.model.provider,
        id: session.model.id,
        name: (session.model as { name?: string }).name,
      }
    : undefined;

  return { runtime, session, resolvedModelDetails };
}
