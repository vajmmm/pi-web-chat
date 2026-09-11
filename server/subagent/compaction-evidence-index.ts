import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AgentRole } from "../../shared/protocol.ts";
import {
  artifactRefFor,
  readTaskArtifact,
  readToolExecutionFacts,
  resolveArtifactRef,
  writeTaskArtifact,
} from "../runtime-artifacts.ts";
import { trackToolOutputMetadata } from "./tool-output-metadata.ts";
import { DEFAULT_OUTPUT_BUDGETS, persistAndVirtualizeToolResult } from "./output-virtualizer.ts";
import {
  appendCompactionTelemetry,
  getOrCreateRecoveryTracker,
  updateLatestTelemetryTokensAfter,
  type CompactionTelemetry,
} from "../compaction-telemetry.ts";



export interface CompactionEvidenceIndex {
  version: "1";
  taskId: string;
  compactionSeq: number;
  compactionEntryId?: string;
  boundary: {
    firstCompactedEntryId?: string;
    firstKeptEntryId?: string;
    compactedThroughEntryId?: string;
  };
  files: { changed: string[]; read: string[] };
  failedExecutions: Array<{
    toolCallId: string;
    toolName: string;
    exitCode?: number;
    artifactRef?: string;
    runtimePath?: string;
  }>;
  offloadedOutputs: Array<{
    toolCallId: string;
    toolName: string;
    artifactRef: string;
    runtimePath?: string;
    completeness?: "complete" | "preview_only";
  }>;
  verificationRefs?: string[];
  transcriptRef: string;
  transcriptRuntimePath?: string;
  summaryInspection?: SummaryInspection;
}

export interface RecoveryManifest {
  schemaVersion: "1.2";
  compactionSeq: number;
  compactionEntryId?: string;
  firstCompactedEntryId?: string;
  firstKeptEntryId?: string;
  transcriptRef: string;
  criticalArtifactRefs: string[];
}

export interface SummaryInspection {
  present: boolean;
  schemaVersion?: string;
  byteLength: number;
  missingSections: string[];
  status: "valid" | "degraded";
}

const CONTINUATION_SECTIONS = [
  "Task Goal",
  "Current State",
  "Completed Work",
  "Unresolved / Failed Work",
  "Failed Attempts / Do Not Retry",
  "Key Decisions / Reasons",
  "Modified Files",
  "Verification State",
  "Next Actions",
  "Critical Evidence / Artifact Refs",
] as const;

export function inspectContinuationSummary(summary: unknown): SummaryInspection {
  const text = typeof summary === "string" ? summary : "";
  const missingSections: string[] = CONTINUATION_SECTIONS
    .filter((section) => !text.includes(`# ${section}`));
  const marker = /<continuation_summary\s+schema="([^"]+)"\s*>/.exec(text);
  if (!marker || marker[1] !== "1.2" || !text.includes("</continuation_summary>")) {
    missingSections.unshift("continuation_summary wrapper/schema");
  }
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > 64 * 1024) missingSections.unshift("maximum length");
  return {
    present: text.trim().length > 0,
    ...(marker?.[1] ? { schemaVersion: marker[1] } : {}),
    byteLength,
    missingSections: [...missingSections],
    status: text.trim().length > 0 && missingSections.length === 0 ? "valid" : "degraded",
  };
}

export interface TaskContextRuntimeState {
  compactionCount: number;
  latestEvidenceIndex?: CompactionEvidenceIndex;
}

const RECOVERY_MANIFEST_FILE = "recovery-manifest.json";

function manifestFor(index: CompactionEvidenceIndex): RecoveryManifest {
  return {
    schemaVersion: "1.2",
    compactionSeq: index.compactionSeq,
    compactionEntryId: index.compactionEntryId,
    firstCompactedEntryId: index.boundary.firstCompactedEntryId,
    firstKeptEntryId: index.boundary.firstKeptEntryId,
    transcriptRef: index.transcriptRef,
    criticalArtifactRefs: unique([
      ...index.failedExecutions.map((entry) => entry.artifactRef).filter((ref): ref is string => Boolean(ref)),
      ...index.offloadedOutputs.map((entry) => entry.artifactRef),
    ]),
  };
}

