import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { UISubagentTask } from "../../shared/protocol.ts";
import { isCanonicalRole } from "../contracts/roles.ts";
import type { SubagentInstance } from "./types.ts";

export const subagentTasks = new Map<string, SubagentInstance>();

export function subagentsDir(): string {
  const dir = join(getAgentDir(), "subagent-tasks");
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  return dir;
}

export function computeDurationMs(task: { startedAt?: string; createdAt: string; completedAt?: string }): number | undefined {
  if (!task.completedAt) return undefined;
  const start = new Date(task.startedAt || task.createdAt).getTime();
  const end = new Date(task.completedAt).getTime();
  if (isNaN(start) || isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

export function taskFilePath(taskId: string): string {
  return join(subagentsDir(), `${taskId}.json`);
}

export function persistTask(task: UISubagentTask): void {
  try {
    const file = taskFilePath(task.taskId);
    const tmpFile = `${file}.${Date.now()}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(task, null, 2), "utf8");
    renameSync(tmpFile, file);
  } catch (err) {
    console.warn(`[SubagentManager] Failed to persist task ${task.taskId}:`, err);
  }
}

export function loadPersistedTasks(): Map<string, UISubagentTask> {
  const map = new Map<string, UISubagentTask>();
  const dir = subagentsDir();
  if (!existsSync(dir)) return map;

  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const content = readFileSync(join(dir, f), "utf8");
        const task = JSON.parse(content) as UISubagentTask;
        if (task && task.taskId) {
          const role = (task as any).role;
          const contractRole = (task as any).taskContract?.role;
          if (
            !isCanonicalRole(role) ||
            (contractRole && !isCanonicalRole(contractRole)) ||
            (contractRole && contractRole !== role)
          ) {
            console.warn(
              `[SubagentManager] Quarantined legacy/invalid persisted task ${task.taskId} with non-canonical role: "${role}". Skipping.`,
            );
            continue;
          }

          if (task.status === "running") {
            task.status = "interrupted";
            task.error = "服务重启已终止";
            task.completedAt = task.completedAt || new Date().toISOString();
            task.durationMs = computeDurationMs(task);
            persistTask(task);
          } else if (task.completedAt && task.durationMs === undefined) {
            task.durationMs = computeDurationMs(task);
            persistTask(task);
          }
          map.set(task.taskId, task);
        }
      } catch (err) {
        console.warn(`[SubagentManager] Failed to read task file ${f}:`, err);
      }
    }
  } catch (err) {
    console.warn("[SubagentManager] Failed to scan subagents dir:", err);
  }

  return map;
}

export function deleteTaskFile(taskId: string): boolean {
  const file = taskFilePath(taskId);
  if (!existsSync(file)) return true;
  try {
    unlinkSync(file);
    return true;
  } catch (err) {
    console.warn(`[SubagentManager] Failed to remove task file ${file}:`, err);
    return false;
  }
}

