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


export function registerIntegrationWorkspaceTests(getGitRepoDir: () => string) {
  let gitRepoDir: string;
  beforeEach(() => {
    gitRepoDir = getGitRepoDir();
  });


  describe("9. Integration Workspace & Zero Git Pollution Finalize (working_tree Mode)", () => {
    it("should merge task commits to integration branch and deliver final working tree without polluting user git log", async () => {
      const sessionId = `session-pollute-test-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      const headBefore = execFileSync("git", ["-C", gitRepoDir, "rev-parse", "HEAD"]).toString().trim();
      const logCountBefore = parseInt(
        execFileSync("git", ["-C", gitRepoDir, "rev-list", "--count", "HEAD"]).toString().trim(),
        10,
      );

      // Task A: Modifies task_a.ts
      const taskAId = `task-a-${Date.now()}`;
      const taskA = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Task A",
        taskPrompt: "Create task_a.ts",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId: taskAId,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Create task_a.ts",
        },
      });

      assert.ok(taskA.worktreePath);
      writeFileSync(join(taskA.worktreePath, "task_a.ts"), "export const a = 1;\n");
      await subagentManager.handleSubagentCompletion(taskAId);
      assert.equal(taskA.status, "completed");

      // Task B: Modifies task_b.ts
      const taskBId = `task-b-${Date.now()}`;
      const taskB = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Task B",
        taskPrompt: "Create task_b.ts",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId: taskBId,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Create task_b.ts",
        },
      });

      assert.ok(taskB.worktreePath);
      writeFileSync(join(taskB.worktreePath, "task_b.ts"), "export const b = 2;\n");
      await subagentManager.handleSubagentCompletion(taskBId);
      assert.equal(taskB.status, "completed");

      // Finalize the Run in working_tree mode (default)
      const finalizeRes = await subagentManager.finalizeRun(sessionId, { mode: "working_tree" });
      assert.equal(finalizeRes.success, true);
      assert.equal(finalizeRes.status, "FINALIZED");

      // Verify User Workspace & Git Log
      const headAfter = execFileSync("git", ["-C", gitRepoDir, "rev-parse", "HEAD"]).toString().trim();
      const logCountAfter = parseInt(
        execFileSync("git", ["-C", gitRepoDir, "rev-list", "--count", "HEAD"]).toString().trim(),
        10,
      );

      assert.equal(headAfter, headBefore, "User branch HEAD must NOT change in working_tree finalize mode");
      assert.equal(logCountAfter, logCountBefore, "User branch commit count must NOT increase");

      // Verify modified files exist in user's working tree
      assert.ok(existsSync(join(gitRepoDir, "task_a.ts")), "task_a.ts must be in working tree");
      assert.ok(existsSync(join(gitRepoDir, "task_b.ts")), "task_b.ts must be in working tree");
      assert.equal(readFileSync(join(gitRepoDir, "task_a.ts"), "utf8"), "export const a = 1;\n");
      assert.equal(readFileSync(join(gitRepoDir, "task_b.ts"), "utf8"), "export const b = 2;\n");

      // Verify git log has ZERO task commits
      const gitLog = execFileSync("git", ["-C", gitRepoDir, "log", "--oneline"]).toString();
      assert.ok(!gitLog.includes("task/task-a"), "User git log must not contain task-a commit");
      assert.ok(!gitLog.includes("task/task-b"), "User git log must not contain task-b commit");

      // Clean up test files
      try {
        rmSync(join(gitRepoDir, "task_a.ts"), { force: true });
        rmSync(join(gitRepoDir, "task_b.ts"), { force: true });
      } catch {}
    });
  });

  // -------------------------------------------------------------------------
  // 10. squash_commit Finalize Mode
  // -------------------------------------------------------------------------
  describe("10. squash_commit Finalize Mode", () => {
    it("should compress all internal task commits into exactly 1 user commit in squash_commit mode", async () => {
      const sessionId = `session-squash-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      const logCountBefore = parseInt(
        execFileSync("git", ["-C", gitRepoDir, "rev-list", "--count", "HEAD"]).toString().trim(),
        10,
      );

      const taskId = `task-sq-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Squash feature",
        taskPrompt: "Create feature.ts",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Create feature.ts",
        },
      });

      assert.ok(task.worktreePath);
      writeFileSync(join(task.worktreePath, "feature.ts"), "export const feature = true;\n");
      await subagentManager.handleSubagentCompletion(taskId);

      const finalizeRes = await subagentManager.finalizeRun(sessionId, {
        mode: "squash_commit",
        commitMessage: "feat: add squashed feature",
      });

      assert.equal(finalizeRes.success, true);
      assert.equal(finalizeRes.status, "FINALIZED");

      const logCountAfter = parseInt(
        execFileSync("git", ["-C", gitRepoDir, "rev-list", "--count", "HEAD"]).toString().trim(),
        10,
      );
      assert.equal(logCountAfter, logCountBefore + 1, "User branch must have exactly +1 commit");

      const lastCommitMsg = execFileSync("git", ["-C", gitRepoDir, "log", "-1", "--pretty=%s"]).toString().trim();
      assert.equal(lastCommitMsg, "feat: add squashed feature");

      const gitLog = execFileSync("git", ["-C", gitRepoDir, "log", "--oneline"]).toString();
      assert.ok(!gitLog.includes("task/task-sq"), "Internal task commit must not appear in git log");
    });
  });

  // -------------------------------------------------------------------------
  // 11. User Working Tree Protection & Finalize Conflict
  // -------------------------------------------------------------------------
  describe("11. User Working Tree Protection & Finalize Conflict", () => {
    it("should preserve user uncommitted modifications when there is no conflict", async () => {
      const sessionId = `session-protect-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      // User has uncommitted change in user_work.txt
      writeFileSync(join(gitRepoDir, "user_work.txt"), "user's precious unfinished work\n");

      const taskId = `task-protect-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Agent work",
        taskPrompt: "Agent edits other_file.ts",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Agent edits other_file.ts",
        },
      });

      assert.ok(task.worktreePath);
      writeFileSync(join(task.worktreePath, "other_file.ts"), "export const ok = 1;\n");
      await subagentManager.handleSubagentCompletion(taskId);

      const finalizeRes = await subagentManager.finalizeRun(sessionId, { mode: "working_tree" });
      assert.equal(finalizeRes.success, true);

      // User's uncommitted work is completely preserved
      assert.ok(existsSync(join(gitRepoDir, "user_work.txt")));
      assert.equal(
        readFileSync(join(gitRepoDir, "user_work.txt"), "utf8"),
        "user's precious unfinished work\n",
      );

      // Clean up
      try {
        rmSync(join(gitRepoDir, "user_work.txt"), { force: true });
        rmSync(join(gitRepoDir, "other_file.ts"), { force: true });
      } catch {}
    });

    it("should fail-closed with FINALIZE_CONFLICT and refuse to overwrite when user modified the same file", async () => {
      const sessionId = `session-conflict-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      // Shared file in repo
      writeFileSync(join(gitRepoDir, "shared.ts"), "const initial = 100;\n");
      execFileSync("git", ["-C", gitRepoDir, "add", "shared.ts"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "add shared.ts"]);

      const taskId = `task-conf-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Modify shared.ts",
        taskPrompt: "Change shared.ts",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Change shared.ts",
        },
      });

      // Agent modifies shared.ts in worktree
      assert.ok(task.worktreePath);
      writeFileSync(join(task.worktreePath, "shared.ts"), "const agentVersion = 999;\n");
      await subagentManager.handleSubagentCompletion(taskId);

      // User simultaneously modifies shared.ts in user workspace
      writeFileSync(join(gitRepoDir, "shared.ts"), "const userSimultaneousEdit = 42;\n");

      // Attempt finalize
      const finalizeRes = await subagentManager.finalizeRun(sessionId, { mode: "working_tree" });
      assert.equal(finalizeRes.success, false);
      assert.equal(finalizeRes.status, "FINALIZE_CONFLICT");
      assert.ok(finalizeRes.error?.includes("FINALIZE_CONFLICT"));

      // Verify user's file is NOT overwritten
      assert.equal(
        readFileSync(join(gitRepoDir, "shared.ts"), "utf8"),
        "const userSimultaneousEdit = 42;\n",
      );

      // Revert user change for clean state
      execFileSync("git", ["-C", gitRepoDir, "checkout", "shared.ts"]);
    });
  });

  // -------------------------------------------------------------------------
  // 12. Verification Improvements: Task Commit Fail-Closed, ExpectedEffects & Command Purpose
  // -------------------------------------------------------------------------

  describe("14. squash_commit Isolation of User's Existing Staged & Unstaged Modifications", () => {
    it("should NOT absorb user's existing staged changes into the squash commit and ensure agent file is clean in status", async () => {
      const sessionId = `session-staged-iso-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      // User creates and STAGES a file in repo
      writeFileSync(join(gitRepoDir, "user_staged.ts"), "export const userStaged = 1;\n");
      execFileSync("git", ["-C", gitRepoDir, "add", "user_staged.ts"]);

      // User also creates an UNSTAGED file in repo
      writeFileSync(join(gitRepoDir, "user_unstaged.ts"), "export const userUnstaged = 2;\n");

      // Agent modifies agent_staged_test.ts
      const taskId = `task-staged-iso-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Agent feature",
        taskPrompt: "Create agent_staged_test.ts",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Create agent_staged_test.ts",
        },
      });

      assert.ok(task.worktreePath);
      writeFileSync(join(task.worktreePath, "agent_staged_test.ts"), "export const agentOk = true;\n");
      await subagentManager.handleSubagentCompletion(taskId);

      // Finalize squash_commit
      const finalizeRes = await subagentManager.finalizeRun(sessionId, {
        mode: "squash_commit",
        commitMessage: "feat: agent only feature",
      });
      assert.equal(finalizeRes.success, true);

      // Verify the new commit on HEAD contains ONLY agent_staged_test.ts and NOT user_staged.ts or user_unstaged.ts
      const commitFiles = execFileSync("git", [
        "-C",
        gitRepoDir,
        "show",
        "--name-only",
        "--pretty=format:",
        "HEAD",
      ])
        .toString()
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

      assert.ok(commitFiles.includes("agent_staged_test.ts"), "Commit must contain agent file");
      assert.ok(!commitFiles.includes("user_staged.ts"), "Commit MUST NOT absorb user staged file");
      assert.ok(!commitFiles.includes("user_unstaged.ts"), "Commit MUST NOT absorb user unstaged file");

      // Verify git status:
      // 1. agent_staged_test.ts must be CLEAN (not shown in status)
      // 2. user_staged.ts must remain STAGED
      // 3. user_unstaged.ts must remain UNSTAGED
      const statusOut = execFileSync("git", ["-C", gitRepoDir, "status", "--porcelain"]).toString();
      assert.ok(!statusOut.includes("agent_staged_test.ts"), "agent_staged_test.ts must be clean in status");
      assert.ok(statusOut.includes("A  user_staged.ts") || statusOut.includes("A user_staged.ts"), "user_staged.ts must remain staged");
      assert.ok(statusOut.includes("?? user_unstaged.ts"), "user_unstaged.ts must remain unstaged");

      // Verify file contents untouched
      assert.equal(readFileSync(join(gitRepoDir, "user_staged.ts"), "utf8"), "export const userStaged = 1;\n");
      assert.equal(readFileSync(join(gitRepoDir, "user_unstaged.ts"), "utf8"), "export const userUnstaged = 2;\n");

      // Clean up
      execFileSync("git", ["-C", gitRepoDir, "reset", "HEAD", "user_staged.ts"]);
      rmSync(join(gitRepoDir, "user_staged.ts"), { force: true });
      rmSync(join(gitRepoDir, "user_unstaged.ts"), { force: true });
    });
  });

  // -------------------------------------------------------------------------
  // 15. User Commits During Run Protection
  // -------------------------------------------------------------------------
  describe("15. User Commits During Run Protection", () => {
    it("should allow safe finalize when user committed an unrelated file during run", async () => {
      const sessionId = `session-unrelated-commit-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      const taskId = `task-unrelated-c-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Agent Task",
        taskPrompt: "Create agent_unrelated.ts",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Create agent_unrelated.ts",
        },
      });

      assert.ok(task.worktreePath);
      writeFileSync(join(task.worktreePath, "agent_unrelated.ts"), "export const agentUnrelated = 1;\n");
      await subagentManager.handleSubagentCompletion(taskId);

      // User simultaneously commits an unrelated file on main branch during run
      writeFileSync(join(gitRepoDir, "user_concurrent.ts"), "export const userConcurrent = 2;\n");
      execFileSync("git", ["-C", gitRepoDir, "add", "user_concurrent.ts"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "user commit during run"]);

      // Finalize
      const finalizeRes = await subagentManager.finalizeRun(sessionId, { mode: "working_tree" });
      assert.equal(finalizeRes.success, true);
      assert.equal(finalizeRes.status, "FINALIZED");

      // Both user's committed file and agent's file exist safely
      assert.ok(existsSync(join(gitRepoDir, "user_concurrent.ts")), "User commit must exist");
      assert.ok(existsSync(join(gitRepoDir, "agent_unrelated.ts")), "Agent file must exist");

      // Clean
      rmSync(join(gitRepoDir, "agent_unrelated.ts"), { force: true });
    });
  });

  // -------------------------------------------------------------------------
  // 16. finalize_run Hard State Gate
  // -------------------------------------------------------------------------

}

// Allow running standalone
if (process.argv[1] && process.argv[1].endsWith("integration-workspace.test.ts")) {
  describe("9 - 11, 14 - 15 Integration Workspace & User Protection", () => {
    let repo: { gitRepoDir: string; cleanup: () => void };
    before(() => {
      repo = setupTestGitRepo();
    });
    after(() => {
      repo.cleanup();
    });
    registerIntegrationWorkspaceTests(() => repo.gitRepoDir);
  });
}
