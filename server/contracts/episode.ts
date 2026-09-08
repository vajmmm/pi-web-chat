import type { AgentRole } from "../../shared/protocol.ts";
import type { TaskExecutionStatus, VerificationResult } from "./task.ts";

export interface ArtifactRef {
  ref: string;
}

export interface TaskEpisodeCard {
  version: "1";
  physical: {
    runId: string;
    taskId: string;
    parentTaskId?: string;
    role: AgentRole;
    terminalStatus: TaskExecutionStatus;
    timings: {
      startedAt?: string;
      completedAt: string;
      durationMs?: number;
    };
    metrics: {
      turnCount?: number;
      compactionCount: number;
      totalToolCalls: number;
    };
    worktree: {
      baseCommit?: string;
      finalCommit?: string;
      filesChanged: string[];
      stats?: { additions: number; deletions: number };
    };
    artifacts: {
      transcript: ArtifactRef;
      taskResult: ArtifactRef;
      toolOutputsDir: ArtifactRef;
      verifier?: ArtifactRef;
    };
  };
  verification?: {
    result: VerificationResult;
    evidence?: ArtifactRef;
  };
  semantic?: {
    provenance: {
      source: "task_result";
      sourceRef: ArtifactRef;
      schemaVersion: "1";
      contentHash?: string;
    };
    reportedSummary: string;
  };
}

export interface TaskEpisodeViewOptions {
  maxTotalBytes?: number;
  maxFiles?: number;
  maxSummaryBytes?: number;
}
