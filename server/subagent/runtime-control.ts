import type { SubagentInstance } from "./types.ts";

export function queuePendingTerminal(
  instance: SubagentInstance,
  next: { type: "completed" | "failed"; error?: string },
): void {
  if (!instance.pendingTerminal) {
    instance.pendingTerminal = next;
    return;
  }
  // failed 优先级高于 completed
  if (instance.pendingTerminal.type === "completed" && next.type === "failed") {
    instance.pendingTerminal = next;
  }
}

/**
 * UI delivery is an observer of task execution. It must never be allowed to
 * reject the Agent Core event pipeline (which would otherwise abort a turn
 * before Agent Core has appended its toolResult message).
 */
export function notifyUpdate(instance: SubagentInstance): void {
  try {
    instance.onUpdate?.(instance.task);
  } catch (err) {
    console.warn(
      `[SubagentManager] Failed to publish update for ${instance.task.taskId}:`,
      err,
    );
  }
}

/**
 * Agent Core emits tool_execution_end before it appends the toolResult
 * message. Include any finalized-but-not-yet-appended results in terminal
 * snapshots so an interruption cannot leave a dangling tool call.
 */
export function getSerializableMessages(instance: SubagentInstance, interruptionReason?: string): any[] {
  const messages = [...(instance.runtime?.session?.messages ?? [])] as any[];
  const pending = instance.pendingToolResults;

  const persistedToolCallIds = new Set(
    messages
      .filter((message) => message?.role === "toolResult")
      .map((message) => message.toolCallId),
  );
  if (pending) {
    for (const [toolCallId, result] of pending) {
      if (!persistedToolCallIds.has(toolCallId)) {
        messages.push(result);
        persistedToolCallIds.add(toolCallId);
      }
    }
  }

  // If the host interrupts the tool before tool_execution_end, there is no
  // event result to retain. Close every still-open tool call explicitly in
  // the terminal snapshot instead of exposing an unpaired assistant call.
  if (interruptionReason) {
    for (const message of messages) {
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
        if (persistedToolCallIds.has(block.id)) continue;
        messages.push({
          role: "toolResult",
          toolCallId: block.id,
          toolName: String(block.name ?? "unknown"),
          content: [{
            type: "text",
            text: `Tool execution interrupted: ${interruptionReason}`,
          }],
          details: { interrupted: true },
          isError: true,
          timestamp: Date.now(),
        });
        persistedToolCallIds.add(block.id);
      }
    }
  }
  return messages;
}

/** Bounded wait for in-flight tools after session.abort() before terminal status is published. */
export const ACTIVE_TOOL_QUIESCE_MS = 500;

export function isTerminalLocked(instance: SubagentInstance): boolean {
  if (instance.reported || instance.terminalizing) return true;
  return ["aborted", "failed", "interrupted", "completed", "incomplete", "conflict"].includes(
    instance.task.status,
  );
}

export function registerActiveTool(
  instance: SubagentInstance,
  event: { toolCallId?: string; toolName?: string; args?: unknown },
): void {
  if (!event.toolCallId) return;
  if (!instance.activeTools) instance.activeTools = new Map();
  instance.activeTools.set(event.toolCallId, {
    toolCallId: event.toolCallId,
    toolName: String(event.toolName ?? "unknown"),
    startedAt: Date.now(),
    args: event.args,
  });
}

export function clearActiveTool(instance: SubagentInstance, toolCallId?: string): void {
  if (!toolCallId || !instance.activeTools) return;
  instance.activeTools.delete(toolCallId);
  if (instance.activeTools.size === 0) instance.activeTools = undefined;
}

export function listActiveToolNames(instance: SubagentInstance): string[] {
  if (!instance.activeTools || instance.activeTools.size === 0) return [];
  return [...instance.activeTools.values()].map(
    (t) => `${t.toolName}(${t.toolCallId})`,
  );
}

/**
 * After abort, wait briefly for tool_execution_end to clear activeTools.
 * Does not block forever — leftover tools are logged and dropped from the gate.
 */
export async function waitForActiveTools(
  instance: SubagentInstance,
  timeoutMs = ACTIVE_TOOL_QUIESCE_MS,
): Promise<string[]> {
  const started = Date.now();
  while (instance.activeTools && instance.activeTools.size > 0) {
    if (Date.now() - started >= timeoutMs) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  const leftover = listActiveToolNames(instance);
  if (leftover.length > 0) {
    instance.task.logs?.push(
      `[SubagentManager] Active tools still running after ${timeoutMs}ms wait: ${leftover.join(", ")}`,
    );
    instance.activeTools = undefined;
  }
  return leftover;
}

/**
 * Stop the agent loop and give in-flight tools a short chance to observe
 * AbortSignal. Terminal status must not be published before this returns.
 */
export async function abortSessionAndQuiesceTools(
  instance: SubagentInstance,
  reason: string,
): Promise<void> {
  const runtime = instance.runtime;
  if (!runtime) {
    instance.activeTools = undefined;
    return;
  }

  if (typeof runtime.session?.abort === "function") {
    try {
      await runtime.session.abort();
    } catch (err) {
      console.warn(
        `[SubagentManager] Failed to abort runtime for ${instance.task.taskId} during ${reason}:`,
        err,
      );
    }
  }

  await waitForActiveTools(instance);
}

export async function disposeRuntime(instance: SubagentInstance, reason: string): Promise<void> {
  const runtime = instance.runtime;
  if (!runtime) {
    instance.activeTools = undefined;
    return;
  }

  if (typeof runtime.dispose === "function") {
    try {
      await runtime.dispose();
      if (instance.runtime === runtime) instance.runtime = undefined;
    } catch (err) {
      console.warn(
        `[SubagentManager] Failed to dispose runtime for ${instance.task.taskId} during ${reason}:`,
        err,
      );
    }
  } else if (instance.runtime === runtime) {
    instance.runtime = undefined;
  }

  instance.activeTools = undefined;
}
