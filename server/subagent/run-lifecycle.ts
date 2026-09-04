import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { UISubagentTask } from "../../shared/protocol.ts";
import type { TaskExecutionStatus, TaskResult } from "../contracts/index.ts";
import { runGit } from "../git/git.ts";
import { findRepoRootForWorktree } from "../git/runtime-resources.ts";
import { getRoleConfig } from "../roles.ts";
import { serializeMessages } from "../serialize.ts";
import { buildBoundedCompletionReport } from "../subagent-report.ts";
import { isPendingDeletion } from "../session/deletion-tombstone.ts";
import { deleteSessionTurns } from "../turn-recorder.ts";
import { removeTaskMemory } from "../task-memory.ts";
import {
  cleanupRunResources,
  finalizeRun as finalizeGitRun,
  loadPersistedRuntimeResources,
  removeWorktree,
  resolveGitRepoRoot,
  resolveProjectRoot,
  unregisterRuntimeResource,
  type CleanupResult,
  type FinalizeMode,
  type FinalizeResult,
  type IntegrationWorkspace,
  type QuiescenceResult,
} from "../worktree.ts";
import { computeDurationMs, deleteTaskFile, persistTask, subagentTasks } from "./task-store.ts";
import type { SubagentInstance } from "./types.ts";
import type { AbortSource, SubagentManagerHost } from "./manager-host.ts";
import { waitForActiveTools } from "./runtime-control.ts";

  /**
   * 自动检查当前会话的所有子任务生命周期与质量 Gate。
   * 调度触发点为会话 agent_end（Coordinator 空闲且消息队列全空时触发）。
   * 本方法作为底层防御性 Gate，严格校验：
   * 1. Coordinator 非执行态 (isCoordinatorActive === false)；
   * 2. 无正在执行中的 finalize (finalizingRuns in-flight lock)；
   * 3. 对应 Session 的 Integration 工作区已初始化；
   * 4. 该会话所有任务 Lineage 叶子节点均满足通过标准且无运行中/返工中任务。
   * 当且仅当所有 Gate 校验全部通过时，自动将 Integration 工作区改动写回用户工作区。
   */
export async function tryAutoFinalizeRun(mgr: SubagentManagerHost, parentSessionId: string): Promise<FinalizeResult | null> {
    if (mgr.deletingRuns.has(parentSessionId)) {
      return null;
    }
    if (mgr.isCoordinatorActive(parentSessionId)) {
      return null;
    }

    if (mgr.finalizingRuns.has(parentSessionId)) {
      return null;
    }
    if (mgr.finalizedRuns.has(parentSessionId)) {
      return mgr.finalizedRuns.get(parentSessionId)!;
    }

    const integration = mgr.integrations.get(parentSessionId);
    if (!integration) return null;

    if (!mgr.isSessionLineageSatisfied(parentSessionId)) {
      return null;
    }

    mgr.finalizingRuns.add(parentSessionId);
    const finalizePromise = mgr.finalizeRun(parentSessionId, { mode: "working_tree" });
    mgr.finalizingRunPromises.set(parentSessionId, finalizePromise);
    try {
      return await finalizePromise;
    } catch (err) {
      console.warn(`[SubagentManager] Auto finalizeRun failed for session ${parentSessionId}:`, err);
      return null;
    } finally {
      mgr.finalizingRuns.delete(parentSessionId);
      mgr.finalizingRunPromises.delete(parentSessionId);
    }
  }

  /**
   * 中断指定的 Subagent (标记为 aborted，若非主动放弃则向 Coordinator 上报)
   */
