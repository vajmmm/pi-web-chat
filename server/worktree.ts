import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024 * 2,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

/**
 * 检查指定目录是否在 Git 仓库内，并返回仓库根目录
 */
export async function resolveGitRepoRoot(cwd: string): Promise<string | null> {
  try {
    const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    return root && existsSync(root) ? resolve(root) : null;
  } catch {
    return null;
  }
}

/**
 * 统一解析 Project 根路径（跨 Worktree / 子目录）
 */
export async function resolveProjectRoot(cwd: string): Promise<{
  projectRoot: string;
  isGit: boolean;
  isWorktree: boolean;
  branch: string | null;
}> {
  try {
    const out = await runGit(cwd, [
      "rev-parse",
      "--git-common-dir",
      "--git-dir",
      "--show-toplevel",
      "--abbrev-ref",
      "HEAD",
    ]);
    const [commonDirRaw, gitDirRaw, toplevelRaw, ref] = out.split("\n").map((l) => l.trim());
    const commonDir = resolve(cwd, commonDirRaw);
    const gitDir = resolve(cwd, gitDirRaw);
    const toplevel = resolve(cwd, toplevelRaw);
    const isWorktree = commonDir !== gitDir;
    // 对于 linked worktree，commonDir 通常位于 <mainRepo>/.git，其 dirname 即为主仓库 Project 根目录
    const mainProjectRoot = isWorktree ? dirname(commonDir) : toplevel;
    const projectRoot = existsSync(mainProjectRoot) ? mainProjectRoot : toplevel;
    return {
      projectRoot: resolve(projectRoot),
      isGit: true,
      isWorktree,
      branch: ref && ref !== "HEAD" ? ref : null,
    };
  } catch {
    return {
      projectRoot: resolve(cwd),
      isGit: false,
      isWorktree: false,
      branch: null,
    };
  }
}

/**
 * 获取 Git 仓库下已注册的所有 Worktree 文件夹
 */
export async function listWorktreeFolders(
  cwd: string,
): Promise<Array<{ path: string; branch: string | null; isMain: boolean }>> {
  try {
    const out = await runGit(cwd, ["worktree", "list", "--porcelain"]);
    const worktrees: Array<{ path: string; branch: string | null; isMain: boolean }> = [];
    let curPath = "";
    let curBranch: string | null = null;
    let prunable = false;
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        curPath = line.slice("worktree ".length).trim();
      } else if (line.startsWith("branch refs/heads/")) {
        curBranch = line.slice("branch refs/heads/".length).trim();
      } else if (line.startsWith("detached")) {
        curBranch = null;
      } else if (line.startsWith("prunable")) {
        prunable = true;
      } else if (line === "") {
        if (curPath && !prunable && existsSync(curPath)) {
          worktrees.push({
            path: resolve(curPath),
            branch: curBranch,
            isMain: worktrees.length === 0,
          });
        }
        curPath = "";
        curBranch = null;
        prunable = false;
      }
    }
    if (curPath && !prunable && existsSync(curPath)) {
      worktrees.push({
        path: resolve(curPath),
        branch: curBranch,
        isMain: worktrees.length === 0,
      });
    }
    return worktrees;
  } catch {
    return [{ path: resolve(cwd), branch: null, isMain: true }];
  }
}

/**
 * 获取指定目录当前的 Git 分支名
 */
export async function getCurrentGitBranch(cwd: string): Promise<string | null> {
  try {
    const branch = await runGit(cwd, ["branch", "--show-current"]);
    return branch || null;
  } catch {
    return null;
  }
}

export interface WorktreeResult {
  worktreePath: string;
  branch: string;
  baseCommit?: string;
}

/**
 * 在仓库下创建独立的 Git Worktree 隔离工作区，并记录创建时的 baseCommit
 */
export async function createWorktree(
  repoRoot: string,
  taskId: string,
  preferredBranch?: string,
): Promise<WorktreeResult> {
  const rawId = taskId.startsWith("task-") ? taskId.slice(5) : taskId;
  const shortId = rawId.slice(0, 8);
  const branch = preferredBranch?.trim() || `feat/task-${shortId}`;
  const worktreesDir = join(repoRoot, ".worktrees");
  mkdirSync(worktreesDir, { recursive: true });
  const worktreePath = resolve(join(worktreesDir, taskId));

  // 记录基础 Commit
  let baseCommit: string | undefined;
  try {
    baseCommit = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  } catch {
    /* ignore */
  }

  // 检查分支是否已经存在
  let branchExists = false;
  try {
    await runGit(repoRoot, ["show-ref", "--verify", `refs/heads/${branch}`]);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  if (branchExists) {
    await runGit(repoRoot, ["worktree", "add", worktreePath, branch]);
  } else {
    await runGit(repoRoot, ["worktree", "add", "-b", branch, worktreePath]);
  }

  return { worktreePath, branch, baseCommit };
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
    try {
      headCommit = await runGit(worktreePath, ["rev-parse", "HEAD"]);
    } catch {
      /* ignore */
    }

    // 1. 如果 HEAD 与 baseCommit 不同，说明 Agent 产生了真实的新提交
    if (baseCommit && headCommit && baseCommit !== headCommit) {
      try {
        lastCommit = await runGit(worktreePath, ["log", "-1", "--oneline", "HEAD"]);
        const committedDiff = await runGit(worktreePath, [
          "diff",
          "--name-only",
          baseCommit,
          headCommit,
        ]);
        if (committedDiff) {
          for (const file of committedDiff.split("\n")) {
            if (file.trim()) changedFiles.push(file.trim());
          }
        }
      } catch {
        /* ignore */
      }
    } else {
      // 未产生新提交，lastCommit 必须为 undefined，严禁误读父提交
      lastCommit = undefined;
    }

    // 2. 检查未暂存/未提交的工作区变更
    const statusOutput = await runGit(worktreePath, ["status", "--porcelain"]);
    if (statusOutput) {
      const lines = statusOutput.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
          changedFiles.push(parts.slice(1).join(" "));
        }
      }
    }

    // 3. 获取整体差异统计
    try {
      const diffRef = baseCommit || "HEAD";
      diffStat = await runGit(worktreePath, ["diff", "--stat", diffRef]);
    } catch {
      diffStat = "";
    }
  } catch (err) {
    console.warn(`[worktree] Failed to get diff for ${worktreePath}:`, err);
  }

  return {
    changedFiles: Array.from(new Set(changedFiles)),
    diffStat,
    lastCommit,
    headCommit,
  };
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
 * 移除并清理指定的 Git Worktree
 */
export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    if (existsSync(worktreePath)) {
      await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    }
  } catch (err) {
    console.warn(`[worktree] Failed to remove worktree ${worktreePath}:`, err);
  }
}
