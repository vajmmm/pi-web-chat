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

// 短 TTL 缓存,避免会话冷开时在关键路径上重复 spawn `git`。
// repo root 对同一 cwd 基本恒定;branch 仅用于 UI 展示,秒级过期可接受。
// 缓存收益主要落在"同一仓库下多个会话轮流冷开"——首个解析后,其余命中缓存。
interface GitCacheEntry<T> {
  value: T;
  expires: number;
}
const REPO_ROOT_TTL_MS = 30_000;
const BRANCH_TTL_MS = 3_000;
const repoRootCache = new Map<string, GitCacheEntry<string | null>>();
const branchCache = new Map<string, GitCacheEntry<string | null>>();

function readCache<T>(cache: Map<string, GitCacheEntry<T>>, key: string): { hit: boolean; value?: T } {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return { hit: true, value: entry.value };
  if (entry) cache.delete(key);
  return { hit: false };
}

/**
 * 检查指定目录是否在 Git 仓库内，并返回仓库根目录
 */
export async function resolveGitRepoRoot(cwd: string): Promise<string | null> {
  const cached = readCache(repoRootCache, cwd);
  if (cached.hit) return cached.value ?? null;
  let value: string | null = null;
  try {
    const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    value = root && existsSync(root) ? resolve(root) : null;
  } catch {
    value = null;
  }
  repoRootCache.set(cwd, { value, expires: Date.now() + REPO_ROOT_TTL_MS });
  return value;
}

/**
 * 获取指定目录当前的 Git 分支名
 */
export async function getCurrentGitBranch(cwd: string): Promise<string | null> {
  const cached = readCache(branchCache, cwd);
  if (cached.hit) return cached.value ?? null;
  let value: string | null = null;
  try {
    const branch = await runGit(cwd, ["branch", "--show-current"]);
    value = branch || null;
  } catch {
    value = null;
  }
  branchCache.set(cwd, { value, expires: Date.now() + BRANCH_TTL_MS });
  return value;
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