export async function abort(mgr: SubagentManagerHost, taskId: string, options?: { source?: AbortSource }): Promise<boolean> {
    const instance = subagentTasks.get(taskId);
    if (!instance) return false;

    // 若存在初始化清理错误，abort 调用自动重试清理
    if (instance.initializationCleanupError) {
      return await mgr.retryInitializationCleanup(instance);
    }

    if (
      instance.reported ||
      instance.terminalizing ||
      instance.aborting ||
      instance.task.status === "aborted" ||
      instance.task.status === "completed" ||
      instance.task.status === "failed" ||
      instance.task.status === "interrupted" ||
      instance.task.status === "incomplete" ||
      instance.task.status === "conflict"
    ) {
      return false;
    }
    instance.aborting = true;
    const source = options?.source ?? "system";
    const isSilent = source === "coordinator" || source === "user";
    let abortReason = "任务已被用户或 Coordinator 主动终止 (aborted)";
    if (source === "timeout") {
      abortReason = "子任务执行超时并被终止";
    } else if (source === "system") {
      abortReason = "子任务因系统原因被终止";
    }

    try {
      // session.abort() must propagate: callers (deletion quiescence) treat
      // a thrown abort as failure. Tool wait happens only after abort succeeds.
      if (instance.runtime) {
        await instance.runtime.session.abort();
      }
      await waitForActiveTools(instance);
      instance.terminalizing = true;
      if (instance.timeoutTimer) {
        clearTimeout(instance.timeoutTimer);
        instance.timeoutTimer = undefined;
      }
      instance.task.status = "aborted";
      instance.task.completedAt = new Date().toISOString();
      instance.task.durationMs = computeDurationMs(instance.task);
      instance.task.summary = abortReason;
      instance.task.messages = serializeMessages(
        mgr.getSerializableMessages(instance, abortReason),
      );
      const finalTaskResult: TaskResult = {
        taskId: instance.task.taskId,
        role: instance.task.role,
        status: "aborted",
        summary: abortReason,
        startedAt: instance.task.startedAt,
        completedAt: instance.task.completedAt,
        durationMs: instance.task.durationMs,
        meta: { error: abortReason },
      };
      instance.task.taskResult = finalTaskResult;

      const roleConfig = getRoleConfig(instance.task.role);
      const report = buildBoundedCompletionReport({
        taskId: instance.task.taskId,
        taskTitle: instance.task.taskTitle,
        role: instance.task.role,
        roleName: roleConfig.name,
        branch: instance.task.branchName,
        status: "aborted",
        error: abortReason,
        changedFiles: instance.task.changedFiles,
        startedAt: instance.task.startedAt,
        completedAt: instance.task.completedAt,
        durationMs: instance.task.durationMs,
        lastAssistantText: abortReason,
        taskResult: finalTaskResult,
      });

      instance.reported = true;
      persistTask(instance.task);
      mgr.notifyUpdate(instance);
      await mgr.disposeRuntime(instance, "abort");
      instance.aborting = false;
      instance.terminalizing = false;
      instance.pendingTerminal = undefined;
      if (!isSilent && !mgr.deletingRuns.has(instance.task.parentSessionId)) {
        await Promise.resolve(
          instance.onReport?.(instance.task, report.parentReport, { kind: "terminal" }),
        );
      }
      return true;
    } catch {
      instance.aborting = false;
      instance.terminalizing = false;
      const pending = instance.pendingTerminal;
      instance.pendingTerminal = undefined;

      if (pending) {
        if (pending.type === "failed") {
          await mgr.finalizeFailed(instance, pending.error || "执行异常终止");
        } else if (pending.type === "completed") {
          await mgr.finalizeCompleted(instance);
        }
      }
      return false;
    }
  }

  /**
   * 重试清理在初始化阶段因异常残留的运行时与 Git 资源 (Idempotent & Fail-Closed)
   * 仅当所有残留资源（Runtime、Worktree、Branch）全部确认清理成功后，
   * 才清除 initializationCleanupError 并将 task.status 标为 "aborted"。
   */
