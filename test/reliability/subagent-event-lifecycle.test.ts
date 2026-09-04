import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { subagentTasks, SubagentManager } from "../../server/subagent-manager.ts";
import { createMockSession, setupTestGitRepo, waitUntil } from "./helpers.ts";

describe("Subagent event lifecycle hardening", () => {
  it("does not persist a dangling tool call before toolResult message_end", async () => {
    const repo = setupTestGitRepo();
    const manager = new SubagentManager({} as any);
    const toolCallId = `call-${Date.now()}`;
    const assistantMessage = {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: toolCallId, name: "slow_tool", arguments: {} }],
    };
    const session = createMockSession([assistantMessage]);

    try {
      const task = await manager.spawn({
        parentSessionId: `parent-${Date.now()}`,
        role: "researcher",
        taskTitle: "tool event ordering",
        taskPrompt: "test",
        parentCwd: repo.gitRepoDir,
        customSession: session,
      });

      await session.emit({
        type: "tool_execution_end",
        toolCallId,
        toolName: "slow_tool",
        result: { content: [{ type: "text", text: "ok" }] },
        isError: false,
      });

      assert.deepEqual(task.messages, [], "tool_execution_end must not overwrite messages with a stale snapshot");

      const toolResult = {
        role: "toolResult",
        toolCallId,
        toolName: "slow_tool",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      };
      session.messages.push(toolResult);
      await session.emit({ type: "message_end", message: toolResult });

      assert.equal(task.messages?.[0]?.content?.[0]?.type, "toolCall");
      assert.deepEqual(task.messages?.[0]?.content?.[0]?.result, { text: "ok", isError: false });
    } finally {
      subagentTasks.clear();
      repo.cleanup();
    }
  });

  it("contains update delivery failures inside the observer boundary", async () => {
    const repo = setupTestGitRepo();
    const manager = new SubagentManager({} as any);
    const toolCallId = `call-${Date.now()}`;
    const session = createMockSession([
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: toolCallId, name: "slow_tool", arguments: {} }],
      },
    ]);
    let updates = 0;

    try {
      await manager.spawn({
        parentSessionId: `parent-${Date.now()}`,
        role: "researcher",
        taskTitle: "observer failure",
        taskPrompt: "test",
        parentCwd: repo.gitRepoDir,
        customSession: session,
        onUpdate: () => {
          updates += 1;
          if (updates > 1) throw new Error("simulated websocket failure");
        },
      });

      await assert.doesNotReject(() =>
        session.emit({
          type: "tool_execution_end",
          toolCallId,
          toolName: "slow_tool",
          result: { content: [{ type: "text", text: "ok" }] },
          isError: false,
        }),
      );
      assert.ok(updates > 1);
    } finally {
      subagentTasks.clear();
      repo.cleanup();
    }
  });

  it("defers completion when agent_end schedules an automatic retry", async () => {
    const repo = setupTestGitRepo();
    const manager = new SubagentManager({} as any);
    const session = createMockSession([
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "temporary provider failure",
        content: [],
      },
    ]);

    try {
      const task = await manager.spawn({
        parentSessionId: `parent-${Date.now()}`,
        role: "researcher",
        taskTitle: "retry boundary",
        taskPrompt: "test",
        parentCwd: repo.gitRepoDir,
        customSession: session,
      });

      await session.emit({ type: "agent_end", messages: session.messages, willRetry: true });
      assert.equal(task.status, "running");
      assert.equal(task.error, undefined);
      assert.ok(task.logs?.some((line) => line.includes("automatic retry")));
    } finally {
      subagentTasks.clear();
      repo.cleanup();
    }
  });

  it("closes an unobserved tool call when the host ends the run before tool_execution_end", async () => {
    const repo = setupTestGitRepo();
    const manager = new SubagentManager({} as any);
    const toolCallId = `call-${Date.now()}`;
    const session = createMockSession([
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: toolCallId, name: "slow_tool", arguments: {} }],
      },
    ]);

    try {
      const task = await manager.spawn({
        parentSessionId: `parent-${Date.now()}`,
        role: "researcher",
        taskTitle: "interrupted tool",
        taskPrompt: "test",
        parentCwd: repo.gitRepoDir,
        customSession: session,
      });

      await session.emit({ type: "agent_end", messages: session.messages, willRetry: false });
      await waitUntil(() => task.status === "failed");

      const toolBlock = task.messages?.[0]?.content?.[0] as any;
      assert.equal(task.status, "failed");
      assert.equal(toolBlock?.type, "toolCall");
      assert.equal(toolBlock?.result?.isError, true);
      assert.match(toolBlock?.result?.text ?? "", /interrupted/i);
    } finally {
      subagentTasks.clear();
      repo.cleanup();
    }
  });

  it("disposes the runtime when a subagent reaches failed terminal state", async () => {
    const repo = setupTestGitRepo();
    const manager = new SubagentManager({} as any);
    let disposed = false;
    let aborted = false;
    const session = createMockSession([
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "SIGTERM",
        content: [],
      },
    ]) as any;
    session.dispose = async () => {
      disposed = true;
    };
    session.abort = async () => {
      aborted = true;
      session.isStreaming = false;
    };

    try {
      const task = await manager.spawn({
        parentSessionId: `parent-${Date.now()}`,
        role: "researcher",
        taskTitle: "failed cleanup",
        taskPrompt: "test",
        parentCwd: repo.gitRepoDir,
        customSession: session,
      });

      await session.emit({ type: "agent_end", messages: session.messages, willRetry: false });
      await waitUntil(() => disposed && task.status === "failed");

      assert.equal(task.status, "failed");
      assert.ok(task.error?.includes("SIGTERM"));
      assert.equal(aborted, true);
      assert.equal(disposed, true);
    } finally {
      subagentTasks.clear();
      repo.cleanup();
    }
  });

  it("disposes the runtime on successful completion so the agent cannot keep working", async () => {
    const repo = setupTestGitRepo();
    const manager = new SubagentManager({} as any);
    let disposed = false;
    let aborted = false;
    const session = createMockSession([
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "deliverable done" }],
      },
    ]) as any;
    session.dispose = async () => {
      disposed = true;
    };
    session.abort = async () => {
      aborted = true;
    };

    try {
      const task = await manager.spawn({
        parentSessionId: `parent-${Date.now()}`,
        role: "researcher",
        taskTitle: "completed cleanup",
        taskPrompt: "test",
        parentCwd: repo.gitRepoDir,
        customSession: session,
      });

      await session.emit({ type: "agent_end", messages: session.messages, willRetry: false });
      await waitUntil(() => disposed && task.status === "completed");

      assert.equal(task.status, "completed");
      assert.equal(aborted, true, "completed path must abort the session");
      assert.equal(disposed, true, "completed path must dispose the runtime");
    } finally {
      subagentTasks.clear();
      repo.cleanup();
    }
  });

  it("tracks in-flight tools and does not let late success events revive a failed task", async () => {
    const repo = setupTestGitRepo();
    const manager = new SubagentManager({} as any);
    const toolCallId = `call-inflight-${Date.now()}`;
    let disposed = false;
    const session = createMockSession([
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "provider dropped",
        content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "sleep 999" } }],
      },
    ]) as any;
    session.dispose = async () => {
      disposed = true;
    };

    try {
      const task = await manager.spawn({
        parentSessionId: `parent-${Date.now()}`,
        role: "researcher",
        taskTitle: "inflight gate",
        taskPrompt: "test",
        parentCwd: repo.gitRepoDir,
        customSession: session,
      });

      await session.emit({
        type: "tool_execution_start",
        toolCallId,
        toolName: "bash",
        args: { command: "sleep 999" },
      });
      assert.ok(task.logs?.some((line) => line.includes("bash start")));

      // Simulate agent_end while tool still running (harness must still terminalize).
      await session.emit({ type: "agent_end", messages: session.messages, willRetry: false });
      await waitUntil(() => disposed && task.status === "failed", 2000);

      assert.equal(task.status, "failed");
      const failedAt = task.completedAt;
      assert.ok(failedAt);
      assert.equal(disposed, true);
      assert.ok(
        task.logs?.some((line) => line.includes("in-flight tools") || line.includes("Active tools still running")),
        "inflight tool must be visible in the terminal log",
      );

      // Late tool success must not reopen the task or rewrite terminal metadata.
      await session.emit({
        type: "tool_execution_end",
        toolCallId,
        toolName: "bash",
        result: { content: [{ type: "text", text: "should be ignored for status" }] },
        isError: false,
      });
      await session.emit({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "zombie continuation" }],
        },
      });

      assert.equal(task.status, "failed");
      assert.equal(task.completedAt, failedAt);
      assert.ok(!task.summary?.includes("zombie"));
    } finally {
      subagentTasks.clear();
      repo.cleanup();
    }
  });
});
