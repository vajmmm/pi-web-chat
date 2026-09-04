import type { CleanupResult, QuiescenceResult } from "../contracts/task.ts";
import { deleteSessionFile } from "../projects.ts";
import { deleteSessionTurns } from "../turn-recorder.ts";
import type { SessionRegistry } from "./session-registry.ts";
import type { SubagentManager } from "../subagent-manager.ts";
import {
  isPendingDeletion,
  recordPendingDeletion,
  removePendingDeletion,
  updatePendingDeletionStage,
} from "./deletion-tombstone.ts";

export interface SessionCleanupContext {
  sessionRegistry: SessionRegistry;
  subagentManager: SubagentManager;
}

export interface SessionCleanupOptions {
  deleteFile?: boolean;
}

export interface SessionCleanupResult {
  success: boolean;
  quiescence?: QuiescenceResult;
  gitCleanup?: CleanupResult;
  errors?: string[];
}

/**
 * Single-flight promise map ensuring only one deletion transaction runs per session
 */
const inFlightDeletions = new Map<string, Promise<SessionCleanupResult>>();

/**
 * 统一清理 Session 及其所有派生资源 (Single-Flight Transaction & 5-Phase Reverse Destruction):
 *
 * 0. Single-Flight Mutex: 同一 sessionId 并发 DELETE 共享同一个 Transaction Promise。
 * 1. Pre-flight & Quiescence:
 *    - 激活 deletion gate，等待 in-flight acquire、in-flight parent operations、in-flight subagent starts 与 completions。
 *    - 若 Quiescence 失败且未进入 destructive 阶段，释放 gate 返回 409。
 * 2. 写入持久化 Tombstone: 标记 session 正式进入 destructive cleanup 周期。
 * 3. Phase A (Subagent Dispose): 销毁所有 Subagent Runtime，但完整保留 Task metadata、Git 路径与所有权。失败则立即中止。
 * 4. Phase B (Git Cleanup): 利用完好的元数据清理 Worktrees 与 Branches。存在但未确认所有权严格 fail-closed。失败则中止并保留 retry metadata。
 * 5. Phase C (Metadata Purge): Git 成功后销毁 Task 文件、Task Memory、TurnRecorder、DAG、Coordinator State 及 Inbox。失败则立即中止。
 * 6. Phase D (Parent Disposal): 销毁 Parent Runtime 并注销断开所有客户端 WebSocket。失败则中止。
 * 7. Phase E (Session JSONL Delete): 最后删除主 Session 文件。成功后移除 Tombstone 并释放 gate。
 */
export async function cleanupDeletedSessionResources(
  sessionId: string,
  ctx: SessionCleanupContext,
  repoRootHint?: string,
  options?: SessionCleanupOptions,
): Promise<SessionCleanupResult> {
  const existing = inFlightDeletions.get(sessionId);
  if (existing) {
    return existing;
  }

  const promise = executeSessionDeletionTransaction(sessionId, ctx, repoRootHint, options).finally(() => {
    inFlightDeletions.delete(sessionId);
  });

  inFlightDeletions.set(sessionId, promise);
  return promise;
}