export async function retryInitializationCleanup(mgr: SubagentManagerHost, instance: SubagentInstance): Promise<boolean> {
    const parentSessionId = instance.task.parentSessionId;
    const taskId = instance.task.taskId;
    const repoRoot =
      instance.repoRoot ||
      (await resolveGitRepoRoot(instance.spawnOptions?.parentCwd || process.cwd()));
    const remainingErrors: string[] = [];

    // 1. 若 runtime 存在，先尝试 abort (若处于 streaming)，再 dispose
    if (instance.runtime) {
      if (instance.runtime.session?.isStreaming) {
        try {
          await instance.runtime.session.abort();
        } catch {
          /* best effort */
        }
      }
      try {
        await instance.runtime.dispose();
        instance.runtime = undefined;
      } catch (err) {
        const msg = `Failed to dispose subagent session runtime during retry cleanup for ${taskId}: ${String(err instanceof Error ? err.message : err)}`;
        console.warn(`[SubagentManager] ${msg}`);
        remainingErrors.push(msg);
      }
    }

    // 2. 若 task.worktreePath 存在，尝试 removeWorktree
    if (instance.task.worktreePath && repoRoot) {
      try {
        await removeWorktree(repoRoot, instance.task.worktreePath);
        unregisterRuntimeResource(parentSessionId, "task_worktree", instance.task.worktreePath, repoRoot);
        instance.task.worktreePath = undefined;
      } catch (err) {
        const msg = `Failed to remove worktree ${instance.task.worktreePath} during retry cleanup for ${taskId}: ${String(err instanceof Error ? err.message : err)}`;
        console.warn(`[SubagentManager] ${msg}`);
        remainingErrors.push(msg);
      }
    }

    // 3. 若 task.branchName 存在，尝试 git branch -D
    if (instance.task.branchName && repoRoot) {
      try {
        await runGit(repoRoot, ["branch", "-D", instance.task.branchName]);
        unregisterRuntimeResource(parentSessionId, "task_branch", instance.task.branchName, repoRoot);
        instance.task.branchName = undefined;
      } catch (err) {
        const msg = `Failed to delete branch ${instance.task.branchName} during retry cleanup for ${taskId}: ${String(err instanceof Error ? err.message : err)}`;
        console.warn(`[SubagentManager] ${msg}`);
        remainingErrors.push(msg);
      }
    }

    if (remainingErrors.length > 0) {
      instance.initializationCleanupError = remainingErrors.join("; ");
      persistTask(instance.task);
      return false;
    }

    // 全部清理成功：清除错误，确认任务安全进入 aborted 终态
    instance.initializationCleanupError = undefined;
    instance.task.status = "aborted";
    instance.task.summary = "Task initialization rollback completed on retry";
    persistTask(instance.task);
    return true;
  }

  /**
   * 删除指定的 Subagent 任务及其磁盘持久化文件，并清理附属 Task Memory (Fail-closed)
   * 必须确保：
   * 1. 存在 initializationCleanupError 时，重试清理残留 side effects 且必须成功；
   * 2. 若任务处于 streaming，尝试 abort 并确认已停止；
   * 3. 若任务未处于 terminal state，尝试 abort 并确认终态；
   * 4. 如果 instance.runtime 存在，必须确认 runtime.dispose() 成功，否则严禁从 subagentTasks 移除；
   * 5. 全部确认安全释放后，清除 timeoutTimer，删除内存映射，删除磁盘持久化及 Task Memory。
   */
