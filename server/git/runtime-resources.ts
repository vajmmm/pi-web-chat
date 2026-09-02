import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { listWorktreeFolders, runGit } from "./git.ts";

export interface RuntimeGitResource {
  id: string;
  runId: string;
  type: "task_branch" | "integration_branch" | "task_worktree" | "integration_worktree";
  nameOrPath: string;
  createdByRuntime: true;
  createdAt: number;
}

// 内存级 Runtime 临时资源所有权注册表
const runtimeResourceRegistry = new Map<string, RuntimeGitResource>();

export function normalizeWorktreePath(p: string): string {
  const resolved = resolve(p);
  let cur = resolved;
  let suffix = "";
  while (cur && cur !== "/" && !existsSync(cur)) {
    suffix = "/" + basename(cur) + suffix;
    cur = dirname(cur);
  }
  if (cur && existsSync(cur)) {
    try {
      const realCur = realpathSync(cur);
      return resolve(realCur + suffix);
    } catch {}
  }
  return resolved;
}

function getResourceRegistryKey(runId: string, type: RuntimeGitResource["type"], nameOrPath: string): string {
  const normalizedName = type.endsWith("_worktree") ? normalizeWorktreePath(nameOrPath) : nameOrPath.trim();
  return `${runId}:${type}:${normalizedName}`;
}

function findRepoRootForWorktree(worktreePath: string): string | undefined {
  try {
    const norm = normalizeWorktreePath(worktreePath);
    const parentDir = resolve(norm, "..");
    if (basename(parentDir) === ".worktrees") {
      const candidateRepo = resolve(parentDir, "..");
      if (existsSync(join(candidateRepo, ".git"))) {
        return candidateRepo;
      }
    }
  } catch {}
  return undefined;
}

export function getRuntimeResourcesFilePath(repoRoot: string): string {
  return join(repoRoot, ".runtime", "git-resources.json");
}

export function loadPersistedRuntimeResources(repoRoot: string): RuntimeGitResource[] {
  try {
    const file = getRuntimeResourcesFilePath(repoRoot);
    if (!existsSync(file)) return [];
    const content = readFileSync(file, "utf8");
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (r): r is RuntimeGitResource =>
          r &&
          r.createdByRuntime === true &&
          typeof r.id === "string" &&
          typeof r.runId === "string" &&
          (r.type === "task_branch" ||
            r.type === "integration_branch" ||
            r.type === "task_worktree" ||
            r.type === "integration_worktree") &&
          typeof r.nameOrPath === "string",
      );
    }
    return [];
  } catch (err) {
    console.warn(`[worktree] Failed to read persisted runtime resources from ${repoRoot}:`, err);
    return [];
  }
}

