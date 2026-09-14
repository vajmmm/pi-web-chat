import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { createBashTool, createReadTool } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ConstraintResolver, PromptAssembler } from "../server/contracts/index.ts";
import { performSessionCompaction } from "../server/compact.ts";
import {
  artifactRefFor,
  persistToolOutput,
  resolveArtifactRef,
  getTaskRuntimeDir,
  readToolExecutionFacts,
  readTranscriptEntries,
  searchTranscriptEntries,
  readArtifactByRef,
  appendShadowTranscript,
  writeTaskArtifact,
  removeTaskArtifacts,
  readTaskArtifact,
} from "../server/runtime-artifacts.ts";
import {
  buildCompactionEvidenceIndex,
  createTaskContextExtension,
  inspectContinuationSummary,
  renderEvidenceIndex,
  restoreLatestRecoveryManifest,
} from "../server/subagent/compaction-evidence-index.ts";
import { buildTaskEpisodeCard, buildTaskEpisodeView, persistTaskEpisode, boundTaskLineage } from "../server/subagent/episode-card.ts";
import { createShadowTranscriptRecorder } from "../server/subagent/shadow-transcript.ts";
import { hashRequestPrefix } from "../server/turn-recorder.ts";
import { persistAndVirtualizeToolResult } from "../server/subagent/output-virtualizer.ts";
import { createRecoveryTools } from "../server/subagent/agent-runtime.ts";
import {
  createStallTelemetryState,
  observeToolExecution,
  recordContextPressure,
} from "../server/subagent/stall-arbiter.ts";

