import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// The stall window is read once at module load from the env, so pin a tiny
// value before importing the module under test.
process.env.PI_SUBAGENT_STALL_TIMEOUT_MS = "40";

const { bumpStallWatchdog, SUBAGENT_STALL_TIMEOUT_MS } = await import(
  "../../server/subagent/task-lifecycle.ts"
);

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AbortCall {
  taskId: string;
  source?: string;
}

function makeInstance(status = "running"): any {
  return { task: { taskId: "t1", status }, stallTimer: undefined };
}

function makeMgr(getTools: () => string[] = () => []): {
  mgr: any;
  aborts: AbortCall[];
} {
  const aborts: AbortCall[] = [];
  const mgr = {
    listActiveToolNames: () => getTools(),
    abort: async (taskId: string, opts?: { source?: string }) => {
      aborts.push({ taskId, source: opts?.source });
      return true;
    },
  };
  return { mgr, aborts };
}

/** Disarm a lingering timer so it can't fire into a later test. */
function disarm(instance: any, mgr: any) {
  instance.task.status = "aborted";
  bumpStallWatchdog(instance, mgr);
}

describe("subagent inactivity (stall) watchdog", () => {
  before(() => {
    assert.equal(SUBAGENT_STALL_TIMEOUT_MS, 40, "env override should take effect");
  });

  it("aborts a running task after the idle window with no activity", async () => {
    const inst = makeInstance();
    const { mgr, aborts } = makeMgr();
    bumpStallWatchdog(inst, mgr);
    await delay(90);
    assert.equal(aborts.length, 1, "should abort once when idle past the window");
    assert.equal(aborts[0]?.source, "timeout");
  });

  it("resets on every bump so a busy task is never killed", async () => {
    const inst = makeInstance();
    const { mgr, aborts } = makeMgr();
    bumpStallWatchdog(inst, mgr);
    // Keep bumping within the window: never idle for a full 40ms stretch.
    for (let i = 0; i < 4; i++) {
      await delay(20);
      bumpStallWatchdog(inst, mgr);
    }
    assert.equal(aborts.length, 0, "continuous activity must not trip the watchdog");
    // Then go quiet — it fires.
    await delay(90);
    assert.equal(aborts.length, 1);
  });

  it("re-arms instead of aborting while a tool is still executing", async () => {
    const inst = makeInstance();
    let tools = ["bash"];
    const { mgr, aborts } = makeMgr(() => tools);
    bumpStallWatchdog(inst, mgr);
    await delay(90); // fires, sees an active tool, re-arms
    assert.equal(aborts.length, 0, "a long-running tool is legitimate silence");
    tools = []; // tool finished; next fire has nothing in flight
    await delay(90);
    assert.equal(aborts.length, 1);
  });

  it("does not arm for an already-terminal task", async () => {
    const inst = makeInstance("completed");
    const { mgr, aborts } = makeMgr();
    bumpStallWatchdog(inst, mgr);
    assert.equal(inst.stallTimer, undefined, "no timer for a non-running task");
    await delay(90);
    assert.equal(aborts.length, 0);
  });

  it("a fire that lands after the task went terminal is a harmless no-op", async () => {
    const inst = makeInstance();
    const { mgr, aborts } = makeMgr();
    bumpStallWatchdog(inst, mgr);
    // Task completes elsewhere before the timer fires.
    inst.task.status = "completed";
    await delay(90);
    assert.equal(aborts.length, 0, "self-guard suppresses the stale fire");
    disarm(inst, mgr);
  });
});
