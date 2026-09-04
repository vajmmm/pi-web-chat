import type { WebSocket } from "ws";
import type { ServerEvent } from "../../shared/protocol.ts";
import type { SessionEntry } from "../session/session-registry.ts";
import { buildSnapshot } from "../session/snapshot.ts";
import type { SubagentManager } from "../subagent-manager.ts";

export function sendTo(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(event));
    } catch (err) {
      // WebSocket delivery is best-effort and must not abort the Agent Core
      // event pipeline when a client is closing or has already failed.
      console.warn("[WebSocket] Failed to send event:", err);
    }
  }
}

export function broadcastTo(entry: SessionEntry, event: ServerEvent): void {
  let data: string;
  try {
    data = JSON.stringify(event);
  } catch (err) {
    console.warn("[WebSocket] Failed to serialize broadcast event:", err);
    return;
  }
  for (const ws of entry.clients) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(data);
      } catch (err) {
        console.warn("[WebSocket] Failed to broadcast event:", err);
      }
    }
  }
}

export function publishEntry(entry: SessionEntry, ws?: WebSocket): void {
  entry.published = true;
  const event: ServerEvent = { type: "session_bound", sessionId: entry.id };
  if (ws) sendTo(ws, event);
  else broadcastTo(entry, event);
}

export function broadcastSnapshot(
  entry: SessionEntry,
  subagentManager: SubagentManager,
): void {
  broadcastTo(entry, {
    type: "snapshot",
    snapshot: buildSnapshot(entry, subagentManager),
  });
}
