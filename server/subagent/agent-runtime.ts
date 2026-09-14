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
  type SubagentExecutionOptions,
} from "../contracts/index.ts";
import {
  getCompactionInstructions,
  type CompactionMode,
} from "../compact.ts";
import { getOrCreateRecoveryTracker } from "../compaction-telemetry.ts";
import {
  readArtifactByRef,
  readTranscriptEntries,
  searchTranscriptEntries,
} from "../runtime-artifacts.ts";
import { installTurnRecorderOnSession } from "../turn-recorder.ts";
import { createWebSearchExtension } from "../web-search-extension.ts";
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
  customTools?: any[];
  executionOptions?: SubagentExecutionOptions;
  onReportBlocker?: (message: string, severity?: "info" | "warning" | "blocking", context?: string) => void;
  onCompaction?: (count: number) => void;
  compactionMode?: CompactionMode;
}

export function createRecoveryTools(getScope: () => { runId: string; taskId: string }): any[] {
  return [
    defineTool({
      name: "read_transcript",
      label: "按范围读取历史 transcript",
      description:
        "Read a small slice of this task's durable transcript from before compaction. Use only when the Pi continuation summary is not enough. firstEntryId = recovery_manifest.firstCompactedEntryId. firstKeptEntryId is the first uncompacted entry; it is not lastEntryId (lastEntryId is inclusive). Current run/task only.",
      promptSnippet: "按 recovery_manifest.firstCompactedEntryId 读取当前任务压缩前的少量 transcript",
      parameters: Type.Object({
        firstEntryId: Type.Optional(Type.String()),
        lastEntryId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      }),
      async execute(_toolCallId, params) {
        const scope = getScope();
        const entries = readTranscriptEntries(scope.runId, scope.taskId, params);
        try {
          getOrCreateRecoveryTracker(scope.taskId).recordTranscriptRecovery();
        } catch {
          // fail-open
        }
        return { content: [{ type: "text", text: JSON.stringify(entries) }], details: {} };
      },
    }),
    defineTool({
      name: "search_transcript",
      label: "搜索历史 transcript",
      description:
        "Search this task's durable transcript by keyword for a small number of matching records. Targeted lookup only, not a full-history investigation. Current run/task only.",
      promptSnippet: "在当前任务 durable transcript 中做定向关键词查找",
      parameters: Type.Object({
        query: Type.String({ minLength: 1 }),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
      }),
      async execute(_toolCallId, params) {
        const scope = getScope();
        const entries = searchTranscriptEntries(scope.runId, scope.taskId, params.query, params.limit);
        try {
          getOrCreateRecoveryTracker(scope.taskId).recordTranscriptRecovery();
        } catch {
          // fail-open
        }
        return { content: [{ type: "text", text: JSON.stringify(entries) }], details: {} };
      },
    }),
    defineTool({
      name: "read_artifact",
      label: "按引用读取 artifact",
      description:
        "Read a bounded durable artifact by artifacts:// from this task's recovery_manifest transcriptRef / criticalArtifactRefs, or from a pointer in this session's tool preview. preview_only is not complete raw output. Covers the current run/task only; foreign artifacts:// refs are rejected.",
      promptSnippet: "按 artifacts:// 读取当前任务 recovery_manifest 中的 artifact",
      parameters: Type.Object({
        artifactRef: Type.String({ minLength: 1 }),
        maxBytes: Type.Optional(Type.Number({ minimum: 1, maximum: 32 * 1024 })),
      }),
      async execute(_toolCallId, params) {
        const scope = getScope();
        const content = readArtifactByRef(params.artifactRef, scope.runId, scope.taskId, params.maxBytes);
        if (content !== null) {
          try {
            getOrCreateRecoveryTracker(scope.taskId).recordArtifactRecovery();
          } catch {
            // fail-open
          }
        }
        return {
          content: [{ type: "text", text: content ?? "Artifact unavailable." }],
          details: {},
          isError: content === null,
        };
      },
    }),
  ];

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
        return { systemPrompt: assembled.systemPrompt };
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
  customTools.push(
    ...createRecoveryTools(() => ({ runId: effectiveRunId, taskId }))
      .filter((tool) => effectiveContext.runtime.activeTools.includes(tool.name)),
  );
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
                return assembled.systemPrompt;
              },
              appendSystemPromptOverride: () => [],
              extensionFactories: [
                createTaskContextExtension({
                  runId: effectiveRunId,
                  taskId,
                  role,
                  state: taskContextState,
                  onCompaction,
                  getSettingsManager: () => services.settingsManager,
                  getModel: () => runtimeModelRef.current,
                }),
                createAuthoritativePromptExtension({
                  taskId,
                  effectiveContext,
                  runtimeModelRef,
                }),
                createWebSearchExtension(),
              ],
            },
          });
          services.settingsManager.applyOverrides({
            compaction: {
              triggerRatio: 0.8,
              customInstructions: getCompactionInstructions(options.compactionMode),
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
