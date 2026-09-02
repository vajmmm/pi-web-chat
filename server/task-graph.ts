/**
 * Task Dependency Graph
 *
 * Lightweight dependency tracker that enforces task ordering.
 * Uses the existing subagentTasks Map as the backing store.
 *
 * Coordinator decides dependency relationships. Runtime enforces them.
 */

import type { TaskExecutionStatus } from "./contracts/task.ts";

/** Minimal task info needed for dependency resolution */
interface TaskInfo {
  taskId: string;
  status: TaskExecutionStatus;
  dependsOn: string[];
}

export type DependencyLookup = (id: string) => boolean | TaskExecutionStatus | undefined;

/**
 * 满足性检查所需的最小 Task 契约结构
 */
export interface TaskSatisfiableInfo {
  taskId: string;
  status: TaskExecutionStatus;
  reworkOfTaskId?: string;
  taskContract?: { reworkOfTaskId?: string };
  verification?: { overall: string } | null;
  review?: { verdict: string } | null;
  taskResult?: {
    verification?: { overall: string } | null;
    review?: { verdict: string } | null;
  } | null;
}

/**
 * 评估单次 Task 执行是否满足质量与完成标准：
 * 1. 状态必须为 "completed"（非 completed 状态如 failed, aborted, running, blocked, conflict 等一律不满足）
 * 2. 如果存在 Review，verdict 不能为 "REQUEST_CHANGES"
 * 3. 如果存在 Verification 记录：
 *    - verification.overall 必须为 "pass"
 *    - "fail" 和 "partially_verified" 均视为未满足
 * 4. 如果没有 Verification 记录（例如部分非代码/非测试任务且无验证器介入），只要 status === "completed" 且 Review 未拒绝即满足
 */
export function isTaskExecutionSatisfied(task: TaskSatisfiableInfo): boolean {
  if (task.status !== "completed") {
    return false;
  }
  const review = task.review ?? task.taskResult?.review;
  if (review && review.verdict === "REQUEST_CHANGES") {
    return false;
  }
  const verification = task.verification ?? task.taskResult?.verification;
  if (verification) {
    return verification.overall === "pass";
  }
  return true;
}

/**
 * 评估某个任务的依赖 Lineage 是否已被满足：
 * 沿着 reworkOfTaskId 线性链条 (A -> B -> C...) 追踪到当前唯一的有效终端叶子节点 (leaf)。
 * 只有当该有效 leaf 自身的单次执行质量满足标准 (isTaskExecutionSatisfied) 时，该 Lineage 才判定为 satisfied。
 *
 * 关键不变式与语义：
 * 1. 历史任务的结果（即使曾经是 PASS）一旦被后续显式 Rework 接续，即被新执行 supersede。
 * 2. 若存在正在进行的 Rework（leaf 处于 running / ready / blocked / conflict），Lineage 视为未满足 (false)。
 * 3. 若最新 Rework 失败（leaf fail），Lineage 视为未满足 (false)。
 * 4. 仅当最新有效 leaf 执行完成且通过质量 Gate（leaf pass），Lineage 视为满足 (true)。
 * 5. 多轮返工 (A fail -> B fail -> C pass)，有效 leaf 为 C (pass)，Lineage 视为满足 (true)。
 * 6. 过程中所有历史 Task 节点记录与状态保持不可变。
 */
export function isTaskLineageSatisfied(
  taskId: string,
  getTask: (id: string) => TaskSatisfiableInfo | undefined,
  allTasks?: TaskSatisfiableInfo[] | Iterable<TaskSatisfiableInfo>,
): boolean {
  const root = getTask(taskId);
  if (!root) return false;

  const pool = allTasks
    ? Array.isArray(allTasks)
      ? allTasks
      : Array.from(allTasks)
    : [root];

  // 沿着线性返工链追踪最新后继 (leaf)
  let leaf: TaskSatisfiableInfo = root;
  const visited = new Set<string>([leaf.taskId]);

  while (true) {
    let next: TaskSatisfiableInfo | undefined;
    for (const t of pool) {
      const target = t.reworkOfTaskId ?? t.taskContract?.reworkOfTaskId;
      if (target === leaf.taskId && !visited.has(t.taskId)) {
        next = t;
        break;
      }
    }
    if (!next) {
      break;
    }
    visited.add(next.taskId);
    leaf = next;
  }

  return isTaskExecutionSatisfied(leaf);
}

/**
 * TaskGraph tracks dependencies between tasks and controls readiness transitions.
 *
 * Not a standalone data store: it reads task status/satisfaction from a provided lookup function,
 * so it stays in sync with SubagentManager's subagentTasks Map automatically.
 */
export class TaskGraph {
  /** taskId -> list of dependency taskIds */
  private deps = new Map<string, string[]>();

  /**
   * Register a task with its dependencies.
   */
  addTask(taskId: string, dependsOn: string[]): void {
    this.deps.set(taskId, [...dependsOn]);
  }

  /**
   * Remove a task from tracking.
   */
  removeTask(taskId: string): void {
    this.deps.delete(taskId);
  }

  /**
   * Get the dependency list for a task.
   */
  getDependencies(taskId: string): string[] {
    return this.deps.get(taskId) ?? [];
  }

  /**
   * Check whether all dependencies of a task are satisfied (completed).
   * A task with no dependencies is always ready.
   */
  canStart(taskId: string, lookup: DependencyLookup): boolean {
    const taskDeps = this.deps.get(taskId);
    if (!taskDeps || taskDeps.length === 0) return true;

    return taskDeps.every((depId) => {
      const res = lookup(depId);
      if (typeof res === "boolean") return res;
      return res === "completed";
    });
  }

  /**
   * Get all tasks that are currently blocked (have unmet dependencies).
   */
  getBlockedTasks(lookup: DependencyLookup): string[] {
    const blocked: string[] = [];
    for (const [taskId] of this.deps) {
      const res = lookup(taskId);
      const isBlocked = res === "blocked" || res === false;
      if (isBlocked && !this.canStart(taskId, lookup)) {
        blocked.push(taskId);
      }
    }
    return blocked;
  }

  /**
   * Get tasks that were blocked but now have all dependencies met.
   * Returns task IDs that should transition from "blocked" to "ready".
   */
  getNewlyReadyTasks(lookup: DependencyLookup): string[] {
    const ready: string[] = [];
    for (const [taskId] of this.deps) {
      const res = lookup(taskId);
      const isBlocked = res === "blocked" || res === false;
      if (isBlocked && this.canStart(taskId, lookup)) {
        ready.push(taskId);
      }
    }
    return ready;
  }

  /**
   * Check for circular dependencies. Returns the cycle path if found.
   */
  detectCycle(): string[] | null {
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const path: string[] = [];

    const dfs = (taskId: string): boolean => {
      if (inStack.has(taskId)) {
        // Found cycle: extract the cycle from path
        const cycleStart = path.indexOf(taskId);
        return true;
      }
      if (visited.has(taskId)) return false;

      visited.add(taskId);
      inStack.add(taskId);
      path.push(taskId);

      const taskDeps = this.deps.get(taskId) ?? [];
      for (const dep of taskDeps) {
        if (dfs(dep)) return true;
      }

      path.pop();
      inStack.delete(taskId);
      return false;
    };

    for (const [taskId] of this.deps) {
      if (!visited.has(taskId)) {
        if (dfs(taskId)) return path;
      }
    }

    return null;
  }

  /**
   * Clear all tracked dependencies.
   */
  clear(): void {
    this.deps.clear();
  }
}
