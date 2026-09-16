import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { handleCommand } from "../server/ws/command-handler.ts";
import {
  bindSessionEvents,
  extractUserMessageTexts,
  reconcileQueuedMessages,
} from "../server/ws/session-binding.ts";
import { SessionRegistry, type SessionEntry } from "../server/session/session-registry.ts";
import { SubagentManager } from "../server/subagent-manager.ts";
import { buildSnapshot } from "../server/session/snapshot.ts";
import type { ServerEvent } from "../shared/protocol.ts";

function createMockSession() {
  const subscribers: ((event: any) => void)[] = [];
  const prompts: string[] = [];
  const followUps: string[] = [];
  const steers: string[] = [];
  // Ordered call log (e.g. "abort:start", "abort:end", "followUp", "prompt") so
  // tests can assert abort strictly precedes the resumed prompt, not just that both ran.
  const callLog: string[] = [];
  const abortCalls: number[] = [];

  const session: any = {
    messages: [],
    isStreaming: false,
    abortDelayMs: 0,
    abortResolved: false,
    promptSawAbortResolved: false,
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
      callLog.push("prompt");
      session.promptSawAbortResolved = session.abortResolved === true;
      prompts.push(text);
      return { ok: true };
    },
    followUp: async (text: string) => {
      callLog.push("followUp");
      followUps.push(text);
      session.emit({ type: "queue_update", steering: [...steers], followUp: [...followUps] });
    },
    steer: async (text: string) => {
      callLog.push("steer");
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
    abort: async () => {
      callLog.push("abort:start");
      abortCalls.push(Date.now());
      if (session.abortDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, session.abortDelayMs));
      }
      session.abortResolved = true;
      callLog.push("abort:end");
    },
    setModel: async () => {},
    setThinkingLevel: () => {},
    model: { provider: "mock", id: "mock-model" },
    prompts,
    followUps,
    steers,
    callLog,
    abortCalls,
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

  it("aborts the running turn then prompts the queued message via send_queued_message_now", async () => {
    session.isStreaming = true;
    const ctx = (entry as any).ctx;

    await handleCommand({ type: "prompt", text: "急需插话执行的消息" }, fakeWs, ctx);
    await handleCommand({ type: "prompt", text: "后续排队消息" }, fakeWs, ctx);

    assert.equal(entry.queuedMessages?.length, 2);
    const queuedId = entry.queuedMessages![0].id;

    // Make abort asynchronous so the ordering assertion is meaningful.
    session.abortDelayMs = 15;

    await handleCommand({
      type: "send_queued_message_now",
      id: queuedId,
    }, fakeWs, ctx);

    // New semantics: abort the current run, never steer.
    assert.equal(session.abortCalls.length, 1, "abort must be called exactly once");
    assert.equal(session.steers.length, 0, "send_queued_message_now must no longer steer");
    assert.equal(session.prompts.length, 1);
    assert.equal(session.prompts[0], "急需插话执行的消息");

    // Strict ordering: abort starts, abort finishes (idle), only then prompt.
    const abortStart = session.callLog.indexOf("abort:start");
    const abortEnd = session.callLog.indexOf("abort:end");
    const promptIdx = session.callLog.indexOf("prompt");
    assert.ok(abortStart !== -1, "abort must be invoked");
    assert.ok(abortStart < abortEnd, "abort must resolve");
    assert.ok(abortEnd < promptIdx, "prompt must run after abort resolves (idle)");
    assert.equal(session.promptSawAbortResolved, true, "prompt must observe abort completion");

    // The remaining queued item must survive in both UI and session queues.
    assert.equal(entry.queuedMessages?.length, 1);
    assert.equal(entry.queuedMessages![0].text, "后续排队消息");
    assert.deepEqual(session.followUps, ["后续排队消息"]);
  });

  it("prompts immediately without aborting when send_queued_message_now is used while not streaming", async () => {
    const ctx = (entry as any).ctx;
    entry.queuedMessages = [
      { id: "q-ns-1", text: "非流式目标", mode: "followUp", createdAt: new Date().toISOString(), deliverAfterUserMsgCount: 0 },
      { id: "q-ns-2", text: "非流式剩余", mode: "followUp", createdAt: new Date().toISOString(), deliverAfterUserMsgCount: 0 },
    ];

    await handleCommand({ type: "send_queued_message_now", id: "q-ns-1" }, fakeWs, ctx);

    assert.equal(session.abortCalls.length, 0, "non-streaming path must not abort");
    assert.equal(session.prompts.length, 1);
    assert.equal(session.prompts[0], "非流式目标");
    assert.equal(entry.queuedMessages?.length, 1);
    assert.equal(entry.queuedMessages![0].text, "非流式剩余");
    assert.deepEqual(session.followUps, ["非流式剩余"]);
  });

  it("sends an error event (no unhandled rejection) when the immediate prompt rejects", async () => {
    session.isStreaming = true;
    const ctx = (entry as any).ctx;

    await handleCommand({ type: "prompt", text: "会失败的消息" }, fakeWs, ctx);
    const queuedId = entry.queuedMessages![0].id;

    session.prompt = async () => {
      throw new Error("prompt exploded");
    };

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await handleCommand({ type: "send_queued_message_now", id: queuedId }, fakeWs, ctx);
      // trackInFlightOp is fire-and-forget; wait for it to settle.
      await registry.awaitInFlightOps(entry.id);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    const errors = receivedEvents.filter((e) => e.type === "error") as any[];
    assert.equal(errors.length, 1, "client must receive a single error event");
    assert.match(errors[0].message, /prompt exploded/);
    assert.equal(unhandled.length, 0, "prompt rejection must not surface as unhandledRejection");
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

  it("keeps original queued text visible when session expands skill/template text", async () => {
    session.isStreaming = true;
    const ctx = (entry as any).ctx;

    await handleCommand({ type: "prompt", text: "/commit" }, fakeWs, ctx);
    assert.equal(entry.queuedMessages?.length, 1);
    const originalId = entry.queuedMessages![0].id;

    // Simulate agent-session skill expansion: queue holds expanded body, not the slash command.
    session.emit({
      type: "queue_update",
      steering: [],
      followUp: ["Expanded skill body for commit workflow"],
    });

    assert.equal(entry.queuedMessages?.length, 1, "expanded queue_update must not drop the visible queue item");
    assert.equal(entry.queuedMessages![0].id, originalId, "must preserve queue item identity/metadata");
    assert.equal(entry.queuedMessages![0].text, "/commit", "panel should keep user-facing original text");

    const latest = receivedEvents.filter((e) => e.type === "snapshot").at(-1) as any;
    assert.equal(latest.snapshot.queuedMessages?.[0]?.text, "/commit");
  });

  it("keeps other queued items across clearQueue + partial requeue races", async () => {
    session.isStreaming = true;
    const ctx = (entry as any).ctx;

    await handleCommand({ type: "prompt", text: "first" }, fakeWs, ctx);
    await handleCommand({ type: "prompt", text: "second" }, fakeWs, ctx);
    await handleCommand({ type: "prompt", text: "third" }, fakeWs, ctx);
    assert.equal(entry.queuedMessages?.length, 3);

    const secondId = entry.queuedMessages![1].id;

    // cancel triggers clearQueue (empty update) then requeues survivors.
    // Also inject a partial queue_update mid-flight as if only one followUp landed.
    await handleCommand({ type: "cancel_queued_message", id: secondId }, fakeWs, ctx);

    // After cancel, remaining must still be present
    assert.equal(entry.queuedMessages?.length, 2);
    assert.deepEqual(
      entry.queuedMessages!.map((m) => m.text),
      ["first", "third"],
    );

    // Partial session queue (only first re-enqueued so far) must not wipe third
    session.emit({ type: "queue_update", steering: [], followUp: ["first"] });
    assert.equal(entry.queuedMessages?.length, 2);
    assert.deepEqual(
      entry.queuedMessages!.map((m) => m.text),
      ["first", "third"],
    );

    // Expansion mismatch on one survivor must not drop the other
    session.emit({
      type: "queue_update",
      steering: [],
      followUp: ["FIRST_EXPANDED", "third"],
    });
    assert.equal(entry.queuedMessages?.length, 2);
    assert.equal(entry.queuedMessages![0].text, "first");
    assert.equal(entry.queuedMessages![1].text, "third");
  });

  it("shows multiple queued messages that share the same text", async () => {
    session.isStreaming = true;
    const ctx = (entry as any).ctx;

    await handleCommand({ type: "prompt", text: "same" }, fakeWs, ctx);
    await handleCommand({ type: "prompt", text: "same" }, fakeWs, ctx);
    await handleCommand({ type: "prompt", text: "same" }, fakeWs, ctx);

    assert.equal(entry.queuedMessages?.length, 3);
    assert.ok(entry.queuedMessages!.every((m) => m.text === "same"));
    const ids = new Set(entry.queuedMessages!.map((m) => m.id));
    assert.equal(ids.size, 3, "duplicate texts still need distinct queue identities");

    const latest = receivedEvents.filter((e) => e.type === "snapshot").at(-1) as any;
    assert.equal(latest.snapshot.queuedMessages?.length, 3);
  });

  it("does not drop UI queue item on dequeue until user message exists in session.messages", async () => {
    session.isStreaming = true;
    const ctx = (entry as any).ctx;

    await handleCommand({ type: "prompt", text: "pending-delivery" }, fakeWs, ctx);
    assert.equal(entry.queuedMessages?.length, 1);
    const queuedId = entry.queuedMessages![0].id;

    // Agent dequeues at message_start: session queue empty, but messages not yet appended (message_end).
    session.followUps.length = 0;
    session.emit({ type: "queue_update", steering: [], followUp: [] });

    assert.equal(
      entry.queuedMessages?.length,
      1,
      "UI queue must not create a hole before the user message is visible",
    );
    assert.equal(entry.queuedMessages![0].id, queuedId);
    assert.equal(entry.queuedMessages![0].text, "pending-delivery");

    // After message_end, user message is in session.messages — now safe to drop.
    session.messages.push({
      role: "user",
      content: [{ type: "text", text: "pending-delivery" }],
    });
    session.emit({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "pending-delivery" }] },
    });

    assert.equal(entry.queuedMessages?.length, 0);
  });

  it("drops dequeued expanded item only after expanded user message is present", async () => {
    session.isStreaming = true;
    const ctx = (entry as any).ctx;

    await handleCommand({ type: "prompt", text: "/review" }, fakeWs, ctx);
    const queuedId = entry.queuedMessages![0].id;

    session.emit({
      type: "queue_update",
      steering: [],
      followUp: ["Expanded review checklist"],
    });
    assert.equal(entry.queuedMessages?.[0]?.id, queuedId);
    assert.equal(entry.queuedMessages?.[0]?.text, "/review");

    // Dequeue (expanded form leaves session queue). Clear mock session queues like the real agent.
    session.followUps.length = 0;
    session.steers.length = 0;
    session.emit({ type: "queue_update", steering: [], followUp: [] });
    assert.equal(entry.queuedMessages?.length, 1, "still visible until message lands");

    // Delivered message uses expanded text
    session.messages.push({
      role: "user",
      content: [{ type: "text", text: "Expanded review checklist" }],
    });
    session.emit({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "Expanded review checklist" }] },
    });
    assert.equal(entry.queuedMessages?.length, 0);
  });

  it("does not drop a newly queued item because transcript already has the same user text", async () => {
    session.isStreaming = true;
    const ctx = (entry as any).ctx;

    // Historical user turn already in the transcript with identical text.
    session.messages.push({
      role: "user",
      content: [{ type: "text", text: "重复指令" }],
    });
    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "历史回复" }],
    });

    await handleCommand({ type: "prompt", text: "重复指令" }, fakeWs, ctx);
    assert.equal(entry.queuedMessages?.length, 1);
    const queuedId = entry.queuedMessages![0].id;

    // In-flight: session dequeued, but this turn's user message is not in messages yet.
    session.followUps.length = 0;
    session.emit({ type: "queue_update", steering: [], followUp: [] });

    assert.equal(
      entry.queuedMessages?.length,
      1,
      "historical same user text must not remove the newly queued item",
    );
    assert.equal(entry.queuedMessages![0].id, queuedId);
    assert.equal(entry.queuedMessages![0].text, "重复指令");

    // A later message_end for an unrelated assistant chunk still must not steal the queue row.
    session.emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "still streaming" }] },
    });
    assert.equal(entry.queuedMessages?.length, 1);
    assert.equal(entry.queuedMessages![0].id, queuedId);

    // Real delivery of this turn's user message may drop it.
    session.messages.push({
      role: "user",
      content: [{ type: "text", text: "重复指令" }],
    });
    session.emit({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "重复指令" }] },
    });
    assert.equal(entry.queuedMessages?.length, 0);
  });

  it("reconcile adopts session-only steering/followUp leftovers as UI rows", () => {
    const adopted = reconcileQueuedMessages(
      [],
      ["steer-external"],
      ["follow-external"],
      ["old-user"],
    );
    assert.equal(adopted.length, 2);
    assert.equal(adopted[0].mode, "steer");
    assert.equal(adopted[0].text, "steer-external");
    assert.equal(adopted[0].sessionText, "steer-external");
    assert.equal(adopted[0].deliverAfterUserMsgCount, 1);
    assert.equal(adopted[1].mode, "followUp");
    assert.equal(adopted[1].text, "follow-external");
    assert.equal(adopted[1].deliverAfterUserMsgCount, 1);
  });

  it("extractUserMessageTexts supports string content and ignores non-user roles", () => {
    assert.deepEqual(extractUserMessageTexts(undefined), []);
    assert.deepEqual(
      extractUserMessageTexts([
        { role: "assistant", content: "nope" },
        { role: "user", content: "plain string" },
        { role: "user", content: [{ type: "text", text: "block" }, { type: "image" }] },
        { role: "user", content: 123 },
      ]),
      ["plain string", "block"],
    );
  });
});

