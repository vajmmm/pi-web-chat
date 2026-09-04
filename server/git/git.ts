import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024 * 2,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

export type GitProbeStatus = "exists" | "missing" | "error";

export interface GitProbeResult {
  status: GitProbeStatus;
  error?: string;
}

function gitErrorCode(err: unknown): string | number | undefined {
  return (err as { code?: string | number })?.code;
}

function gitErrorMessage(err: unknown): string {
  return String(err instanceof Error ? err.message : err);
}

/**
 * Distinguish branch exists / missing / operational error.
 * `git rev-parse --verify --quiet` returns 1 for a missing ref and 128+ for repo/git failures.
 */
export async function probeGitBranch(repoRoot: string, branch: string): Promise<GitProbeResult> {
  try {
    await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return { status: "exists" };
  } catch (err) {
    const code = gitErrorCode(err);
    if (code === 1) return { status: "missing" };
    return { status: "error", error: gitErrorMessage(err) };
  }
}

/**
 * Distinguish worktree exists / missing / operational error.
 * Git list failure is never treated as missing.
 */
export async function probeGitWorktree(repoRoot: string, worktreePath: string): Promise<GitProbeResult> {
  const target = resolve(worktreePath);
  const onDisk = existsSync(target);
  try {
    const out = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
    const listed = out.split("\n").some((line) => {
      if (!line.startsWith("worktree ")) return false;
      return resolve(line.slice("worktree ".length).trim()) === target;
    });
    if (listed || onDisk) return { status: "exists" };
    return { status: "missing" };
  } catch (err) {
    return {
      status: "error",
      error: onDisk
        ? `Worktree path exists on disk but git worktree list failed: ${gitErrorMessage(err)}`
        : gitErrorMessage(err),
    };
  }
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
