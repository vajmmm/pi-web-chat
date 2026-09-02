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


export function registerFinalizeGatesMutationTests(getGitRepoDir: () => string) {
  let gitRepoDir: string;
  beforeEach(() => {
    gitRepoDir = getGitRepoDir();
  });


  describe("13. working_tree Finalize: File Deletion & Rename Support", () => {
    it("should correctly delete file in user workspace when agent deleted it", async () => {
      const sessionId = `session-delete-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      // Create a file in user repo and commit
      writeFileSync(join(gitRepoDir, "to_delete.txt"), "delete me later\n");
      execFileSync("git", ["-C", gitRepoDir, "add", "to_delete.txt"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "add to_delete.txt"]);

      const taskId = `task-del-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "junior_be",
        taskTitle: "Delete file",
        taskPrompt: "Delete to_delete.txt",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "junior_be",
          goal: "Delete to_delete.txt",
          expectedEffects: ["code_change"],
        },
      });

      assert.ok(task.worktreePath);
      // Agent deletes file in worktree
      rmSync(join(task.worktreePath, "to_delete.txt"), { force: true });
      await subagentManager.handleSubagentCompletion(taskId);

      // Finalize in working_tree mode
      const finalizeRes = await subagentManager.finalizeRun(sessionId, { mode: "working_tree" });
      assert.equal(finalizeRes.success, true);
      assert.equal(finalizeRes.status, "FINALIZED");

      // Verify file is deleted in user's working tree
      assert.equal(existsSync(join(gitRepoDir, "to_delete.txt")), false, "to_delete.txt must be deleted in user workspace");

      // Clean git state
      execFileSync("git", ["-C", gitRepoDir, "checkout", "HEAD", "--", "to_delete.txt"]);
      rmSync(join(gitRepoDir, "to_delete.txt"), { force: true });
      execFileSync("git", ["-C", gitRepoDir, "add", "-A"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "clean to_delete.txt"]);
    });

    it("should correctly handle file rename (old.ts -> new.ts) in working_tree finalize", async () => {
      const sessionId = `session-rename-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      // Create old.ts in repo and commit
      writeFileSync(join(gitRepoDir, "old_name.ts"), "export const legacy = true;\n");
      execFileSync("git", ["-C", gitRepoDir, "add", "old_name.ts"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "add old_name.ts"]);

      const taskId = `task-rename-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "junior_fe",
        taskTitle: "Rename file",
        taskPrompt: "Rename old_name.ts to new_name.ts",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "junior_fe",
          goal: "Rename old_name.ts to new_name.ts",
          expectedEffects: ["code_change"],
        },
      });

      assert.ok(task.worktreePath);
      // Agent renames in worktree
      rmSync(join(task.worktreePath, "old_name.ts"), { force: true });
      writeFileSync(join(task.worktreePath, "new_name.ts"), "export const legacy = false;\n");

      await subagentManager.handleSubagentCompletion(taskId);

      const finalizeRes = await subagentManager.finalizeRun(sessionId, { mode: "working_tree" });
      assert.equal(finalizeRes.success, true);

      // old_name.ts must be gone, new_name.ts must exist
      assert.equal(existsSync(join(gitRepoDir, "old_name.ts")), false, "old_name.ts must not exist");
      assert.ok(existsSync(join(gitRepoDir, "new_name.ts")), "new_name.ts must exist");
      assert.equal(
        readFileSync(join(gitRepoDir, "new_name.ts"), "utf8"),
        "export const legacy = false;\n",
      );

      // Clean
      rmSync(join(gitRepoDir, "new_name.ts"), { force: true });
      execFileSync("git", ["-C", gitRepoDir, "checkout", "HEAD", "--", "old_name.ts"]);
    });
  });

  // -------------------------------------------------------------------------
  // 14. squash_commit Isolation of User's Existing Staged & Unstaged Modifications
  // -------------------------------------------------------------------------

  describe("16. finalize_run Hard State Gate", () => {
    it("should reject finalize_run when tasks are still running, blocked, or conflict", async () => {
      const sessionId = `session-gate-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      const taskAId = `task-gate-a-${Date.now()}`;
      const taskBId = `task-gate-b-${Date.now()}`;

      // Spawn Task A (running)
      await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "junior_be",
        taskTitle: "Running Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId: taskAId,
          parentSessionId: sessionId,
          role: "junior_be",
          goal: "Do A",
          expectedEffects: ["analysis"],
        },
      });

      // Spawn Task B (blocked on A)
      await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "junior_fe",
        taskTitle: "Blocked Task B",
        taskPrompt: "Do B",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId: taskBId,
          parentSessionId: sessionId,
          role: "junior_fe",
          goal: "Do B",
          expectedEffects: ["analysis"],
          dependsOn: [taskAId],
        },
      });

      // 1. Attempt finalize while tasks are running/blocked -> MUST FAIL
      const failRes1 = await subagentManager.finalizeRun(sessionId);
      assert.equal(failRes1.success, false);
      assert.equal(failRes1.status, "ERROR");
      assert.ok(failRes1.error?.includes("still active"));
      assert.ok(failRes1.error?.includes(taskAId));
      assert.ok(failRes1.error?.includes(taskBId));

      // 2. Complete Task A -> Task A becomes completed, Task B unblocks and becomes running -> MUST STILL FAIL
      await subagentManager.handleSubagentCompletion(taskAId);
      const failRes2 = await subagentManager.finalizeRun(sessionId);
      assert.equal(failRes2.success, false);
      assert.ok(failRes2.error?.includes(taskBId));
      assert.ok(failRes2.error?.includes("active") || failRes2.error?.includes("running"));

      // 3. Complete Task B -> all tasks completed -> FINALIZE SUCCEEDS
      await subagentManager.handleSubagentCompletion(taskBId);
      const okRes = await subagentManager.finalizeRun(sessionId);
      assert.equal(okRes.success, true);
    });
  });

  // -------------------------------------------------------------------------
  // 17. Critical Git State Reads Fail-Closed
  // -------------------------------------------------------------------------
  describe("17. Critical Git State Reads Fail-Closed", () => {
    it("should fail-closed and return ERROR instead of NO_CHANGES when integration diff or read fails", async () => {
      const sessionId = `session-fail-closed-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      const taskId = `task-fc-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "junior_be",
        taskTitle: "Fail closed test",
        taskPrompt: "Modify fc.ts",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "junior_be",
          goal: "Modify fc.ts",
        },
      });

      assert.ok(task.worktreePath);
      writeFileSync(join(task.worktreePath, "fc.ts"), "export const fc = true;\n");
      await subagentManager.handleSubagentCompletion(taskId);

      // Corrupt baseCommit in integration to simulate git diff failure
      const integration = (subagentManager as any).integrations.get(sessionId);
      assert.ok(integration);
      const originalBase = integration.baseCommit;
      integration.baseCommit = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

      const finalizeRes = await subagentManager.finalizeRun(sessionId);
      assert.equal(finalizeRes.success, false);
      assert.equal(finalizeRes.status, "ERROR");
      assert.notEqual(finalizeRes.status, "NO_CHANGES");
      assert.ok(finalizeRes.error?.includes("Failed to read integration diff") || finalizeRes.error?.includes("Failed"));

      // Verify temporary resources are NOT cleaned up
      assert.ok(existsSync(integration.worktreePath), "Integration worktree must be preserved on error");

      // Restore and clean
      integration.baseCommit = originalBase;
      await subagentManager.finalizeRun(sessionId);
      rmSync(join(gitRepoDir, "fc.ts"), { force: true });
    });
  });

  // -------------------------------------------------------------------------
  // 18. Rename Conflict Detection during Run
  // -------------------------------------------------------------------------
  describe("18. Rename Conflict Detection during Run", () => {
    it("should detect conflict when user committed a rename of a file that agent modified", async () => {
      const sessionId = `session-rename-conflict-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      // Create base file
      writeFileSync(join(gitRepoDir, "target_to_rename.ts"), "const v = 1;\n");
      execFileSync("git", ["-C", gitRepoDir, "add", "target_to_rename.ts"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "add target_to_rename.ts"]);

      const taskId = `task-rename-conf-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "junior_be",
        taskTitle: "Agent edit",
        taskPrompt: "Edit target_to_rename.ts",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "junior_be",
          goal: "Edit target_to_rename.ts",
        },
      });

      assert.ok(task.worktreePath);
      writeFileSync(join(task.worktreePath, "target_to_rename.ts"), "const v = 999;\n");
      await subagentManager.handleSubagentCompletion(taskId);

      // User concurrently renames target_to_rename.ts -> target_renamed.ts on main branch and commits
      execFileSync("git", ["-C", gitRepoDir, "mv", "target_to_rename.ts", "target_renamed.ts"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "user rename target_to_rename.ts -> target_renamed.ts"]);

      // Attempt finalize -> must detect overlap on oldPath 'target_to_rename.ts' and return FINALIZE_CONFLICT
      const finalizeRes = await subagentManager.finalizeRun(sessionId, { mode: "working_tree" });
      assert.equal(finalizeRes.success, false);
      assert.equal(finalizeRes.status, "FINALIZE_CONFLICT");
      assert.ok(finalizeRes.error?.includes("FINALIZE_CONFLICT"));

      // Clean
      execFileSync("git", ["-C", gitRepoDir, "rm", "-f", "target_renamed.ts"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "clean rename test"]);
    });
  });

  // -------------------------------------------------------------------------
  // 19. History Rewrite / Ancestry Gate
  // -------------------------------------------------------------------------
  describe("19. History Rewrite / Ancestry Gate", () => {
    it("should reject finalize when baseCommit is no longer an ancestor of current HEAD (e.g. reset/rebase)", async () => {
      const sessionId = `session-ancestry-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      // Create a commit before run
      writeFileSync(join(gitRepoDir, "ancestry_dummy.ts"), "const a = 1;\n");
      execFileSync("git", ["-C", gitRepoDir, "add", "ancestry_dummy.ts"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "commit before run"]);

      const taskId = `task-ancestry-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "junior_be",
        taskTitle: "Agent Task",
        taskPrompt: "Edit dummy",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "junior_be",
          goal: "Edit dummy",
        },
      });

      assert.ok(task.worktreePath);
      writeFileSync(join(task.worktreePath, "agent_ancestry.ts"), "const ok = true;\n");
      await subagentManager.handleSubagentCompletion(taskId);

      // User resets HEAD to prior commit on main (history rewritten, baseCommit no longer ancestor of HEAD)
      execFileSync("git", ["-C", gitRepoDir, "reset", "--hard", "HEAD~1"]);

      // Attempt finalize -> must fail with FINALIZE_CONFLICT due to ancestry check
      const finalizeRes = await subagentManager.finalizeRun(sessionId);
      assert.equal(finalizeRes.success, false);
      assert.equal(finalizeRes.status, "FINALIZE_CONFLICT");
      assert.ok(finalizeRes.error?.includes("no longer an ancestor"));
    });
  });

  // -------------------------------------------------------------------------
  // 20. squash_commit Atomic Rollback on Mutation Failure
  // -------------------------------------------------------------------------
  describe("20. squash_commit Atomic Rollback on Mutation Failure", () => {
    it("should rollback branch HEAD and restore agent paths when mutation fails after update-ref, preserving user staged/unstaged", async () => {
      const sessionId = `session-rollback-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      // User creates and STAGES a file
      writeFileSync(join(gitRepoDir, "user_rb_staged.ts"), "export const userStaged = 'keep';\n");
      execFileSync("git", ["-C", gitRepoDir, "add", "user_rb_staged.ts"]);

      // User creates an UNSTAGED file
      writeFileSync(join(gitRepoDir, "user_rb_unstaged.ts"), "export const userUnstaged = 'keep';\n");

      const headBefore = execFileSync("git", ["-C", gitRepoDir, "rev-parse", "HEAD"]).toString().trim();

      const taskId = `task-rb-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "junior_fe",
        taskTitle: "Agent Rollback Test",
        taskPrompt: "Create agent_rb_fail.ts",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "junior_fe",
          goal: "Create agent_rb_fail.ts",
        },
      });

      assert.ok(task.worktreePath);
      writeFileSync(join(task.worktreePath, "agent_rb_fail.ts"), "export const agentFail = true;\n");
      await subagentManager.handleSubagentCompletion(taskId);

      // Finalize squash_commit with simulated mutation failure -> must trigger rollback
      const finalizeRes = await subagentManager.finalizeRun(sessionId, {
        mode: "squash_commit",
        commitMessage: "feat: will fail and rollback",
        _injectMutationError: true,
      });

      assert.equal(finalizeRes.success, false);
      assert.equal(finalizeRes.status, "ERROR");

      // 1. Verify HEAD has been atomically rolled back to headBefore
      const headAfter = execFileSync("git", ["-C", gitRepoDir, "rev-parse", "HEAD"]).toString().trim();
      assert.equal(headAfter, headBefore, "HEAD must be restored to original commit");

      // 2. Verify user's staged file is STILL STAGED
      const statusOut = execFileSync("git", ["-C", gitRepoDir, "status", "--porcelain"]).toString();
      assert.ok(statusOut.includes("A  user_rb_staged.ts") || statusOut.includes("A user_rb_staged.ts"), "user_rb_staged.ts must remain staged");
      assert.ok(statusOut.includes("?? user_rb_unstaged.ts"), "user_rb_unstaged.ts must remain unstaged");

      // 3. Verify user file contents untouched
      assert.equal(readFileSync(join(gitRepoDir, "user_rb_staged.ts"), "utf8"), "export const userStaged = 'keep';\n");
      assert.equal(readFileSync(join(gitRepoDir, "user_rb_unstaged.ts"), "utf8"), "export const userUnstaged = 'keep';\n");

      // 4. Verify integration worktree still exists
      const integration = (subagentManager as any).integrations.get(sessionId);
      assert.ok(integration);
      assert.ok(existsSync(integration.worktreePath), "Integration worktree must be preserved on failure");

      // Clean
      execFileSync("git", ["-C", gitRepoDir, "reset", "HEAD", "user_rb_staged.ts"]);
      rmSync(join(gitRepoDir, "user_rb_staged.ts"), { force: true });
      rmSync(join(gitRepoDir, "user_rb_unstaged.ts"), { force: true });
    });
  });

  // -------------------------------------------------------------------------
  // 21. Mutation Fail-Closed & Working Tree Consistency Check
  // -------------------------------------------------------------------------
  describe("21. Mutation Fail-Closed & Working Tree Consistency Check", () => {
    it("should fail finalize and not report FINALIZED when working_tree consistency check fails", async () => {
      const sessionId = `session-wt-consist-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      const taskId = `task-wt-cons-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "junior_be",
        taskTitle: "Consistency test",
        taskPrompt: "Create wt_cons.ts",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "junior_be",
          goal: "Create wt_cons.ts",
        },
      });

      assert.ok(task.worktreePath);
      writeFileSync(join(task.worktreePath, "wt_cons.ts"), "export const ok = 1;\n");
      await subagentManager.handleSubagentCompletion(taskId);

      const finalizeRes = await subagentManager.finalizeRun(sessionId, {
        mode: "working_tree",
        _injectMutationError: true,
      });

      assert.equal(finalizeRes.success, false);
      assert.equal(finalizeRes.status, "ERROR");

      // Verify resources preserved
      const integration = (subagentManager as any).integrations.get(sessionId);
      assert.ok(integration);
      assert.ok(existsSync(integration.worktreePath), "Worktree must be preserved on error");
    });
  });

  // -------------------------------------------------------------------------
  // 22. working_tree Rollback: Scenario A - Second File Mutation Fails
  // -------------------------------------------------------------------------

}

// Allow running standalone
if (process.argv[1] && process.argv[1].endsWith("finalize-gates-mutation.test.ts")) {
  describe("13, 16 - 21 Finalize Gates & Mutations", () => {
    let repo: { gitRepoDir: string; cleanup: () => void };
    before(() => {
      repo = setupTestGitRepo();
    });
    after(() => {
      repo.cleanup();
    });
    registerFinalizeGatesMutationTests(() => repo.gitRepoDir);
  });
}
