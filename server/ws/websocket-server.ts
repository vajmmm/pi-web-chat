import type { WebSocket } from "ws";
import type { ServerEvent } from "../../shared/protocol.ts";
import type { SessionEntry } from "../session/session-registry.ts";
import { buildSnapshot } from "../session/snapshot.ts";
import type { SubagentManager } from "../subagent-manager.ts";

export function sendTo(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

export function broadcastTo(entry: SessionEntry, event: ServerEvent): void {
  const data = JSON.stringify(event);
  for (const ws of entry.clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
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
