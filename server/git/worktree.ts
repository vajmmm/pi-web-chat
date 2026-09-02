import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runGit } from "./git.ts";
import { registerRuntimeResource } from "./runtime-resources.ts";

export interface WorktreeResult {
  worktreePath: string;
  branch: string;
  baseCommit?: string;
}

/**
 * 在仓库下创建独立的 Git Worktree 隔离工作区，严格生成 runtime/task-* 分支并记录所有权
 */
export async function createWorktree(
  repoRoot: string,
  taskId: string,
  preferredBranchOrRunId?: string,
  baseRef?: string,
  explicitRunId?: string,
): Promise<WorktreeResult> {
  const safeTaskId = taskId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const actualRunId =
    explicitRunId ||
    (preferredBranchOrRunId && preferredBranchOrRunId.startsWith("session-") ? preferredBranchOrRunId : undefined);

  // 1. 生成 Candidate 分支名与 Worktree 路径
  const baseBranchName = actualRunId
    ? `runtime/task-${actualRunId.replace(/[^a-zA-Z0-9._-]/g, "-")}-${safeTaskId}`
    : `runtime/task-${safeTaskId}`;

  const worktreesDir = join(repoRoot, ".worktrees");
  mkdirSync(worktreesDir, { recursive: true });
  const baseWorktreePath = resolve(join(worktreesDir, safeTaskId));

  // 2. 检查同名分支是否存在（禁止直接认领/复用已有分支，方案 A：分配唯一名称）
  let targetBranch = baseBranchName;
  let branchAttempts = 0;
  while (true) {
    let exists = false;
    try {
      await runGit(repoRoot, ["show-ref", "--verify", `refs/heads/${targetBranch}`]);
      exists = true;
    } catch {
      exists = false;
    }

    if (!exists) break;

    // 分支已存在：分配唯一分支名后缀
    branchAttempts++;
    if (branchAttempts > 50) {
      throw new Error(`Failed to allocate a unique runtime task branch for ${baseBranchName}`);
    }
    const shortId = randomUUID().slice(0, 8);
    targetBranch = `${baseBranchName}-${shortId}`;
  }

  // 3. 检查同名 Worktree 路径是否存在（分配唯一目录路径）
  let targetWorktreePath = baseWorktreePath;
  let wtAttempts = 0;
  while (existsSync(targetWorktreePath)) {
    wtAttempts++;
    if (wtAttempts > 50) {
      throw new Error(`Failed to allocate a unique runtime worktree path for ${baseWorktreePath}`);
    }
    const shortId = randomUUID().slice(0, 8);
    targetWorktreePath = resolve(join(worktreesDir, `${safeTaskId}-${shortId}`));
  }

  // 4. 记录基础 Commit
  let baseCommit: string | undefined;
  try {
    baseCommit = (await runGit(repoRoot, ["rev-parse", baseRef || "HEAD"])).trim();
  } catch {
    /* ignore */
  }

  // 5. 执行真实创建（原子新增分支与 worktree）
  try {
    if (baseRef) {
      await runGit(repoRoot, ["worktree", "add", "-b", targetBranch, targetWorktreePath, baseRef]);
    } else {
      await runGit(repoRoot, ["worktree", "add", "-b", targetBranch, targetWorktreePath]);
    }
  } catch (err) {
    // 创建失败：清理可能的残留，绝对不登记 ownership
    try {
      if (existsSync(targetWorktreePath)) {
        await runGit(repoRoot, ["worktree", "remove", "--force", targetWorktreePath]);
      }
    } catch {}
    try {
      await runGit(repoRoot, ["branch", "-D", targetBranch]);
    } catch {}
    throw new Error(`Failed to create runtime worktree for task ${taskId}: ${String(err instanceof Error ? err.message : err)}`);
  }

  // 6. 验证资源真实存在
  let branchVerified = false;
  try {
    await runGit(repoRoot, ["show-ref", "--verify", `refs/heads/${targetBranch}`]);
    branchVerified = true;
  } catch {
    branchVerified = false;
  }

  const worktreeVerified = existsSync(targetWorktreePath);

  if (!branchVerified || !worktreeVerified) {
    // 验证失败：清理并抛出异常，绝不登记 ownership
    try {
      if (worktreeVerified) {
        await runGit(repoRoot, ["worktree", "remove", "--force", targetWorktreePath]);
      }
    } catch {}
    try {
      if (branchVerified) {
        await runGit(repoRoot, ["branch", "-D", targetBranch]);
      }
    } catch {}
    throw new Error(`Runtime verification failed after creating worktree: branch=${branchVerified}, worktree=${worktreeVerified}`);
  }

  // 7. 成功创建并通过验证后，登记 Ownership 并持久化
  if (actualRunId) {
    registerRuntimeResource(actualRunId, "task_branch", targetBranch, repoRoot);
    registerRuntimeResource(actualRunId, "task_worktree", targetWorktreePath, repoRoot);
  }

  return { worktreePath: targetWorktreePath, branch: targetBranch, baseCommit };
}

