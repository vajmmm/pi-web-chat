import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Migration-only location used by releases before the Fact Store architecture. */
export function getTaskMemoriesRoot(): string {
  return join(getAgentDir(), "task-memories");
}

export function getTaskMemoryDir(taskId: string): string {
  const dir = join(getTaskMemoriesRoot(), taskId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Test/migration helper. Active task startup never calls this function. */
export function initTaskMemory(taskId: string, _goal?: string): {
  workingMemoryPath: string;
  processJournalPath: string;
} {
  const dir = getTaskMemoryDir(taskId);
  const marker = join(dir, "legacy-memory.json");
  if (!existsSync(marker)) writeFileSync(marker, "{}\n", "utf8");
  return {
    workingMemoryPath: join(dir, "working-memory.md"),
    processJournalPath: join(dir, "process-journal.md"),
  };
}

export function removeTaskMemory(taskId: string): boolean {
  if (!taskId || typeof taskId !== "string" || !taskId.trim()) return false;
  const trimmed = taskId.trim();
  if (
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) return false;

  const root = resolve(getTaskMemoriesRoot());
  const targetDir = resolve(root, trimmed);
  const rel = relative(root, targetDir);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel !== trimmed || targetDir === root) return false;
  if (!existsSync(targetDir)) return true;
  try {
    rmSync(targetDir, { recursive: true, force: true });
    return true;
  } catch (error) {
    console.warn(`[LegacyTaskMemory] Failed to remove ${targetDir}:`, error);
    return false;
  }
}
