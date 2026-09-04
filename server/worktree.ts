export type { CleanupResult, FinalizeMode, FinalizeResult, QuiescenceResult } from "./contracts/task.ts";
export {
  resolveGitRepoRoot,
  getCurrentGitBranch,
  listWorktreeFolders,
  probeGitBranch,
  probeGitWorktree,
  type GitProbeResult,
  type GitProbeStatus,
} from "./git/git.ts";
export * from "./git/project-root.ts";
export {
  type RuntimeGitResource,
  normalizeWorktreePath,
  getRuntimeResourcesFilePath,
  loadPersistedRuntimeResources,
  savePersistedRuntimeResources,
  clearRuntimeResourceRegistry,
  isResourceNamespaceValid,
  registerRuntimeResource,
  hasRuntimeOwnership,
  unregisterRuntimeResource,
  recoverRuntimeResources,
} from "./git/runtime-resources.ts";
export * from "./git/worktree.ts";
export * from "./git/integration-workspace.ts";
export * from "./git/finalize-run.ts";
export * from "./git/cleanup.ts";
