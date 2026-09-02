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
