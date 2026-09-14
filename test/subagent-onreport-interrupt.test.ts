import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { SubagentReportDispatcher } from "../server/subagent/report-dispatcher.ts";
import { SessionRegistry, type SessionEntry } from "../server/session/session-registry.ts";
import type { SubagentManager } from "../server/subagent-manager.ts";

function createMockSession() {
  const prompts: string[] = [];
  const followUps: string[] = [];
  const steers: string[] = [];
  let abortCount = 0;

  const session: any = {
    messages: [],
    isStreaming: false,
    prompt: async (text: string) => {
      prompts.push(text);
      return { ok: true };
    },
    followUp: async (text: string) => {
      followUps.push(text);
    },
    steer: async (text: string) => {
      steers.push(text);
    },
    clearQueue: () => {
      const s = [...steers];
      const f = [...followUps];
      steers.length = 0;
      followUps.length = 0;
      return { steering: s, followUp: f };
    },
    abort: async () => {
      abortCount++;
      session.isStreaming = false;
    },
    prompts,
    followUps,
    steers,
    get abortCount() {
      return abortCount;
    },
  };
  return session;
}

function createTestEntry(id: string, session: any): SessionEntry {
  return {
    id,
    runtime: { session } as any,
    clients: new Set(),
    activeRole: "coordinator",
    lastActive: Date.now(),
    queuedMessages: [],
  };
}

