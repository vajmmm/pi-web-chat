import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CleanupResult } from "../contracts/task.ts";
import type { IntegrationWorkspace } from "./integration-workspace.ts";
import { probeGitBranch, probeGitWorktree, runGit } from "./git.ts";
import { removeWorktree } from "./worktree.ts";
import {
  hasRuntimeOwnership,
  isResourceNamespaceValid,
  unregisterRuntimeResource,
  loadPendingGitRecovery,
  removePendingGitRecovery,
} from "./runtime-resources.ts";

export interface CleanupRunOptions {
  _injectCleanupError?: boolean;
  _injectWorktreeRemoveError?: boolean;
  _injectBranchDeleteError?: boolean;
}

/**
 * 严格基于所有权机制清理指定 Run 产生的所有 Worktrees 及 Branches
 * 1. 杜绝任何基于 glob/正则的前缀扫描或批量删除；
 * 2. 仅清理明确注册归属于该 runId 的资源；
 * 3. 对非自身所有、命名空间不符或越界的路径严格跳过并上报；
 * 4. 仅在底层物理资源确认删除成功后，才注销所有权；若删除失败则保留所有权记录供重试。
 */
export async function cleanupRunResources(
  repoRoot: string,
  integration: IntegrationWorkspace,
  taskInstances?: { worktreePath?: string; branchName?: string }[],
  options?: CleanupRunOptions,
): Promise<CleanupResult> {
  const runId = integration.runId;
  const removed: string[] = [];
  const skipped: string[] = [];
  const leftovers: string[] = [];
  const errors: string[] = [];

  if (options?._injectCleanupError) {
    leftovers.push("injected_cleanup_error");
    errors.push("Injected cleanup error");
  }

  if (!repoRoot || !existsSync(repoRoot)) {
    return {
      success: false,
      removed,
      skipped,
      leftovers,
      errors: [`Repository root does not exist: ${repoRoot}`],
    };
  }

  // 0. 整合 pending git recovery 记录
  const pendingRecoveries = loadPendingGitRecovery(repoRoot).filter((r) => r.runId === runId);

  const taskWorktreePaths: string[] = [];
  const taskBranchNames: string[] = [];
  if (taskInstances) {
    for (const t of taskInstances) {
      if (t.worktreePath) taskWorktreePaths.push(resolve(t.worktreePath));
      if (t.branchName) taskBranchNames.push(t.branchName.trim());
    }
  }
  for (const rec of pendingRecoveries) {
    if (rec.type === "task_worktree") {
      const p = resolve(rec.nameOrPath);
      if (!taskWorktreePaths.includes(p)) taskWorktreePaths.push(p);
    } else if (rec.type === "task_branch") {
      const b = rec.nameOrPath.trim();
      if (!taskBranchNames.includes(b)) taskBranchNames.push(b);
    }
  }

  let intWorktreePath = integration.worktreePath ? resolve(integration.worktreePath) : undefined;
  let intBranchName = integration.branch ? integration.branch.trim() : undefined;
  for (const rec of pendingRecoveries) {
    if (rec.type === "integration_worktree" && !intWorktreePath) {
      intWorktreePath = resolve(rec.nameOrPath);
    } else if (rec.type === "integration_branch" && !intBranchName) {
      intBranchName = rec.nameOrPath.trim();
    }
  }

  // 1. 清理 task worktrees
  for (const wtPath of taskWorktreePaths) {
    const isNamespaceValid = isResourceNamespaceValid("task_worktree", wtPath, repoRoot);
    const isOwned = hasRuntimeOwnership(runId, "task_worktree", wtPath, repoRoot);

    const wtProbe = await probeGitWorktree(repoRoot, wtPath);
    if (wtProbe.status === "error") {
      leftovers.push(`task_worktree:${wtPath}`);
      errors.push(
        `task_worktree:${wtPath} git probe operational error; refusing to delete or unregister (fail-closed): ${wtProbe.error}`,
      );
    } else if (!isOwned || !isNamespaceValid) {
      skipped.push(`task_worktree:${wtPath} (no ownership or path/namespace invalid)`);
      if (wtProbe.status === "exists") {
        leftovers.push(`task_worktree:${wtPath}`);
        errors.push(
          `task_worktree:${wtPath} exists on disk but has missing/invalid ownership; refusing to delete unverified resource (fail-closed)`,
        );
      }
    } else {
      try {
        if (options?._injectWorktreeRemoveError) {
          throw new Error(`Injected worktree remove error for ${wtPath}`);
        }

        if (wtProbe.status === "exists") {
          await removeWorktree(repoRoot, wtPath);
        }

        const afterProbe = await probeGitWorktree(repoRoot, wtPath);
        if (afterProbe.status === "error") {
          throw new Error(
            `Worktree ${wtPath} git probe operational error after removal: ${afterProbe.error}`,
          );
        }
        if (afterProbe.status === "exists") {
          throw new Error(`Worktree still exists after removal: ${wtPath}`);
        }

        unregisterRuntimeResource(runId, "task_worktree", wtPath, repoRoot);
        removePendingGitRecovery(repoRoot, runId, "task_worktree", wtPath);
        removed.push(`task_worktree:${wtPath}`);
      } catch (err) {
        leftovers.push(`task_worktree:${wtPath}`);
        errors.push(`Failed to remove worktree ${wtPath}: ${String(err instanceof Error ? err.message : err)}`);
      }
    }
  }

  // 2. 清理 task branches
  for (const branch of taskBranchNames) {
    const branchProbe = await probeGitBranch(repoRoot, branch);
    const isNamespaceValid = isResourceNamespaceValid("task_branch", branch, repoRoot);
    const isOwned = hasRuntimeOwnership(runId, "task_branch", branch, repoRoot);

    if (branchProbe.status === "error") {
      leftovers.push(`task_branch:${branch}`);
      errors.push(
        `task_branch:${branch} git probe operational error; refusing to delete or unregister (fail-closed): ${branchProbe.error}`,
      );
    } else if (!isOwned || !isNamespaceValid) {
      skipped.push(`task_branch:${branch} (no ownership or invalid namespace)`);
      if (branchProbe.status === "exists") {
        leftovers.push(`task_branch:${branch}`);
        errors.push(
          `task_branch:${branch} exists in git refs but has missing/invalid ownership (fail-closed)`,
        );
      }
    } else {
      try {
        if (options?._injectBranchDeleteError) {
          throw new Error(`Injected branch delete error for ${branch}`);
        }

        if (branchProbe.status === "exists") {
          await runGit(repoRoot, ["branch", "-D", branch]);
          const afterProbe = await probeGitBranch(repoRoot, branch);
          if (afterProbe.status === "error") {
            throw new Error(
              `Branch ${branch} git probe operational error after deletion: ${afterProbe.error}`,
            );
          }
          if (afterProbe.status === "exists") {
            throw new Error(`Branch ${branch} still exists in git refs after deletion`);
          }
        }

        unregisterRuntimeResource(runId, "task_branch", branch, repoRoot);
        removePendingGitRecovery(repoRoot, runId, "task_branch", branch);
        removed.push(`task_branch:${branch}`);
      } catch (err) {
        leftovers.push(`task_branch:${branch}`);
        errors.push(`Failed to delete branch ${branch}: ${String(err instanceof Error ? err.message : err)}`);
      }
    }
  }

  // 3. 清理 integration worktree
  if (intWorktreePath) {
    const intWtPath = resolve(intWorktreePath);
    const isNamespaceValid = isResourceNamespaceValid("integration_worktree", intWtPath, repoRoot);
    const isOwned = hasRuntimeOwnership(runId, "integration_worktree", intWtPath, repoRoot);

    const intWtProbe = await probeGitWorktree(repoRoot, intWtPath);
    if (intWtProbe.status === "error") {
      leftovers.push(`integration_worktree:${intWtPath}`);
      errors.push(
        `integration_worktree:${intWtPath} git probe operational error; refusing to delete or unregister (fail-closed): ${intWtProbe.error}`,
      );
    } else if (!isOwned || !isNamespaceValid) {
      skipped.push(`integration_worktree:${intWtPath} (no ownership or path/namespace invalid)`);
      if (intWtProbe.status === "exists") {
        leftovers.push(`integration_worktree:${intWtPath}`);
        errors.push(
          `integration_worktree:${intWtPath} exists on disk but has missing/invalid ownership (fail-closed)`,
        );
      }
    } else {
      try {
        if (options?._injectWorktreeRemoveError) {
          throw new Error(`Injected integration worktree remove error for ${intWtPath}`);
        }

        if (intWtProbe.status === "exists") {
          await removeWorktree(repoRoot, intWtPath);
        }

        const afterProbe = await probeGitWorktree(repoRoot, intWtPath);
        if (afterProbe.status === "error") {
          throw new Error(
            `Integration worktree ${intWtPath} git probe operational error after removal: ${afterProbe.error}`,
          );
        }
        if (afterProbe.status === "exists") {
          throw new Error(`Integration worktree still exists after removal: ${intWtPath}`);
        }

        unregisterRuntimeResource(runId, "integration_worktree", intWtPath, repoRoot);
        removePendingGitRecovery(repoRoot, runId, "integration_worktree", intWtPath);
        removed.push(`integration_worktree:${intWtPath}`);
      } catch (err) {
        leftovers.push(`integration_worktree:${intWtPath}`);
        errors.push(`Failed to remove integration worktree ${intWtPath}: ${String(err instanceof Error ? err.message : err)}`);
      }
    }
  }

  // 4. 清理 integration branch
  if (intBranchName) {
    const intBranch = intBranchName.trim();
    const intBranchProbe = await probeGitBranch(repoRoot, intBranch);
    const isNamespaceValid = isResourceNamespaceValid("integration_branch", intBranch, repoRoot);
    const isOwned = hasRuntimeOwnership(runId, "integration_branch", intBranch, repoRoot);

    if (intBranchProbe.status === "error") {
      leftovers.push(`integration_branch:${intBranch}`);
      errors.push(
        `integration_branch:${intBranch} git probe operational error; refusing to delete or unregister (fail-closed): ${intBranchProbe.error}`,
      );
    } else if (!isOwned || !isNamespaceValid) {
      skipped.push(`integration_branch:${intBranch} (no ownership or invalid namespace)`);
      if (intBranchProbe.status === "exists") {
        leftovers.push(`integration_branch:${intBranch}`);
        errors.push(
          `integration_branch:${intBranch} exists in git refs but has missing/invalid ownership (fail-closed)`,
        );
      }
    } else {
      try {
        if (options?._injectBranchDeleteError) {
          throw new Error(`Injected integration branch delete error for ${intBranch}`);
        }

        if (intBranchProbe.status === "exists") {
          await runGit(repoRoot, ["branch", "-D", intBranch]);
          const afterProbe = await probeGitBranch(repoRoot, intBranch);
          if (afterProbe.status === "error") {
            throw new Error(
              `Integration branch ${intBranch} git probe operational error after deletion: ${afterProbe.error}`,
            );
          }
          if (afterProbe.status === "exists") {
            throw new Error(`Integration branch ${intBranch} still exists in git refs after deletion`);
          }
        }

        unregisterRuntimeResource(runId, "integration_branch", intBranch, repoRoot);
        removePendingGitRecovery(repoRoot, runId, "integration_branch", intBranch);
        removed.push(`integration_branch:${intBranch}`);
      } catch (err) {
        leftovers.push(`integration_branch:${intBranch}`);
        errors.push(`Failed to delete integration branch ${intBranch}: ${String(err instanceof Error ? err.message : err)}`);
      }
    }
  }

  const success = leftovers.length === 0;
  return {
    success,
    removed,
    skipped,
    leftovers,
    errors: errors.length > 0 ? errors : undefined,
  };
}
