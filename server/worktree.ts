export type { CleanupResult, FinalizeMode, FinalizeResult } from "./contracts/task.ts";
export { resolveGitRepoRoot, getCurrentGitBranch, listWorktreeFolders } from "./git/git.ts";
export * from "./git/project-root.ts";
export * from "./git/runtime-resources.ts";
export * from "./git/worktree.ts";
export * from "./git/integration-workspace.ts";
export * from "./git/finalize-run.ts";
export * from "./git/cleanup.ts";
