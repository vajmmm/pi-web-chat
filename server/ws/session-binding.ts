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
  entry.unsubscribe = entry.runtime.session.subscribe((event) => {
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

        // 检查并消费子任务主动上报队列
        if (entry.pendingReports.length > 0) {
          const nextReport = entry.pendingReports.shift();
          subagentManager.notifyCoordinatorReportConsumed(entry.id);
          if (nextReport) {
            setTimeout(() => {
              subagentManager.notifyCoordinatorTurnStart(entry.id);
              entry.runtime.session
                .prompt(nextReport, {
                  ...(entry.runtime.session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
                })
                .catch(console.error);
            }, 200);
          }
        } else {
          // Coordinator Safe Boundary: 当前 Turn 已完整结束且没有等待消费的汇报
          subagentManager.notifyCoordinatorTurnEnd(entry.id, { hasPendingReports: false }).catch(console.error);
        }
        break;
      }
    }
  });
}