export async function deleteTask(mgr: SubagentManagerHost, taskId: string): Promise<boolean> {
    const instance = subagentTasks.get(taskId);
    if (instance) {
      // 1. 如果存在初始化回滚错误，先重试清理残留资源，重试失败严禁当成普通终态任务删除
      if (instance.initializationCleanupError) {
        const retryOk = await mgr.retryInitializationCleanup(instance);
        if (!retryOk) {
          console.warn(
            `[SubagentManager] Cannot delete task ${taskId}: initialization cleanup retry failed: ${instance.initializationCleanupError}`,
          );
          return false;
        }
      }

      const terminalStates: TaskExecutionStatus[] = [
        "completed",
        "failed",
        "aborted",
        "interrupted",
        "incomplete",
      ];

      // 2. 检查 streaming 并确保退出
      let isStreaming = Boolean(instance.runtime?.session?.isStreaming);
      if (isStreaming) {
        try {
          await instance.runtime?.session?.abort();
        } catch {
          /* best effort */
        }
        isStreaming = Boolean(instance.runtime?.session?.isStreaming);
        if (isStreaming) {
          console.warn(`[SubagentManager] Cannot delete task ${taskId}: session is still streaming after abort`);
          return false;
        }
      }

      // 3. 确保进入安全终态
      let isSafelyTerminal = terminalStates.includes(instance.task.status);
      if (!isSafelyTerminal) {
        let aborted = false;
        try {
          aborted = await mgr.abort(taskId, { source: "user" });
        } catch (err) {
          console.warn(`[SubagentManager] Failed to abort task ${taskId} prior to deletion:`, err);
          aborted = false;
        }

        const confirmedTerminal = terminalStates.includes(instance.task.status);
        if (!aborted && !confirmedTerminal) {
          console.warn(
            `[SubagentManager] Cannot delete task ${taskId}: task is running and failed to abort (fail-closed)`,
          );
          return false;
        }
      }

      // 4. 统一 Invariant：从 subagentTasks 永久移除之前，若 instance.runtime 存在，必须确认 runtime.dispose() 成功
      if (instance.runtime) {
        try {
          await instance.runtime.dispose();
          instance.runtime = undefined;
        } catch (err) {
          console.warn(
            `[SubagentManager] Cannot delete task ${taskId}: runtime.dispose() failed: ${String(err instanceof Error ? err.message : err)}. Fail-closed: retaining instance handle.`,
          );
          return false;
        }
      }

      if (instance.timeoutTimer) {
        clearTimeout(instance.timeoutTimer);
        instance.timeoutTimer = undefined;
      }
    }

    try {
      const memOk = removeTaskMemory(taskId);
      if (!memOk) {
        console.warn(
          `[SubagentManager] Cannot delete task ${taskId}: task memory cleanup failed. Preserving persistent task file as retry anchor.`,
        );
        return false;
      }
    } catch (err) {
      console.warn(`[SubagentManager] Unexpected error during memory cleanup for ${taskId}:`, err);
      return false;
    }

    try {
      const turnsOk = deleteSessionTurns(taskId);
      if (!turnsOk) {
        console.warn(
          `[SubagentManager] Cannot delete task ${taskId}: turns cleanup failed. Preserving persistent task file as retry anchor.`,
        );
        return false;
      }
    } catch (err) {
      console.warn(`[SubagentManager] Unexpected error during turns cleanup for ${taskId}:`, err);
      return false;
    }

    try {
      const fileOk = deleteTaskFile(taskId);
      if (!fileOk) {
        console.warn(
          `[SubagentManager] Cannot delete task ${taskId}: task file unlink failed. Preserving in-memory instance and file as retry anchor.`,
        );
        return false;
      }
    } catch (err) {
      console.warn(`[SubagentManager] Failed to delete task file for ${taskId}:`, err);
      return false;
    }

    subagentTasks.delete(taskId);
    mgr.taskGraph.removeTask(taskId);
    return true;
  }

  /**
   * Phase A: 销毁指定 Parent Session 下属所有 Subagent 的 Session Runtime
   * 仅销毁 runtime，完整保留 Task metadata、worktreePath、branchName、所有权与持久化文件
   */
export async function disposeSubagentRuntimesForParent(mgr: SubagentManagerHost, parentSessionId: string): Promise<boolean> {
    let allSucceeded = true;
    for (const [taskId, inst] of subagentTasks.entries()) {
      if (inst.task.parentSessionId === parentSessionId) {
        if (inst.runtime) {
          try {
            await inst.runtime.dispose();
            inst.runtime = undefined;
          } catch (err) {
            console.warn(`[SubagentManager] Failed to dispose runtime for task ${taskId}:`, err);
            allSucceeded = false;
          }
        }
      }
    }
    return allSucceeded;
  }

  /**
   * Phase C: 在 Git 清理成功后，彻底销毁指定 Parent Session 下属的 Subagent 元数据、文件、Memory、TurnRecorder、DAG 与复用智能体
   */
export async function purgeSubagentMetadataForParent(mgr: SubagentManagerHost, parentSessionId: string): Promise<boolean> {
    try {
      await mgr.clearTasksForParent(parentSessionId);
      return true;
    } catch (err) {
      console.warn(`[SubagentManager] Failed to purge subagent metadata for ${parentSessionId}:`, err);
      return false;
    }
  }

  /**
   * 准备删除 Run（Quiescence 阶段）：
   * 1. 标记该 Run 为 deleting，拦截后续 Auto Finalize；
   * 2. 若当前已有 in-flight Auto Finalize，等待其执行完毕，避免并发冲突；
   * 3. 静默停止当前 Parent Session 下仍然处于 active/running 状态的子任务，确保 Runtime 完全 Quiescent；
   * 4. 显式检查 abort() 的真实返回结果，若无法确认进入安全终态则报告 Quiescence Failure；
   * 5. 不删除 Task metadata（保留 metadata 供随后的 Git cleanup 使用）。
   */
