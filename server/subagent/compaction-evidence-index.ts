import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AgentRole } from "../../shared/protocol.ts";
import { artifactRefFor, readToolExecutionFacts, resolveArtifactRef } from "../runtime-artifacts.ts";
import { trackToolOutputMetadata } from "./tool-output-metadata.ts";
import { DEFAULT_OUTPUT_BUDGETS, persistAndVirtualizeToolResult } from "./output-virtualizer.ts";

export interface CompactionEvidenceIndex {
  version: "1";
  taskId: string;
  compactionSeq: number;
  boundary: {
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
}

export interface TaskContextRuntimeState {
  compactionCount: number;
  latestEvidenceIndex?: CompactionEvidenceIndex;
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
  compactedThroughEntryId?: string;
  toolCallIds?: Set<string>;
  changedFiles?: string[];
  readFiles?: string[];
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
    boundary: {
      firstKeptEntryId: options.firstKeptEntryId,
      compactedThroughEntryId: options.compactedThroughEntryId,
    },
    files: { changed, read },
    failedExecutions,
    offloadedOutputs,
    transcriptRef: artifactRefFor(options.runId, options.taskId, "transcript.jsonl"),
    transcriptRuntimePath: resolveArtifactRef(artifactRefFor(options.runId, options.taskId, "transcript.jsonl")) ?? undefined,
  };
  const maxBytes = options.maxBytes ?? 8 * 1024;
  while (Buffer.byteLength(renderEvidenceIndex(index), "utf8") > maxBytes) {
    if (index.files.read.length > 0) index.files.read.pop();
    else if (index.files.changed.length > 0) index.files.changed.pop();
    else if (index.offloadedOutputs.length > 0) index.offloadedOutputs.pop();
    else if (index.failedExecutions.length > 0) index.failedExecutions.pop();
    else throw new RangeError("Evidence budget cannot contain the transcript recovery pointer");
  }
  return index;
}

export function renderEvidenceIndex(index: CompactionEvidenceIndex): string {
  return `<compaction_evidence_index authority="deterministic_navigation_only" latest="true">\n` +
    `${JSON.stringify(index)}\n</compaction_evidence_index>`;
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
  runId: string;
  taskId: string;
  role: AgentRole;
  state: TaskContextRuntimeState;
  onCompaction?: (count: number) => void;
}): InlineExtension {
  let pendingCompaction: {
    firstKeptEntryId?: string;
    compactedThroughEntryId?: string;
    toolCallIds: Set<string>;
    changedFiles: string[];
    readFiles: string[];
  } | undefined;
  return {
    name: `task-context-${options.taskId}`,
    factory: (pi: ExtensionAPI) => {
      const takeMetadata = trackToolOutputMetadata(pi);
      pi.on("tool_result", async (event) => {
        const budget = options.role === "verifier"
          ? DEFAULT_OUTPUT_BUDGETS.verifier
          : DEFAULT_OUTPUT_BUDGETS.subagent;
        const projected = persistAndVirtualizeToolResult({
          runId: options.runId,
          taskId: options.taskId,
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
        pendingCompaction = {
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

      pi.on("session_compact", async (event) => {
        options.state.compactionCount += 1;
        options.state.latestEvidenceIndex = buildCompactionEvidenceIndex({
          runId: options.runId,
          taskId: options.taskId,
          compactionSeq: options.state.compactionCount,
          firstKeptEntryId: pendingCompaction?.firstKeptEntryId ?? event.compactionEntry.firstKeptEntryId,
          compactedThroughEntryId: pendingCompaction?.compactedThroughEntryId,
          toolCallIds: pendingCompaction?.toolCallIds,
          changedFiles: pendingCompaction?.changedFiles,
          readFiles: pendingCompaction?.readFiles,
        });
        pendingCompaction = undefined;
        options.onCompaction?.(options.state.compactionCount);
      });

      pi.on("context", async (event) => {
        if (!options.state.latestEvidenceIndex) return;
        return { messages: [...event.messages, evidenceMessage(options.state.latestEvidenceIndex)] };
      });
    },
  };
}
