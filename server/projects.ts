import { existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import type { UIProjectFolder, UIProjectItem, UISessionInfo } from "../shared/protocol.ts";
import {
  getCurrentGitBranch,
  listWorktreeFolders,
  resolveGitRepoRoot,
  resolveProjectRoot,
} from "./worktree.ts";

const HOME = homedir();

function shorten(p: string): string {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

export function formatRelativeTime(dateInput: string | Date): string {
  const date = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  const now = Date.now();
  const diffMs = Math.max(0, now - date.getTime());
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return "1m";
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHour < 24) return `${diffHour}h`;
  if (diffDay < 30) return `${diffDay}d`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo`;
  return `${Math.floor(diffDay / 365)}y`;
}

function sessionIdOf(file?: string): string {
  if (!file) return "";
  const base = basename(file).replace(/\.jsonl$/, "");
  const i = base.lastIndexOf("_");
  return i >= 0 ? base.slice(i + 1) : base;
}

/**
 * 从 .jsonl 首行快速解析 session header 获取 cwd
 */
function readHeaderCwd(filePath: string): string | null {
  try {
    const fd = readFileSync(filePath, "utf8");
    const firstNewline = fd.indexOf("\n");
    const firstLine = firstNewline >= 0 ? fd.slice(0, firstNewline) : fd;
    const parsed = JSON.parse(firstLine) as { type?: string; cwd?: string };
    return parsed?.cwd ?? null;
  } catch {
    return null;
  }
}

// 缓存已知项目及文件夹列表
const knownFolderPaths = new Set<string>();

export function registerKnownProjectPath(p: string) {
  if (p && existsSync(p)) {
    knownFolderPaths.add(resolve(p));
  }
}

export function removeKnownProjectPath(p: string) {
  if (p) {
    const resolved = resolve(p);
    knownFolderPaths.delete(resolved);
    for (const item of Array.from(knownFolderPaths)) {
      if (item === resolved || item.startsWith(resolved + "/")) {
        knownFolderPaths.delete(item);
      }
    }
  }
}

/**
 * 删除单个会话文件
 */
export async function deleteSessionFile(sessionId: string, cwd?: string): Promise<{ ok: boolean; path?: string }> {
  const sessionsDir = join(getAgentDir(), "sessions");
  const suffix = `_${sessionId}.jsonl`;

  if (cwd && existsSync(cwd)) {
    try {
      const list = await SessionManager.list(cwd);
      const target = list.find((s) => sessionIdOf(s.path) === sessionId);
      if (target?.path && existsSync(target.path)) {
        unlinkSync(target.path);
        return { ok: true, path: target.path };
      }
    } catch {
      /* fallback to full scan */
    }
  }

  if (existsSync(sessionsDir)) {
    const dirs = readdirSync(sessionsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const projectPath = join(sessionsDir, dir.name);
      try {
        const files = readdirSync(projectPath);
        for (const file of files) {
          if (file.endsWith(suffix) || file.replace(/\.jsonl$/, "").endsWith(sessionId)) {
            const fullPath = join(projectPath, file);
            unlinkSync(fullPath);
            return { ok: true, path: fullPath };
          }
        }
      } catch {
        /* continue */
      }
    }
  }

  return { ok: false };
}

/**
 * 删除单个文件夹/工作区下的所有会话记录
 */
export async function deleteFolderSessions(folderPath: string): Promise<{ ok: boolean; deletedCount: number }> {
  const resolved = resolve(folderPath);
  removeKnownProjectPath(resolved);

  let deletedCount = 0;
  const sessionsDir = join(getAgentDir(), "sessions");

  if (existsSync(sessionsDir)) {
    const dirs = readdirSync(sessionsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const projectPath = join(sessionsDir, dir.name);
      try {
        const files = readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));
        if (files.length > 0) {
          const headerCwd = readHeaderCwd(join(projectPath, files[0]));
          if (headerCwd && resolve(headerCwd) === resolved) {
            for (const file of files) {
              unlinkSync(join(projectPath, file));
              deletedCount++;
            }
            rmSync(projectPath, { recursive: true, force: true });
          }
        } else {
          // 清理空会话文件夹
          rmSync(projectPath, { recursive: true, force: true });
        }
      } catch {
        /* continue */
      }
    }
  }

  return { ok: true, deletedCount };
}

/**
 * 删除整个项目（包括该项目下属所有文件夹及 Worktrees）的会话记录
 */
export async function deleteProjectSessions(targetPath: string): Promise<{ ok: boolean; deletedCount: number }> {
  const resolvedTarget = resolve(targetPath);
  const { projectRoot } = await resolveProjectRoot(targetPath);
  removeKnownProjectPath(projectRoot);
  removeKnownProjectPath(resolvedTarget);
  let totalDeleted = 0;

  // 寻找所有属于该 projectRoot 的已记录文件夹
  for (const p of Array.from(knownFolderPaths)) {
    const info = await resolveProjectRoot(p);
    if (info.projectRoot === projectRoot || resolve(p) === resolvedTarget) {
      const res = await deleteFolderSessions(p);
      totalDeleted += res.deletedCount;
    }
  }

  // 扫描 ~/.pi/agent/sessions 兜底清理
  const sessionsDir = join(getAgentDir(), "sessions");
  if (existsSync(sessionsDir)) {
    const dirs = readdirSync(sessionsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const projectPath = join(sessionsDir, dir.name);
      try {
        const files = readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));
        if (files.length > 0) {
          const headerCwd = readHeaderCwd(join(projectPath, files[0]));
          if (headerCwd) {
            const info = await resolveProjectRoot(headerCwd);
            if (info.projectRoot === projectRoot || resolve(headerCwd) === resolvedTarget) {
              for (const file of files) {
                unlinkSync(join(projectPath, file));
                totalDeleted++;
              }
              rmSync(projectPath, { recursive: true, force: true });
            }
          }
        } else {
          rmSync(projectPath, { recursive: true, force: true });
        }
      } catch {
        /* continue */
      }
    }
  }

  return { ok: true, deletedCount: totalDeleted };
}

/**
 * 扫描并获取所有项目及其下属多文件夹/Worktrees与会话列表
 */
export async function listAllProjects(extraCwds: string[] = []): Promise<UIProjectItem[]> {
  for (const p of extraCwds) {
    if (p && existsSync(p)) knownFolderPaths.add(resolve(p));
  }

  const sessionsDir = join(getAgentDir(), "sessions");
  const discoveredFolders = new Set<string>();

  if (existsSync(sessionsDir)) {
    try {
      const dirs = readdirSync(sessionsDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const name = dir.name;
        if (name.startsWith("--private-tmp-") || name.startsWith("--var-folders-")) {
          continue;
        }

        const projectPath = join(sessionsDir, name);
        const files = readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));
        if (files.length > 0) {
          files.sort((a, b) => {
            try {
              return statSync(join(projectPath, b)).mtimeMs - statSync(join(projectPath, a)).mtimeMs;
            } catch {
              return 0;
            }
          });
          const realCwd = readHeaderCwd(join(projectPath, files[0]));
          if (realCwd && existsSync(realCwd)) {
            discoveredFolders.add(resolve(realCwd));
            knownFolderPaths.add(resolve(realCwd));
          }
        }
      }
    } catch (err) {
      console.warn("[Projects] Failed to read sessionsDir:", err);
    }
  }

  for (const p of knownFolderPaths) {
    if (existsSync(p)) {
      discoveredFolders.add(resolve(p));
    }
  }

  // 1. 解析每个 folder 对应的 projectRoot，并将 folder 归纳到对应 Project
  interface IntermediateProject {
    id: string;
    name: string;
    projectRoot: string;
    isGitRepo: boolean;
    gitBranch?: string;
    folders: Map<string, { path: string; branch?: string; isMain: boolean }>;
  }

  const projectMap = new Map<string, IntermediateProject>();

  for (const folderPath of discoveredFolders) {
    const { projectRoot, isGit, branch } = await resolveProjectRoot(folderPath);
    let proj = projectMap.get(projectRoot);
    if (!proj) {
      proj = {
        id: projectRoot,
        name: basename(projectRoot) || projectRoot,
        projectRoot,
        isGitRepo: isGit,
        gitBranch: isGit ? (await getCurrentGitBranch(projectRoot)) ?? undefined : undefined,
        folders: new Map(),
      };
      projectMap.set(projectRoot, proj);

      // 如果是 Git 仓库，自动探测所有登记的 worktree 文件夹
      if (isGit) {
        try {
          const worktrees = await listWorktreeFolders(projectRoot);
          for (const wt of worktrees) {
            if (existsSync(wt.path)) {
              proj.folders.set(wt.path, {
                path: wt.path,
                branch: wt.branch ?? undefined,
                isMain: wt.isMain,
              });
            }
          }
        } catch {
          /* continue */
        }
      }
    }

    if (!proj.folders.has(folderPath)) {
      proj.folders.set(folderPath, {
        path: folderPath,
        branch: branch ?? undefined,
        isMain: folderPath === projectRoot,
      });
    }
  }

  // 2. 读取每个 folder 下的所有会话，并构建完整的 UIProjectItem
  const result: UIProjectItem[] = [];

  for (const proj of projectMap.values()) {
    const folderList: UIProjectFolder[] = [];
    const allProjectSessions: UISessionInfo[] = [];

    for (const folder of proj.folders.values()) {
      let sessions: UISessionInfo[] = [];
      try {
        const rawSessions = await SessionManager.list(folder.path);
        sessions = rawSessions
          .sort((a, b) => b.modified.getTime() - a.modified.getTime())
          .slice(0, 50)
          .map((s) => ({
            id: sessionIdOf(s.path),
            path: s.path,
            name: s.name,
            firstMessage: s.firstMessage?.slice(0, 150) || "",
            modified: s.modified.toISOString(),
            relativeTime: formatRelativeTime(s.modified),
            messageCount: s.messageCount,
            cwd: folder.path,
          }));
      } catch {
        sessions = [];
      }

      allProjectSessions.push(...sessions);

      folderList.push({
        path: folder.path,
        name: basename(folder.path) || folder.path,
        displayPath: shorten(folder.path),
        branch: folder.branch,
        isMain: folder.isMain,
        sessions,
      });
    }

    // 将全部会话按最新时间排序
    allProjectSessions.sort(
      (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
    );

    // 文件夹排序：主目录最前，其余按名称/分支排序
    folderList.sort((a, b) => {
      if (a.isMain && !b.isMain) return -1;
      if (!a.isMain && b.isMain) return 1;
      return a.name.localeCompare(b.name);
    });

    const latestTime = allProjectSessions[0]?.modified ?? new Date(0).toISOString();

    result.push({
      id: proj.id,
      name: proj.name,
      cwd: proj.projectRoot,
      projectRoot: proj.projectRoot,
      displayPath: shorten(proj.projectRoot),
      isGitRepo: proj.isGitRepo,
      gitBranch: proj.gitBranch,
      lastModified: latestTime,
      folders: folderList,
      sessions: allProjectSessions,
    });
  }

  result.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
  return result;
}