export async function prepareRunForDeletion(mgr: SubagentManagerHost, parentSessionId: string, timeoutMs = 5000): Promise<QuiescenceResult> {
    // 1. 标记 deletion gate (互斥门禁)
    mgr.deletingRuns.add(parentSessionId);

    // 2. 等待当前已在进行的 finalize 完成 (serialized)
    const inFlightFinalize = mgr.finalizingRunPromises.get(parentSessionId);
    if (inFlightFinalize) {
      try {
        await inFlightFinalize;
      } catch {
        /* ignore settle error */
      }
    }

    // 2.5 等待已进入 in-flight 的 start/spawn 初始化流程安全退出或取消 (with timeout)
    const inFlightStarts = mgr.inFlightTaskStarts.get(parentSessionId);
    if (inFlightStarts && inFlightStarts.size > 0) {
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([
        Promise.allSettled([...inFlightStarts]),
        timeoutPromise,
      ]).finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      });
    }

    // 2.6 等待已进入 in-flight 的 subagent completion 流程执行完毕
    const inFlightComps = mgr.inFlightCompletions.get(parentSessionId);
    if (inFlightComps && inFlightComps.size > 0) {
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([
        Promise.allSettled([...inFlightComps]),
        timeoutPromise,
      ]).finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      });
    }

    // 3. 静默停止所有运行中/活跃中的子任务，等待 Runtime 真正退出并显式检查 abort() 真实结果
    const failedTaskIds: string[] = [];
    const terminalStates: TaskExecutionStatus[] = [
      "completed",
      "failed",
      "aborted",
      "interrupted",
      "incomplete",
    ];

    for (const [taskId, inst] of subagentTasks.entries()) {
      if (inst.task.parentSessionId === parentSessionId) {
        // FAIL-CLOSED: 若任务在初始化 rollback 期间曾失败，在本次删除准备阶段自动重试清理
        if (inst.initializationCleanupError) {
          const retryOk = await mgr.retryInitializationCleanup(inst);
          if (!retryOk) {
            console.warn(
              `[SubagentManager] Quiescence failure: task ${taskId} had initialization rollback failure and retry failed: ${inst.initializationCleanupError}`,
            );
            failedTaskIds.push(taskId);
            continue;
          }
        }

        const isStreaming = Boolean(inst.runtime?.session?.isStreaming);
        if (terminalStates.includes(inst.task.status) && !isStreaming) {
          continue;
        }

        let aborted = false;
        try {
          aborted = await mgr.abort(taskId, { source: "user" });
        } catch (err) {
          console.warn(`[SubagentManager] Failed to abort task ${taskId} during run deletion:`, err);
          aborted = false;
        }

        const safelyTerminal =
          terminalStates.includes(inst.task.status) && !Boolean(inst.runtime?.session?.isStreaming);
        if (!aborted && !safelyTerminal) {
          console.warn(
            `[SubagentManager] Quiescence failure: task ${taskId} (status=${inst.task.status}) failed to abort and is not confirmed quiescent`,
          );
          failedTaskIds.push(taskId);
        }
      }
    }

    // 4. 再次确认没有任何 in-flight task starts / completions 残留
    const remainingStarts = mgr.inFlightTaskStarts.get(parentSessionId);
    if (remainingStarts && remainingStarts.size > 0) {
      console.warn(
        `[SubagentManager] Quiescence failure: in-flight task starts still active for session ${parentSessionId}`,
      );
      failedTaskIds.push(`in-flight-start-${parentSessionId}`);
    }

    const remainingComps = mgr.inFlightCompletions.get(parentSessionId);
    if (remainingComps && remainingComps.size > 0) {
      console.warn(
        `[SubagentManager] Quiescence failure: in-flight task completions still active for session ${parentSessionId}`,
      );
      failedTaskIds.push(`in-flight-completion-${parentSessionId}`);
    }

    if (failedTaskIds.length > 0) {
      return { success: false, failedTaskIds };
    }
    return { success: true };
  }

  /**
   * 删除完成后解除 Run 的 deleting 状态
   */
export function finishRunDeletion(mgr: SubagentManagerHost, parentSessionId: string): void {
    mgr.deletingRuns.delete(parentSessionId);
  }

  /**
   * 当 Parent Session 被永久删除时，安全清理该 Session 拥有的所有 Git Runtime Resources
   * 包含 Task worktrees/branches 与 Integration worktree/branch，具备严格所有权保护
   * 支持 active 会话及服务器重启后的 inactive 历史会话
   */
