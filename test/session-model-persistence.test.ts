import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { handleCommand } from "../server/ws/command-handler.ts";
import { bindSessionEvents } from "../server/ws/session-binding.ts";
import { SessionRegistry, type SessionEntry } from "../server/session/session-registry.ts";
import { SubagentManager } from "../server/subagent-manager.ts";
import type { ServerEvent } from "../shared/protocol.ts";
import { resolvePinnedStoredValue } from "../src/lib/sidebar.ts";

/**
 * Regression suite for:
 *  - Main-session model / thinking-level persistence (set_model & set_thinking_level must persist to global defaults).
 *  - Sidebar default state: missing storage key => pinned (open), explicit "0" => collapsed.
 */

interface RecordedCall {
  model?: any;
  level?: any;
  options?: any;
}

function createMockSession() {
  const setModelCalls: RecordedCall[] = [];
  const setThinkingCalls: RecordedCall[] = [];

  const session: any = {
    messages: [],
    isStreaming: false,
    sessionFile: "/tmp/fake-session_persist-1.jsonl",
    subscribe: () => () => {},
    prompt: async () => ({ ok: true }),
    followUp: async () => {},
    steer: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => {},
    setModel: async (model: any, options?: any) => {
      setModelCalls.push({ model, options });
    },
    setThinkingLevel: (level: any, options?: any) => {
      setThinkingCalls.push({ level, options });
    },
    model: { provider: "mock", id: "mock-model" },
    setModelCalls,
    setThinkingCalls,
  };
  return session;
}

function createTestEntry(session: any): SessionEntry {
  return {
    id: "test-persist-1",
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

describe("Main session model & thinking persistence", () => {
  let session: ReturnType<typeof createMockSession>;
  let entry: SessionEntry;
  let registry: SessionRegistry;
  let subagentManager: SubagentManager;
  let receivedEvents: ServerEvent[];
  let fakeWs: any;
  let ctx: any;
  const model = { provider: "mock-prov", id: "model-alpha", name: "Model Alpha" };

  beforeEach(() => {
    session = createMockSession();
    entry = createTestEntry(session);
    registry = new SessionRegistry();
    registry.set(entry.id, entry);
    subagentManager = new SubagentManager();
    bindSessionEvents(entry, subagentManager);

    ctx = {
      sessionRegistry: registry,
      subagentManager,
      getModelRuntime: () => ({ getModel: (provider: string, id: string) => (provider === "mock-prov" && id === "model-alpha" ? model : null) }),
      homeDir: "/tmp",
      agentCwd: "/tmp",
      createRuntime: {} as any,
    };

    receivedEvents = [];
    fakeWs = {
      readyState: 1,
      OPEN: 1,
      send: (data: string) => {
        receivedEvents.push(JSON.parse(data));
      },
    };
    entry.clients.add(fakeWs);
    registry.bindWs(fakeWs, entry);
  });

  it("persists main-session model selection with { persist: true }", async () => {
    await handleCommand({ type: "set_model", provider: "mock-prov", id: "model-alpha" }, fakeWs, ctx);

    assert.equal(session.setModelCalls.length, 1);
    assert.equal(session.setModelCalls[0].model, model);
    assert.deepEqual(session.setModelCalls[0].options, { persist: true });
  });

  it("does not persist when the requested model does not exist", async () => {
    await handleCommand({ type: "set_model", provider: "mock-prov", id: "missing-model" }, fakeWs, ctx);

    assert.equal(session.setModelCalls.length, 0);
    const errors = receivedEvents.filter((e) => e.type === "error") as any[];
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Model not found/);
  });

  it("persists main-session thinking level with { persist: true }", async () => {
    await handleCommand({ type: "set_thinking_level", level: "high" as any }, fakeWs, ctx);

    assert.equal(session.setThinkingCalls.length, 1);
    assert.equal(session.setThinkingCalls[0].level, "high");
    assert.deepEqual(session.setThinkingCalls[0].options, { persist: true });
  });
});

describe("Sidebar pinned default state", () => {
  it("treats a missing storage key as pinned (open)", () => {
    assert.equal(resolvePinnedStoredValue(null), true);
  });

  it("treats an explicit '0' as collapsed", () => {
    assert.equal(resolvePinnedStoredValue("0"), false);
  });

  it("treats an explicit '1' as pinned", () => {
    assert.equal(resolvePinnedStoredValue("1"), true);
  });
});
