import { basename } from "node:path";
import type { WebSocket } from "ws";
import type { createAgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentRole } from "../../shared/protocol.ts";

export interface SessionEntry {
  id: string;
  runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
  clients: Set<WebSocket>;
  unsubscribe?: () => void;
  lastActive: number;
  published: boolean;
  activeRole: AgentRole;
  cwd: string;
  isGitRepo: boolean;
  gitBranch?: string;
  isCompacting?: boolean;
  pendingReports: string[];
}

export function sessionIdOf(file?: string): string {
  if (!file) return "";
  const base = basename(file).replace(/\.jsonl$/, "");
  const i = base.lastIndexOf("_");
  return i >= 0 ? base.slice(i + 1) : base;
}

export async function resolveSessionPath(id: string, cwd?: string, fallbackCwd?: string): Promise<string | undefined> {
  const targetCwd = cwd || fallbackCwd;
  if (!targetCwd) return undefined;
  const sessions = await SessionManager.list(targetCwd);
  const found = sessions.find((s) => sessionIdOf(s.path) === id);
  if (found) return found.path;
  if (fallbackCwd && targetCwd !== fallbackCwd) {
    const fallback = await SessionManager.list(fallbackCwd);
    return fallback.find((s) => sessionIdOf(s.path) === id)?.path;
  }
  return undefined;
}

export class SessionRegistry {
  public readonly entries = new Map<string, SessionEntry>();
  public readonly pending = new Map<string, Promise<SessionEntry>>();
  public readonly wsEntry = new Map<WebSocket, SessionEntry>();

  public get(id: string): SessionEntry | undefined {
    return this.entries.get(id);
  }

  public getByWs(ws: WebSocket): SessionEntry | undefined {
    return this.wsEntry.get(ws);
  }

  public bindWs(ws: WebSocket, entry: SessionEntry): void {
    entry.clients.add(ws);
    this.wsEntry.set(ws, entry);
  }

  public unbindWs(ws: WebSocket): void {
    const entry = this.wsEntry.get(ws);
    if (entry) {
      entry.clients.delete(ws);
      this.wsEntry.delete(ws);
    }
  }

  public set(id: string, entry: SessionEntry): void {
    this.entries.set(id, entry);
  }

  public remove(id: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      this.entries.delete(id);
      entry.unsubscribe?.();
      void entry.runtime.dispose().catch(() => {});
    }
  }

  public all(): SessionEntry[] {
    return Array.from(this.entries.values());
  }

  public rekey(entry: SessionEntry): string | null {
    const next = sessionIdOf(entry.runtime.session.sessionFile);
    if (!next || next === entry.id) return null;
    this.entries.delete(entry.id);
    entry.id = next;
    this.entries.set(next, entry);
    entry.published = true;
    return next;
  }

  public async acquire(
    id: string | null,
    creator: () => Promise<SessionEntry>,
  ): Promise<SessionEntry> {
    if (!id) return creator();
    const hit = this.entries.get(id);
    if (hit) return hit;
    const inflight = this.pending.get(id);
    if (inflight) return inflight;
    const p = creator().finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }

  public startIdlePruning(ttlMs = 15 * 60_000, intervalMs = 60_000): NodeJS.Timeout {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const entry of Array.from(this.entries.values())) {
        if (entry.clients.size > 0 || entry.runtime.session.isStreaming) continue;
        if (now - entry.lastActive < ttlMs) continue;
        this.remove(entry.id);
      }
    }, intervalMs);
    timer.unref();
    return timer;
  }
}