export async function cleanupRunResourcesForParent(
    mgr: SubagentManagerHost,
    parentSessionId: string,
    repoRootHint?: string,
  ): Promise<CleanupResult | undefined> {
    let repoRoot: string | undefined;

    const activeInt = mgr.integrations.get(parentSessionId);
    if (activeInt?.worktreePath) {
      repoRoot = findRepoRootForWorktree(activeInt.worktreePath);
    }

    if (!repoRoot) {
      for (const inst of subagentTasks.values()) {
        if (inst.task.parentSessionId === parentSessionId && inst.task.worktreePath) {
          const candidate = findRepoRootForWorktree(inst.task.worktreePath);
          if (candidate) {
            repoRoot = candidate;
            break;
          }
        }
      }
    }

    if (!repoRoot && repoRootHint) {
      try {
        const info = await resolveProjectRoot(repoRootHint);
        if (existsSync(join(info.projectRoot, ".git"))) {
          repoRoot = info.projectRoot;
        }
      } catch {
        /* ignore */
      }
    }

    if (!repoRoot) {
      const hasGitExpectation =
        mgr.integrations.has(parentSessionId) ||
        Array.from(subagentTasks.values()).some(
          (inst) =>
            inst.task.parentSessionId === parentSessionId &&
            Boolean(inst.task.worktreePath || inst.task.branchName),
        );
      if (hasGitExpectation) {
        return {
          success: false,
          removed: [],
          skipped: [],
          leftovers: [],
          errors: [`Cannot resolve git repository root for session ${parentSessionId} while git runtime resources exist`],
        };
      }
      mgr.integrations.delete(parentSessionId);
      return { success: true, removed: [], skipped: [], leftovers: [] };
    }

    const taskInstances: { worktreePath?: string; branchName?: string }[] = [];
    for (const inst of subagentTasks.values()) {
      if (inst.task.parentSessionId === parentSessionId) {
        if (inst.task.worktreePath || inst.task.branchName) {
          taskInstances.push({
            worktreePath: inst.task.worktreePath,
            branchName: inst.task.branchName,
          });
        }
      }
    }

    const persisted = loadPersistedRuntimeResources(repoRoot);
    for (const r of persisted) {
      if (r.runId === parentSessionId) {
        if (r.type === "task_worktree") {
          if (!taskInstances.some((t) => t.worktreePath === r.nameOrPath)) {
            taskInstances.push({ worktreePath: r.nameOrPath });
          }
        } else if (r.type === "task_branch") {
          if (!taskInstances.some((t) => t.branchName === r.nameOrPath)) {
            taskInstances.push({ branchName: r.nameOrPath });
          }
        }
      }
    }

    let integration: IntegrationWorkspace;
    if (activeInt) {
      integration = activeInt;
    } else {
      const persistedIntWt = persisted.find(
        (r) => r.runId === parentSessionId && r.type === "integration_worktree",
      )?.nameOrPath;
      const persistedIntBranch = persisted.find(
        (r) => r.runId === parentSessionId && r.type === "integration_branch",
      )?.nameOrPath;
      const safeId = parentSessionId.replace(/[^a-zA-Z0-9._-]/g, "-");
      integration = {
        runId: parentSessionId,
        worktreePath: persistedIntWt || resolve(repoRoot, ".worktrees", `integration-${safeId}`),
        branch: persistedIntBranch || `runtime/run-${safeId}`,
        baseCommit: "",
        originalBranch: "",
      };
    }

    const result = await cleanupRunResources(repoRoot, integration, taskInstances);
    // 仅当清理完全成功时才注销 integration 内存记录；若失败保留记录以供 retry
    if (result.success) {
      mgr.integrations.delete(parentSessionId);
    }
    return result;
  }

  /**
   * 清空某主会话下的所有历史 Subagent 任务 (Fail-closed)
   * 若存在无法安全停止或删除的任务，不得假装清理成功，必须抛出错误并保留未安全停止的实例。
   */
export async function clearTasksForParent(mgr: SubagentManagerHost, parentSessionId: string): Promise<number> {
    let count = 0;
    const taskIds: string[] = [];
    for (const [id, inst] of subagentTasks.entries()) {
      if (inst.task.parentSessionId === parentSessionId) {
        taskIds.push(id);
      }
    }
    const failedTaskIds: string[] = [];
    for (const id of taskIds) {
      const ok = await mgr.deleteTask(id);
      if (ok) {
        count++;
      } else {
        failedTaskIds.push(id);
      }
    }
    if (failedTaskIds.length > 0) {
      throw new Error(
        `Failed to safely clear tasks for parent session ${parentSessionId}: tasks [${failedTaskIds.join(", ")}] could not be quiesced or deleted`,
      );
    }
    mgr.reusableAgents.clearForParent(parentSessionId);
    mgr.finalizedRuns.delete(parentSessionId);
    return count;
  }

  /**
   * 终结整轮 Run：将当前 session 的 Integration 结果安全写回用户工作区或正式 commit
   */