async function executeSessionDeletionTransaction(
  sessionId: string,
  ctx: SessionCleanupContext,
  repoRootHint?: string,
  options?: SessionCleanupOptions,
): Promise<SessionCleanupResult> {
  const errors: string[] = [];
  let gitCleanup: CleanupResult | undefined;
  let quiesceResult: QuiescenceResult = { success: false };
  let hasEnteredDestructive = isPendingDeletion(sessionId);

  try {
    // 0. 激活 Run 维度的内存删除门禁 (拦截并发 spawn/continue/DAG unblock/WS command)
    ctx.subagentManager.markRunDeleting(sessionId);

    // 0.1 等待可能正在进行的 session acquire
    const pendingAcquire = ctx.sessionRegistry.pending.get(sessionId);
    if (pendingAcquire) {
      try {
        await pendingAcquire;
      } catch {
        /* ignore acquire rejection to inspect pending cleanup state */
      }
      // 若该并发 acquire 在清理销毁时失败，句柄已被存入 pendingAcquireCleanup
      if (ctx.sessionRegistry.pendingAcquireCleanup.has(sessionId)) {
        const msg = `Quiescence failure for session ${sessionId}: concurrent in-flight acquire runtime dispose failed`;
        console.warn(`[server] ${msg}`);
        errors.push(msg);
        quiesceResult = { success: false, failedTaskIds: [`pending-acquire-${sessionId}`] };
        hasEnteredDestructive = true;
        updatePendingDeletionStage(sessionId, "quiescing", msg);
      }
    } else {
      // 0.2 第二次 DELETE / 重试清理：尝试重新释放先前遗留的 pendingAcquireCleanup runtime
      const pendingCleanup = ctx.sessionRegistry.pendingAcquireCleanup.get(sessionId);
      if (pendingCleanup) {
        try {
          await pendingCleanup.runtime.dispose();
          ctx.sessionRegistry.pendingAcquireCleanup.delete(sessionId);
        } catch (err) {
          const msg = `Quiescence failure for session ${sessionId}: failed to dispose pending acquire runtime: ${String(err instanceof Error ? err.message : err)}`;
          console.warn(`[server] ${msg}`);
          errors.push(msg);
          quiesceResult = { success: false, failedTaskIds: [`pending-acquire-${sessionId}`] };
          hasEnteredDestructive = true;
          updatePendingDeletionStage(sessionId, "quiescing", msg);
        }
      }
    }

    // 1. Parent Runtime Quiescence：若 Parent Session 正在 streaming，等待其安全中止并确认静止
    try {
      const parentQuiesced = await ctx.sessionRegistry.abortStreamingSession(sessionId);
      if (!parentQuiesced) {
        const msg = `Quiescence failure for session ${sessionId}: parent runtime failed to abort or is still streaming`;
        console.warn(`[server] ${msg}`);
        errors.push(msg);
        quiesceResult = { success: false, failedTaskIds: [`parent-session-${sessionId}`] };
      }
    } catch (err) {
      const msg = `Quiescence failure for session ${sessionId}: parent runtime abort error: ${String(err instanceof Error ? err.message : err)}`;
      console.warn(`[server] ${msg}`);
      errors.push(msg);
      quiesceResult = { success: false, failedTaskIds: [`parent-session-${sessionId}`] };
    }

    // 1.1 等待所有已开始的 Parent 操作 (prompt, compact, fork, set_session_cwd, guidance) 全部 settle
    const parentOpsSettled = await ctx.sessionRegistry.awaitInFlightOps(sessionId);
    if (!parentOpsSettled) {
      const msg = `Quiescence failure for session ${sessionId}: in-flight parent operations failed to settle`;
      console.warn(`[server] ${msg}`);
      errors.push(msg);
      quiesceResult = { success: false, failedTaskIds: [`parent-ops-${sessionId}`] };
    }

    if (errors.length > 0) {
      console.warn(`[server] Aborting session cleanup for ${sessionId} due to parent quiescence failure (fail-closed)`);
      if (!hasEnteredDestructive) {
        ctx.subagentManager.finishRunDeletion(sessionId);
      }
      return { success: false, quiescence: quiesceResult, errors };
    }

    // 1.2 Subagent Quiescence 阶段：等待 in-flight starts 与 completions，停止运行中 Subagent 确保 Runtime 停止
    try {
      quiesceResult = await ctx.subagentManager.prepareRunForDeletion(sessionId);
      if (!quiesceResult.success) {
        const msg = `Quiescence failure for session ${sessionId}: failed to confirm subagent tasks termination [${quiesceResult.failedTaskIds?.join(", ") || ""}]`;
        console.warn(`[server] ${msg}`);
        errors.push(msg);
      }
    } catch (err) {
      const msg = `Quiescence failure for session ${sessionId}: ${String(err instanceof Error ? err.message : err)}`;
      console.warn(`[server] ${msg}`);
      errors.push(msg);
      quiesceResult = { success: false };
    }

    if (!quiesceResult.success) {
      console.warn(`[server] Aborting session cleanup for ${sessionId} due to subagent quiescence failure (fail-closed)`);
      if (!hasEnteredDestructive) {
        ctx.subagentManager.finishRunDeletion(sessionId);
      }
      return { success: false, quiescence: quiesceResult, errors };
    }

    const hint = repoRootHint || ctx.sessionRegistry.get(sessionId)?.cwd;

    // 2. 正式进入破坏性清理阶段：写入持久化 Tombstone
    hasEnteredDestructive = true;
    updatePendingDeletionStage(sessionId, "disposing_subagents");

    // =========================================================================
    // Phase A: 销毁所有 Subagent Runtimes (保持 Task 元数据、Git 路径与所有权)
    // =========================================================================
    const subagentsDisposed = await ctx.subagentManager.disposeSubagentRuntimesForParent(sessionId);
    if (!subagentsDisposed) {
      const msg = `Phase A failure: failed to dispose all subagent session runtimes for ${sessionId}`;
      console.warn(`[server] ${msg}`);
      errors.push(msg);
      updatePendingDeletionStage(sessionId, "disposing_subagents", msg);
      return { success: false, quiescence: quiesceResult, errors };
    }

    // =========================================================================
    // Phase B: Git Runtime 资源清理 (依据完好的元数据与所有权验证)
    // =========================================================================
    updatePendingDeletionStage(sessionId, "git_cleanup");
    try {
      gitCleanup = await ctx.subagentManager.cleanupRunResourcesForParent(sessionId, hint);
      if (gitCleanup && !gitCleanup.success && gitCleanup.errors) {
        errors.push(...gitCleanup.errors);
        console.warn(`[server] Git runtime cleanup had errors for session ${sessionId}:`, gitCleanup.errors);
      }
    } catch (err) {
      const msg = `Failed to cleanup git runtime resources for session ${sessionId}: ${String(err instanceof Error ? err.message : err)}`;
      console.warn(`[server] ${msg}`);
      errors.push(msg);
      updatePendingDeletionStage(sessionId, "git_cleanup", msg);
      return { success: false, quiescence: quiesceResult, errors };
    }

    // FAIL-CLOSED: throw 或 success=false 都必须立即中止，严禁进入 Phase C 销毁 retry metadata
    if (!gitCleanup || !gitCleanup.success) {
      console.warn(
        `[server] Aborting further session cleanup for ${sessionId} because git resource cleanup failed (fail-closed, preserving retry metadata)`,
      );
      updatePendingDeletionStage(sessionId, "git_cleanup", errors.join("; "));
      return {
        success: false,
        quiescence: quiesceResult,
        gitCleanup,
        errors,
      };
    }

    // =========================================================================
    // Phase C: Git 成功后，清理 Subagent 任务元数据、Memory、TurnRecorder、DAG、Coordinator 与 Inbox
    // =========================================================================
    updatePendingDeletionStage(sessionId, "metadata_cleanup");

    const metaOk = await ctx.subagentManager.purgeSubagentMetadataForParent(sessionId);
    if (!metaOk) {
      errors.push(`Failed to purge all subagent tasks or memories for ${sessionId}`);
    }

    try {
      ctx.subagentManager.clearCoordinatorState(sessionId);
    } catch (err) {
      errors.push(`Failed to clear coordinator state: ${String(err instanceof Error ? err.message : err)}`);
    }

    const turnsOk = deleteSessionTurns(sessionId);
    if (turnsOk === false) {
      errors.push(`Failed to delete turn recorder file for session ${sessionId}`);
    }

    if (errors.length > 0) {
      console.warn(`[server] Aborting further session cleanup for ${sessionId} due to metadata purge failure:`, errors);
      updatePendingDeletionStage(sessionId, "metadata_cleanup", errors.join("; "));
      return { success: false, quiescence: quiesceResult, gitCleanup, errors };
    }

    // =========================================================================
    // Phase D: Parent Runtime 销毁及 WebSocket 客户端清理
    // =========================================================================
    updatePendingDeletionStage(sessionId, "disposing_parent");
    try {
      await ctx.sessionRegistry.remove(sessionId, { strict: true });
    } catch (err) {
      const msg = `Failed to dispose parent session runtime for ${sessionId}: ${String(err instanceof Error ? err.message : err)}`;
      console.warn(`[server] ${msg}`);
      errors.push(msg);
      updatePendingDeletionStage(sessionId, "disposing_parent", msg);
      return { success: false, quiescence: quiesceResult, gitCleanup, errors };
    }

    // =========================================================================
    // Phase E: Session JSONL 文件删除 (Last Step)
    // =========================================================================
    if (options?.deleteFile !== false) {
      updatePendingDeletionStage(sessionId, "session_file_delete");
      let fileDeleteFailed = false;
      try {
        const fileRes = await deleteSessionFile(sessionId, hint);
        if (!fileRes.ok) {
          const msg = fileRes.error || `Failed to delete session file for ${sessionId}`;
          console.warn(`[server] ${msg}`);
          errors.push(msg);
          fileDeleteFailed = true;
        }
      } catch (err) {
        const msg = `Failed to delete session file for ${sessionId}: ${String(err instanceof Error ? err.message : err)}`;
        console.warn(`[server] ${msg}`);
        errors.push(msg);
        fileDeleteFailed = true;
      }

      if (fileDeleteFailed) {
        console.warn(`[server] Session JSONL deletion failed for ${sessionId} (fail-closed)`);
        updatePendingDeletionStage(sessionId, "session_file_delete", errors.join("; "));
        return { success: false, quiescence: quiesceResult, gitCleanup, errors };
      }
    }

    // =========================================================================
    // Transaction Success: 彻底移除持久化 Tombstone 并释放 Deletion Gate
    // =========================================================================
    removePendingDeletion(sessionId);
    ctx.subagentManager.finishRunDeletion(sessionId);

    return {
      success: true,
      quiescence: quiesceResult,
      gitCleanup,
    };
  } finally {
    // 若失败且已经进入 destructive 阶段，保持 Tombstone 与 deletingRuns，阻止会话恢复运行
    if (!hasEnteredDestructive) {
      ctx.subagentManager?.finishRunDeletion(sessionId);
    }
  }
}