function indexForManifest(manifest: RecoveryManifest, taskId: string): CompactionEvidenceIndex {
  return {
    version: "1",
    taskId,
    compactionSeq: manifest.compactionSeq,
    compactionEntryId: manifest.compactionEntryId,
    boundary: {
      firstCompactedEntryId: manifest.firstCompactedEntryId,
      firstKeptEntryId: manifest.firstKeptEntryId,
    },
    files: { changed: [], read: [] },
    failedExecutions: [],
    offloadedOutputs: manifest.criticalArtifactRefs.map((artifactRef) => ({
      toolCallId: "recovered",
      toolName: "recovered",
      artifactRef,
      runtimePath: resolveArtifactRef(artifactRef) ?? undefined,
    })),
    transcriptRef: manifest.transcriptRef,
    transcriptRuntimePath: resolveArtifactRef(manifest.transcriptRef) ?? undefined,
  };
}

/** Restore only the latest navigation manifest; transcript and facts remain on-demand. */
export function restoreLatestRecoveryManifest(
  state: TaskContextRuntimeState,
  runId: string,
  taskId: string,
): void {
  const manifest = readTaskArtifact<RecoveryManifest>(runId, taskId, RECOVERY_MANIFEST_FILE);
  if (!manifest || manifest.schemaVersion !== "1.2") return;
  state.compactionCount = manifest.compactionSeq;
  state.latestEvidenceIndex = indexForManifest(manifest, taskId);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function inputPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" ? path : undefined;
}

export function buildCompactionEvidenceIndex(options: {
  runId: string;
  taskId: string;
  compactionSeq: number;
  firstKeptEntryId?: string;
  firstCompactedEntryId?: string;
  compactionEntryId?: string;
  compactedThroughEntryId?: string;
  toolCallIds?: Set<string>;
  changedFiles?: string[];
  readFiles?: string[];
  summaryInspection?: SummaryInspection;
  maxBytes?: number;
}): CompactionEvidenceIndex {
  const facts = readToolExecutionFacts(options.runId, options.taskId);
  const deduped = [...new Map(facts.map((fact) => [fact.toolCallId, fact])).values()]
    .filter((fact) => !options.toolCallIds || options.toolCallIds.has(fact.toolCallId));
  const changed = options.changedFiles ?? unique(deduped
    .filter((fact) => fact.toolName === "edit" || fact.toolName === "write")
    .map((fact) => inputPath(fact.input))
    .filter((path): path is string => Boolean(path)));
  const read = options.readFiles ?? unique(deduped
    .filter((fact) => fact.toolName === "read")
    .map((fact) => inputPath(fact.input))
    .filter((path): path is string => Boolean(path)));
  const failedExecutions = deduped
    .filter((fact) => fact.isError || (typeof fact.exitCode === "number" && fact.exitCode !== 0))
    .map((fact) => ({
      toolCallId: fact.toolCallId,
      toolName: fact.toolName,
      ...(fact.exitCode !== undefined ? { exitCode: fact.exitCode } : {}),
      ...(fact.artifactRef ? { artifactRef: fact.artifactRef } : {}),
      ...(fact.artifactRef ? { runtimePath: resolveArtifactRef(fact.artifactRef) ?? undefined } : {}),
    }));
  const offloadedOutputs = deduped
    .filter((fact) => Boolean(fact.artifactRef))
    .map((fact) => ({
      toolCallId: fact.toolCallId,
      toolName: fact.toolName,
      artifactRef: fact.artifactRef!,
      runtimePath: resolveArtifactRef(fact.artifactRef!) ?? undefined,
      completeness: fact.completeness,
    }));
  const index: CompactionEvidenceIndex = {
    version: "1",
    taskId: options.taskId,
    compactionSeq: options.compactionSeq,
    compactionEntryId: options.compactionEntryId,
    boundary: {
      firstCompactedEntryId: options.firstCompactedEntryId,
      firstKeptEntryId: options.firstKeptEntryId,
      compactedThroughEntryId: options.compactedThroughEntryId,
    },
    files: { changed, read },
    failedExecutions,
    offloadedOutputs,
    transcriptRef: artifactRefFor(options.runId, options.taskId, "transcript.jsonl"),
    transcriptRuntimePath: resolveArtifactRef(artifactRefFor(options.runId, options.taskId, "transcript.jsonl")) ?? undefined,
    summaryInspection: options.summaryInspection,
  };
  const maxBytes = options.maxBytes ?? 8 * 1024;
  while (Buffer.byteLength(renderEvidenceIndex(index), "utf8") > maxBytes) {
    if (index.files.read.length > 0) index.files.read.shift();
    else if (index.files.changed.length > 0) index.files.changed.shift();
    else if (index.offloadedOutputs.length > 0) index.offloadedOutputs.shift();
    else if (index.failedExecutions.length > 0) index.failedExecutions.shift();
    else throw new RangeError("Evidence budget cannot contain the transcript recovery pointer");
  }
  return index;
}