export async function finalizeRun(
    mgr: SubagentManagerHost,
    parentSessionId: string,
    options?: {
      mode?: FinalizeMode;
      commitMessage?: string;
      cleanup?: boolean;
      _injectSnapshotError?: boolean;
      _injectMutationError?: boolean;
      _injectMutationErrorAtStep?: number;
      _injectRollbackError?: boolean;
      _injectCleanupError?: boolean;
    },
  ): Promise<FinalizeResult> {
    if (mgr.deletingRuns.has(parentSessionId)) {
      return {
        success: false,
        status: "ERROR",
        mode: options?.mode || "working_tree",
        changedFiles: [],
        error: `Cannot finalize run for session ${parentSessionId}: session is being deleted`,
      };
    }

    const integration = mgr.integrations.get(parentSessionId);
    let repoRoot: string | undefined;

    // 门禁检查：所有属于当前 Run 的任务必须全部进入终态（completed, failed, aborted, interrupted, incomplete）
    const nonTerminalStates: TaskExecutionStatus[] = [
      "blocked",
      "ready",
      "running",
      "conflict",
    ];

    const activeTasks: { taskId: string; status: TaskExecutionStatus }[] = [];
    const taskInstances: { worktreePath?: string; branchName?: string }[] = [];
    const sessionTasks: UISubagentTask[] = [];
    for (const inst of subagentTasks.values()) {
      if (inst.task.parentSessionId === parentSessionId) {
        sessionTasks.push(inst.task);
        if (nonTerminalStates.includes(inst.task.status)) {
          activeTasks.push({ taskId: inst.task.taskId, status: inst.task.status });
        }
        if (!repoRoot && inst.repoRoot) {
          repoRoot = inst.repoRoot;
        }
        taskInstances.push({
          worktreePath: inst.task.worktreePath,
          branchName: inst.task.branchName,
        });
      }
    }

    if (activeTasks.length > 0) {
      return {
        success: false,
        status: "ERROR",
        mode: options?.mode || "working_tree",
        changedFiles: [],
        error: `Cannot finalize run: ${activeTasks.length} task(s) are still active or not in terminal state: ${activeTasks.map((t) => `${t.taskId} (${t.status})`).join(", ")}`,
      };
    }

    // 门禁检查 2：质量与返工闭环检查 (Quality & Lineage Gate)
    // 所有任务谱系必须得到满足：不存在未解决的 verification.fail / partially_verified / REQUEST_CHANGES
    const unsatisfiedTasks = sessionTasks.filter((t) => !mgr.isTaskLineageSatisfied(t.taskId, parentSessionId));
    if (unsatisfiedTasks.length > 0) {
      const details = unsatisfiedTasks
        .map((t) => {
          const ver = t.verification?.overall ?? t.taskResult?.verification?.overall;
          const rev = t.review?.verdict ?? t.taskResult?.review?.verdict;
          return `${t.taskId} (status=${t.status}, verification=${ver ?? "none"}, review=${rev ?? "none"})`;
        })
        .join(", ");
      return {
        success: false,
        status: "ERROR",
        mode: options?.mode || "working_tree",
        changedFiles: [],
        error: `Cannot finalize run: unsatisfied task lineage(s) exist: ${details}. Quality gate requires all tasks to be completed with passing verification/review or be resolved by a successful rework.`,
      };
    }

    if (!integration || !repoRoot) {
      if (mgr.finalizedRuns.has(parentSessionId)) {
        return mgr.finalizedRuns.get(parentSessionId)!;
      }
      return {
        success: false,
        status: "ERROR",
        mode: options?.mode || "working_tree",
        changedFiles: [],
        error: "No active integration workspace found for this session.",
      };
    }

    const result = await finalizeGitRun(repoRoot, integration, options, taskInstances);
    if (result.success) {
      mgr.finalizedRuns.set(parentSessionId, result);
      if (options?.cleanup !== false) {
        mgr.integrations.delete(parentSessionId);
      }
    }
    return result;
  }