export interface DiffStatResult {
  changedFiles: string[];
  diffStat: string;
  lastCommit?: string;
  headCommit?: string;
}

/**
 * 获取 Worktree 目录中的文件改动与真实提交信息
 * 严格依据 baseCommit..HEAD 与 working tree status 计算真实变更，杜绝将父提交误认为 Agent commit。
 */
export async function getWorktreeDiff(
  worktreePath: string,
  baseCommit?: string,
): Promise<DiffStatResult> {
  if (!existsSync(worktreePath)) {
    return { changedFiles: [], diffStat: "" };
  }

  const changedFiles: string[] = [];
  let diffStat = "";
  let lastCommit: string | undefined;
  let headCommit: string | undefined;

  try {
    // 1. 获取当前最新 HEAD
    headCommit = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim();
    if (!headCommit) return { changedFiles: [], diffStat: "" };

    // 2. 检查是否有新生成的 commit
    if (baseCommit && headCommit !== baseCommit.trim()) {
      lastCommit = headCommit;
      const logFiles = await runGit(worktreePath, [
        "log",
        `${baseCommit.trim()}..${headCommit}`,
        "--name-only",
        "--pretty=format:",
      ]);
      const committedFiles = logFiles
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      changedFiles.push(...committedFiles);

      try {
        diffStat = await runGit(worktreePath, ["diff", "--stat", baseCommit.trim(), headCommit]);
      } catch {
        /* ignore */
      }
    }

    // 3. 获取未提交的工作区变更（含已暂存与未追踪）
    const statusOut = await runGit(worktreePath, ["status", "--porcelain"]);
    if (statusOut && statusOut.trim().length > 0) {
      const workingLines = statusOut.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of workingLines) {
        const filePath = line.slice(2).trim();
        if (filePath && !changedFiles.includes(filePath)) {
          changedFiles.push(filePath);
        }
      }
    }

    return {
      changedFiles: Array.from(new Set(changedFiles)),
      diffStat,
      lastCommit,
      headCommit,
    };
  } catch (err) {
    console.warn(`[worktree] Failed to get diff for ${worktreePath}:`, err);
    return { changedFiles: [], diffStat: "" };
  }
}

/**
 * 将 Worktree 分支合并回主分支
 */
export async function mergeWorktreeBranch(
  repoRoot: string,
  branchName: string,
): Promise<{ success: boolean; output: string }> {
  try {
    const output = await runGit(repoRoot, ["merge", branchName, "-m", `Merge subagent branch ${branchName}`]);
    return { success: true, output };
  } catch (err) {
    return {
      success: false,
      output: String(err instanceof Error ? err.message : err),
    };
  }
}

/**
 * 自动将 Worktree 工作区内未提交的代码及未追踪文件执行 stage 与 commit
 */
