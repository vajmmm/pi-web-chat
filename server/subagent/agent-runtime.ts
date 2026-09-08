import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentRole } from "../../shared/protocol.ts";
import {
  PromptAssembler,
  type EffectiveContext,
} from "../contracts/index.ts";
import { installTurnRecorderOnSession } from "../turn-recorder.ts";
import {
  createTaskContextExtension,
  type TaskContextRuntimeState,
} from "./compaction-evidence-index.ts";

export interface CreateSubagentRuntimeOptions {
  taskId: string;
  runId?: string;
  role: AgentRole;
  effectiveCwd: string;
  effectiveContext: EffectiveContext;
  modelRuntime: ModelRuntime;
  parentModel?: { provider: string; id: string } | null;
  customSession?: any;
  onReportBlocker?: (message: string, severity?: string, context?: string) => void;
  onCompaction?: (count: number) => void;
}

function createAuthoritativePromptExtension(options: {
  taskId: string;
  effectiveContext: EffectiveContext;
  runtimeModelRef: { current?: { provider: string; id: string } };
}): InlineExtension {
  return {
    name: `subagent-prompt-${options.taskId}`,
    factory: (pi) => {
      pi.on("before_agent_start", async () => {
        const runtimeModel = options.runtimeModelRef.current;
        if (!runtimeModel) {
          throw new Error("Subagent runtime model identity is unavailable before first agent turn");
        }

        const assembled = PromptAssembler.assemble(options.effectiveContext, {
          runtimeModel,
        });
        return { systemPrompt: assembled.taskSystemPrompt };
      });
    },
  };
}

export async function createSubagentSessionRuntime(options: CreateSubagentRuntimeOptions): Promise<{
  runtime: any;
  session: any;
  resolvedModelDetails?: { provider: string; id: string; name?: string };
}> {
  const {
    taskId,
    runId,
    role,
    effectiveCwd,
    effectiveContext,
    modelRuntime,
    parentModel,
    customSession,
    onReportBlocker,
    onCompaction,
  } = options;
  const effectiveRunId = runId || taskId;

  const taskContextState: TaskContextRuntimeState = { compactionCount: 0 };

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

  const runtimeModelRef: { current?: { provider: string; id: string } } = {};

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
            modelRuntime,
            resourceLoaderOptions: {
              noContextFiles: true,
              noSkills: true,
              // Bootstrap only. ResourceLoader caches this before final model resolution;
              // before_agent_start is the authoritative provider prompt boundary below.
              systemPromptOverride: () => {
                const assembled = PromptAssembler.assemble(effectiveContext, {
                  runtimeModel: runtimeModelRef.current,
                });
                return assembled.taskSystemPrompt;
              },
              appendSystemPromptOverride: () => [],
              extensionFactories: [
                createTaskContextExtension({
                  runId: effectiveRunId,
                  taskId,
                  role,
                  state: taskContextState,
                  onCompaction,
                }),
                createAuthoritativePromptExtension({
                  taskId,
                  effectiveContext,
                  runtimeModelRef,
                }),
              ],
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
  (session as any).__runId = effectiveRunId;
  (session as any).__taskContextState = taskContextState;
  (session as any).__factStoreExtensionInstalled = !resolvedCustomSession;

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
  const resolvedModelDetails = session.model
    ? {
        provider: session.model.provider,
        id: session.model.id,
        name: (session.model as { name?: string }).name,
      }
    : undefined;
  if (!resolvedModelDetails && !resolvedCustomSession) {
    throw new Error("Subagent runtime model identity is unavailable before first agent turn");
  }
  if (resolvedModelDetails) {
    runtimeModelRef.current = {
      provider: resolvedModelDetails.provider,
      id: resolvedModelDetails.id,
    };
  }

  if (resolvedModel?.thinkingLevel) {
    session.setThinkingLevel(resolvedModel.thinkingLevel);
  }

  if (typeof session.setActiveToolsByName === "function") {
    session.setActiveToolsByName([...effectiveContext.runtime.activeTools]);
  }

  installTurnRecorderOnSession(session, () => taskId);

  return { runtime, session, resolvedModelDetails };
}
