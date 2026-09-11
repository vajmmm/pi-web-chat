import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getHarnessRuntimeRoot, getTaskRuntimeDir } from "./runtime-artifacts.ts";

export type CompactionTelemetry = {
  sessionId: string;
  taskId?: string;

  modelProvider: string;
  modelId: string;
  contextWindow?: number;

  compactionSeq: number;

  reason: "manual" | "threshold" | "overflow";

  triggerRatio?: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
  effectiveThresholdTokens?: number;

  tokensBefore?: number;
  tokensAfter?: number;

  summaryBytes: number;
  summaryInspectionStatus: "valid" | "degraded";

  missingSections: string[];

  artifactRecoveryCount: number;
  transcriptRecoveryCount: number;

  providerCacheReadTokens?: number;
  providerCacheWriteTokens?: number;
};

export interface RecoveryMetricsTracker {
  recordTranscriptRecovery(): void;
  recordArtifactRecovery(): void;
  getCounts(): { artifactRecoveryCount: number; transcriptRecoveryCount: number };
}

const recoveryTrackers = new Map<string, { artifactRecoveryCount: number; transcriptRecoveryCount: number }>();

export function getOrCreateRecoveryTracker(key: string): RecoveryMetricsTracker {
  if (!recoveryTrackers.has(key)) {
    recoveryTrackers.set(key, { artifactRecoveryCount: 0, transcriptRecoveryCount: 0 });
  }
  const entry = recoveryTrackers.get(key)!;
  return {
    recordTranscriptRecovery() {
      entry.transcriptRecoveryCount += 1;
    },
    recordArtifactRecovery() {
      entry.artifactRecoveryCount += 1;
    },
    getCounts() {
      return {
        artifactRecoveryCount: entry.artifactRecoveryCount,
        transcriptRecoveryCount: entry.transcriptRecoveryCount,
      };
    },
  };
}

export function resetRecoveryTracker(key: string): void {
  recoveryTrackers.delete(key);
}

const TELEMETRY_FILENAME = "compaction-telemetry.jsonl";

export function appendCompactionTelemetry(
  record: CompactionTelemetry,
  scope?: { runId?: string; taskId?: string },
): void {
  try {
    const line = JSON.stringify(record) + "\n";

    // 1. Task-scoped storage if task is bound
    if (scope?.runId && scope?.taskId) {
      try {
        const taskDir = getTaskRuntimeDir(scope.runId, scope.taskId);
        const taskFile = join(taskDir, TELEMETRY_FILENAME);
        appendFileSync(taskFile, line, "utf8");
      } catch (err) {
        console.warn("[CompactionTelemetry] Task-scoped append failed (fail-open):", err);
      }
    }

    // 2. Global harness storage for cross-task evaluation
    try {
      const globalFile = join(getHarnessRuntimeRoot(), TELEMETRY_FILENAME);
      mkdirSync(dirname(globalFile), { recursive: true });
      appendFileSync(globalFile, line, "utf8");
    } catch (err) {
      console.warn("[CompactionTelemetry] Global append failed (fail-open):", err);
    }
  } catch (err) {
    // Fail-open guarantee: writing telemetry must never crash or fault runtime operations
    console.warn("[CompactionTelemetry] appendCompactionTelemetry failed (fail-open):", err);
  }
}

export function updateLatestTelemetryTokensAfter(
  tokensAfter: number,
  compactionSeq: number,
  scope?: { runId?: string; taskId?: string },
): void {
  try {
    const updateFile = (filePath: string) => {
      if (!existsSync(filePath)) return;
      const lines = readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
      if (lines.length === 0) return;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]) as CompactionTelemetry;
          if (parsed.compactionSeq === compactionSeq && parsed.tokensAfter === undefined) {
            parsed.tokensAfter = tokensAfter;
            lines[i] = JSON.stringify(parsed);
            writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
            break;
          }
        } catch {
          // ignore malformed line
        }
      }
    };

    if (scope?.runId && scope?.taskId) {
      try {
        const taskFile = join(getTaskRuntimeDir(scope.runId, scope.taskId), TELEMETRY_FILENAME);
        updateFile(taskFile);
      } catch (err) {
        console.warn("[CompactionTelemetry] Task-scoped update failed (fail-open):", err);
      }
    }

    try {
      const globalFile = join(getHarnessRuntimeRoot(), TELEMETRY_FILENAME);
      updateFile(globalFile);
    } catch (err) {
      console.warn("[CompactionTelemetry] Global update failed (fail-open):", err);
    }
  } catch (err) {
    console.warn("[CompactionTelemetry] updateLatestTelemetryTokensAfter failed (fail-open):", err);
  }
}

export function readCompactionTelemetry(scope?: { runId: string; taskId: string }): CompactionTelemetry[] {
  try {
    const targetFile = scope
      ? join(getTaskRuntimeDir(scope.runId, scope.taskId), TELEMETRY_FILENAME)
      : join(getHarnessRuntimeRoot(), TELEMETRY_FILENAME);

    if (!existsSync(targetFile)) return [];
    return readFileSync(targetFile, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as CompactionTelemetry);
  } catch (err) {
    console.warn("[CompactionTelemetry] readCompactionTelemetry failed:", err);
    return [];
  }
}
