import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  appendCompactionTelemetry,
  getOrCreateRecoveryTracker,
  readCompactionTelemetry,
  resetRecoveryTracker,
  updateLatestTelemetryTokensAfter,
  type CompactionTelemetry,
} from "../server/compaction-telemetry.ts";
import {
  getCompactionInstructions,
  STRUCTURED_COMPACTION_PROMPT,
} from "../server/compact.ts";
import { inspectContinuationSummary } from "../server/subagent/compaction-evidence-index.ts";

describe("Compaction Telemetry & A/B Mode", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-telemetry-test-"));
  const previousRoot = process.env.HARNESS_RUNTIME_ROOT;

  before(() => {
    process.env.HARNESS_RUNTIME_ROOT = root;
  });

  after(() => {
    if (previousRoot === undefined) delete process.env.HARNESS_RUNTIME_ROOT;
    else process.env.HARNESS_RUNTIME_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it("evaluates A/B mode toggle correctly", () => {
    assert.match(STRUCTURED_COMPACTION_PROMPT, /continuation hint/);
    assert.match(STRUCTURED_COMPACTION_PROMPT, /Critical Evidence \/ Artifact Refs/);
    assert.equal(getCompactionInstructions("native"), undefined);
    assert.equal(getCompactionInstructions("structured"), STRUCTURED_COMPACTION_PROMPT);

    const oldEnv = process.env.COMPACTION_MODE;
    try {
      process.env.COMPACTION_MODE = "native";
      assert.equal(getCompactionInstructions(), undefined);
      process.env.COMPACTION_MODE = "structured";
      assert.equal(getCompactionInstructions(), STRUCTURED_COMPACTION_PROMPT);
    } finally {
      if (oldEnv === undefined) delete process.env.COMPACTION_MODE;
      else process.env.COMPACTION_MODE = oldEnv;
    }
  });

  it("records telemetry fail-open and persists to task and global storage", () => {
    const scope = { runId: "run-ab-1", taskId: "task-ab-1" };
    const sampleRecord: CompactionTelemetry = {
      sessionId: "session-123",
      taskId: "task-ab-1",
      modelProvider: "minimax-custom",
      modelId: "MiniMax-M2.7",
      contextWindow: 204800,
      compactionSeq: 1,
      reason: "threshold",
      triggerRatio: 0.8,
      reserveTokens: 16384,
      effectiveThresholdTokens: 163840,
      tokensBefore: 170000,
      summaryBytes: 1540,
      summaryInspectionStatus: "valid",
      missingSections: [],
      artifactRecoveryCount: 0,
      transcriptRecoveryCount: 0,
      providerCacheReadTokens: 120,
      providerCacheWriteTokens: 0,
    };

    appendCompactionTelemetry(sampleRecord, scope);

    // Read task-scoped telemetry
    const taskTelemetry = readCompactionTelemetry(scope);
    assert.equal(taskTelemetry.length, 1);
    assert.equal(taskTelemetry[0].compactionSeq, 1);
    assert.equal(taskTelemetry[0].modelId, "MiniMax-M2.7");
    assert.equal(taskTelemetry[0].providerCacheReadTokens, 120);
    assert.equal(taskTelemetry[0].tokensAfter, undefined);

    // Update tokensAfter when provider completes next turn
    updateLatestTelemetryTokensAfter(45000, 1, scope);

    const updatedTaskTelemetry = readCompactionTelemetry(scope);
    assert.equal(updatedTaskTelemetry[0].tokensAfter, 45000);

    // Global telemetry also captured it
    const globalTelemetry = readCompactionTelemetry();
    assert.equal(globalTelemetry.length, 1);
    assert.equal(globalTelemetry[0].tokensAfter, 45000);
  });

  it("tracks transcript and artifact recovery counters", () => {
    resetRecoveryTracker("task-recovery-test");
    const tracker = getOrCreateRecoveryTracker("task-recovery-test");

    assert.deepEqual(tracker.getCounts(), { artifactRecoveryCount: 0, transcriptRecoveryCount: 0 });

    tracker.recordTranscriptRecovery();
    tracker.recordTranscriptRecovery();
    tracker.recordArtifactRecovery();

    assert.deepEqual(tracker.getCounts(), { artifactRecoveryCount: 1, transcriptRecoveryCount: 2 });
    resetRecoveryTracker("task-recovery-test");
  });

  it("marks native summary as degraded and structured summary as valid in inspection", () => {
    const nativeSummary = `## Goal
Fix test failure in auth.ts

## Progress
### Done
- Checked routes.ts

## Next Steps
1. Run npm test`;

    const nativeInspection = inspectContinuationSummary(nativeSummary);
    assert.equal(nativeInspection.status, "degraded");
    assert(nativeInspection.missingSections.length > 0);

    const structuredSummary = `<continuation_summary schema="1.2">

# Task Goal
Fix test failure

# Current State
Investigating auth.ts

# Completed Work
Checked routes.ts

# Unresolved / Failed Work
Auth token expiration

# Failed Attempts / Do Not Retry
Do not bypass signature check

# Key Decisions / Reasons
Preserve existing session cookies

# Modified Files
auth.ts

# Verification State
tests failing

# Next Actions
Implement refresh token logic

# Critical Evidence / Artifact Refs
artifacts://runs/run-1/task-1/out.log

</continuation_summary>`;

    const structuredInspection = inspectContinuationSummary(structuredSummary);
    assert.equal(structuredInspection.status, "valid");
    assert.equal(structuredInspection.missingSections.length, 0);
  });
});
