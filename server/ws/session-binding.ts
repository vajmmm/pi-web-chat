import type { ServerEvent } from "../../shared/protocol.ts";
import type { SessionEntry } from "../session/session-registry.ts";
import { buildSnapshot } from "../session/snapshot.ts";
import type { SubagentManager } from "../subagent-manager.ts";
import { broadcastSnapshot, broadcastTo } from "./websocket-server.ts";

export function bindSessionEvents(
  entry: SessionEntry,
  subagentManager: SubagentManager,
): void {
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
        broadcastSnapshot(entry, subagentManager);
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
        const steering = ((event as any).steering as string[]) ?? [];
        const followUp = ((event as any).followUp as string[]) ?? [];
        const remainingFollowUps = [...followUp];
        const remainingSteerings = [...steering];
        const newQueuedList: typeof entry.queuedMessages = [];

        if (entry.queuedMessages) {
          for (const item of entry.queuedMessages) {
            if (item.mode === "steer") {
              const idx = remainingSteerings.indexOf(item.text);
              if (idx !== -1) {
                newQueuedList.push(item);
                remainingSteerings.splice(idx, 1);
              }
            } else {
              const idx = remainingFollowUps.indexOf(item.text);
              if (idx !== -1) {
                newQueuedList.push(item);
                remainingFollowUps.splice(idx, 1);
              }
            }
          }
        }
        for (const s of remainingSteerings) {
          newQueuedList.push({ id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text: s, mode: "steer", createdAt: new Date().toISOString() });
        }
        for (const f of remainingFollowUps) {
          newQueuedList.push({ id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text: f, mode: "followUp", createdAt: new Date().toISOString() });
        }
        entry.queuedMessages = newQueuedList;
        broadcastSnapshot(entry, subagentManager);
        break;
      }
    }
  });
}