describe("Context / Memory / Compaction v1.1", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-harness-v11-"));
  const previousRoot = process.env.HARNESS_RUNTIME_ROOT;

  before(() => {
    process.env.HARNESS_RUNTIME_ROOT = root;
  });

  after(() => {
    if (previousRoot === undefined) delete process.env.HARNESS_RUNTIME_ROOT;
    else process.env.HARNESS_RUNTIME_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it("persists Pi full output before building a bounded preview", () => {
    const original = "head\n" + "x".repeat(80 * 1024) + "\ntail";
    const piFull = join(root, "pi-full.log");
    writeFileSync(piFull, original);
    const result = persistAndVirtualizeToolResult({
      runId: "run-1",
      taskId: "task-1",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "truncated source" }],
      details: { fullOutputPath: piFull, truncation: { truncated: true } },
      maxBytes: 4096,
    });
    assert.equal(readFileSync(result.pointer.runtimePath, "utf8"), original);
    assert.equal(result.pointer.completeness, "complete");
    assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= 4096);
    assert.match(result.content[0].text, /artifacts:\/\/runs\/run-1\/task-1/);
  });

  it("marks an already-truncated result without a physical full-output source as preview-only", () => {
    const pointer = persistToolOutput({
      runId: "run-1",
      taskId: "task-2",
      toolCallId: "call-2",
      toolName: "read",
      content: [{ type: "text", text: "preview" }],
      details: { truncation: { truncated: true } },
    });
    assert.equal(pointer.completeness, "preview_only");
  });

  it("keeps the System Prompt stable while retaining an internal task projection", () => {
    const make = (taskId: string) => ConstraintResolver.resolve({
      role: "developer",
      cwd: process.cwd(),
      taskContract: {
        taskId,
        parentSessionId: "run-1",
        role: "developer",
        goal: `goal-${taskId}`,
      },
    });
    const a = PromptAssembler.assemble(make("a"));
    const b = PromptAssembler.assemble(make("b"));
    assert.equal(a.globalStablePrefix, b.globalStablePrefix);
    assert.equal(a.globalPrefixHash, b.globalPrefixHash);
    assert.notEqual(a.taskStableSuffix, b.taskStableSuffix);
    assert.ok(a.taskSystemPrompt.startsWith(a.globalStablePrefix));
    assert.equal(a.taskSystemPrompt, a.systemPrompt);
    assert.doesNotMatch(a.systemPrompt, /TASK_SCOPED_STABLE_PREFIX/);
  });

  it("uses deterministic evidence ordering and projects latest-only after compaction", async () => {
    persistToolOutput({
      runId: "run-e",
      taskId: "task-e",
      toolCallId: "failed",
      toolName: "bash",
      content: [{ type: "text", text: "failed" }],
      isError: true,
    });
    const index = buildCompactionEvidenceIndex({
      runId: "run-e",
      taskId: "task-e",
      compactionSeq: 1,
      firstKeptEntryId: "entry-2",
    });
    assert.equal(index.failedExecutions[0].toolCallId, "failed");

    const handlers = new Map<string, Function>();
    const state = { compactionCount: 0 };
    createTaskContextExtension({ runId: "run-e", taskId: "task-e", role: "developer", state })
      .factory({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
    await handlers.get("session_compact")!({ compactionEntry: { firstKeptEntryId: "e1" } });
    await handlers.get("session_compact")!({ compactionEntry: { firstKeptEntryId: "e2" } });
    const projected = await handlers.get("context")!({ messages: [] });
    const rendered = projected.messages[0].content[0].text;
    assert.match(rendered, /"compactionSeq":\s*2/);
    assert.doesNotMatch(rendered, /"compactionSeq":\s*1/);
  });

  it("inspects structured summaries without blocking compaction", () => {
    const summary = `<continuation_summary schema="1.2">\n# Task Goal\n# Current State\n# Completed Work\n# Unresolved / Failed Work\n# Failed Attempts / Do Not Retry\n# Key Decisions / Reasons\n# Modified Files\n# Verification State\n# Next Actions\n# Critical Evidence / Artifact Refs\n</continuation_summary>`;
    assert.deepEqual(inspectContinuationSummary(summary), {
      present: true,
      schemaVersion: "1.2",
      byteLength: Buffer.byteLength(summary, "utf8"),
      missingSections: [],
      status: "valid",
    });
    assert.equal(inspectContinuationSummary("# Task Goal").status, "degraded");
    assert.equal(inspectContinuationSummary(summary.replace('schema="1.2"', 'schema="1.1"')).status, "degraded");
    assert.equal(inspectContinuationSummary("x".repeat(64 * 1024)).byteLength, 64 * 1024);
    assert.equal(inspectContinuationSummary("中".repeat(64 * 1024)).status, "degraded");
  });

  it("captures the compaction boundary and latest recovery manifest", async () => {
    const handlers = new Map<string, Function>();
    const state: any = { compactionCount: 0 };
    createTaskContextExtension({ runId: "manifest", taskId: "task", role: "developer", state })
      .factory({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
    await handlers.get("session_before_compact")!({
      preparation: {
        messagesToSummarize: [],
        turnPrefixMessages: [],
        firstKeptEntryId: "kept",
        fileOps: { written: new Set(), edited: new Set(), read: new Set() },
      },
      branchEntries: [{ id: "compacted" }, { id: "kept" }],
    });
    await handlers.get("session_compact")!({
      compactionEntry: {
        id: "compact-1",
        firstKeptEntryId: "kept",
        summary: "# Task Goal",
      },
    });
    assert.equal(state.latestEvidenceIndex.compactionEntryId, "compact-1");
    assert.equal(state.latestEvidenceIndex.boundary.firstCompactedEntryId, "compacted");
    assert.equal(state.latestEvidenceIndex.summaryInspection.status, "degraded");
    assert.deepEqual(readTaskArtifact("manifest", "task", "recovery-manifest.json"), {
      schemaVersion: "1.2",
      compactionSeq: 1,
      compactionEntryId: "compact-1",
      firstCompactedEntryId: "compacted",
      firstKeptEntryId: "kept",
      transcriptRef: "artifacts://runs/manifest/task/transcript.jsonl",
      criticalArtifactRefs: [],
    });
  });

  it("restores only the latest durable recovery manifest after runtime recreation", async () => {
    const handlers = new Map<string, Function>();
    const state: any = { compactionCount: 0 };
    createTaskContextExtension({ runId: "stable-session", taskId: "coordinator", role: "coordinator", state })
      .factory({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
    await handlers.get("session_before_compact")!({
      preparation: { messagesToSummarize: [], turnPrefixMessages: [], firstKeptEntryId: "kept", fileOps: { written: new Set(), edited: new Set(), read: new Set() } },
      branchEntries: [{ id: "old" }, { id: "kept" }],
    });
    await handlers.get("session_compact")!({ compactionEntry: { id: "compact-1", firstKeptEntryId: "kept", summary: "# Task Goal" } });
    const restored: any = { compactionCount: 0 };
    restoreLatestRecoveryManifest(restored, "stable-session", "coordinator");
    assert.equal(restored.compactionCount, 1);
    assert.equal(restored.latestEvidenceIndex.compactionEntryId, "compact-1");
    assert.equal(restored.latestEvidenceIndex.transcriptRef, "artifacts://runs/stable-session/coordinator/transcript.jsonl");
    removeTaskArtifacts("stable-session", "coordinator");
    assert.equal(readTaskArtifact("stable-session", "coordinator", "recovery-manifest.json"), null);
  });

  it("uses a bound session-stable coordinator scope and never falls back to a temporary directory", async () => {
    let scope: { runId: string; taskId: string } | undefined;
    const handlers = new Map<string, Function>();
    createTaskContextExtension({ getScope: () => scope, role: "coordinator", state: { compactionCount: 0 } })
      .factory({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
    await assert.rejects(
      handlers.get("tool_result")!({ toolCallId: "unbound", toolName: "bash", content: [{ type: "text", text: "x" }] }),
      /scope is not bound/,
    );
    scope = { runId: "coordinator-session-1", taskId: "coordinator" };
    await handlers.get("tool_result")!({ toolCallId: "stable", toolName: "bash", content: [{ type: "text", text: "persisted" }] });
    const ref = artifactRefFor(scope.runId, scope.taskId, "tool_outputs/stable_bash.log");
    assert.equal(readArtifactByRef(ref, scope.runId, scope.taskId), "persisted");
    removeTaskArtifacts(scope.runId, scope.taskId);
    const removedPath = resolveArtifactRef(ref);
    assert.ok(removedPath);
    assert.equal(existsSync(removedPath), false);
  });

  it("tracks the real boundary across repeated compactions", async () => {
    const handlers = new Map<string, Function>();
    const state: any = { compactionCount: 0 };
    createTaskContextExtension({ runId: "repeated", taskId: "task", role: "developer", state })
      .factory({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
    const compact = async (branchEntries: any[], firstKeptEntryId: string, compactionId: string) => {
      await handlers.get("session_before_compact")!({
        preparation: {
          messagesToSummarize: [], turnPrefixMessages: [], firstKeptEntryId,
          fileOps: { written: new Set(), edited: new Set(), read: new Set() },
        },
        branchEntries,
      });
      await handlers.get("session_compact")!({
        compactionEntry: { id: compactionId, firstKeptEntryId, summary: "# Task Goal" },
      });
      return state.latestEvidenceIndex.boundary.firstCompactedEntryId;
    };
    assert.equal(await compact([{ id: "a" }, { id: "b" }, { id: "c" }], "b", "compact-1"), "a");
    assert.equal(await compact([
      { id: "a" }, { id: "b" }, { type: "compaction", id: "compact-1", firstKeptEntryId: "b" }, { id: "c" },
    ], "c", "compact-2"), "b");
    assert.equal(await compact([
      { id: "a" }, { id: "b" }, { type: "compaction", id: "compact-1", firstKeptEntryId: "b" },
      { id: "c" }, { type: "compaction", id: "compact-2", firstKeptEntryId: "c" }, { id: "d" },
    ], "d", "compact-3"), "c");
  });

  it("recovers transcript ranges, searches, and artifacts on demand", () => {
    appendShadowTranscript("recovery", "task", { entryId: "e1", message: { text: "first failure" } });
    appendShadowTranscript("recovery", "task", { entryId: "e2", message: { text: "successful fix" } });
    const pointer = writeTaskArtifact("recovery", "task", "tool_outputs/result.log", "complete output");
    const siblingPointer = writeTaskArtifact("recovery", "sibling", "tool_outputs/result.log", "sibling output");
    const otherRunPointer = writeTaskArtifact("other-run", "task", "tool_outputs/result.log", "other run output");
    assert.deepEqual(readTranscriptEntries("recovery", "task", { firstEntryId: "e2" }).map((entry: any) => entry.entryId), ["e2"]);
    assert.equal(searchTranscriptEntries("recovery", "task", "failure").length, 1);
    assert.equal(readArtifactByRef(pointer.artifactRef, "recovery", "task"), '"complete output"\n');
    assert.equal(readArtifactByRef(siblingPointer.artifactRef, "recovery", "task"), null);
    assert.equal(readArtifactByRef(otherRunPointer.artifactRef, "recovery", "task"), null);
    assert.equal(readArtifactByRef("artifacts://runs/../../etc/passwd", "recovery", "task"), null);
  });

  it("fails closed for invalid transcript ranges", () => {
    appendShadowTranscript("range-errors", "task", { entryId: "e1" });
    appendShadowTranscript("range-errors", "task", { entryId: "e2" });
    assert.throws(() => readTranscriptEntries("range-errors", "task", { firstEntryId: "missing" }), /not found/);
    assert.throws(() => readTranscriptEntries("range-errors", "task", { lastEntryId: "missing" }), /not found/);
    assert.throws(() => readTranscriptEntries("range-errors", "task", { firstEntryId: "e2", lastEntryId: "e1" }), /reversed/);
  });

  it("creates an immutable-schema episode and a hard-bounded coordinator view", () => {
    const task: any = {
      taskId: "task-final",
      parentSessionId: "run-final",
      role: "developer",
      taskTitle: "final",
      taskPrompt: "finish",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      changedFiles: Array.from({ length: 500 }, (_, index) => `src/file-${index}.ts`),
      messages: [],
      taskResult: {
        taskId: "task-final",
        role: "developer",
        status: "completed",
        summary: "s".repeat(10_000),
        completedAt: "2026-01-01T00:00:01.000Z",
      },
    };
    const episode = buildTaskEpisodeCard(task)!;
    assert.equal(episode.physical.terminalStatus, "completed");
    assert.equal(episode.semantic?.provenance.source, "task_result");
    const view = buildTaskEpisodeView(episode, { maxTotalBytes: 2048 });
    assert.ok(Buffer.byteLength(view, "utf8") <= 2048);
    assert.match(view, /task-result\.json/);
  });

  it("teaches recovery tools to use recovery_manifest within the current run/task", () => {
    const rendered = renderEvidenceIndex({
      version: "1",
      taskId: "task-e",
      compactionSeq: 1,
      boundary: { firstCompactedEntryId: "c1", firstKeptEntryId: "k1" },
      files: { changed: [], read: [] },
      failedExecutions: [],
      offloadedOutputs: [],
      transcriptRef: "artifacts://runs/run-e/task-e/transcript.jsonl",
    });
    assert.match(rendered, /"firstCompactedEntryId":\s*"c1"/);
    assert.match(rendered, /"firstKeptEntryId":\s*"k1"/);
    assert.doesNotMatch(rendered, /"boundary"/);

    const tools = Object.fromEntries(
      createRecoveryTools(() => ({ runId: "run-e", taskId: "task-e" })).map((tool: any) => [tool.name, tool]),
    );
    assert.match(tools.read_transcript.description, /firstCompactedEntryId/);
    assert.match(tools.read_transcript.description, /firstKeptEntryId/);
    assert.match(tools.read_transcript.description, /not lastEntryId|is not lastEntryId/);
    assert.doesNotMatch(tools.read_transcript.description, /recovery_manifest\.boundary|\.boundary/);
    assert.match(tools.read_artifact.description, /artifacts:\/\//);
    assert.match(tools.read_artifact.description, /current run\/task only/);
    assert.doesNotMatch(tools.read_artifact.description, /由执行角色在其范围内读取/);
    assert.doesNotMatch(
      `${tools.read_transcript.description}\n${tools.read_artifact.description}`,
      /Evidence Index/,
    );
  });

  it("delegates manual compaction to the public Pi authority", async () => {
    let calls = 0;
    const session: any = {
      model: { id: "m" },
      messages: [{ role: "user" }],
      async compact(instructions?: string) {
        calls += 1;
        assert.equal(instructions, "keep exact errors");
        return { summary: "native", firstKeptEntryId: "entry-1" };
      },
    };
    const result = await performSessionCompaction(session, undefined, "keep exact errors");
    assert.equal(calls, 1);
    assert.equal(result.summary, "native");
  });

  it("never treats context pressure alone as stall", () => {
    const state = createStallTelemetryState();
    recordContextPressure(state, 4);
    assert.equal(state.warningCount, 0);
    assert.equal(observeToolExecution(state, { toolName: "read", args: { path: "a" } }).warning, undefined);
    assert.equal(observeToolExecution(state, { toolName: "read", args: { path: "a" } }).warning, undefined);
    assert.match(
      observeToolExecution(state, { toolName: "read", args: { path: "a" } }).warning || "",
      /not aborted/,
    );
  });

  it("resolves only confined artifact references", () => {
    const ref = artifactRefFor("run", "task", "tool_outputs/call.log");
    assert.ok(resolveArtifactRef(ref)?.startsWith(root));
    assert.equal(existsSync(resolveArtifactRef("artifacts://runs/../../etc/passwd") || ""), false);
  });

  it("preserves real Pi bash failure output from streaming metadata before projection", async () => {
    const raw = "ORIGINAL_HEAD\n" + "x".repeat(100_000) + "\nORIGINAL_TAIL";
    const handlers = new Map<string, Function>();
    createTaskContextExtension({ runId: "failure", taskId: "task", role: "developer", state: { compactionCount: 0 } })
      .factory({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
    const bash = createBashTool(root, { operations: { exec: async (_command, _cwd, options) => {
      options.onData(Buffer.from(raw));
      return { exitCode: 7 };
    } } });
    let error: Error | undefined;
    try {
      await bash.execute("failure-call", { command: "fixture" }, undefined, (partialResult) => {
        handlers.get("tool_execution_update")!({ toolCallId: "failure-call", partialResult });
      });
    } catch (e) { error = e as Error; }
    assert.ok(error);
    const result = await handlers.get("tool_result")!({ toolCallId: "failure-call", toolName: "bash",
      content: [{ type: "text", text: error.message }], isError: true, input: { command: "fixture" } });
    const fact = readToolExecutionFacts("failure", "task")[0];
    assert.equal(fact.completeness, "complete");
    assert.equal(fact.exitCode, 7);
    assert.equal(readFileSync(fact.runtimePath!, "utf8"), raw);
    assert.ok(Buffer.byteLength(result.content[0].text) <= 32 * 1024);
    assert.match(result.content[0].text, /Execution failed: Command exited with code 7/);
    assert.equal(result.details.artifactRef, fact.artifactRef);
    assert.equal(result.isError, true);
    // The model can read the projected path with the real built-in read tool.
    const read = await createReadTool(root).execute("recover", { path: fact.runtimePath!, limit: 1 });
    assert.match((read.content[0] as any).text, /ORIGINAL_HEAD/);
  });

  it("never calls a shell error footer complete when its raw metadata is unavailable", () => {
    const pointer = persistToolOutput({ runId: "missing", taskId: "task", toolCallId: "call", toolName: "bash",
      content: [{ type: "text", text: "[Showing lines 1-2 of 300. Full output: /missing/pi.log]\nCommand exited with code 1" }], isError: true });
    assert.equal(pointer.completeness, "preview_only");
  });

  it("indexes split-turn failures and keeps the complete projection within budget", async () => {
    persistToolOutput({ runId: "split", taskId: "task", toolCallId: "split-call", toolName: "bash",
      content: [{ type: "text", text: "error" }], isError: true });
    const handlers = new Map<string, Function>();
    const state: any = { compactionCount: 0 };
    createTaskContextExtension({ runId: "split", taskId: "task", role: "developer", state })
      .factory({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
    await handlers.get("session_before_compact")!({ preparation: {
      messagesToSummarize: [], turnPrefixMessages: [{ role: "toolResult", toolCallId: "split-call", content: [] }],
      firstKeptEntryId: "kept", fileOps: { written: new Set(), edited: new Set(), read: new Set() },
    }, branchEntries: [{ id: "cut" }, { id: "kept" }] });
    await handlers.get("session_compact")!({ compactionEntry: { firstKeptEntryId: "kept" } });
    assert.equal(state.latestEvidenceIndex.failedExecutions[0].toolCallId, "split-call");
    assert.ok(existsSync(state.latestEvidenceIndex.failedExecutions[0].runtimePath));
    const index = buildCompactionEvidenceIndex({ runId: "split", taskId: "task", compactionSeq: 2,
      readFiles: Array.from({ length: 2000 }, (_, i) => `src/中文-${i}.ts`) });
    assert.ok(Buffer.byteLength(renderEvidenceIndex(index)) <= 8192);
    assert.equal(index.failedExecutions.length, 1);
    assert.ok(index.transcriptRuntimePath);
  });

  it("records actual persisted entry IDs across the pre-append message_end boundary", () => {
    const branch: any[] = [{ id: "first", timestamp: "t1", message: { role: "user", content: "one" } }];
    const session = { sessionManager: { getBranch: () => branch } };
    const flush = createShadowTranscriptRecorder("transcript", "task");
    flush(session); // message_end(second), before Pi appends second
    branch.push({ id: "second", timestamp: "t2", message: { role: "assistant", content: "two" } });
    flush(session); // turn_end
    flush(session); // agent_end must not duplicate
    const records = readFileSync(join(getTaskRuntimeDir("transcript", "task"), "transcript.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records.map((r) => [r.entryId, r.message.content]), [["first", "one"], ["second", "two"]]);
  });

  it("deduplicates a durable shadow transcript when the Coordinator runtime is recreated", () => {
    const branch: any[] = [
      { id: "e1", timestamp: "t1", message: { role: "user", content: "one" } },
      { id: "e2", timestamp: "t2", message: { role: "assistant", content: "two" } },
    ];
    const session = { sessionManager: { getBranch: () => branch } };
    createShadowTranscriptRecorder("recreated-transcript", "coordinator")(session);

    // A recreated runtime sees the full durable branch again, plus one new entry.
    branch.push({ id: "e3", timestamp: "t3", message: { role: "assistant", content: "three" } });
    createShadowTranscriptRecorder("recreated-transcript", "coordinator")(session);

    assert.deepEqual(
      readTranscriptEntries("recreated-transcript", "coordinator", { limit: 10 })
        .map((record: any) => record.entryId),
      ["e1", "e2", "e3"],
    );
  });

  it("freezes episode, its referenced result, and subsequent coordinator views together", () => {
    const task: any = { taskId: "frozen", parentSessionId: "episode", role: "developer", status: "completed",
      completedAt: "2026-09-06T00:00:00Z", taskResult: { summary: "original" } };
    const first = persistTaskEpisode(task)!;
    task.taskResult.summary = "later mutation";
    const subsequent = buildTaskEpisodeCard(task)!;
    assert.deepEqual(subsequent, first);
    const result = JSON.parse(readFileSync(resolveArtifactRef(first.physical.artifacts.taskResult.ref)!, "utf8"));
    assert.equal(result.summary, "original");
    assert.doesNotMatch(JSON.stringify(first), /runtimePath/);
    const view = JSON.parse(buildTaskEpisodeView(subsequent));
    assert.ok(existsSync(view.artifactPointers.taskResult.runtimePath));
    const lineage = boundTaskLineage(Array(100).fill(buildTaskEpisodeView(first, { maxTotalBytes: 1500 })));
    assert.ok(lineage.length < 100);
    const assembled = PromptAssembler.assemble(ConstraintResolver.resolve({ role: "developer", cwd: root,
      taskContract: { taskId: "next", parentSessionId: "episode", role: "developer", goal: "next" }, taskLineage: lineage }));
    const injected = JSON.parse(assembled.taskStableSuffix || "{}").bounded_lineage;
    assert.ok(Buffer.byteLength(JSON.stringify(injected, null, 2)) <= 6144);
  });

  it("deletes only the requested task artifacts and rejects escaping symlinks", () => {
    const a = getTaskRuntimeDir("delete", "a");
    const b = getTaskRuntimeDir("delete", "b");
    writeFileSync(join(a, "raw.log"), "sensitive output");
    removeTaskArtifacts("delete", "a");
    assert.equal(existsSync(a), false);
    assert.equal(existsSync(b), true);
    const external = mkdtempSync(join(tmpdir(), "pi-artifact-external-"));
    try {
      writeFileSync(join(external, "keep.txt"), "keep");
      symlinkSync(external, join(b, "escape"));
      assert.equal(resolveArtifactRef(artifactRefFor("delete", "b", "escape/keep.txt")), null);
      removeTaskArtifacts("delete", "b");
      assert.equal(readFileSync(join(external, "keep.txt"), "utf8"), "keep");
    } finally { rmSync(external, { recursive: true, force: true }); }
  });

  it("observes changed results as progress and detects verification repetition and inverse edits", () => {
    const state = createStallTelemetryState();
    for (let i = 0; i < 4; i++) {
      assert.equal(observeToolExecution(state, { toolName: "bash", args: { command: "npm test" },
        isError: true, content: `different failure ${i}` }).warning, undefined);
    }
    for (let i = 0; i < 4; i++) observeToolExecution(state, { toolName: "bash", args: { command: "npm test" },
      isError: true, content: "same failure" });
    assert.equal(state.verificationStagnationSignals, 1);
    assert.equal(state.warningCount, 1);
    for (const [oldText, newText] of [["a", "b"], ["b", "a"], ["a", "b"]]) {
      observeToolExecution(state, { toolName: "edit", args: { path: "file", oldText, newText }, content: "ok" });
    }
    assert.equal(state.codeOscillationSignals, 1);
  });

  it("fingerprints provider instruction roles and tool schemas without hashing changing user history", () => {
    const base = { messages: [{ role: "developer", content: "contract" }, { role: "user", content: "one" }],
      tools: [{ name: "read", parameters: { type: "object" } }] };
    const first = hashRequestPrefix(base);
    assert.equal(first, hashRequestPrefix({ ...base, messages: [...base.messages, { role: "user", content: "two" }] }));
    assert.notEqual(first, hashRequestPrefix({ ...base, tools: [{ name: "write" }] }));
    assert.notEqual(first, hashRequestPrefix({ ...base, messages: [{ role: "developer", content: "changed" }] }));
    assert.equal(hashRequestPrefix({ input: [{ role: "user", content: "only dynamic" }] }), undefined);
  });
});