export async function commitWorktreeChanges(
  worktreePath: string,
  commitMessage: string,
): Promise<{ committed: boolean; commitSha?: string; error?: string }> {
  try {
    if (!existsSync(worktreePath)) {
      return { committed: false, error: "Worktree path does not exist" };
    }

    const status = await runGit(worktreePath, ["status", "--porcelain"]);
    if (!status || status.trim().length === 0) {
      try {
        const currentHead = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim();
        return { committed: false, commitSha: currentHead };
      } catch {
        return { committed: false };
      }
    }

    await runGit(worktreePath, ["add", "-A"]);
    const msg = commitMessage?.trim() || "Auto-commit task changes";
    await runGit(worktreePath, ["commit", "-m", msg]);

    const newHead = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim();
    return { committed: true, commitSha: newHead };
  } catch (err: unknown) {
    const errorMsg = String(err instanceof Error ? err.message : err);
    return { committed: false, error: errorMsg };
  }
}

/**
 * 移除并清理指定的 Git Worktree
 */
export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  if (existsSync(worktreePath)) {
    await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    if (existsSync(worktreePath)) {
      try {
        await runGit(repoRoot, ["worktree", "prune"]);
      } catch {}
    }
    if (existsSync(worktreePath)) {
      throw new Error(`Worktree directory still exists at ${worktreePath} after removal`);
    }
  }
}

export interface MergeTestResult {
  canMerge: boolean;
  conflictFiles: string[];
}

/**
 * In-memory conflict detection test using `git merge-tree --write-tree`.
 *
 * This checks whether a worktree branch can be merged cleanly into HEAD
 * entirely in-memory without modifying the working directory or git index.
 */
export async function tryMergeWorktree(
  repoRoot: string,
  branchName: string,
): Promise<MergeTestResult> {
  try {
    // Modern git merge-tree --write-tree HEAD <branchName> (Git 2.38+)
    // Returns 0 on clean merge, non-zero with conflict markers on stdout when conflicted.
    await runGit(repoRoot, ["merge-tree", "--write-tree", "HEAD", branchName]);
    return { canMerge: true, conflictFiles: [] };
  } catch (err: unknown) {
    const errorObj = err as { stdout?: string; stderr?: string; message?: string };
    const stdout = (errorObj?.stdout ?? "").toString();
    const stderr = (errorObj?.stderr ?? "").toString();
    const fullOutput = `${errorObj?.message ?? ""}\n${stdout}\n${stderr}`;

    const conflictFiles = new Set<string>();

    // 1. Match tab-delimited stage entries in merge-tree output (e.g. "100644 <sha> 1\t<file>")
    const stageRegex = /^\d+\s+[0-9a-fA-F]+\s+[123]\t(.+)$/gm;
    let stageMatch: RegExpExecArray | null;
    while ((stageMatch = stageRegex.exec(fullOutput)) !== null) {
      if (stageMatch[1]?.trim()) {
        conflictFiles.add(stageMatch[1].trim());
      }
    }

    // 2. Match standard git CONFLICT messages
    const conflictRegex = /CONFLICT.*?:\s+.*?in\s+(\S+)/gi;
    let conflictMatch: RegExpExecArray | null;
    while ((conflictMatch = conflictRegex.exec(fullOutput)) !== null) {
      if (conflictMatch[1]?.trim()) {
        conflictFiles.add(conflictMatch[1].trim());
      }
    }

    // 3. Fallback for older git without --write-tree
    if (fullOutput.includes("unknown option `write-tree'") || fullOutput.includes("usage: git merge-tree")) {
      try {
        const mergeBase = await runGit(repoRoot, ["merge-base", "HEAD", branchName]);
        const treeOut = await runGit(repoRoot, ["merge-tree", mergeBase, "HEAD", branchName]);
        if (treeOut.includes("<<<<<<<") || treeOut.includes("merged with conflict")) {
          return { canMerge: false, conflictFiles: Array.from(conflictFiles) };
        }
        return { canMerge: true, conflictFiles: [] };
      } catch {
        /* ignore */
      }
    }

    return { canMerge: false, conflictFiles: Array.from(conflictFiles) };
  }
}
