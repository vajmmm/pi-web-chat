import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ServerEvent, UIQueuedMessage } from "../../shared/protocol.ts";
import { createAutoTitleState, maybeAutoTitle } from "../session/auto-title.ts";
import type { SessionEntry } from "../session/session-registry.ts";
import { buildSnapshot } from "../session/snapshot.ts";
import type { SubagentManager } from "../subagent-manager.ts";
import { broadcastSnapshot, broadcastTo } from "./websocket-server.ts";

function newQueueId(): string {
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function textFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
    .map((b) => (b as { text?: string }).text ?? "")
    .filter(Boolean)
    .join("\n");
}

/** Collect user message texts currently visible in the session transcript. */
export function extractUserMessageTexts(messages: unknown[] | undefined): string[] {
  if (!messages?.length) return [];
  const texts: string[] = [];
  for (const raw of messages) {
    const m = raw as { role?: string; content?: unknown };
    if (m?.role !== "user") continue;
    const text = textFromMessageContent(m.content);
    if (text) texts.push(text);
  }
  return texts;
}

function matchAndConsume(pool: string[], candidates: Array<string | undefined>): number {
  for (const candidate of candidates) {
    if (candidate == null || candidate === "") continue;
    const idx = pool.indexOf(candidate);
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * Match a delivery candidate against transcript user texts, but only at indices
 * >= afterCount so pre-enqueue historical turns cannot false-consume the row.
 * Consumed slots are nulled (not spliced) to keep indices stable for other rows.
 */
function matchAndConsumeDelivered(
  delivered: Array<string | null>,
  afterCount: number,
  candidates: Array<string | undefined>,
): boolean {
  const start = Math.max(0, afterCount);
  for (const candidate of candidates) {
    if (candidate == null || candidate === "") continue;
    for (let i = start; i < delivered.length; i++) {
      if (delivered[i] === candidate) {
        delivered[i] = null;
        return true;
      }
    }
  }
  return false;
}

/**
 * Reconcile UI queue items with the agent session's steering/followUp queues.
 *
 * Invariants:
 * - Prefer preserving existing item identity/metadata (id, source, original text).
 * - Skill/template expansion: pair by mode FIFO when exact text diverges; keep user-facing text.
 * - Items missing from the session queue are only dropped once a matching user message exists
 *   in session.messages (prevents UI holes between message_start dequeue and message_end).
 * - Historical transcript rows with the same user text must not drop a newly queued item.
 * - clearQueue + partial requeue must not wipe still-pending items.
 */
export function reconcileQueuedMessages(
  existing: UIQueuedMessage[] | undefined,
  steering: readonly string[],
  followUp: readonly string[],
  userMessageTexts: readonly string[],
): UIQueuedMessage[] {
  const remainingSteering = [...steering];
  const remainingFollowUp = [...followUp];
  const delivered: Array<string | null> = [...userMessageTexts];
  const baselineCount = userMessageTexts.length;

  // Stamp missing delivery watermarks so rows enqueued without an explicit count
  // (e.g. subagent pushes) still ignore already-present historical user texts.
  const existingList = (existing ?? []).map((item) =>
    item.deliverAfterUserMsgCount == null
      ? { ...item, deliverAfterUserMsgCount: baselineCount }
      : item,
  );

  // First pass: exact text/sessionText matches (consume from session pools).
  const exactMatched = new Set<string>();
  for (const item of existingList) {
    const pool = item.mode === "steer" ? remainingSteering : remainingFollowUp;
    const idx = matchAndConsume(pool, [item.sessionText, item.text]);
    if (idx !== -1) {
      pool.splice(idx, 1);
      exactMatched.add(item.id);
    }
  }

  // Second pass: expansion/rewrite pairing for remaining session texts by mode.
  // Pair newest unmatched items first so in-flight (dequeued, awaiting message_end) older
  // rows are not rewritten onto a newly queued session text.
  // Items that already carry sessionText but no longer match the session queue are treated as
  // in-flight deliveries, not re-expansion candidates.
  const expansionSessionText = new Map<string, string>();
  const claimExpansion = (mode: "steer" | "followUp", pool: string[]) => {
    const candidates = existingList.filter(
      (item) =>
        item.mode === mode &&
        !exactMatched.has(item.id) &&
        !item.sessionText,
    );
    if (candidates.length === 0 || pool.length === 0) return;
    const pairCount = Math.min(candidates.length, pool.length);
    const startIdx = candidates.length - pairCount;
    for (let i = 0; i < pairCount; i++) {
      expansionSessionText.set(candidates[startIdx + i].id, pool.shift()!);
    }
  };
  claimExpansion("steer", remainingSteering);
  claimExpansion("followUp", remainingFollowUp);

  const result: UIQueuedMessage[] = [];

  // Preserve original UI order for survivors.
  for (const item of existingList) {
    if (exactMatched.has(item.id)) {
      result.push(item);
      continue;
    }
    const expanded = expansionSessionText.get(item.id);
    if (expanded !== undefined) {
      result.push({
        ...item,
        // Keep original user-facing text; remember session form for later match/delivery.
        sessionText: expanded,
      });
      continue;
    }

    // Not in session queue: drop only once a post-enqueue matching user message has landed.
    const deliveredMatched = matchAndConsumeDelivered(
      delivered,
      item.deliverAfterUserMsgCount ?? baselineCount,
      [item.sessionText, item.text],
    );
    if (deliveredMatched) {
      continue;
    }
    result.push(item);
  }

  // Session-only leftovers (e.g. external enqueue) become new UI rows.
  for (const s of remainingSteering) {
    result.push({
      id: newQueueId(),
      text: s,
      sessionText: s,
      mode: "steer",
      deliverAfterUserMsgCount: baselineCount,
      createdAt: new Date().toISOString(),
    });
  }
  for (const f of remainingFollowUp) {
    result.push({
      id: newQueueId(),
      text: f,
      sessionText: f,
      mode: "followUp",
      deliverAfterUserMsgCount: baselineCount,
      createdAt: new Date().toISOString(),
    });
  }

  return result;
}

function applyQueueReconcile(
  entry: SessionEntry,
  steering: readonly string[],
  followUp: readonly string[],
): void {
  const session = entry.runtime.session;
  entry.queuedMessages = reconcileQueuedMessages(
    entry.queuedMessages,
    steering,
    followUp,
    extractUserMessageTexts(session.messages as unknown[] | undefined),
  );
}

/** Re-sync UI queue from live session queues + transcript (e.g. after message_end). */
export function syncQueuedMessagesFromSession(entry: SessionEntry): void {
  const session = entry.runtime.session as {
    getSteeringMessages?: () => readonly string[];
    getFollowUpMessages?: () => readonly string[];
    messages?: unknown[];
  };
  applyQueueReconcile(
    entry,
    session.getSteeringMessages?.() ?? [],
    session.getFollowUpMessages?.() ?? [],
  );
}

export function bindSessionEvents(
  entry: SessionEntry,
  subagentManager: SubagentManager,
  getModelRuntime?: () => ModelRuntime,
): void {
  // Fresh binding (new session / cwd rebind) can still auto-title.
  const autoTitleState = createAutoTitleState();
  entry.unsubscribe?.();
  entry.unsubscribe = entry.runtime.session.subscribe(async (event) => {
    entry.lastActive = Date.now();
    const broadcast = (e: ServerEvent) => broadcastTo(entry, e);
    switch (event.type) {
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta") {
          broadcast({ type: "delta", kind: "text", delta: e.delta });
        } else if (e.type === "thinking_delta") {
          broadcast({ type: "delta", kind: "thinking", delta: e.delta });
        }
        break;
      }
      case "message_end":
        // message_end is when user messages join session.messages; prune delivered queue rows here.
        syncQueuedMessagesFromSession(entry);
        broadcastSnapshot(entry, subagentManager);
        if (getModelRuntime) {
          void autoTitleEntry(entry, getModelRuntime, autoTitleState);
        }
        break;
      case "tool_execution_start":
        broadcast({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName });
        break;
      case "tool_execution_end":
        broadcast({
          type: "tool_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
        });
        broadcastSnapshot(entry, subagentManager);
        break;
      case "agent_start":
        subagentManager.notifyCoordinatorTurnStart(entry.id);
        broadcast({ type: "agent_start" });
        break;
      case "agent_end": {
        broadcast({ type: "agent_end" });
        syncQueuedMessagesFromSession(entry);
        const snap = buildSnapshot(entry, subagentManager);
        snap.isStreaming = false;
        broadcast({ type: "snapshot", snapshot: snap });

        // 标记 Coordinator 当前 turn 结束
        subagentManager.notifyCoordinatorTurnEnd(entry.id);

        // 若队列已空且 Coordinator 空闲，触发 Auto Finalize 检查
        if (!entry.queuedMessages || entry.queuedMessages.length === 0) {
          if (subagentManager.autoFinalize) {
            await subagentManager.tryAutoFinalizeRun(entry.id);
          }
        }
        break;
      }
      case "queue_update": {
        const q = event as {
          steering?: readonly string[];
          followUp?: readonly string[];
        };
        applyQueueReconcile(entry, q.steering ?? [], q.followUp ?? []);
        broadcastSnapshot(entry, subagentManager);
        break;
      }
    }
  });
}

/**
 * Best-effort async auto-title for an unnamed session.
 * Model/provider failures are logged and swallowed; the sidebar keeps falling
 * back to `firstMessage` until (and unless) a name is written.
 */
async function autoTitleEntry(
  entry: SessionEntry,
  getModelRuntime: () => ModelRuntime,
  state: ReturnType<typeof createAutoTitleState>,
): Promise<void> {
  const session = entry.runtime.session;
  // Prefer the session's own runtime so custom providers registered on the
  // session stay resolvable; fall back to the server-wide runtime.
  const resolveRuntime = (): ModelRuntime =>
    entry.runtime.services?.modelRuntime ?? getModelRuntime();
  const title = await maybeAutoTitle({
    session,
    model: session.model,
    state,
    deps: {
      completeSimple: (model, context, options) =>
        resolveRuntime().completeSimple(
          model as Parameters<ModelRuntime["completeSimple"]>[0],
          context as Parameters<ModelRuntime["completeSimple"]>[1],
          options,
        ),
      onError: (err) => {
        console.warn(`[auto-title] Failed to generate title for ${entry.id}:`, err);
      },
    },
  });
  if (title) {
    broadcastTo(entry, { type: "session_name_changed", sessionId: entry.id, name: title });
  }
}
