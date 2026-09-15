import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// helpers.ts sets PI_CODING_AGENT_DIR before any server module is evaluated.
import "./reliability/helpers.ts";
import { bindCoordinatorSessionRuntime } from "../server/ws/session-binding.ts";
import { readTranscriptEntries } from "../server/runtime-artifacts.ts";
import type { SessionEntry } from "../server/session/session-registry.ts";

/**
 * Regression guard for the set_session_cwd runtime-replacement defect:
 * replacing entry.runtime must re-run the same coordinator bindings as
 * createEntry (recovery scope + role + turn recorder + shadow transcript),
 * otherwise turn recording / shadow transcripts silently stop after a cwd
 * switch and the new session's recovery scope stays unbound.
 *
 * The helper is exercised behaviorally with a mock session; the wiring of both
 * call sites (createEntry and set_session_cwd) is pinned structurally.
 */

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const serverIndex = readSource("../server/index.ts");
const commandHandler = readSource("../server/ws/command-handler.ts");
const sessionBinding = readSource("../server/ws/session-binding.ts");

function createMockRuntimeSession() {
  const boundScopes: Array<{ runId: string; taskId: string }> = [];
  const subscribers: Array<(event: any) => void> = [];
  const branch: any[] = [];
  const session: any = {
    model: undefined,
    agent: { streamFn: async () => ({}) },
    sessionManager: { getBranch: () => branch },
    subscribe: (fn: (event: any) => void) => {
      subscribers.push(fn);
      return () => {};
    },
    __bindRecoveryScope: (scope: { runId: string; taskId: string }) => {
      boundScopes.push(scope);
    },
  };
  return { session, boundScopes, subscribers, branch };
}

function createEntry(session: any, id: string): SessionEntry {
  return {
    id,
    runtime: { session } as any,
    clients: new Set(),
    lastActive: Date.now(),
    published: true,
    activeRole: "coordinator",
    cwd: "/tmp",
    isGitRepo: false,
    queuedMessages: [],
  };
}

describe("bindCoordinatorSessionRuntime behavior", () => {
  it("binds the recovery scope, installs the turn recorder and subscribes the shadow transcript", () => {
    const { session, boundScopes, subscribers } = createMockRuntimeSession();
    const entry = createEntry(session, "sess-cwd-rebind-behavior-1");

    bindCoordinatorSessionRuntime(entry);

    assert.deepEqual(boundScopes, [{ runId: entry.id, taskId: "coordinator" }]);
    assert.equal((session.agent as any).__turnRecorderInstalled, true, "turn recorder must be installed");
    assert.equal(subscribers.length, 1, "shadow transcript must subscribe exactly once");
  });

  it("flushes the shadow transcript only on the terminal/compaction events", () => {
    const { session, subscribers, branch } = createMockRuntimeSession();
    const entry = createEntry(session, "sess-cwd-rebind-behavior-2");

    bindCoordinatorSessionRuntime(entry);

    // A non-flush event must not persist anything.
    subscribers[0]({ type: "message_start" });
    assert.equal(readTranscriptEntries(entry.id, "coordinator").length, 0, "message_start must not flush");

    branch.push({ id: "branch-entry-1", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant" } });
    subscribers[0]({ type: "message_end" });

    const persisted = readTranscriptEntries(entry.id, "coordinator") as Array<{ entryId?: string }>;
    assert.equal(persisted.length, 1, "message_end must flush the shadow transcript");
    assert.equal(persisted[0].entryId, "branch-entry-1");
  });

  it("fails closed when the new session has no recovery-scope binder", () => {
    const { session } = createMockRuntimeSession();
    delete session.__bindRecoveryScope;
    const entry = createEntry(session, "sess-cwd-rebind-behavior-3");

    assert.throws(
      () => bindCoordinatorSessionRuntime(entry),
      /Coordinator recovery scope binder is unavailable/,
    );
  });
});

describe("coordinator runtime binding is shared by createEntry and set_session_cwd", () => {
  it("exposes a single reusable helper that owns the runtime-scoped bindings", () => {
    assert.ok(
      sessionBinding.includes("export function bindCoordinatorSessionRuntime("),
      "session-binding must export bindCoordinatorSessionRuntime",
    );
    for (const needle of [
      "__bindRecoveryScope",
      "applyRoleToSession",
      "installTurnRecorderOnSession",
      "createShadowTranscriptRecorder",
      "subscribe(",
    ]) {
      assert.ok(
        sessionBinding.includes(needle),
        `bindCoordinatorSessionRuntime must perform ${needle}`,
      );
    }
    // bindSessionEvents owns entry.unsubscribe; it must stay out of the helper
    // to avoid double-subscribing transport events.
    const helperStart = sessionBinding.indexOf("export function bindCoordinatorSessionRuntime(");
    const helperEnd = sessionBinding.indexOf("export function bindSessionEvents(");
    const helperBody = sessionBinding.slice(helperStart, helperEnd);
    assert.ok(
      !helperBody.includes("bindSessionEvents("),
      "helper must not subscribe bindSessionEvents",
    );
  });

  it("createEntry uses the helper instead of inlining the bindings", () => {
    assert.ok(serverIndex.includes("bindCoordinatorSessionRuntime(entry)"), "createEntry must call the helper");
    assert.ok(
      !serverIndex.includes("installTurnRecorderOnSession("),
      "createEntry must not inline installTurnRecorderOnSession",
    );
    assert.ok(
      !serverIndex.includes("createShadowTranscriptRecorder("),
      "createEntry must not inline createShadowTranscriptRecorder",
    );

    const helperIdx = serverIndex.indexOf("bindCoordinatorSessionRuntime(entry)");
    const bindEventsIdx = serverIndex.indexOf("bindSessionEvents(entry, subagentManager, () => modelRuntime)");
    assert.ok(helperIdx >= 0 && bindEventsIdx > helperIdx, "runtime bindings must precede bindSessionEvents");
  });

  it("set_session_cwd rebinds on the new session after unsubscribe and before bindSessionEvents", () => {
    const cwdCaseIdx = commandHandler.indexOf('case "set_session_cwd":');
    const unsubscribeIdx = commandHandler.indexOf("entry.unsubscribe?.();", cwdCaseIdx);
    const helperIdx = commandHandler.indexOf("bindCoordinatorSessionRuntime(entry)", cwdCaseIdx);
    const bindEventsIdx = commandHandler.indexOf(
      "bindSessionEvents(entry, subagentManager, ctx.getModelRuntime)",
      cwdCaseIdx,
    );

    assert.ok(cwdCaseIdx >= 0, "set_session_cwd case must exist");
    assert.ok(unsubscribeIdx > cwdCaseIdx, "set_session_cwd must still clear entry.unsubscribe");
    assert.ok(helperIdx > unsubscribeIdx, "rebind must run after the old subscription is cleared");
    assert.ok(bindEventsIdx > helperIdx, "bindSessionEvents must run after the runtime rebind");

    const cwdCase = commandHandler.slice(cwdCaseIdx);
    assert.ok(
      cwdCase.includes("bindCoordinatorSessionRuntime(entry)"),
      "set_session_cwd must rebind the coordinator runtime hooks",
    );
    assert.equal(
      (cwdCase.match(/bindSessionEvents\(/g) ?? []).length,
      1,
      "set_session_cwd must subscribe transport events exactly once",
    );
  });
});
