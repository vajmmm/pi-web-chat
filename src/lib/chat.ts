import { useSyncExternalStore } from "react";
import type { AgentRole, ClientCommand, ServerEvent, UISnapshot } from "../../shared/protocol";

export interface ActiveTool {
  toolCallId: string;
  toolName: string;
}

/** WS lifecycle for chrome status (avoid red flash on first paint). */
export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface ChatState {
  connection: ConnectionStatus;
  sessionId: string | null;
  snapshot: UISnapshot | null;
  streamText: string;
  streamThinking: string;
  activeTools: ActiveTool[];
  injectText: string | null;
  focusToken: number;
}

const initialState: ChatState = {
  connection: "connecting",
  sessionId: null,
  snapshot: null,
  streamText: "",
  streamThinking: "",
  activeTools: [],
  injectText: null,
  focusToken: 0,
};

class ChatClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private reconnectDelay = 400;
  private intentionalClose = false;
  /** After a drop, stay on "connecting" briefly before showing disconnected. */
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private everConnected = false;
  private target: string | null = null;
  private currentCwd: string | null = null;
  private pendingText = "";
  private pendingThinking = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  state: ChatState = initialState;

  connect(sessionId: string | null = null, opts?: { force?: boolean; cwd?: string }) {
    if (opts?.cwd) {
      this.currentCwd = opts.cwd;
    }
    if (this.ws) {
      const current = this.state.sessionId ?? this.target;
      if (!opts?.force && (sessionId === null ? this.target === null : sessionId === current)) {
        return;
      }
      this.closeSocket();
      this.clearPendingDeltas();
      this.update({
        snapshot: null,
        sessionId: null,
        streamText: "",
        streamThinking: "",
        activeTools: [],
      });
    }
    this.target = sessionId;
    if (this.state.connection === "disconnected") {
      this.update({ connection: "connecting" });
    }

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams();
    if (sessionId) params.set("session", sessionId);
    const effectiveCwd = opts?.cwd ?? this.currentCwd;
    if (effectiveCwd) params.set("cwd", effectiveCwd);
    const query = params.toString() ? `?${params.toString()}` : "";
    const ws = new WebSocket(`${proto}://${location.host}/ws${query}`);
    this.ws = ws;

    ws.onopen = () => {
      this.clearDisconnectTimer();
      this.reconnectDelay = 400;
      this.everConnected = true;
      this.update({ connection: "connected" });
    };
    ws.onmessage = (e) => {
      try {
        this.handle(JSON.parse(e.data) as ServerEvent);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.intentionalClose) return;

      // Soft state while retrying — don't flash red on first paint / brief blips.
      if (this.state.connection === "connected") {
        this.update({ connection: "connecting" });
      }
      this.scheduleDisconnected();
      const retryTarget = this.state.sessionId ?? this.target;
      setTimeout(() => {
        this.target = retryTarget;
        this.connect(retryTarget);
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(Math.round(this.reconnectDelay * 1.6), 8_000);
    };
    ws.onerror = () => ws.close();
  }

  private closeSocket() {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  send(cmd: ClientCommand) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
    }
  }

  private scheduleDisconnected() {
    this.clearDisconnectTimer();
    // First load: wait longer before red. After a live session drop: faster.
    const graceMs = this.everConnected ? 1_200 : 4_000;
    this.disconnectTimer = setTimeout(() => {
      if (this.ws?.readyState === WebSocket.OPEN) return;
      this.update({ connection: "disconnected" });
    }, graceMs);
  }

  private clearDisconnectTimer() {
    if (this.disconnectTimer !== null) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  private handle(event: ServerEvent) {
    switch (event.type) {
      case "session_bound":
        this.target = event.sessionId;
        this.update({ sessionId: event.sessionId });
        break;
      case "snapshot":
        if (event.snapshot.cwd) {
          this.currentCwd = event.snapshot.cwd;
        }
        this.flushPendingDeltas();
        this.update({ snapshot: event.snapshot, streamText: "", streamThinking: "" });
        break;
      case "delta":
        if (event.kind === "text") {
          this.pendingText += event.delta;
        } else {
          this.pendingThinking += event.delta;
        }
        this.scheduleDeltaFlush();
        break;
      case "tool_start":
        this.update({
          activeTools: [
            ...this.state.activeTools,
            { toolCallId: event.toolCallId, toolName: event.toolName },
          ],
        });
        break;
      case "tool_end":
        this.update({
          activeTools: this.state.activeTools.filter((t) => t.toolCallId !== event.toolCallId),
        });
        break;
      case "agent_start":
        this.update({
          snapshot: this.state.snapshot ? { ...this.state.snapshot, isStreaming: true } : null,
        });
        break;
      case "agent_end":
        this.flushPendingDeltas();
        this.update({
          activeTools: [],
          streamText: "",
          streamThinking: "",
          snapshot: this.state.snapshot
            ? { ...this.state.snapshot, isStreaming: false }
            : null,
        });
        break;
      case "subagent_spawned":
      case "subagent_updated":
      case "subagent_reported": {
        const subagents = this.state.snapshot?.subagents ?? [];
        const index = subagents.findIndex((s) => s.taskId === event.task.taskId);
        const nextSubagents =
          index >= 0
            ? subagents.map((s, i) => (i === index ? event.task : s))
            : [event.task, ...subagents];
        if (this.state.snapshot) {
          this.update({
            snapshot: {
              ...this.state.snapshot,
              subagents: nextSubagents,
            },
          });
        }
        break;
      }
      case "compaction_start":
        if (this.state.snapshot) {
          this.update({ snapshot: { ...this.state.snapshot, isCompacting: true } });
        }
        break;
      case "compaction_end":
        if (this.state.snapshot) {
          this.update({ snapshot: { ...this.state.snapshot, isCompacting: false } });
        }
        break;
      case "forked":
        if (event.selectedText) this.update({ injectText: event.selectedText });
        break;
      case "error":
        console.error("[pi-web-chat]", event.message);
        break;
    }
  }

  setSessionRole(role: AgentRole) {
    this.send({ type: "set_session_role", role });
  }

  abortSubagent(taskId: string) {
    this.send({ type: "abort_subagent", taskId });
  }

  deleteSubagentTask(taskId: string) {
    this.send({ type: "delete_subagent_task", taskId });
  }

  clearSubagentTasks() {
    this.send({ type: "clear_subagent_tasks" });
  }

  consumeInjectText() {
    if (this.state.injectText !== null) this.update({ injectText: null });
  }

  requestComposerFocus() {
    window.setTimeout(() => {
      this.update({ focusToken: this.state.focusToken + 1 });
    }, 50);
  }

  private scheduleDeltaFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPendingDeltas();
    }, 40);
  }

  private flushPendingDeltas() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const text = this.pendingText;
    const thinking = this.pendingThinking;
    if (!text && !thinking) return;
    this.pendingText = "";
    this.pendingThinking = "";
    this.update({
      streamText: text ? this.state.streamText + text : this.state.streamText,
      streamThinking: thinking ? this.state.streamThinking + thinking : this.state.streamThinking,
    });
  }

  private clearPendingDeltas() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingText = "";
    this.pendingThinking = "";
  }

  private update(partial: Partial<ChatState>) {
    this.state = { ...this.state, ...partial };
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.state;
}

export const chatClient = new ChatClient();

export function useChat(): ChatState {
  return useSyncExternalStore(chatClient.subscribe, chatClient.getSnapshot);
}
