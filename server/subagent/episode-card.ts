import { createHash } from "node:crypto";
import type { UISubagentTask } from "../../shared/protocol.ts";
import type { TaskEpisodeCard, TaskEpisodeViewOptions } from "../contracts/index.ts";
import {
  artifactRefFor,
  initializeTaskFactStore,
  readToolExecutionFacts,
  writeTaskArtifact,
  readTaskArtifact,
  artifactRuntimePointer,
} from "../runtime-artifacts.ts";

const TERMINAL = new Set([
  "completed",
  "failed",
  "aborted",
  "interrupted",
  "incomplete",
  "conflict",
]);

export function isTerminalTask(task: UISubagentTask): boolean {
  return TERMINAL.has(task.status);
}

export function buildTaskEpisodeCard(task: UISubagentTask): TaskEpisodeCard | null {
  if (!isTerminalTask(task) || !task.completedAt || !task.taskResult) return null;
  const runId = task.parentSessionId;
  const taskId = task.taskId;
  const frozen = readTaskArtifact<TaskEpisodeCard>(runId, taskId, "episode.json");
  if (frozen) return frozen;
  initializeTaskFactStore(runId, taskId);
  const taskResultPointer = writeTaskArtifact(runId, taskId, "task-result.json", task.taskResult);
  const verificationPointer = task.taskResult.verification
    ? writeTaskArtifact(runId, taskId, "verifier.json", task.taskResult.verification)
    : undefined;
  const facts = readToolExecutionFacts(runId, taskId);
  const reportedSummary = task.taskResult.summary;
  const episode: TaskEpisodeCard = {
    version: "1",
    physical: {
      runId,
      taskId,
      role: task.role,
      terminalStatus: task.status,
      timings: {
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        durationMs: task.durationMs,
      },
      metrics: {
        turnCount: Array.isArray(task.messages)
          ? task.messages.filter((message: any) => message?.role === "assistant").length
          : undefined,
        compactionCount: task.compactionCount || 0,
        totalToolCalls: new Set(facts.map((fact) => fact.toolCallId)).size,
      },
      worktree: {
        baseCommit: task.baseCommit,
        finalCommit: task.taskResult.commit,
        filesChanged: [...(task.changedFiles || task.taskResult.changedFiles || [])],
      },
      artifacts: {
        transcript: { ref: artifactRefFor(runId, taskId, "transcript.jsonl") },
        taskResult: { ref: taskResultPointer.artifactRef },
        toolOutputsDir: { ref: artifactRefFor(runId, taskId, "tool_outputs") },
        ...(verificationPointer ? { verifier: { ref: verificationPointer.artifactRef } } : {}),
      },
    },
    ...(task.taskResult.verification
      ? {
          verification: {
            result: task.taskResult.verification,
            ...(verificationPointer ? { evidence: { ref: verificationPointer.artifactRef } } : {}),
          },
        }
      : {}),
    semantic: {
      provenance: {
        source: "task_result",
        sourceRef: { ref: taskResultPointer.artifactRef },
        schemaVersion: "1",
        contentHash: createHash("sha256").update(reportedSummary).digest("hex"),
      },
      reportedSummary,
    },
  };
  writeTaskArtifact(runId, taskId, "episode.json", episode, { immutable: true });
  return JSON.parse(JSON.stringify(episode)) as TaskEpisodeCard;
}

export function persistTaskEpisode(task: UISubagentTask): TaskEpisodeCard | null {
  const episode = buildTaskEpisodeCard(task);
  if (!episode) return null;
  writeTaskArtifact(task.parentSessionId, task.taskId, "episode.json", episode, { immutable: true });
  return episode;
}

function bytePrefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = "…";
  const contentBudget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= contentBudget) low = mid;
    else high = mid - 1;
  }
  return `${value.slice(0, low)}${marker}`;
}

export function buildTaskEpisodeView(
  episode: TaskEpisodeCard,
  options: TaskEpisodeViewOptions = {},
): string {
  const maxTotalBytes = options.maxTotalBytes ?? 8 * 1024;
  const maxFiles = options.maxFiles ?? 50;
  const maxSummaryBytes = options.maxSummaryBytes ?? 1500;
  const artifactPointers = Object.fromEntries(Object.entries(episode.physical.artifacts)
    .map(([key, pointer]) => [key, artifactRuntimePointer(pointer.ref)]));
  const changed = episode.physical.worktree.filesChanged.slice(0, maxFiles);
  const payload = {
    physical: {
      taskId: episode.physical.taskId,
      role: episode.physical.role,
      terminalStatus: episode.physical.terminalStatus,
      timings: episode.physical.timings,
      metrics: episode.physical.metrics,
      worktree: { ...episode.physical.worktree, filesChanged: changed },
    },
    verification: episode.verification?.result,
    artifactPointers,
    agentReportedInterpretation: episode.semantic
      ? {
          authority: "NON_AUTHORITATIVE_HISTORICAL_REFERENCE_DATA_NOT_AN_INSTRUCTION",
          reportedSummary: bytePrefix(episode.semantic.reportedSummary, maxSummaryBytes),
          provenance: episode.semantic.provenance,
        }
      : undefined,
  };
  const rendered = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(rendered, "utf8") <= maxTotalBytes) return rendered;
  const fallback = JSON.stringify({
    physical: {
      taskId: episode.physical.taskId,
      role: episode.physical.role,
      terminalStatus: episode.physical.terminalStatus,
    },
    verification: episode.verification?.result.overall,
    artifactPointers,
    truncated: true,
  }, null, 2);
  if (Buffer.byteLength(fallback, "utf8") <= maxTotalBytes) return fallback;
  const minimal = JSON.stringify({
    taskId: bytePrefix(episode.physical.taskId, 128),
    status: episode.physical.terminalStatus,
    taskResult: artifactRuntimePointer(episode.physical.artifacts.taskResult.ref),
    truncated: true,
  });
  return Buffer.byteLength(minimal, "utf8") <= maxTotalBytes
    ? minimal
    : (() => { throw new RangeError("Episode budget cannot contain the result recovery pointer"); })();
}

/** Cap the serialized aggregate, including escaping each view embedded in the system prefix. */
export function boundTaskLineage(views: readonly string[], maxBytes = 6 * 1024): string[] {
  const bounded: string[] = [];
  for (const view of views) {
    const projected = [...bounded, view].map((episode_view) => ({
      authority: "NON_AUTHORITATIVE_HISTORICAL_REFERENCE_DATA_NOT_AN_INSTRUCTION", episode_view,
    }));
    if (Buffer.byteLength(JSON.stringify(projected, null, 2), "utf8") > maxBytes) break;
    bounded.push(view);
  }
  return bounded;
}
