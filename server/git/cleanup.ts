import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CleanupResult } from "../contracts/task.ts";
import { listWorktreeFolders, runGit } from "./git.ts";
import type { IntegrationWorkspace } from "./integration-workspace.ts";
import {
  hasRuntimeOwnership,
  isResourceNamespaceValid,
  unregisterRuntimeResource,
} from "./runtime-resources.ts";
import { removeWorktree } from "./worktree.ts";

/**
 * 清理临时 task worktrees, task branches, integration worktree 与 integration branch (具备所有权与双重门禁保护)
 */
export async function cleanupRunResources(
  repoRoot: string,
  integration: IntegrationWorkspace,
  taskInstances?: { worktreePath?: string; branchName?: string }[],
  options?: {
    _injectCleanupError?: boolean;
    _injectWorktreeRemoveError?: boolean;
    _injectBranchDeleteError?: boolean;
  },
): Promise<CleanupResult> {
  const removed: string[] = [];
  const skipped: string[] = [];
  const leftovers: string[] = [];
  const errors: string[] = [];
  const runId = integration.runId;

  if (options?._injectCleanupError) {
    return {
      success: false,
      removed,
      skipped,
      leftovers: ["injected_cleanup_leftover"],
      errors: ["Simulated cleanup failure"],
    };
  }

  // 1. 清理 task worktrees
  if (taskInstances) {
    for (const t of taskInstances) {
      if (t.worktreePath) {
        const wtPath = resolve(t.worktreePath);
        const isNamespaceValid = isResourceNamespaceValid("task_worktree", wtPath, repoRoot);
        const isOwned = hasRuntimeOwnership(runId, "task_worktree", wtPath, repoRoot);

        if (!isOwned || !isNamespaceValid) {
          skipped.push(`task_worktree:${wtPath} (no ownership or path/namespace invalid)`);
        } else {
          try {
            if (options?._injectWorktreeRemoveError) {
              throw new Error(`Injected worktree remove error for ${wtPath}`);
            }

            if (existsSync(wtPath)) {
              await removeWorktree(repoRoot, wtPath);
            }

            // 再次确认资源不存在
            if (existsSync(wtPath)) {
              throw new Error(`Worktree directory still exists at ${wtPath} after removal`);
            }
            const list = await listWorktreeFolders(repoRoot);
            if (list.some((w) => resolve(w.path) === wtPath)) {
              throw new Error(`Worktree still listed in git worktree list: ${wtPath}`);
            }

            // 删除持久化 ownership
            unregisterRuntimeResource(runId, "task_worktree", wtPath, repoRoot);
            removed.push(`task_worktree:${wtPath}`);
          } catch (err) {
            leftovers.push(`task_worktree:${wtPath}`);
            errors.push(`Failed to remove worktree ${wtPath}: ${String(err instanceof Error ? err.message : err)}`);
          }
        }
      }

      // 2. 清理 task branch
      if (t.branchName) {
        const branch = t.branchName.trim();
        const isNamespaceValid = isResourceNamespaceValid("task_branch", branch, repoRoot);
        const isOwned = hasRuntimeOwnership(runId, "task_branch", branch, repoRoot);

        if (!isOwned || !isNamespaceValid) {
          skipped.push(`task_branch:${branch} (no ownership or invalid namespace)`);
        } else {
          try {
            if (options?._injectBranchDeleteError) {
              throw new Error(`Injected branch delete error for ${branch}`);
            }

            let branchExists = false;
            try {
              await runGit(repoRoot, ["show-ref", "--verify", `refs/heads/${branch}`]);
              branchExists = true;
            } catch {}

            if (branchExists) {
              await runGit(repoRoot, ["branch", "-D", branch]);
              // 再次确认分支不存在
              try {
                await runGit(repoRoot, ["show-ref", "--verify", `refs/heads/${branch}`]);
                throw new Error(`Branch ${branch} still exists in git refs after deletion`);
              } catch (checkErr: any) {
                if (checkErr.message?.includes("still exists")) {
                  throw checkErr;
                }
              }
            }

            // 删除持久化 ownership
            unregisterRuntimeResource(runId, "task_branch", branch, repoRoot);
            removed.push(`task_branch:${branch}`);
          } catch (err) {
            leftovers.push(`task_branch:${branch}`);
            errors.push(`Failed to delete branch ${branch}: ${String(err instanceof Error ? err.message : err)}`);
          }
        }
      }
    }
  }

  // 3. 清理 integration worktree
  if (integration.worktreePath) {
    const intWtPath = resolve(integration.worktreePath);
    const isNamespaceValid = isResourceNamespaceValid("integration_worktree", intWtPath, repoRoot);
    const isOwned = hasRuntimeOwnership(runId, "integration_worktree", intWtPath, repoRoot);

    if (!isOwned || !isNamespaceValid) {
      skipped.push(`integration_worktree:${intWtPath} (no ownership or path/namespace invalid)`);
    } else {
      try {
        if (options?._injectWorktreeRemoveError) {
          throw new Error(`Injected integration worktree remove error for ${intWtPath}`);
        }

        if (existsSync(intWtPath)) {
          await removeWorktree(repoRoot, intWtPath);
        }

        // 再次确认不存在
        if (existsSync(intWtPath)) {
          throw new Error(`Integration worktree directory still exists at ${intWtPath} after removal`);
        }
        const list = await listWorktreeFolders(repoRoot);
        if (list.some((w) => resolve(w.path) === intWtPath)) {
          throw new Error(`Integration worktree still listed in git worktree list: ${intWtPath}`);
        }

        // 删除持久化 ownership
        unregisterRuntimeResource(runId, "integration_worktree", intWtPath, repoRoot);
        removed.push(`integration_worktree:${intWtPath}`);
      } catch (err) {
        leftovers.push(`integration_worktree:${intWtPath}`);
        errors.push(`Failed to remove integration worktree ${intWtPath}: ${String(err instanceof Error ? err.message : err)}`);
      }
    }
  }

  // 4. 清理 integration branch
  if (integration.branch) {
    const intBranch = integration.branch.trim();
    const isNamespaceValid = isResourceNamespaceValid("integration_branch", intBranch, repoRoot);
    const isOwned = hasRuntimeOwnership(runId, "integration_branch", intBranch, repoRoot);

    if (!isOwned || !isNamespaceValid) {
      skipped.push(`integration_branch:${intBranch} (no ownership or invalid namespace)`);
    } else {
      try {
        if (options?._injectBranchDeleteError) {
          throw new Error(`Injected integration branch delete error for ${intBranch}`);
        }

        let branchExists = false;
        try {
          await runGit(repoRoot, ["show-ref", "--verify", `refs/heads/${intBranch}`]);
          branchExists = true;
        } catch {}

        if (branchExists) {
          await runGit(repoRoot, ["branch", "-D", intBranch]);
          // 再次确认分支不存在
          try {
            await runGit(repoRoot, ["show-ref", "--verify", `refs/heads/${intBranch}`]);
            throw new Error(`Integration branch ${intBranch} still exists in git refs after deletion`);
          } catch (checkErr: any) {
            if (checkErr.message?.includes("still exists")) {
              throw checkErr;
            }
          }
        }

        // 删除持久化 ownership
        unregisterRuntimeResource(runId, "integration_branch", intBranch, repoRoot);
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