export function renderEvidenceIndex(index: CompactionEvidenceIndex): string {
  const manifest = manifestFor(index);
  return `<recovery_manifest authority="deterministic_navigation_only" latest="true">\n` +
    `${JSON.stringify(manifest)}\n</recovery_manifest>`;
}

function evidenceMessage(index: CompactionEvidenceIndex): any {
  return {
    role: "user",
    content: [{
      type: "text",
      text: renderEvidenceIndex(index),
    }],
    timestamp: Date.now(),
  };
}

export function createTaskContextExtension(options: {
  runId?: string;
  taskId?: string;
  /** Main Coordinator binds this only after its actual session ID is known. */
  getScope?: () => { runId: string; taskId: string } | undefined;
  sessionId?: string;
  getSessionId?: () => string | undefined;
  role: AgentRole;
  state: TaskContextRuntimeState;
  onCompaction?: (count: number) => void;
  getSettingsManager?: () => any;
  getModel?: () => { provider?: string; id?: string; contextWindow?: number } | undefined;
}): InlineExtension {
  let pendingCompaction: {
    firstCompactedEntryId?: string;
    firstKeptEntryId?: string;
    compactedThroughEntryId?: string;
    toolCallIds: Set<string>;
    changedFiles: string[];
    readFiles: string[];
  } | undefined;
  return {
    name: `task-context-${options.taskId ?? "bound"}`,
    factory: (pi: ExtensionAPI) => {
      let pendingTokensAfterSeq: number | undefined;
      const takeMetadata = trackToolOutputMetadata(pi);
      pi.on("tool_result", async (event) => {
        const scope = options.getScope?.() ?? (options.runId && options.taskId
          ? { runId: options.runId, taskId: options.taskId }
          : undefined);
        if (!scope) throw new Error("Task context scope is not bound");
        const budget = options.role === "coordinator"
          ? DEFAULT_OUTPUT_BUDGETS.coordinator
          : options.role === "verifier"
            ? DEFAULT_OUTPUT_BUDGETS.verifier
            : DEFAULT_OUTPUT_BUDGETS.subagent;
        const projected = persistAndVirtualizeToolResult({
          runId: scope.runId,
          taskId: scope.taskId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          content: event.content,
          details: takeMetadata(event.toolCallId, event.details),
          input: event.input,
          isError: event.isError,
          maxBytes: budget,
        });
        if (!projected.virtualized) return;
        return {
          content: projected.content,
          details: {
            ...(event.details && typeof event.details === "object" ? event.details : {}),
            artifactRef: projected.pointer.artifactRef,
            completeness: projected.pointer.completeness,
          },
          isError: event.isError,
        };
      });

      pi.on("session_before_compact", async (event) => {
        const toolCallIds = new Set<string>();
        for (const message of [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages]) {
          if ((message as any).role === "toolResult" && (message as any).toolCallId) {
            toolCallIds.add((message as any).toolCallId);
          }
          for (const block of Array.isArray((message as any).content) ? (message as any).content : []) {
            if ((block.type === "toolCall" || block.type === "tool_call") && (block.id || block.toolCallId)) {
              toolCallIds.add(block.id || block.toolCallId);
            }
          }
        }
        const keptIndex = event.branchEntries.findIndex(
          (entry) => entry.id === event.preparation.firstKeptEntryId,
        );
        const previousCompactionIndex = event.branchEntries.reduce(
          (latest, entry, index) => entry.type === "compaction" ? index : latest,
          -1,
        );
        const previousCompaction = previousCompactionIndex >= 0
          ? event.branchEntries[previousCompactionIndex]
          : undefined;
        const previousKeptIndex = previousCompaction && previousCompaction.type === "compaction"
          ? event.branchEntries.findIndex((entry) => entry.id === previousCompaction.firstKeptEntryId)
          : -1;
        const boundaryStart = previousCompactionIndex >= 0
          ? (previousKeptIndex >= 0 ? previousKeptIndex : previousCompactionIndex + 1)
          : 0;
        pendingCompaction = {
          firstCompactedEntryId: event.branchEntries[boundaryStart]?.id,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          compactedThroughEntryId: keptIndex > 0 ? event.branchEntries[keptIndex - 1]?.id : undefined,
          toolCallIds,
          changedFiles: unique([
            ...event.preparation.fileOps.written,
            ...event.preparation.fileOps.edited,
          ]),
          readFiles: [...event.preparation.fileOps.read].filter(
            (path) => !event.preparation.fileOps.written.has(path) && !event.preparation.fileOps.edited.has(path),
          ),
        };
      });

      pi.on("session_compact", async (event, ctx) => {
        const scope = options.getScope?.() ?? (options.runId && options.taskId
          ? { runId: options.runId, taskId: options.taskId }
          : undefined);
        if (!scope) throw new Error("Task context scope is not bound");
        options.state.compactionCount += 1;
        const summaryText = typeof (event.compactionEntry as any).summary === "string"
          ? (event.compactionEntry as any).summary
          : "";
        const summaryInspection = inspectContinuationSummary(summaryText);
        options.state.latestEvidenceIndex = buildCompactionEvidenceIndex({
          runId: scope.runId,
          taskId: scope.taskId,
          compactionSeq: options.state.compactionCount,
          compactionEntryId: (event.compactionEntry as any).id,
          firstCompactedEntryId: pendingCompaction?.firstCompactedEntryId,
          firstKeptEntryId: pendingCompaction?.firstKeptEntryId ?? event.compactionEntry.firstKeptEntryId,
          compactedThroughEntryId: pendingCompaction?.compactedThroughEntryId,
          toolCallIds: pendingCompaction?.toolCallIds,
          changedFiles: pendingCompaction?.changedFiles,
          readFiles: pendingCompaction?.readFiles,
          summaryInspection,
        });
        // This is deliberately a single overwriting file: recovery has one latest navigation point.
        writeTaskArtifact(scope.runId, scope.taskId, RECOVERY_MANIFEST_FILE, manifestFor(options.state.latestEvidenceIndex));
        pendingCompaction = undefined;
        options.onCompaction?.(options.state.compactionCount);

        // Record compaction telemetry (fail-open)
        try {
          const model = (ctx as any)?.model
            ?? (pi as any).getModel?.()
            ?? (pi as any).model
            ?? options.getModel?.()
            ?? ((options as any).runtimeModelRef?.current);
          const tracker = getOrCreateRecoveryTracker(scope.taskId);
          const recoveryCounts = tracker.getCounts();
          const summaryBytes = Buffer.byteLength(summaryText, "utf8");
          const usage = (event.compactionEntry as any).usage;
          const providerCacheReadTokens = typeof usage?.cacheRead === "number" && usage.cacheRead > 0
            ? usage.cacheRead
            : undefined;
          const providerCacheWriteTokens = typeof usage?.cacheWrite === "number" && usage.cacheWrite > 0
            ? usage.cacheWrite
            : undefined;

          const settingsManager = options.getSettingsManager?.()
            ?? (ctx as any)?.sessionManager?.settingsManager
            ?? (pi as any).session?.settingsManager
            ?? (pi as any).settingsManager;
          const compactionSettings = settingsManager?.getCompactionSettings?.();

          const contextWindow = typeof model?.contextWindow === "number" ? model.contextWindow : undefined;
          const triggerRatio = typeof compactionSettings?.triggerRatio === "number"
            ? compactionSettings.triggerRatio
            : (typeof (event as any).triggerRatio === "number" ? (event as any).triggerRatio : 0.8);
          const reserveTokens = typeof compactionSettings?.reserveTokens === "number"
            ? compactionSettings.reserveTokens
            : (typeof (event as any).reserveTokens === "number" ? (event as any).reserveTokens : 16384);
          const keepRecentTokens = typeof compactionSettings?.keepRecentTokens === "number"
            ? compactionSettings.keepRecentTokens
            : 7000;

          const effectiveThresholdTokens = contextWindow
            ? Math.min(Math.floor(contextWindow * triggerRatio), contextWindow - reserveTokens)
            : undefined;

          const rawProvider = model?.provider;
          const rawModelId = model?.id;
          const modelProvider = rawProvider && rawProvider !== "unknown" ? rawProvider : "unavailable";
          const modelId = rawModelId && rawModelId !== "unknown" ? rawModelId : "unavailable";

          const telemetry: CompactionTelemetry = {
            sessionId: options.sessionId ?? options.getSessionId?.() ?? scope.taskId,
            taskId: scope.taskId,
            modelProvider,
            modelId,
            ...(contextWindow !== undefined ? { contextWindow } : {}),
            compactionSeq: options.state.compactionCount,
            reason: (event as any).reason ?? "manual",
            triggerRatio,
            reserveTokens,
            keepRecentTokens,
            ...(effectiveThresholdTokens !== undefined ? { effectiveThresholdTokens } : {}),
            ...(typeof (event.compactionEntry as any).tokensBefore === "number"
              ? { tokensBefore: (event.compactionEntry as any).tokensBefore }
              : {}),
            summaryBytes,
            summaryInspectionStatus: summaryInspection.status,
            missingSections: summaryInspection.missingSections,
            artifactRecoveryCount: recoveryCounts.artifactRecoveryCount,
            transcriptRecoveryCount: recoveryCounts.transcriptRecoveryCount,
            ...(providerCacheReadTokens !== undefined ? { providerCacheReadTokens } : {}),
            ...(providerCacheWriteTokens !== undefined ? { providerCacheWriteTokens } : {}),
          };

          appendCompactionTelemetry(telemetry, scope);
          pendingTokensAfterSeq = options.state.compactionCount;
        } catch (err) {
          console.warn("[CompactionTelemetry] session_compact logging failed (fail-open):", err);
        }
      });

      pi.on("message_end", async (event) => {
        if (pendingTokensAfterSeq === undefined) return;
        const msg = (event as any).message;
        if (msg && msg.role === "assistant" && msg.usage) {
          try {
            const scope = options.getScope?.() ?? (options.runId && options.taskId
              ? { runId: options.runId, taskId: options.taskId }
              : undefined);
            const inputTokens = typeof msg.usage.input === "number" ? msg.usage.input : undefined;
            if (inputTokens !== undefined) {
              const cacheRead = typeof msg.usage.cacheRead === "number" ? msg.usage.cacheRead : 0;
              const tokensAfter = inputTokens + cacheRead;
              updateLatestTelemetryTokensAfter(tokensAfter, pendingTokensAfterSeq, scope);
              pendingTokensAfterSeq = undefined;
            }
          } catch (err) {
            console.warn("[CompactionTelemetry] message_end token update failed (fail-open):", err);
          }
        }
      });

      pi.on("context", async (event) => {
        if (!options.state.latestEvidenceIndex) return;
        return { messages: [...event.messages, evidenceMessage(options.state.latestEvidenceIndex)] };
      });
    },
  };
}

