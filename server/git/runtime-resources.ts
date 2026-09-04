import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { probeGitBranch, probeGitWorktree } from "./git.ts";

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

export function findRepoRootForWorktree(worktreePath: string): string | undefined {
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
  const file = getRuntimeResourcesFilePath(repoRoot);
  if (!existsSync(file)) return [];
  const content = readFileSync(file, "utf8");
  if (!content.trim()) return [];
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
  throw new Error(`Corrupted runtime resources file at ${file}: content is not an array`);
}

export function savePersistedRuntimeResources(repoRoot: string, resources: RuntimeGitResource[]): void {
  const dir = join(repoRoot, ".runtime");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const targetFile = join(dir, "git-resources.json");
  const tmpFile = `${targetFile}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmpFile, JSON.stringify(resources, null, 2), "utf8");
    renameSync(tmpFile, targetFile);
  } catch (err) {
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    } catch {}
    throw err;
  }
}

let persistenceFailureInjector: ((resource: RuntimeGitResource) => boolean) | null = null;
let rollbackWorktreeRemoveFailureInjector: ((path: string) => boolean) | null = null;

export function setPersistenceFailureInjector(fn: ((resource: RuntimeGitResource) => boolean) | null): void {
  persistenceFailureInjector = fn;
}

export function setRollbackWorktreeRemoveFailureInjector(fn: ((path: string) => boolean) | null): void {
  rollbackWorktreeRemoveFailureInjector = fn;
}

export function shouldInjectRollbackWorktreeRemoveFailure(path: string): boolean {
  return rollbackWorktreeRemoveFailureInjector ? rollbackWorktreeRemoveFailureInjector(path) : false;
}

export function clearRuntimeResourceRegistry(): void {
  runtimeResourceRegistry.clear();
  persistenceFailureInjector = null;
  rollbackWorktreeRemoveFailureInjector = null;
}

export interface PendingGitRecoveryRecord {
  id: string;
  repoRoot: string;
  runId: string;
  type: "task_branch" | "integration_branch" | "task_worktree" | "integration_worktree";
  nameOrPath: string;
  source: "task_worktree" | "integration_workspace";
  rollbackError: string;
  createdAt: number;
}

export function getPendingGitRecoveryFilePath(repoRoot: string): string {
  return join(repoRoot, ".runtime", "pending-git-recovery.json");
}

export function loadPendingGitRecovery(repoRoot: string): PendingGitRecoveryRecord[] {
  const file = getPendingGitRecoveryFilePath(repoRoot);
  if (!existsSync(file)) return [];
  const content = readFileSync(file, "utf8");
  if (!content.trim()) return [];
  const parsed = JSON.parse(content);
  if (Array.isArray(parsed)) {
    return parsed.filter(
      (r): r is PendingGitRecoveryRecord =>
        r &&
        typeof r.id === "string" &&
        typeof r.repoRoot === "string" &&
        typeof r.runId === "string" &&
        (r.type === "task_branch" ||
          r.type === "integration_branch" ||
          r.type === "task_worktree" ||
          r.type === "integration_worktree") &&
        typeof r.nameOrPath === "string" &&
        (r.source === "task_worktree" || r.source === "integration_workspace"),
    );
  }
  throw new Error(`Corrupted pending git recovery file at ${file}`);
}

export function savePendingGitRecovery(repoRoot: string, records: PendingGitRecoveryRecord[]): void {
  const dir = join(repoRoot, ".runtime");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const targetFile = join(dir, "pending-git-recovery.json");
  const tmpFile = `${targetFile}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmpFile, JSON.stringify(records, null, 2), "utf8");
    renameSync(tmpFile, targetFile);
  } catch (err) {
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    } catch {}
    throw err;
  }
}

export function recordPendingGitRecovery(record: PendingGitRecoveryRecord): void {
  const existing = loadPendingGitRecovery(record.repoRoot);
  const updated = existing.filter((r) => r.id !== record.id);
  updated.push(record);
  savePendingGitRecovery(record.repoRoot, updated);
}

