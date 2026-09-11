import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const testAgentDir = mkdtempSync(join(tmpdir(), "pi-session-running-test-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

import { CoordinatorStateTracker } from "../server/coordinator/coordinator-state.ts";
import { handleSessionsRoutes } from "../server/http/routes-sessions.ts";
import { SessionRegistry } from "../server/session/session-registry.ts";
import { SubagentManager, subagentTasks } from "../server/subagent-manager.ts";
import type { UISubagentTask } from "../shared/protocol.ts";

function readSource(relative: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
  } catch {
    return "";
  }
}

function makeTask(overrides: Partial<UISubagentTask> & { taskId: string; parentSessionId: string }): UISubagentTask {
  return {
    role: "developer",
    taskTitle: "t",
    taskPrompt: "p",
    status: "running",
    createdAt: new Date().toISOString(),
    ...overrides,
  } as UISubagentTask;
}

describe("Session running-state detection", () => {
  const touched: string[] = [];
  const reset = () => {
    for (const id of touched) subagentTasks.delete(id);
    touched.length = 0;
  };
  after(() => {
    reset();
    try {
      rmSync(testAgentDir, { recursive: true, force: true });
    } catch {}
  });

  it("CoordinatorStateTracker.activeSessionIds only reports in-flight turns", () => {
    const tracker = new CoordinatorStateTracker();
    assert.deepEqual(tracker.activeSessionIds(), []);
    tracker.turnStarted("s1");
    tracker.turnStarted("s2");
    tracker.turnEnded("s1");
    assert.deepEqual(tracker.activeSessionIds().sort(), ["s2"]);
  });

  it("SubagentManager.getActiveParentSessionIds reports non-terminal tasks, streaming runtimes and coordinator turns", () => {
    reset();
    const manager = new SubagentManager({} as any);

    const runningId = "sess-running";
    const terminalId = "sess-terminal";
    const coordinatorId = "sess-coordinator";
    subagentTasks.set(
      "t-running",
      { task: makeTask({ taskId: "t-running", parentSessionId: runningId, status: "running" }) } as any,
    );
    subagentTasks.set(
      "t-blocked",
      { task: makeTask({ taskId: "t-blocked", parentSessionId: runningId, status: "blocked" }) } as any,
    );
    subagentTasks.set(
      "t-completed",
      { task: makeTask({ taskId: "t-completed", parentSessionId: terminalId, status: "completed" }) } as any,
    );
    subagentTasks.set(
      "t-streaming",
      {
        task: makeTask({ taskId: "t-streaming", parentSessionId: terminalId, status: "completed" }),
        runtime: { session: { isStreaming: true } },
      } as any,
    );
    touched.push("t-running", "t-blocked", "t-completed", "t-streaming");

    manager.notifyCoordinatorTurnStart(coordinatorId);

    const ids = manager.getActiveParentSessionIds().sort();
    assert.deepEqual(ids, [coordinatorId, runningId, terminalId].sort());
    // terminal + non-streaming parent must NOT be reported
    assert.ok(!ids.includes("sess-idle"));
  });

  it("SubagentManager.getActiveParentSessionIds ignores fully-terminal parents", () => {
    reset();
    const manager = new SubagentManager({} as any);
    subagentTasks.set(
      "t-done",
      { task: makeTask({ taskId: "t-done", parentSessionId: "sess-done", status: "completed" }) } as any,
    );
    touched.push("t-done");
    assert.deepEqual(manager.getActiveParentSessionIds(), []);
  });

  function makeRes() {
    let status = 0;
    const chunks: string[] = [];
    const res: any = {
      writeHead(code: number) {
        status = code;
        return res;
      },
      end(chunk?: string) {
        if (chunk) chunks.push(chunk);
      },
    };
    return {
      res,
      get status() {
        return status;
      },
      get body() {
        return chunks.join("");
      },
    };
  }

  function makeReq(body: unknown, method = "POST"): any {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as any;
    req.method = method;
    return req;
  }

  it("GET /api/sessions/running reports streaming parents and active subagent parents", async () => {
    reset();
    const registry = new SessionRegistry();
    registry.set("live", { id: "live", runtime: { session: { isStreaming: true } }, clients: new Set() } as any);
    registry.set("idle", { id: "idle", runtime: { session: { isStreaming: false } }, clients: new Set() } as any);
    subagentTasks.set(
      "t-busy",
      { task: makeTask({ taskId: "t-busy", parentSessionId: "subagent-parent", status: "running" }) } as any,
    );
    touched.push("t-busy");

    const manager = new SubagentManager({} as any);
    const ctx: any = { sessionRegistry: registry, subagentManager: manager, agentCwd: testAgentDir };
    const out = makeRes();
    const handled = await handleSessionsRoutes(
      new URL("http://localhost/api/sessions/running"),
      makeReq({}, "GET"),
      out.res,
      ctx,
    );
    assert.equal(handled, true);
    assert.equal(out.status, 200);
    assert.deepEqual(JSON.parse(out.body).sessionIds.sort(), ["live", "subagent-parent"]);
  });

  it("POST /api/sessions/batch-delete returns a per-session summary and is idempotent for missing sessions", async () => {
    reset();
    const registry = new SessionRegistry();
    const manager = new SubagentManager({} as any);
    const ctx: any = { sessionRegistry: registry, subagentManager: manager, agentCwd: testAgentDir };
    const out = makeRes();
    const handled = await handleSessionsRoutes(
      new URL("http://localhost/api/sessions/batch-delete"),
      makeReq({ sessions: [{ id: "missing-1", cwd: testAgentDir }, { id: "missing-2", cwd: testAgentDir }] }),
      out.res,
      ctx,
    );
    assert.equal(handled, true);
    assert.equal(out.status, 200);
    const json = JSON.parse(out.body);
    assert.equal(json.ok, true);
    assert.equal(json.deletedCount, 2);
    assert.deepEqual(json.failedSessionIds, []);
    assert.deepEqual(json.deletedSessionIds.sort(), ["missing-1", "missing-2"]);
  });

  it("POST /api/sessions/batch-delete rejects malformed bodies", async () => {
    reset();
    const ctx: any = {
      sessionRegistry: new SessionRegistry(),
      subagentManager: new SubagentManager({} as any),
      agentCwd: testAgentDir,
    };
    const out = makeRes();
    const req = Readable.from([Buffer.from("{not-json")]) as any;
    req.method = "POST";
    const handled = await handleSessionsRoutes(
      new URL("http://localhost/api/sessions/batch-delete"),
      req,
      out.res,
      ctx,
    );
    assert.equal(handled, true);
    assert.equal(out.status, 400);
  });
});

describe("Batch session deletion + running spinner wiring", () => {
  const routesSessions = readSource("../server/http/routes-sessions.ts");
  const api = readSource("../src/lib/api.ts");
  const drawer = readSource("../src/components/SessionsDrawer.tsx");

  it("exposes GET /api/sessions/running", () => {
    assert.ok(routesSessions.includes('"/api/sessions/running"'), "running endpoint must exist");
    assert.ok(routesSessions.includes("getActiveParentSessionIds"), "running endpoint must consult subagent activity");
  });

  it("exposes POST /api/sessions/batch-delete iterating cleanupDeletedSessionResources", () => {
    assert.ok(routesSessions.includes('"/api/sessions/batch-delete"'), "batch-delete endpoint must exist");
    const idx = routesSessions.indexOf('"/api/sessions/batch-delete"');
    const body = routesSessions.slice(idx, idx + 1600);
    assert.ok(body.includes("cleanupDeletedSessionResources"), "batch-delete must reuse the deletion transaction");
    assert.ok(body.includes("deletedSessionIds"), "batch-delete must report per-session results");
    assert.ok(body.includes("failedSessionIds"), "batch-delete must report failures");
  });

  it("client exposes deleteSessionsBatchApi and useRunningSessions", () => {
    assert.ok(api.includes("deleteSessionsBatchApi"), "api must expose batch delete");
    assert.ok(api.includes('"/api/sessions/batch-delete"'), "api must hit the batch endpoint");
    assert.ok(api.includes("useRunningSessions"), "api must expose running sessions hook");
    assert.ok(api.includes('"/api/sessions/running"'), "hook must hit the running endpoint");
  });

  it("drawer renders a spinner for busy sessions and a batch selection mode", () => {
    assert.ok(drawer.includes("SpinnerIcon"), "spinner component must exist");
    assert.ok(drawer.includes("animate-spin"), "spinner must animate");
    assert.ok(drawer.includes("runningIdSet"), "drawer must derive running session ids");
    assert.ok(drawer.includes("useRunningSessions"), "drawer must poll running sessions");
    assert.ok(drawer.includes("SelectCheckbox"), "drawer must render selection checkboxes");
    assert.ok(drawer.includes("handleBatchDelete"), "drawer must implement batch delete");
    assert.ok(drawer.includes("deleteSessionsBatchApi"), "drawer must call batch delete api");
  });
});
