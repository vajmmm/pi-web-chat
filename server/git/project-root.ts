import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runGit } from "./git.ts";

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