export function removePendingGitRecovery(
  repoRoot: string,
  runId: string,
  type: RuntimeGitResource["type"],
  nameOrPath: string,
): void {
  const normalizedName = type.endsWith("_worktree") ? normalizeWorktreePath(nameOrPath) : nameOrPath.trim();
  const existing = loadPendingGitRecovery(repoRoot);
  const updated = existing.filter(
    (r) =>
      !(
        r.runId === runId &&
        r.type === type &&
        (type.endsWith("_worktree")
          ? normalizeWorktreePath(r.nameOrPath) === normalizedName
          : r.nameOrPath === normalizedName)
      ),
  );
  if (updated.length !== existing.length) {
    savePendingGitRecovery(repoRoot, updated);
  }
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

  const root = repoRoot || (type.endsWith("_worktree") ? findRepoRootForWorktree(normalizedName) : undefined);
  if (root) {
    if (persistenceFailureInjector && persistenceFailureInjector(resource)) {
      throw new Error(`Injected persistence failure for resource ${resource.type}: ${resource.nameOrPath}`);
    }
    const existing = loadPersistedRuntimeResources(root);
    const updated = existing.filter((r) => r.id !== key);
    updated.push(resource);
    savePersistedRuntimeResources(root, updated);
  }

  runtimeResourceRegistry.set(key, resource);
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

    const pending = loadPendingGitRecovery(root);
    const foundPending = pending.find(
      (r) => r.id === key || (r.runId === runId && r.type === type && (type.endsWith("_worktree") ? normalizeWorktreePath(r.nameOrPath) === normalizedName : r.nameOrPath === normalizedName)),
    );
    if (foundPending) {
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

  const root = repoRoot || (type.endsWith("_worktree") ? findRepoRootForWorktree(normalizedName) : undefined);
  if (root) {
    const existing = loadPersistedRuntimeResources(root);
    const updated = existing.filter(
      (r) => r.id !== key && !(r.runId === runId && r.type === type && (type.endsWith("_worktree") ? normalizeWorktreePath(r.nameOrPath) === normalizedName : r.nameOrPath === normalizedName)),
    );
    savePersistedRuntimeResources(root, updated);
  }

  runtimeResourceRegistry.delete(key);
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
    const probe =
      record.type === "task_branch" || record.type === "integration_branch"
        ? await probeGitBranch(repoRoot, record.nameOrPath)
        : await probeGitWorktree(repoRoot, record.nameOrPath);

    if (probe.status === "error") {
      throw new Error(
        `Cannot recover runtime resource ${record.id}: git probe operational error: ${probe.error}`,
      );
    }

    if (probe.status === "exists") {
      recovered.push(record);
    } else {
      staleRemoved.push(record);
    }
  }

  // 恢复未完成注册但物理存在的 pending recovery 资源
  const recoveryRecords = loadPendingGitRecovery(repoRoot);
  const stillPending: PendingGitRecoveryRecord[] = [];
  for (const rec of recoveryRecords) {
    const probe =
      rec.type === "task_branch" || rec.type === "integration_branch"
        ? await probeGitBranch(repoRoot, rec.nameOrPath)
        : await probeGitWorktree(repoRoot, rec.nameOrPath);

    if (probe.status === "error") {
      throw new Error(
        `Cannot recover pending git recovery resource ${rec.id}: git probe operational error: ${probe.error}`,
      );
    }

    if (probe.status === "exists") {
      stillPending.push(rec);
      const syntheticResource: RuntimeGitResource = {
        id: rec.id,
        runId: rec.runId,
        type: rec.type,
        nameOrPath: rec.nameOrPath,
        createdByRuntime: true,
        createdAt: rec.createdAt,
      };
      recovered.push(syntheticResource);
      runtimeResourceRegistry.set(rec.id, syntheticResource);
    }
  }

  if (stillPending.length !== recoveryRecords.length) {
    savePendingGitRecovery(repoRoot, stillPending);
  }

  for (const record of recovered) {
    runtimeResourceRegistry.set(record.id, record);
  }
  for (const record of staleRemoved) {
    runtimeResourceRegistry.delete(record.id);
  }

  savePersistedRuntimeResources(repoRoot, recovered.filter((r) => !recoveryRecords.some((rec) => rec.id === r.id)));

  return { recovered, staleRemoved };
}