export function savePersistedRuntimeResources(repoRoot: string, resources: RuntimeGitResource[]): void {
  try {
    const dir = join(repoRoot, ".runtime");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const targetFile = join(dir, "git-resources.json");
    const tmpFile = `${targetFile}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(resources, null, 2), "utf8");
    renameSync(tmpFile, targetFile);
  } catch (err) {
    console.warn(`[worktree] Failed to write persisted runtime resources for ${repoRoot}:`, err);
  }
}

export function clearRuntimeResourceRegistry(): void {
  runtimeResourceRegistry.clear();
}

/**
 * 校验资源类型与命名空间/路径的严格匹配门禁
 */
export function isResourceNamespaceValid(
  type: RuntimeGitResource["type"],
  nameOrPath: string,
  repoRoot: string,
): boolean {
  if (type === "task_branch") {
    return nameOrPath.startsWith("runtime/task-");
  }
  if (type === "integration_branch") {
    return nameOrPath.startsWith("runtime/run-");
  }
  if (type === "task_worktree") {
    const resolvedWorktreesDir = normalizeWorktreePath(join(repoRoot, ".worktrees"));
    const resolvedPath = normalizeWorktreePath(nameOrPath);
    if (
      !resolvedPath.startsWith(resolvedWorktreesDir + "/") ||
      resolvedPath === resolvedWorktreesDir ||
      resolvedPath === normalizeWorktreePath(repoRoot)
    ) {
      return false;
    }
    const base = basename(resolvedPath);
    return !base.startsWith("integration-");
  }
  if (type === "integration_worktree") {
    const resolvedWorktreesDir = normalizeWorktreePath(join(repoRoot, ".worktrees"));
    const resolvedPath = normalizeWorktreePath(nameOrPath);
    if (
      !resolvedPath.startsWith(resolvedWorktreesDir + "/") ||
      resolvedPath === resolvedWorktreesDir ||
      resolvedPath === normalizeWorktreePath(repoRoot)
    ) {
      return false;
    }
    const base = basename(resolvedPath);
    return base.startsWith("integration-");
  }
  return false;
}

/**
 * 登记 Runtime 创建的临时资源所有权（必须在资源真实创建成功后调用）
 */
export function registerRuntimeResource(
  runId: string,
  type: RuntimeGitResource["type"],
  nameOrPath: string,
  repoRoot?: string,
): RuntimeGitResource {
  const normalizedName = type.endsWith("_worktree") ? normalizeWorktreePath(nameOrPath) : nameOrPath.trim();
  const key = getResourceRegistryKey(runId, type, normalizedName);
  const resource: RuntimeGitResource = {
    id: key,
    runId,
    type,
    nameOrPath: normalizedName,
    createdByRuntime: true,
    createdAt: Date.now(),
  };

  runtimeResourceRegistry.set(key, resource);

  const root = repoRoot || (type.endsWith("_worktree") ? findRepoRootForWorktree(normalizedName) : undefined);
  if (root) {
    const existing = loadPersistedRuntimeResources(root);
    const updated = existing.filter((r) => r.id !== key);
    updated.push(resource);
    savePersistedRuntimeResources(root, updated);
  }

  return resource;
}

/**
 * 验证指定资源是否拥有当前 Runtime Run 的所有权记录（结合内存与持久化存储）
 */
export function hasRuntimeOwnership(
  runId: string,
  type: RuntimeGitResource["type"],
  nameOrPath: string,
  repoRoot?: string,
): boolean {
  const normalizedName = type.endsWith("_worktree") ? normalizeWorktreePath(nameOrPath) : nameOrPath.trim();
  const key = getResourceRegistryKey(runId, type, normalizedName);

  const inMem = runtimeResourceRegistry.get(key);
  if (inMem && inMem.createdByRuntime === true && inMem.runId === runId && inMem.type === type) {
    return true;
  }

  const root = repoRoot || (type.endsWith("_worktree") ? findRepoRootForWorktree(normalizedName) : undefined);
  if (root) {
    const persisted = loadPersistedRuntimeResources(root);
    const found = persisted.find(
      (r) => r.id === key || (r.runId === runId && r.type === type && (type.endsWith("_worktree") ? normalizeWorktreePath(r.nameOrPath) === normalizedName : r.nameOrPath === normalizedName)),
    );
    if (found && found.createdByRuntime === true) {
      runtimeResourceRegistry.set(key, found);
      return true;
    }
  }

  return false;
}

/**
 * 注销已清理的资源所有权（必须在资源真实删除且确认不存在后调用）
 */
export function unregisterRuntimeResource(
  runId: string,
  type: RuntimeGitResource["type"],
  nameOrPath: string,
  repoRoot?: string,
): void {
  const normalizedName = type.endsWith("_worktree") ? normalizeWorktreePath(nameOrPath) : nameOrPath.trim();
  const key = getResourceRegistryKey(runId, type, normalizedName);

  runtimeResourceRegistry.delete(key);

  const root = repoRoot || (type.endsWith("_worktree") ? findRepoRootForWorktree(normalizedName) : undefined);
  if (root) {
    const existing = loadPersistedRuntimeResources(root);
    const updated = existing.filter(
      (r) => r.id !== key && !(r.runId === runId && r.type === type && (type.endsWith("_worktree") ? normalizeWorktreePath(r.nameOrPath) === normalizedName : r.nameOrPath === normalizedName)),
    );
    savePersistedRuntimeResources(root, updated);
  }
}

/**
 * 服务启动时恢复 Git 资源所有权（仅依据持久化记录与实际 Git 状态核实，严禁无根据扫描认领）
 */
export async function recoverRuntimeResources(repoRoot: string): Promise<{
  recovered: RuntimeGitResource[];
  staleRemoved: RuntimeGitResource[];
}> {
  const persisted = loadPersistedRuntimeResources(repoRoot);
  const recovered: RuntimeGitResource[] = [];
  const staleRemoved: RuntimeGitResource[] = [];

  for (const record of persisted) {
    let exists = false;
    if (record.type === "task_branch" || record.type === "integration_branch") {
      try {
        await runGit(repoRoot, ["show-ref", "--verify", `refs/heads/${record.nameOrPath}`]);
        exists = true;
      } catch {
        exists = false;
      }
    } else if (record.type === "task_worktree" || record.type === "integration_worktree") {
      if (existsSync(record.nameOrPath)) {
        try {
          const list = await listWorktreeFolders(repoRoot);
          const targetNorm = normalizeWorktreePath(record.nameOrPath);
          exists = list.some((w) => normalizeWorktreePath(w.path) === targetNorm);
        } catch {
          exists = false;
        }
      } else {
        exists = false;
      }
    }

    if (exists) {
      recovered.push(record);
      runtimeResourceRegistry.set(record.id, record);
    } else {
      staleRemoved.push(record);
      runtimeResourceRegistry.delete(record.id);
    }
  }

  // 写回仅包含活跃有效资源的持久化记录
  savePersistedRuntimeResources(repoRoot, recovered);

  return { recovered, staleRemoved };
}
