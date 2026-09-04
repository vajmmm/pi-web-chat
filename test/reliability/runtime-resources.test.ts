import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type {
  ReviewResult,
  TaskContract,
  UISubagentTask,
  VerificationResult,
} from "../../shared/protocol.ts";
import { ConstraintResolver, getRoleDefinition, RoleRegistry } from "../../server/contracts/index.ts";
import {
  runVerification,
  extractCommandRecords,
  classifyCommandPurpose,
  resolveExpectedEffects,
  DEFAULT_ROLE_EXPECTED_EFFECTS,
  verifyTestExecution,
} from "../../server/runtime-verifier.ts";
import {
  extractLastAssistantText,
  normalizeFinishReason,
  buildBoundedCompletionReport,
} from "../../server/subagent-report.ts";
import { subagentTasks, SubagentManager } from "../../server/subagent-manager.ts";
import { isTaskExecutionSatisfied, isTaskLineageSatisfied } from "../../server/task-graph.ts";
import {
  captureWorkingTreePathSnapshots,
  cleanupRunResources,
  clearRuntimeResourceRegistry,
  createWorktree,
  getRuntimeResourcesFilePath,
  getWorktreeDiff,
  hasRuntimeOwnership,
  loadPersistedRuntimeResources,
  normalizeWorktreePath,
  recoverRuntimeResources,
  registerRuntimeResource,
  tryMergeWorktree,
  unregisterRuntimeResource,
} from "../../server/worktree.ts";
import { createMockSession, mockModelRuntime, setupTestGitRepo, testAgentDir } from "./helpers.ts";


