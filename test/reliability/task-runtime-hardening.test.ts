import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// helpers.ts sets PI_CODING_AGENT_DIR before server modules are evaluated.
import "./helpers.ts";
import { armTimeout } from "../../server/subagent/task-lifecycle.ts";
import type { SubagentInstance } from "../../server/subagent/types.ts";

/**
 * Regression guard for two verified robustness defects:
 *  - H2: fire-and-forget `void session.steer()/followUp()` turning rejections
 *        into unhandledRejection.
 *  - H3: the max_tokens auto-continuation never re-arming the wall-clock
 *        watchdog, leaving a "zombie" running task / unreleased worktree.
 *
 * Structural assertions pin the composition; the armTimeout cases exercise the
 * real shared helper.
 */

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const commandHandler = readSource("../../server/ws/command-handler.ts");
const reportDispatcher = readSource("../../server/subagent/report-dispatcher.ts");
const taskTerminal = readSource("../../server/subagent/task-terminal.ts");
const taskLifecycle = readSource("../../server/subagent/task-lifecycle.ts");
const subagentTypes = readSource("../../server/subagent/types.ts");

describe("H2: queued steer/followUp rejections are captured", () => {
  it("no bare `void session.steer()` / `void session.followUp()` remains", () => {
    for (const [name, src] of [
      ["command-handler", commandHandler],
      ["report-dispatcher", reportDispatcher],
    ] as const) {
      assert.ok(!/void\s+session\.steer\s*\(/.test(src), `${name} still fires void session.steer`);
      assert.ok(!/void\s+session\.followUp\s*\(/.test(src), `${name} still fires void session.followUp`);
    }
  });

  it("routes queued dispatches through a rejection-capturing helper", () => {
    assert.ok(commandHandler.includes("function dispatchQueueItem("), "command-handler helper missing");
    assert.ok(reportDispatcher.includes("function dispatchQueueItem("), "report-dispatcher helper missing");
    assert.ok(commandHandler.includes("op.catch("), "command-handler must .catch the dispatch promise");
    assert.ok(reportDispatcher.includes("op.catch("), "report-dispatcher must .catch the dispatch promise");
    assert.ok(
      commandHandler.includes("dispatchQueueItem(session, item, entry.id)"),
      "command-handler queued loops must use the helper",
    );
    assert.ok(
      commandHandler.includes("await session.abort();"),
      "interject-now must abort the running turn before resuming",
    );
    assert.ok(
      !commandHandler.includes("dispatchQueueItem(session, item, entry.id, true)"),
      "interject-now must no longer force the removed steer path",
    );
    assert.ok(
      reportDispatcher.includes("dispatchQueueItem(session, item, sessionId)"),
      "report-dispatcher re-dispatch loop must use the helper",
    );
  });

  it("still performs the steer/followUp dispatch (helper does not drop it)", () => {
    assert.ok(commandHandler.includes("session.steer(item.text)"));
    assert.ok(commandHandler.includes("session.followUp(item.text)"));
    assert.ok(reportDispatcher.includes("session.steer(item.text)"));
    assert.ok(reportDispatcher.includes("session.followUp(item.text)"));
  });
});

describe("H3: max_tokens continuation re-arms the wall-clock watchdog", () => {
  it("persists timeoutMs on SubagentInstance and arms via shared armTimeout", () => {
    assert.ok(subagentTypes.includes("timeoutMs?: number;"), "timeoutMs must be persisted on SubagentInstance");
    assert.ok(taskLifecycle.includes("export function armTimeout("), "armTimeout must be exported by task-lifecycle");
    assert.ok(
      taskLifecycle.includes("instance.timeoutMs = options.executionOptions.timeoutMs"),
      "startTaskExecution must persist the budget onto the instance",
    );
    assert.ok(/armTimeout\(instance, mgr\)/.test(taskLifecycle), "startTaskExecution must arm via armTimeout");
  });

  it("re-arms after continuation dispatch and before the failure catch", () => {
    const continuationIdx = taskTerminal.indexOf("const sendContinuation =");
    const armIdx = taskTerminal.indexOf("armTimeout(instance, mgr);", continuationIdx);
    const catchIdx = taskTerminal.indexOf("sendContinuation.catch(", continuationIdx);

    assert.ok(continuationIdx >= 0, "max_tokens continuation dispatch must exist");
    assert.ok(armIdx > continuationIdx, "watchdog must be re-armed after continuation dispatch");
    assert.ok(catchIdx > armIdx, "watchdog must be armed before the rejection catch");
    assert.ok(
      taskTerminal.includes('import { armTimeout } from "./task-lifecycle.ts";'),
      "task-terminal must reuse the shared armTimeout",
    );
  });
});

describe("armTimeout behavior", () => {
  function makeInstance(timeoutMs?: number): SubagentInstance {
    return {
      task: { taskId: "task-timeout-test" },
      timeoutMs,
    } as unknown as SubagentInstance;
  }

  it("arms a watchdog that aborts with source=timeout", async () => {
    const calls: Array<{ taskId: string; options?: { source?: string } }> = [];
    const mgr = {
      abort: async (taskId: string, options?: { source?: string }) => {
        calls.push({ taskId, options });
        return true;
      },
    } as any;

    const instance = makeInstance(30);
    try {
      armTimeout(instance, mgr);
      assert.ok(instance.timeoutTimer, "timer must be armed");

      const started = Date.now();
      while (calls.length === 0) {
        if (Date.now() - started > 2000) throw new Error("armTimeout watchdog did not fire");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.equal(calls[0].taskId, "task-timeout-test");
      assert.equal(calls[0].options?.source, "timeout");
    } finally {
      if (instance.timeoutTimer) clearTimeout(instance.timeoutTimer);
    }
  });

  it("does not arm for absent or non-positive timeoutMs", () => {
    const mgr = { abort: async () => true } as any;
    for (const value of [undefined, 0, -1]) {
      const instance = makeInstance(value);
      armTimeout(instance, mgr);
      assert.equal(instance.timeoutTimer, undefined, `must not arm for timeoutMs=${String(value)}`);
    }
  });

  it("re-arming replaces the previous timer", () => {
    const mgr = { abort: async () => true } as any;
    const instance = makeInstance(5000);
    try {
      armTimeout(instance, mgr);
      const first = instance.timeoutTimer;
      armTimeout(instance, mgr);
      assert.ok(first, "first arm must produce a timer");
      assert.notEqual(instance.timeoutTimer, first, "armTimeout must replace the stale timer");
    } finally {
      if (instance.timeoutTimer) clearTimeout(instance.timeoutTimer);
    }
  });
});
