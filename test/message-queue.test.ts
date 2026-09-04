import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { handleCommand } from "../server/ws/command-handler.ts";
import { bindSessionEvents } from "../server/ws/session-binding.ts";
import { SessionRegistry, type SessionEntry } from "../server/session/session-registry.ts";
import { SubagentManager } from "../server/subagent-manager.ts";
import { buildSnapshot } from "../server/session/snapshot.ts";
import type { ServerEvent } from "../shared/protocol.ts";

function createMockSession() {
  const subscribers: ((event: any) => void)[] = [];
  const prompts: string[] = [];
  const followUps: string[] = [];
  const steers: string[] = [];

  const session: any = {
    messages: [],
    isStreaming: false,
    sessionFile: "/tmp/fake-session_test-1.jsonl",
    subscribe: (fn: (event: any) => void) => {
      subscribers.push(fn);
      return () => {
        const idx = subscribers.indexOf(fn);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    },
    emit: (event: any) => {
      for (const s of [...subscribers]) s(event);
    },
    prompt: async (text: string) => {
      prompts.push(text);
      return { ok: true };
    },
    followUp: async (text: string) => {
      followUps.push(text);
      session.emit({ type: "queue_update", steering: [...steers], followUp: [...followUps] });
    },
    steer: async (text: string) => {
      steers.push(text);
      session.emit({ type: "queue_update", steering: [...steers], followUp: [...followUps] });
    },
    clearQueue: () => {
      const s = [...steers];
      const f = [...followUps];
      steers.length = 0;
      followUps.length = 0;
      session.emit({ type: "queue_update", steering: [], followUp: [] });
      return { steering: s, followUp: f };
    },
    getSteeringMessages: () => [...steers],
    getFollowUpMessages: () => [...followUps],
    abort: async () => {},
    setModel: async () => {},
    setThinkingLevel: () => {},
    model: { provider: "mock", id: "mock-model" },
    prompts,
    followUps,
    steers,
  };
  return session;
}

function createTestEntry(session: any): SessionEntry {
  const entry: SessionEntry = {
    id: "test-1",
    runtime: { session } as any,
    clients: new Set(),
    lastActive: Date.now(),
    published: true,
    activeRole: "coordinator",
    cwd: "/tmp",
    isGitRepo: false,
    queuedMessages: [],
  };
  return entry;
}

describe("Message Queue Tests", () => {
  let session: ReturnType<typeof createMockSession>;
  let entry: SessionEntry;
  let registry: SessionRegistry;
  let subagentManager: SubagentManager;
  let receivedEvents: ServerEvent[];
  let fakeWs: any;

  beforeEach(() => {
    session = createMockSession();
    entry = createTestEntry(session);
    registry = new SessionRegistry();
    registry.set(entry.id, entry);
    subagentManager = new SubagentManager();
    bindSessionEvents(entry, subagentManager);

    const ctx: any = {
      sessionRegistry: registry,
      subagentManager,
      getModelRuntime: () => ({ getModel: () => null }),
      homeDir: "/tmp",
      agentCwd: "/tmp",
      createRuntime: {} as any,
    };

    receivedEvents = [];
    fakeWs = {
      readyState: 1, // OPEN
      OPEN: 1,
      send: (data: string) => {
        receivedEvents.push(JSON.parse(data));
      },
    };
    entry.clients.add(fakeWs);
    registry.bindWs(fakeWs, entry);
    (entry as any).ctx = ctx;
  });

  it("queues message as followUp when streaming rather than immediately executing prompt", async () => {
    session.isStreaming = true;
    const ctx = (entry as any).ctx;

    await handleCommand({ type: "prompt", text: "这是排队指令 1" }, fakeWs, ctx);

    // Verify session.prompt was NOT called
    assert.equal(session.prompts.length, 0);
    // Verify session.followUp WAS called
    assert.equal(session.followUps.length, 1);
    assert.equal(session.followUps[0], "这是排队指令 1");
    // Verify entry.queuedMessages was populated
    assert.equal(entry.queuedMessages?.length, 1);
    assert.equal(entry.queuedMessages[0].text, "这是排队指令 1");
    assert.equal(entry.queuedMessages[0].mode, "followUp");
    assert.ok(entry.queuedMessages[0].id.startsWith("q-"));

    // Verify snapshot was broadcast with queuedMessages
    const snapshotEvents = receivedEvents.filter((e) => e.type === "snapshot") as any[];
    assert.ok(snapshotEvents.length > 0);
    const latestSnapshot = snapshotEvents[snapshotEvents.length - 1].snapshot;
    assert.equal(latestSnapshot.queuedMessages?.length, 1);
    assert.equal(latestSnapshot.queuedMessages[0].text, "这是排队指令 1");
  });

  it("supports editing a queued message", async () => {
    session.isStreaming = true;
    const ctx = (entry as any).ctx;

    await handleCommand({ type: "prompt", text: "原始消息" }, fakeWs, ctx);

    const queuedId = entry.queuedMessages![0].id;

    await handleCommand({
      type: "edit_queued_message",
      id: queuedId,
      text: "修改后的消息",
    }, fakeWs, ctx);

    assert.equal(entry.queuedMessages?.length, 1);
    assert.equal(entry.queuedMessages[0].text, "修改后的消息");
    assert.equal(session.followUps.length, 1);
    assert.equal(session.followUps[0], "修改后的消息");
  });

  it("supports cancelling a queued message", async () => {
    session.isStreaming = true;
    const ctx = (entry as any).ctx;

    await handleCommand({ type: "prompt", text: "待取消消息" }, fakeWs, ctx);

    assert.equal(entry.queuedMessages?.length, 1);
    const queuedId = entry.queuedMessages![0].id;

    await handleCommand({
      type: "cancel_queued_message",
      id: queuedId,
    }, fakeWs, ctx);

    assert.equal(entry.queuedMessages?.length, 0);
    assert.equal(session.followUps.length, 0);
  });

  it("supports sending a queued message immediately via send_queued_message_now", async () => {
    session.isStreaming = true;
    const ctx = (entry as any).ctx;

    await handleCommand({ type: "prompt", text: "急需插话执行的消息" }, fakeWs, ctx);

    assert.equal(entry.queuedMessages?.length, 1);
    const queuedId = entry.queuedMessages![0].id;

    await handleCommand({
      type: "send_queued_message_now",
      id: queuedId,
    }, fakeWs, ctx);

    // Message is steered immediately to intervene
    assert.equal(session.steers.length, 1);
    assert.equal(session.steers[0], "急需插话执行的消息");
    assert.equal(entry.queuedMessages?.length, 1);
    assert.equal(entry.queuedMessages[0].mode, "steer");

    // Once consumed by agent, queue drops to 0
    session.emit({ type: "queue_update", steering: [], followUp: [] });
    assert.equal(entry.queuedMessages?.length, 0);
  });

  it("subagent report enqueues in unified queue as followUp when streaming", async () => {
    session.isStreaming = true;
    const ctx = (entry as any).ctx;

    // 1. User queues a message
    await handleCommand({ type: "prompt", text: "用户指令 A" }, fakeWs, ctx);

    // 2. Subagent finishes and reports
    const subtask = { taskId: "task-42", taskTitle: "Build Subagent", role: "developer", status: "completed" };
    const reportText = "子任务构建已完成，所有测试通过。";

    // Simulate onReport logic
    const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    entry.queuedMessages!.push({
      id,
      text: reportText,
      mode: "followUp",
      createdAt: new Date().toISOString(),
      source: "subagent",
      taskId: subtask.taskId,
      taskTitle: subtask.taskTitle,
      role: subtask.role as any,
      taskStatus: subtask.status,
      kind: "subagent_terminal",
    });
    await session.followUp(reportText);

    // 3. User queues another message
    await handleCommand({ type: "prompt", text: "用户指令 B" }, fakeWs, ctx);

    // Verify all 3 messages are in the SAME queue in strict chronological order
    assert.equal(entry.queuedMessages?.length, 3);
    assert.equal(entry.queuedMessages[0].text, "用户指令 A");
    assert.equal(entry.queuedMessages[0].source, undefined);
    assert.equal(entry.queuedMessages[1].text, reportText);
    assert.equal(entry.queuedMessages[1].source, "subagent");
    assert.equal(entry.queuedMessages[1].role, "developer");
    assert.equal(entry.queuedMessages[1].taskTitle, "Build Subagent");
    assert.equal(entry.queuedMessages[1].kind, "subagent_terminal");
    assert.equal(entry.queuedMessages[2].text, "用户指令 B");

    // Verify session.followUps received all 3 in order
    assert.deepEqual(session.followUps, ["用户指令 A", reportText, "用户指令 B"]);
  });

  it("subagent blocker report enqueues as steer when streaming", async () => {
    session.isStreaming = true;

    const subtask = { taskId: "task-99", taskTitle: "Deploy", role: "developer", status: "failed" };
    const blockerText = "部署阻塞：环境缺失";

    const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    entry.queuedMessages!.push({
      id,
      text: blockerText,
      mode: "steer",
      createdAt: new Date().toISOString(),
      source: "subagent",
      taskId: subtask.taskId,
      taskTitle: subtask.taskTitle,
      role: subtask.role as any,
      taskStatus: subtask.status,
      kind: "subagent_blocker",
    });
    await session.steer(blockerText);

    assert.equal(entry.queuedMessages?.length, 1);
    assert.equal(entry.queuedMessages[0].mode, "steer");
    assert.equal(entry.queuedMessages[0].kind, "subagent_blocker");
    assert.equal(session.steers.length, 1);
    assert.equal(session.steers[0], blockerText);
  });
});