describe("Subagent Report Dispatcher - Session Interruption & Direct Insertion", () => {
  let sessionRegistry: SessionRegistry;
  let mockSubagentManager: any;
  let deletingSet: Set<string>;
  let snapshotsBroadcast: SessionEntry[];
  let dispatcher: SubagentReportDispatcher;

  beforeEach(() => {
    sessionRegistry = new SessionRegistry();
    deletingSet = new Set();
    snapshotsBroadcast = [];
    mockSubagentManager = {
      isDeleting: (id: string) => deletingSet.has(id),
    } as unknown as SubagentManager;

    dispatcher = new SubagentReportDispatcher({
      sessionRegistry,
      subagentManager: mockSubagentManager,
      isPendingDeletion: (id: string) => deletingSet.has(id),
      broadcastSnapshot: (entry) => {
        snapshotsBroadcast.push(entry);
      },
    });
  });

  it("interrupts an in-flight streaming session and forcibly inserts subtask report", async () => {
    const session = createMockSession();
    session.isStreaming = true;
    const entry = createTestEntry("session-1", session);
    sessionRegistry.set("session-1", entry);

    const task = {
      taskId: "task-101",
      taskTitle: "Implement Feature",
      role: "developer",
      status: "completed",
    };
    const reportText = "### 子任务结果\n已成功实现特性并自测通过。";

    await dispatcher.handleReport(entry, task, reportText, { kind: "terminal" });

    // Wait for in-flight ops on session-1
    await sessionRegistry.awaitInFlightOps("session-1");

    assert.equal(session.abortCount, 1, "Must call session.abort() to interrupt in-flight streaming session");
    assert.equal(session.prompts.length, 1, "Must forcibly prompt reportText into main session");
    assert.equal(session.prompts[0], reportText);
    assert.equal(session.followUps.length, 0, "Must NOT queue terminal report into followUps");
  });

  it("does not call abort when session is already idle and prompts directly", async () => {
    const session = createMockSession();
    session.isStreaming = false;
    const entry = createTestEntry("session-2", session);
    sessionRegistry.set("session-2", entry);

    const task = {
      taskId: "task-102",
      taskTitle: "Research Architecture",
      role: "researcher",
      status: "completed",
    };
    const reportText = "### 调研报告\n架构摸底完毕，无代码修改。";

    await dispatcher.handleReport(entry, task, reportText, { kind: "terminal" });
    await sessionRegistry.awaitInFlightOps("session-2");

    assert.equal(session.abortCount, 0, "Must NOT abort when session is already idle");
    assert.equal(session.prompts.length, 1, "Must prompt reportText directly into main session");
    assert.equal(session.prompts[0], reportText);
  });

  it("purges stale subagent items from queuedMessages while preserving user messages", async () => {
    const session = createMockSession();
    session.isStreaming = true;
    const entry = createTestEntry("session-3", session);
    entry.queuedMessages = [
      {
        id: "q-user-1",
        text: "用户排队消息 1",
        mode: "followUp",
        createdAt: new Date().toISOString(),
        source: "user",
      },
      {
        id: "q-sub-1",
        text: "陈旧子任务消息",
        mode: "followUp",
        createdAt: new Date().toISOString(),
        source: "subagent",
      },
    ];
    sessionRegistry.set("session-3", entry);

    const task = {
      taskId: "task-103",
      taskTitle: "Fix Bug",
      role: "developer",
      status: "completed",
    };
    const reportText = "### 缺陷修复完成";

    await dispatcher.handleReport(entry, task, reportText, { kind: "terminal" });
    await sessionRegistry.awaitInFlightOps("session-3");

    // Stale subagent items purged
    assert.equal(entry.queuedMessages.length, 1);
    assert.equal(entry.queuedMessages[0].id, "q-user-1");
    assert.equal(entry.queuedMessages[0].source, "user");

    // User message re-queued as followUp
    assert.deepEqual(session.followUps, ["用户排队消息 1"]);
    assert.equal(session.prompts[0], reportText);
  });

  it("blocker reports also interrupt streaming session and prompt directly", async () => {
    const session = createMockSession();
    session.isStreaming = true;
    const entry = createTestEntry("session-4", session);
    sessionRegistry.set("session-4", entry);

    const task = {
      taskId: "task-104",
      taskTitle: "Database Migration",
      role: "developer",
      status: "blocked",
    };
    const blockerText = "[Subagent 报告阻塞] 缺少迁移权限";

    await dispatcher.handleReport(entry, task, blockerText, { kind: "blocker" });
    await sessionRegistry.awaitInFlightOps("session-4");

    assert.equal(session.abortCount, 1, "Blocker report must abort in-flight session");
    assert.equal(session.prompts.length, 1, "Blocker report must be directly prompted");
    assert.equal(session.prompts[0], blockerText);
  });

  it("safely ignores reports when session is marked for deletion", async () => {
    const session = createMockSession();
    session.isStreaming = true;
    const entry = createTestEntry("session-5", session);
    sessionRegistry.set("session-5", entry);
    deletingSet.add("session-5");

    const task = { taskId: "task-105", taskTitle: "Deleted", role: "developer", status: "completed" };
    await dispatcher.handleReport(entry, task, "不会被处理的报告", { kind: "terminal" });
    await sessionRegistry.awaitInFlightOps("session-5");

    assert.equal(session.abortCount, 0);
    assert.equal(session.prompts.length, 0);
  });

  it("batches concurrent reports arriving while session is aborting", async () => {
    const session = createMockSession();
    session.isStreaming = true;
    const entry = createTestEntry("session-6", session);
    sessionRegistry.set("session-6", entry);

    const task1 = { taskId: "task-106a", taskTitle: "Part 1", role: "developer", status: "completed" };
    const task2 = { taskId: "task-106b", taskTitle: "Part 2", role: "researcher", status: "completed" };

    // Fire two reports concurrently
    await Promise.all([
      dispatcher.handleReport(entry, task1, "报告 A 完成", { kind: "terminal" }),
      dispatcher.handleReport(entry, task2, "报告 B 完成", { kind: "terminal" }),
    ]);

    await sessionRegistry.awaitInFlightOps("session-6");

    assert.ok(session.abortCount >= 1, "Streaming session must be aborted");
    assert.ok(session.prompts.length >= 1, "Must prompt delivered reports");
    const combinedDelivered = session.prompts.join("\n\n---\n\n");
    assert.ok(combinedDelivered.includes("报告 A 完成"));
    assert.ok(combinedDelivered.includes("报告 B 完成"));
  });
});