export function registerRuntimeResourcesTests(getGitRepoDir: () => string) {
  let gitRepoDir: string;
  beforeEach(() => {
    gitRepoDir = getGitRepoDir();
  });


  describe("32. Runtime Resource Ownership & Dual Gate Branch Deletion", () => {
    it("should skip user existing branch (feature/user-important) and preserve it", async () => {
      const runId = `session-owner-test-${Date.now()}`;
      const userBranch = "feature/user-important";

      // User creates a branch manually
      execFileSync("git", ["-C", gitRepoDir, "branch", userBranch]);

      // Attempt cleanup targeting userBranch without ownership
      const result = await cleanupRunResources(gitRepoDir, {
        runId,
        branch: `runtime/run-${runId}`,
        worktreePath: join(gitRepoDir, ".worktrees", `integration-${runId}`),
        baseCommit: "HEAD",
        originalBranch: "main",
      }, [
        { branchName: userBranch },
      ]);

      // Verify branch is skipped and still exists
      assert.ok(result.skipped.some((s) => s.includes(userBranch)));
      const branchesOut = execFileSync("git", ["-C", gitRepoDir, "branch", "--list", userBranch], { encoding: "utf8" });
      assert.ok(branchesOut.includes(userBranch), "User branch must not be deleted");

      // Clean test user branch
      execFileSync("git", ["-C", gitRepoDir, "branch", "-D", userBranch]);
    });

    it("should safely cleanup runtime owned branch and skip unowned runtime-prefixed branch", async () => {
      const runId = `session-owner-branch-${Date.now()}`;
      const ownedBranch = `runtime/task-${runId}-task1`;
      const unownedBranch = `runtime/task-user-created-${Date.now()}`;

      execFileSync("git", ["-C", gitRepoDir, "branch", ownedBranch]);
      execFileSync("git", ["-C", gitRepoDir, "branch", unownedBranch]);

      // Register ownership ONLY for ownedBranch
      registerRuntimeResource(runId, "task_branch", ownedBranch);

      const result = await cleanupRunResources(gitRepoDir, {
        runId,
        branch: `runtime/run-${runId}`,
        worktreePath: join(gitRepoDir, ".worktrees", `integration-${runId}`),
        baseCommit: "HEAD",
        originalBranch: "main",
      }, [
        { branchName: ownedBranch },
        { branchName: unownedBranch },
      ]);

      assert.ok(result.removed.some((r) => r.includes(ownedBranch)));
      assert.ok(result.skipped.some((s) => s.includes(unownedBranch)));

      // Verify ownedBranch deleted, unownedBranch preserved
      const branchesOut = execFileSync("git", ["-C", gitRepoDir, "branch", "--list"], { encoding: "utf8" });
      assert.ok(!branchesOut.includes(ownedBranch), "Owned branch must be deleted");
      assert.ok(branchesOut.includes(unownedBranch), "Unowned branch must be preserved");

      // Clean unowned
      execFileSync("git", ["-C", gitRepoDir, "branch", "-D", unownedBranch]);
    });
  });

  // -------------------------------------------------------------------------
  // 33. Worktree Ownership & Path Confinement Protection
  // -------------------------------------------------------------------------
  describe("33. Worktree Ownership & Path Confinement Protection", () => {
    it("should forbid deleting external/user worktrees and path escaping attempts", async () => {
      const runId = `session-wt-confinement-${Date.now()}`;
      const escapingPath = join(gitRepoDir, ".worktrees", "..", "important_file");
      const userWorktree = join(tmpdir(), `user-custom-wt-${Date.now()}`);

      const result = await cleanupRunResources(gitRepoDir, {
        runId,
        branch: `runtime/run-${runId}`,
        worktreePath: join(gitRepoDir, ".worktrees", `integration-${runId}`),
        baseCommit: "HEAD",
        originalBranch: "main",
      }, [
        { worktreePath: escapingPath },
        { worktreePath: userWorktree },
      ]);

      assert.ok(result.skipped.some((s) => s.includes(escapingPath)));
      assert.ok(result.skipped.some((s) => s.includes(userWorktree)));
    });

    it("should safely delete runtime owned worktree under .worktrees directory", async () => {
      const runId = `session-wt-valid-${Date.now()}`;
      const safeTaskId = `task-valid-${Date.now()}`;
      const wtRes = await createWorktree(gitRepoDir, safeTaskId, undefined, undefined, runId);

      assert.ok(existsSync(wtRes.worktreePath));
      assert.ok(hasRuntimeOwnership(runId, "task_worktree", wtRes.worktreePath));

      const result = await cleanupRunResources(gitRepoDir, {
        runId,
        branch: `runtime/run-${runId}`,
        worktreePath: join(gitRepoDir, ".worktrees", `integration-${runId}`),
        baseCommit: "HEAD",
        originalBranch: "main",
      }, [
        { worktreePath: wtRes.worktreePath, branchName: wtRes.branch },
      ]);

      assert.ok(result.removed.some((r) => r.includes(wtRes.worktreePath)));
      assert.ok(!existsSync(wtRes.worktreePath), "Runtime worktree must be removed");
    });
  });

  // -------------------------------------------------------------------------
  // 34. Remote Deletion Prohibition Audit
  // -------------------------------------------------------------------------
  describe("34. Remote Deletion Prohibition Audit", () => {
    it("should not contain any remote branch deletion commands in codebase", () => {
      const worktreeSource = readFileSync(join(process.cwd(), "server/worktree.ts"), "utf8");
      const subagentSource = readFileSync(join(process.cwd(), "server/subagent-manager.ts"), "utf8");

      assert.ok(!worktreeSource.includes("push") || !worktreeSource.includes("--delete"), "worktree.ts must not contain remote branch deletion");
      assert.ok(!worktreeSource.includes("push origin :"), "worktree.ts must not contain remote branch push deletion");
      assert.ok(!subagentSource.includes("push") || !subagentSource.includes("--delete"), "subagent-manager.ts must not contain remote deletion");
    });
  });

  // -------------------------------------------------------------------------
  // 35. Cleanup Idempotence
  // -------------------------------------------------------------------------
  describe("35. Cleanup Idempotence", () => {
    it("should succeed and not throw when cleanup is called repeatedly on non-existent resources", async () => {
      const runId = `session-idempotent-${Date.now()}`;
      const intWorkspace = {
        runId,
        branch: `runtime/run-${runId}`,
        worktreePath: join(gitRepoDir, ".worktrees", `integration-${runId}`),
        baseCommit: "HEAD",
        originalBranch: "main",
      };

      const firstCleanup = await cleanupRunResources(gitRepoDir, intWorkspace, []);
      assert.equal(firstCleanup.success, true);
      assert.equal(firstCleanup.leftovers.length, 0);

      const secondCleanup = await cleanupRunResources(gitRepoDir, intWorkspace, []);
      assert.equal(secondCleanup.success, true);
      assert.equal(secondCleanup.leftovers.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // 36. Cleanup Fail-Safe (Finalize Success Unaffected)
  // -------------------------------------------------------------------------
  describe("36. Cleanup Fail-Safe (Finalize Success Unaffected)", () => {
    it("should preserve FINALIZED success state even if cleanup encounters failure", async () => {
      const sessionId = `session-cleanup-failsafe-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      const taskId = `task-cs-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Cleanup failsafe task",
        taskPrompt: "Create file_cs.ts",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Create file_cs.ts",
        },
      });

      assert.ok(task.worktreePath);
      writeFileSync(join(task.worktreePath, "file_cs.ts"), "export const cs = 1;\n");
      await subagentManager.handleSubagentCompletion(taskId);

      // Injected cleanup failure
      const finalizeRes = await subagentManager.finalizeRun(sessionId, {
        mode: "working_tree",
        _injectCleanupError: true,
      });

      // Finalize itself must still be SUCCESS
      assert.equal(finalizeRes.success, true);
      assert.equal(finalizeRes.status, "FINALIZED");
      assert.ok(finalizeRes.cleanupResult);
      assert.equal(finalizeRes.cleanupResult.success, false);
      assert.ok(finalizeRes.cleanupResult.leftovers.length > 0);

      // Verify file delivery succeeded
      assert.equal(readFileSync(join(gitRepoDir, "file_cs.ts"), "utf8"), "export const cs = 1;\n");

      // Clean
      execFileSync("git", ["-C", gitRepoDir, "reset", "HEAD", "file_cs.ts"]);
      rmSync(join(gitRepoDir, "file_cs.ts"), { force: true });
    });
  });

  // -------------------------------------------------------------------------
  // 37. Runtime Git Resource Ownership & Robust Cleanup (Scenarios A - I)
  // -------------------------------------------------------------------------
  describe("37. Runtime Git Resource Ownership & Robust Cleanup (Scenarios A - I)", () => {
    it("A. should persist ownership to .runtime/git-resources.json and restore it after simulated restart", async () => {
      const runId = `session-scen-a-${Date.now()}`;
      const taskId = `task-a-${Date.now()}`;
      const wtRes = await createWorktree(gitRepoDir, taskId, undefined, undefined, runId);
      const normWtPath = normalizeWorktreePath(wtRes.worktreePath);

      // 1. Verify persisted file exists and contains resources
      const persisted = loadPersistedRuntimeResources(gitRepoDir);
      assert.ok(persisted.some((r) => r.runId === runId && r.type === "task_branch" && r.nameOrPath === wtRes.branch));
      assert.ok(persisted.some((r) => r.runId === runId && r.type === "task_worktree" && normalizeWorktreePath(r.nameOrPath) === normWtPath));

      // 2. Simulate service restart by wiping in-memory registry
      clearRuntimeResourceRegistry();
      assert.equal(hasRuntimeOwnership(runId, "task_branch", wtRes.branch), false);

      // 3. Run recovery
      const { recovered, staleRemoved } = await recoverRuntimeResources(gitRepoDir);
      assert.ok(recovered.some((r) => r.nameOrPath === wtRes.branch));
      assert.ok(recovered.some((r) => normalizeWorktreePath(r.nameOrPath) === normWtPath));
      assert.equal(staleRemoved.filter((r) => r.runId === runId).length, 0);

      // 4. Verify in-memory ownership is restored
      assert.equal(hasRuntimeOwnership(runId, "task_branch", wtRes.branch), true);
      assert.equal(hasRuntimeOwnership(runId, "task_worktree", wtRes.worktreePath), true);

      // 5. Cleanup correctly identifies and deletes resources, unregistering from persistence
      const result = await cleanupRunResources(gitRepoDir, {
        runId,
        branch: `runtime/run-${runId}`,
        worktreePath: join(gitRepoDir, ".worktrees", `integration-${runId}`),
        baseCommit: "HEAD",
        originalBranch: "main",
      }, [
        { worktreePath: wtRes.worktreePath, branchName: wtRes.branch },
      ]);

      assert.ok(result.removed.some((r) => r.includes(wtRes.branch)));
      assert.ok(result.removed.some((r) => r.includes(wtRes.worktreePath)));
      assert.equal(result.leftovers.length, 0);

      const afterCleanupPersisted = loadPersistedRuntimeResources(gitRepoDir);
      assert.ok(!afterCleanupPersisted.some((r) => r.runId === runId));
    });

    it("B. should allocate a unique branch and not claim or overwrite user-created same-name runtime branch", async () => {
      const runId = `session-scen-b-${Date.now()}`;
      const taskId = `task-b-${Date.now()}`;
      const safeTaskId = taskId.replace(/[^a-zA-Z0-9._-]/g, "-");
      const userConflictBranch = `runtime/task-${runId}-${safeTaskId}`;

      // User manually created a branch with the standard name
      execFileSync("git", ["-C", gitRepoDir, "branch", userConflictBranch]);

      // Runtime attempts to create worktree with same runId and taskId
      const wtRes = await createWorktree(gitRepoDir, taskId, undefined, undefined, runId);

      // Must have generated a unique branch with random suffix
      assert.notEqual(wtRes.branch, userConflictBranch);
      assert.ok(wtRes.branch.startsWith(userConflictBranch + "-"));

      // Ownership must be for the new unique branch, NOT the user's branch
      assert.equal(hasRuntimeOwnership(runId, "task_branch", wtRes.branch), true);
      assert.equal(hasRuntimeOwnership(runId, "task_branch", userConflictBranch), false);

      // Cleanup should delete runtime branch and leave user branch intact
      const result = await cleanupRunResources(gitRepoDir, {
        runId,
        branch: `runtime/run-${runId}`,
        worktreePath: join(gitRepoDir, ".worktrees", `integration-${runId}`),
        baseCommit: "HEAD",
        originalBranch: "main",
      }, [
        { worktreePath: wtRes.worktreePath, branchName: wtRes.branch },
        { branchName: userConflictBranch },
      ]);

      assert.ok(result.removed.some((r) => r.includes(wtRes.branch)));
      assert.ok(result.skipped.some((s) => s.includes(userConflictBranch)));

      const branchesOut = execFileSync("git", ["-C", gitRepoDir, "branch", "--list", userConflictBranch], { encoding: "utf8" });
      assert.ok(branchesOut.includes(userConflictBranch), "User branch must remain intact");

      // Clean user branch
      execFileSync("git", ["-C", gitRepoDir, "branch", "-D", userConflictBranch]);
    });

    it("C. should not register any ownership if worktree creation fails", async () => {
      const runId = `session-scen-c-${Date.now()}`;
      const taskId = `task-c-${Date.now()}`;

      let caught = false;
      try {
        await createWorktree(gitRepoDir, taskId, undefined, "non-existent-commit-sha-99999", runId);
      } catch {
        caught = true;
      }
      assert.equal(caught, true, "createWorktree must throw on invalid baseRef");

      const persisted = loadPersistedRuntimeResources(gitRepoDir);
      assert.ok(!persisted.some((r) => r.runId === runId), "No ownership must be persisted on failure");
      assert.equal(hasRuntimeOwnership(runId, "task_branch", `runtime/task-${runId}-${taskId}`), false);
    });

    it("D. should retain ownership in registry and report leftovers when worktree deletion fails", async () => {
      const runId = `session-scen-d-${Date.now()}`;
      const taskId = `task-d-${Date.now()}`;
      const wtRes = await createWorktree(gitRepoDir, taskId, undefined, undefined, runId);
      const normWtPath = normalizeWorktreePath(wtRes.worktreePath);

      const result = await cleanupRunResources(
        gitRepoDir,
        {
          runId,
          branch: `runtime/run-${runId}`,
          worktreePath: join(gitRepoDir, ".worktrees", `integration-${runId}`),
          baseCommit: "HEAD",
          originalBranch: "main",
        },
        [{ worktreePath: wtRes.worktreePath, branchName: wtRes.branch }],
        { _injectWorktreeRemoveError: true },
      );

      assert.equal(result.success, false);
      assert.ok(!result.removed.some((r) => r.includes(wtRes.worktreePath)));
      assert.ok(result.leftovers.some((l) => l.includes(wtRes.worktreePath)));
      assert.ok(result.errors && result.errors.length > 0);

      // Ownership must be RETAINED
      assert.equal(hasRuntimeOwnership(runId, "task_worktree", wtRes.worktreePath), true);
      const persisted = loadPersistedRuntimeResources(gitRepoDir);
      assert.ok(persisted.some((r) => r.runId === runId && normalizeWorktreePath(r.nameOrPath) === normWtPath));

      // Now clean it up properly
      const cleanResult = await cleanupRunResources(
        gitRepoDir,
        {
          runId,
          branch: `runtime/run-${runId}`,
          worktreePath: join(gitRepoDir, ".worktrees", `integration-${runId}`),
          baseCommit: "HEAD",
          originalBranch: "main",
        },
        [{ worktreePath: wtRes.worktreePath, branchName: wtRes.branch }],
      );
      assert.equal(cleanResult.success, true);
    });

    it("E. should retain ownership in registry and report leftovers when branch deletion fails", async () => {
      const runId = `session-scen-e-${Date.now()}`;
      const taskId = `task-e-${Date.now()}`;
      const wtRes = await createWorktree(gitRepoDir, taskId, undefined, undefined, runId);

      const result = await cleanupRunResources(
        gitRepoDir,
        {
          runId,
          branch: `runtime/run-${runId}`,
          worktreePath: join(gitRepoDir, ".worktrees", `integration-${runId}`),
          baseCommit: "HEAD",
          originalBranch: "main",
        },
        [{ worktreePath: wtRes.worktreePath, branchName: wtRes.branch }],
        { _injectBranchDeleteError: true },
      );

      assert.equal(result.success, false);
      assert.ok(!result.removed.some((r) => r.includes(wtRes.branch)));
      assert.ok(result.leftovers.some((l) => l.includes(wtRes.branch)));
      assert.ok(result.errors && result.errors.length > 0);

      // Ownership must be RETAINED
      assert.equal(hasRuntimeOwnership(runId, "task_branch", wtRes.branch), true);
      const persisted = loadPersistedRuntimeResources(gitRepoDir);
      assert.ok(persisted.some((r) => r.runId === runId && r.nameOrPath === wtRes.branch));

      // Clean
      await cleanupRunResources(
        gitRepoDir,
        {
          runId,
          branch: `runtime/run-${runId}`,
          worktreePath: join(gitRepoDir, ".worktrees", `integration-${runId}`),
          baseCommit: "HEAD",
          originalBranch: "main",
        },
        [{ worktreePath: wtRes.worktreePath, branchName: wtRes.branch }],
      );
    });

    it("F. should unregister ownership only after resource is verified deleted", async () => {
      const runId = `session-scen-f-${Date.now()}`;
      const taskId = `task-f-${Date.now()}`;
      const wtRes = await createWorktree(gitRepoDir, taskId, undefined, undefined, runId);

      assert.equal(hasRuntimeOwnership(runId, "task_worktree", wtRes.worktreePath), true);
      assert.equal(hasRuntimeOwnership(runId, "task_branch", wtRes.branch), true);

      const result = await cleanupRunResources(
        gitRepoDir,
        {
          runId,
          branch: `runtime/run-${runId}`,
          worktreePath: join(gitRepoDir, ".worktrees", `integration-${runId}`),
          baseCommit: "HEAD",
          originalBranch: "main",
        },
        [{ worktreePath: wtRes.worktreePath, branchName: wtRes.branch }],
      );

      assert.equal(result.success, true);
      assert.equal(existsSync(wtRes.worktreePath), false);
      const branchesOut = execFileSync("git", ["-C", gitRepoDir, "branch", "--list", wtRes.branch], { encoding: "utf8" });
      assert.equal(branchesOut.includes(wtRes.branch), false);

      assert.equal(hasRuntimeOwnership(runId, "task_worktree", wtRes.worktreePath), false);
      assert.equal(hasRuntimeOwnership(runId, "task_branch", wtRes.branch), false);

      const persisted = loadPersistedRuntimeResources(gitRepoDir);
      assert.ok(!persisted.some((r) => r.runId === runId));
    });

    it("G. should refuse cleanup and preserve unregistered runtime/* branches", async () => {
      const runId = `session-scen-g-${Date.now()}`;
      const unownedBranch = `runtime/task-unregistered-${Date.now()}`;
      execFileSync("git", ["-C", gitRepoDir, "branch", unownedBranch]);

      const result = await cleanupRunResources(
        gitRepoDir,
        {
          runId,
          branch: `runtime/run-${runId}`,
          worktreePath: join(gitRepoDir, ".worktrees", `integration-${runId}`),
          baseCommit: "HEAD",
          originalBranch: "main",
        },
        [{ branchName: unownedBranch }],
      );

      assert.ok(result.skipped.some((s) => s.includes(unownedBranch)));
      assert.ok(!result.removed.some((r) => r.includes(unownedBranch)));

      const branchesOut = execFileSync("git", ["-C", gitRepoDir, "branch", "--list", unownedBranch], { encoding: "utf8" });
      assert.ok(branchesOut.includes(unownedBranch), "Unregistered branch must remain");

      execFileSync("git", ["-C", gitRepoDir, "branch", "-D", unownedBranch]);
    });

    it("H. should refuse cleanup if resource type does not match namespace pattern", async () => {
      const runId = `session-scen-h-${Date.now()}`;
      const branchName = `runtime/run-mismatch-${Date.now()}`;
      execFileSync("git", ["-C", gitRepoDir, "branch", branchName]);

      // Forged ownership: type = task_branch, but branch name matches integration pattern runtime/run-*
      registerRuntimeResource(runId, "task_branch", branchName, gitRepoDir);

      const result = await cleanupRunResources(
        gitRepoDir,
        {
          runId,
          branch: `runtime/run-${runId}`,
          worktreePath: join(gitRepoDir, ".worktrees", `integration-${runId}`),
          baseCommit: "HEAD",
          originalBranch: "main",
        },
        [{ branchName }],
      );

      assert.ok(result.skipped.some((s) => s.includes(branchName)));
      assert.ok(!result.removed.some((r) => r.includes(branchName)));

      const branchesOut = execFileSync("git", ["-C", gitRepoDir, "branch", "--list", branchName], { encoding: "utf8" });
      assert.ok(branchesOut.includes(branchName), "Branch with mismatched namespace must not be deleted");

      // Clean
      execFileSync("git", ["-C", gitRepoDir, "branch", "-D", branchName]);
      unregisterRuntimeResource(runId, "task_branch", branchName, gitRepoDir);
    });

    it("I. should cleanly purge stale ownership records on startup without executing Git deletions", async () => {
      const runId = `session-scen-i-${Date.now()}`;
      const nonExistentBranch = `runtime/task-stale-branch-${Date.now()}`;

      // Register ownership directly without creating branch in Git
      registerRuntimeResource(runId, "task_branch", nonExistentBranch, gitRepoDir);

      const persistedBefore = loadPersistedRuntimeResources(gitRepoDir);
      assert.ok(persistedBefore.some((r) => r.nameOrPath === nonExistentBranch));

      // Simulate startup recovery
      clearRuntimeResourceRegistry();
      const { recovered, staleRemoved } = await recoverRuntimeResources(gitRepoDir);

      assert.ok(staleRemoved.some((r) => r.nameOrPath === nonExistentBranch));
      assert.ok(!recovered.some((r) => r.nameOrPath === nonExistentBranch));

      const persistedAfter = loadPersistedRuntimeResources(gitRepoDir);
      assert.ok(!persistedAfter.some((r) => r.nameOrPath === nonExistentBranch));
      assert.equal(hasRuntimeOwnership(runId, "task_branch", nonExistentBranch), false);
    });
  });

  // -------------------------------------------------------------------------
  // 38. ExpectedEffects Fallback, Test Execution Evidence & Fail-Closed FinishReason
  // -------------------------------------------------------------------------

}

// Allow running standalone
if (process.argv[1] && process.argv[1].endsWith("runtime-resources.test.ts")) {
  describe("32 - 37 Runtime Resources Ownership & Robust Cleanup", () => {
    let repo: { gitRepoDir: string; cleanup: () => void };
    before(() => {
      repo = setupTestGitRepo();
    });
    after(() => {
      repo.cleanup();
    });
    registerRuntimeResourcesTests(() => repo.gitRepoDir);
  });
}
