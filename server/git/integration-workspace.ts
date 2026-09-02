import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runGit } from "./git.ts";
import { hasRuntimeOwnership, registerRuntimeResource } from "./runtime-resources.ts";

export interface IntegrationWorkspace {
  runId: string;
  branch: string;
  worktreePath: string;
  baseCommit: string;
  originalBranch: string;
}

/**
 * 创建或获取当前 Run 的 Integration 工作区与分支 (runtime/run-<runId>)
 */
export async function getOrCreateIntegrationWorkspace(
  repoRoot: string,
  runId: string,
): Promise<IntegrationWorkspace> {
  const safeId = runId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const baseBranch = `runtime/run-${safeId}`;
  const worktreesDir = join(repoRoot, ".worktrees");
  mkdirSync(worktreesDir, { recursive: true });
  const baseWorktreePath = resolve(join(worktreesDir, `integration-${safeId}`));

  let originalBranch = "main";
  try {
    originalBranch = (await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() || "main";
  } catch {
    /* ignore */
  }

  let baseCommit = "";
  try {
    baseCommit = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
  } catch {
    /* ignore */
  }

  // 1. 分支分配与冲突检查（若分支已存在且非当前 Run 拥有，分配唯一分支名）
  let targetBranch = baseBranch;
  let branchExists = false;
  try {
    await runGit(repoRoot, ["show-ref", "--verify", `refs/heads/${targetBranch}`]);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  if (branchExists) {
    const owned = hasRuntimeOwnership(runId, "integration_branch", targetBranch, repoRoot);
    if (!owned) {
      let attempts = 0;
      while (branchExists) {
        attempts++;
        if (attempts > 50) {
          throw new Error(`Failed to allocate unique integration branch for ${baseBranch}`);
        }
        targetBranch = `${baseBranch}-${randomUUID().slice(0, 8)}`;
        try {
          await runGit(repoRoot, ["show-ref", "--verify", `refs/heads/${targetBranch}`]);
          branchExists = true;
        } catch {
          branchExists = false;
        }
      }
      await runGit(repoRoot, ["branch", targetBranch, baseCommit || "HEAD"]);
    }
  } else {
    await runGit(repoRoot, ["branch", targetBranch, baseCommit || "HEAD"]);
  }

  // 验证分支存在
  try {
    await runGit(repoRoot, ["show-ref", "--verify", `refs/heads/${targetBranch}`]);
  } catch (err) {
    throw new Error(`Failed to verify integration branch ${targetBranch}: ${String(err instanceof Error ? err.message : err)}`);
  }

  // 登记 branch ownership（创建成功后）
  registerRuntimeResource(runId, "integration_branch", targetBranch, repoRoot);

  // 2. Worktree 分配与冲突检查
  let targetWorktreePath = baseWorktreePath;
  let wtExists = existsSync(targetWorktreePath);
  if (wtExists) {
    const owned = hasRuntimeOwnership(runId, "integration_worktree", targetWorktreePath, repoRoot);
    if (!owned) {
      let wtAttempts = 0;
      while (wtExists) {
        wtAttempts++;
        if (wtAttempts > 50) {
          throw new Error(`Failed to allocate unique integration worktree path for ${baseWorktreePath}`);
        }
        targetWorktreePath = resolve(join(worktreesDir, `integration-${safeId}-${randomUUID().slice(0, 8)}`));
        wtExists = existsSync(targetWorktreePath);
      }
    }
  }

  if (!existsSync(targetWorktreePath)) {
    try {
      await runGit(repoRoot, ["worktree", "add", targetWorktreePath, targetBranch]);
    } catch {
      try {
        await runGit(repoRoot, ["worktree", "prune"]);
        await runGit(repoRoot, ["worktree", "add", targetWorktreePath, targetBranch]);
      } catch (err) {
        throw new Error(`Failed to create integration worktree: ${String(err instanceof Error ? err.message : err)}`);
      }
    }
  }

  // 验证 worktree 存在
  if (!existsSync(targetWorktreePath)) {
    throw new Error(`Integration worktree ${targetWorktreePath} does not exist after creation`);
  }

  // 登记 worktree ownership（创建成功后）
  registerRuntimeResource(runId, "integration_worktree", targetWorktreePath, repoRoot);

  return { runId, branch: targetBranch, worktreePath: targetWorktreePath, baseCommit, originalBranch };
}

/**
 * 将子任务的 Task Commit 合并到 Integration 工作区（而非用户主分支）
 */
export async function mergeTaskToIntegration(
  integration: IntegrationWorkspace,
  taskBranch: string,
): Promise<{ success: boolean; output: string }> {
  try {
    const output = await runGit(integration.worktreePath, [
      "merge",
      taskBranch,
      "-m",
      `Merge task ${taskBranch} into integration`,
    ]);
    return { success: true, output };
  } catch (err: unknown) {
    return {
      success: false,
      output: String(err instanceof Error ? err.message : err),
    };
  }
}

export interface GitFileChange {
  status: "A" | "M" | "D" | "R" | "C" | "T" | "U";
  path: string;
  oldPath?: string;
}

/**
 * 获取 integration 分支相对 baseCommit 的完整文件改动列表及状态 (A, M, D, R, C) - Fail-Closed
 */
export async function getIntegrationFileChanges(
  repoRoot: string,
  baseCommit: string,
  finalIntegrationCommit: string,
): Promise<GitFileChange[]> {
  const raw = await runGit(repoRoot, [
    "diff",
    "--name-status",
    "-M",
    baseCommit,
    finalIntegrationCommit,
  ]);
  if (!raw.trim()) return [];

  const changes: GitFileChange[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length >= 2) {
      const statusCode = parts[0][0];
      if (statusCode === "R" || statusCode === "C") {
        const oldPath = parts[1]?.trim();
        const newPath = parts[2]?.trim();
        if (newPath) {
          changes.push({
            status: statusCode as "R" | "C",
            path: newPath,
            oldPath,
          });
        }
      } else {
        const path = parts[1]?.trim();
        if (path) {
          changes.push({
            status: statusCode as "A" | "M" | "D",
            path,
          });
        }
      }
    }
  }
  return changes;
}
