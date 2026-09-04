import { basename } from "node:path";
import type { WebSocket } from "ws";
import type { createAgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentRole, UIQueuedMessage } from "../../shared/protocol.ts";
import { isPendingDeletion, updatePendingDeletionStage } from "./deletion-tombstone.ts";

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
  pendingReplacementRuntime?: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
  queuedMessages?: UIQueuedMessage[];
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
  public readonly pendingAcquireCleanup = new Map<string, SessionEntry>();
  private inFlightParentOps = new Map<string, Set<Promise<unknown>>>();
  public isDeleting?: (sessionId: string) => boolean;

  public trackInFlightOp<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    let ops = this.inFlightParentOps.get(sessionId);
    if (!ops) {
      ops = new Set();
      this.inFlightParentOps.set(sessionId, ops);
    }
    const p = (async () => {
      return await fn();
    })().finally(() => {
      ops?.delete(p);
      if (ops?.size === 0) {
        this.inFlightParentOps.delete(sessionId);
      }
    });
    ops.add(p);
    return p;
  }

  public async awaitInFlightOps(sessionId: string, timeoutMs = 5000): Promise<boolean> {
    const ops = this.inFlightParentOps.get(sessionId);
    if (!ops || ops.size === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    await Promise.race([Promise.allSettled(Array.from(ops)), timeoutPromise]);
    if (timer) clearTimeout(timer);
    return (this.inFlightParentOps.get(sessionId)?.size ?? 0) === 0;
  }

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

  /**
   * 删除流程专用的严格删除：先 await runtime.dispose()，成功后才注销事件并从 Registry 移除。
   * 同时彻底解除所有客户端 ws 映射，发送 session_deleted 通知。
   * 若 dispose 抛异常，不吞异常，保留 Registry entry，fail-closed。
   */
  public async disposeAndRemoveStrict(id: string): Promise<void> {
    const pendingCleanup = this.pendingAcquireCleanup.get(id);
    if (pendingCleanup) {
      await pendingCleanup.runtime.dispose();
      this.pendingAcquireCleanup.delete(id);
    }

    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.pendingReplacementRuntime) {
      await entry.pendingReplacementRuntime.dispose();
      entry.pendingReplacementRuntime = undefined;
    }
    await entry.runtime.dispose();
    entry.unsubscribe?.();
    this.entries.delete(id);

    // 彻底解绑所有 WebSocket 客户端
    for (const ws of Array.from(entry.clients)) {
      this.wsEntry.delete(ws);
      try {
        ws.send(JSON.stringify({ type: "session_deleted", sessionId: id }));
      } catch {
        /* ignore */
      }
    }
    entry.clients.clear();
  }

  /**
   * 普通非删除流程的尽力清理
   */
  public async removeBestEffort(id: string): Promise<void> {
    const pendingCleanup = this.pendingAcquireCleanup.get(id);
    if (pendingCleanup) {
      this.pendingAcquireCleanup.delete(id);
      try {
        await pendingCleanup.runtime.dispose();
      } catch {
        /* ignore dispose error */
      }
    }

    const entry = this.entries.get(id);
    if (entry) {
      this.entries.delete(id);
      entry.unsubscribe?.();
      for (const ws of Array.from(entry.clients)) {
        this.wsEntry.delete(ws);
      }
      entry.clients.clear();
      if (entry.pendingReplacementRuntime) {
        try {
          await entry.pendingReplacementRuntime.dispose();
          entry.pendingReplacementRuntime = undefined;
        } catch {
          /* ignore dispose error */
        }
      }
      try {
        await entry.runtime.dispose();
      } catch {
        /* ignore dispose error */
      }
    }
  }

  public async remove(id: string, options?: { strict?: boolean }): Promise<void> {
    if (options?.strict) {
      return this.disposeAndRemoveStrict(id);
    }
    return this.removeBestEffort(id);
  }

  public async abortStreamingSession(id: string, timeoutMs = 5000): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return true;
    if (!entry.runtime?.session?.isStreaming) return true;

    try {
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Parent session abort timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timeoutHandle.unref?.();
      });

      await Promise.race([
        entry.runtime.session.abort(),
        timeoutPromise,
      ]).finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      });

      return !entry.runtime.session.isStreaming;
    } catch (err) {
      console.warn(`[SessionRegistry] Failed to abort streaming session ${id}:`, err);
      return false;
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
    if (id && (isPendingDeletion(id) || this.isDeleting?.(id))) {
      throw new Error(`Cannot acquire session ${id}: session is pending deletion`);
    }
    if (!id) return creator();
    const hit = this.entries.get(id);
    if (hit) return hit;
    const inflight = this.pending.get(id);
    if (inflight) return inflight;
    const p = creator()
      .then(async (entry) => {
        if (isPendingDeletion(id) || this.isDeleting?.(id)) {
          // 异步创建期间发生删除：立即销毁新创建的运行时，绝不插入 entries
          try {
            await entry.runtime.dispose();
            this.pendingAcquireCleanup.delete(id);
          } catch (disposeErr) {
            this.pendingAcquireCleanup.set(id, entry);
            updatePendingDeletionStage(
              id,
              "quiescing",
              `In-flight acquire runtime dispose failed: ${String(disposeErr instanceof Error ? disposeErr.message : disposeErr)}`,
            );
            throw new AggregateError(
              [new Error(`Cannot acquire session ${id}: session is pending deletion`), disposeErr],
              `Cannot acquire session ${id}: session is pending deletion and runtime cleanup dispose failed`,
            );
          }
          throw new Error(`Cannot acquire session ${id}: session is pending deletion`);
        }
        return entry;
      })
      .finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }

  public startIdlePruning(
    canPrune?: (sessionId: string) => boolean,
    ttlMs = 15 * 60_000,
    intervalMs = 60_000,
  ): NodeJS.Timeout {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const entry of Array.from(this.entries.values())) {
        if (entry.clients.size > 0 || entry.runtime.session.isStreaming) continue;
        if (now - entry.lastActive < ttlMs) continue;
        if (canPrune && !canPrune(entry.id)) continue;
        void this.disposeAndRemoveStrict(entry.id).catch((err) => {
          console.warn(`[SessionRegistry] Idle prune dispose-first failed for ${entry.id}:`, err);
        });
      }
    }, intervalMs);
    timer.unref();
    return timer;
  }
}
