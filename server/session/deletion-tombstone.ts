import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type DeletionStage =
  | "quiescing"
  | "disposing_subagents"
  | "git_cleanup"
  | "metadata_cleanup"
  | "disposing_parent"
  | "session_file_delete";

export interface PendingDeletionRecord {
  sessionId: string;
  cwd?: string;
  stage: DeletionStage;
  startedAt: string;
  lastError?: string;
}

let pendingDeletionsCache: Map<string, PendingDeletionRecord> | null = null;

export function getPendingDeletionsFilePath(): string {
  return join(getAgentDir(), "pending-deletions.json");
}

export const VALID_DELETION_STAGES: readonly DeletionStage[] = [
  "quiescing",
  "disposing_subagents",
  "git_cleanup",
  "metadata_cleanup",
  "disposing_parent",
  "session_file_delete",
] as const;

const validStageSet = new Set<string>(VALID_DELETION_STAGES);

function isValidPendingDeletionRecord(item: unknown): item is PendingDeletionRecord {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return false;
  }
  const rec = item as Record<string, unknown>;
  if (typeof rec.sessionId !== "string" || rec.sessionId.trim().length === 0) {
    return false;
  }
  if (typeof rec.stage !== "string" || !validStageSet.has(rec.stage)) {
    return false;
  }
  if (typeof rec.startedAt !== "string" || rec.startedAt.trim().length === 0 || Number.isNaN(Date.parse(rec.startedAt))) {
    return false;
  }
  if (rec.cwd !== undefined && typeof rec.cwd !== "string") {
    return false;
  }
  if (rec.lastError !== undefined && typeof rec.lastError !== "string") {
    return false;
  }
  return true;
}

export function loadPendingDeletions(): Map<string, PendingDeletionRecord> {
  const filePath = getPendingDeletionsFilePath();
  const map = new Map<string, PendingDeletionRecord>();

  if (!existsSync(filePath)) {
    return map;
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `[deletion-tombstone] Failed to read pending deletions from ${filePath}: ${String(err instanceof Error ? err.message : err)}`,
    );
  }

  if (!raw.trim()) {
    throw new Error(`[deletion-tombstone] Pending deletions file is empty (fail-closed): ${filePath}`);
  }

  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[deletion-tombstone] Failed to parse pending deletions from ${filePath}: ${String(err instanceof Error ? err.message : err)}`,
    );
  }

  if (!Array.isArray(list)) {
    throw new Error(`[deletion-tombstone] Pending deletions file is not an array (fail-closed): ${filePath}`);
  }

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!isValidPendingDeletionRecord(item)) {
      throw new Error(
        `[deletion-tombstone] Malformed record at index ${i} in ${filePath} (fail-closed)`,
      );
    }
    map.set(item.sessionId, item);
  }

  return map;
}

export function savePendingDeletions(records: Map<string, PendingDeletionRecord>): void {
  const filePath = getPendingDeletionsFilePath();
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const list = Array.from(records.values());
  if (list.length === 0) {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    return;
  }

  const tmpFile = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmpFile, JSON.stringify(list, null, 2), "utf8");
    renameSync(tmpFile, filePath);
  } catch (err) {
    console.warn(`[deletion-tombstone] Failed to write pending deletions to ${filePath}:`, err);
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function getCache(): Map<string, PendingDeletionRecord> {
  if (!pendingDeletionsCache) {
    pendingDeletionsCache = loadPendingDeletions();
  }
  return pendingDeletionsCache;
}

export function isPendingDeletion(sessionId: string): boolean {
  if (!sessionId) return false;
  return getCache().has(sessionId);
}

export function getPendingDeletion(sessionId: string): PendingDeletionRecord | undefined {
  if (!sessionId) return undefined;
  return getCache().get(sessionId);
}

function commitPendingDeletions(next: Map<string, PendingDeletionRecord>): void {
  savePendingDeletions(next);
  pendingDeletionsCache = next;
}

export function recordPendingDeletion(record: PendingDeletionRecord): void {
  const cache = getCache();
  const next = new Map(cache);
  next.set(record.sessionId, { ...record });
  commitPendingDeletions(next);
}

export function updatePendingDeletionStage(
  sessionId: string,
  stage: DeletionStage,
  lastError?: string,
): void {
  const cache = getCache();
  const existing = cache.get(sessionId);
  const next = new Map(cache);
  if (existing) {
    next.set(sessionId, {
      ...existing,
      stage,
      lastError: lastError !== undefined ? lastError : existing.lastError,
    });
  } else {
    next.set(sessionId, {
      sessionId,
      stage,
      startedAt: new Date().toISOString(),
      lastError,
    });
  }
  commitPendingDeletions(next);
}

export function removePendingDeletion(sessionId: string): void {
  const cache = getCache();
  if (!cache.has(sessionId)) return;
  const next = new Map(cache);
  next.delete(sessionId);
  commitPendingDeletions(next);
}

export function clearPendingDeletionsCache(): void {
  pendingDeletionsCache = null;
}
