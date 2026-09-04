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


export function registerFinalizeRollbackTests(getGitRepoDir: () => string) {
  let gitRepoDir: string;
  beforeEach(() => {
    gitRepoDir = getGitRepoDir();
  });


  describe("22. working_tree Rollback: Scenario A - Second File Mutation Fails", () => {
    it("should rollback first file changes when second file mutation fails, restoring pre-finalize state", async () => {
      const sessionId = `session-wt-scen-a-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      // Setup initial files on main branch
      writeFileSync(join(gitRepoDir, "file_a.ts"), "export const a = 'original';\n");
      writeFileSync(join(gitRepoDir, "file_b.ts"), "export const b = 'original';\n");
      execFileSync("git", ["-C", gitRepoDir, "add", "file_a.ts", "file_b.ts"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "initial file_a and file_b"]);

      const taskId = `task-wt-a-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Edit file_a and file_b",
        taskPrompt: "Modify file_a and file_b",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Modify file_a and file_b",
        },
      });

      assert.ok(task.worktreePath);
      writeFileSync(join(task.worktreePath, "file_a.ts"), "export const a = 'modified_by_agent';\n");
      writeFileSync(join(task.worktreePath, "file_b.ts"), "export const b = 'modified_by_agent';\n");
      await subagentManager.handleSubagentCompletion(taskId);

      // Finalize with injected failure at step 1 (second file mutation)
      const finalizeRes = await subagentManager.finalizeRun(sessionId, {
        mode: "working_tree",
        _injectMutationErrorAtStep: 1,
      });

      assert.equal(finalizeRes.success, false);
      assert.equal(finalizeRes.status, "ERROR");

      // Verify file_a.ts and file_b.ts are rolled back to original content
      assert.equal(readFileSync(join(gitRepoDir, "file_a.ts"), "utf8"), "export const a = 'original';\n");
      assert.equal(readFileSync(join(gitRepoDir, "file_b.ts"), "utf8"), "export const b = 'original';\n");

      // Clean
      execFileSync("git", ["-C", gitRepoDir, "rm", "-f", "file_a.ts", "file_b.ts"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "clean file_a and file_b"]);
    });
  });

  // -------------------------------------------------------------------------
  // 23. working_tree Rollback: Scenario B - Delete Mid-Way Fails
  // -------------------------------------------------------------------------
  describe("23. working_tree Rollback: Scenario B - Delete Mid-Way Fails", () => {
    it("should restore deleted file with exact original content when subsequent mutation fails", async () => {
      const sessionId = `session-wt-scen-b-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      // Create target to delete and second file
      writeFileSync(join(gitRepoDir, "target_to_del.ts"), "export const deleteMe = 'must_be_restored';\n");
      writeFileSync(join(gitRepoDir, "second_file.ts"), "export const second = 1;\n");
      execFileSync("git", ["-C", gitRepoDir, "add", "target_to_del.ts", "second_file.ts"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "add target_to_del and second_file"]);

      const taskId = `task-wt-b-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Delete target and modify second",
        taskPrompt: "Delete target_to_del.ts and modify second_file.ts",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Delete target_to_del.ts and modify second_file.ts",
        },
      });

      assert.ok(task.worktreePath);
      rmSync(join(task.worktreePath, "target_to_del.ts"), { force: true });
      writeFileSync(join(task.worktreePath, "second_file.ts"), "export const second = 999;\n");
      await subagentManager.handleSubagentCompletion(taskId);

      // Finalize with error at step 1
      const finalizeRes = await subagentManager.finalizeRun(sessionId, {
        mode: "working_tree",
        _injectMutationErrorAtStep: 1,
      });

      assert.equal(finalizeRes.success, false);
      assert.equal(finalizeRes.status, "ERROR");

      // Verify target_to_del.ts is restored with original content
      assert.ok(existsSync(join(gitRepoDir, "target_to_del.ts")));
      assert.equal(readFileSync(join(gitRepoDir, "target_to_del.ts"), "utf8"), "export const deleteMe = 'must_be_restored';\n");

      // Clean
      execFileSync("git", ["-C", gitRepoDir, "rm", "-f", "target_to_del.ts", "second_file.ts"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "clean scenario b"]);
    });
  });

  // -------------------------------------------------------------------------
  // 24. working_tree Rollback: Scenario C - Rename Mid-Way Fails
  // -------------------------------------------------------------------------
  describe("24. working_tree Rollback: Scenario C - Rename Mid-Way Fails", () => {
    it("should restore old file and remove new file when rename mid-way mutation fails", async () => {
      const sessionId = `session-wt-scen-c-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      writeFileSync(join(gitRepoDir, "old_rename_item.ts"), "export const item = 'legacy';\n");
      writeFileSync(join(gitRepoDir, "accompany_file.ts"), "export const acc = 1;\n");
      execFileSync("git", ["-C", gitRepoDir, "add", "old_rename_item.ts", "accompany_file.ts"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "add old_rename_item and accompany_file"]);

      const taskId = `task-wt-c-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Rename old_rename_item.ts",
        taskPrompt: "Rename old_rename_item.ts to new_rename_item.ts",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Rename old_rename_item.ts to new_rename_item.ts",
        },
      });

      assert.ok(task.worktreePath);
      execFileSync("git", ["-C", task.worktreePath, "mv", "old_rename_item.ts", "new_rename_item.ts"]);
      writeFileSync(join(task.worktreePath, "accompany_file.ts"), "export const acc = 2;\n");
      await subagentManager.handleSubagentCompletion(taskId);

      // Finalize with error at step 1
      const finalizeRes = await subagentManager.finalizeRun(sessionId, {
        mode: "working_tree",
        _injectMutationErrorAtStep: 1,
      });

      assert.equal(finalizeRes.success, false);
      assert.equal(finalizeRes.status, "ERROR");

      // Verify old_rename_item.ts restored, new_rename_item.ts not present
      assert.ok(existsSync(join(gitRepoDir, "old_rename_item.ts")));
      assert.equal(readFileSync(join(gitRepoDir, "old_rename_item.ts"), "utf8"), "export const item = 'legacy';\n");
      assert.ok(!existsSync(join(gitRepoDir, "new_rename_item.ts")));

      // Clean
      execFileSync("git", ["-C", gitRepoDir, "rm", "-f", "old_rename_item.ts", "accompany_file.ts"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "clean scenario c"]);
    });
  });

  // -------------------------------------------------------------------------
  // 25. working_tree Rollback: Scenario D - User Staged & Unstaged Protection
  // -------------------------------------------------------------------------
  describe("25. working_tree Rollback: Scenario D - User Staged & Unstaged Protection", () => {
    it("should keep user staged and unstaged modifications completely untouched on working_tree rollback", async () => {
      const sessionId = `session-wt-scen-d-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      // User creates & stages a file
      writeFileSync(join(gitRepoDir, "user_wt_staged.ts"), "export const userStaged = 'protect_me';\n");
      execFileSync("git", ["-C", gitRepoDir, "add", "user_wt_staged.ts"]);

      // User creates an unstaged file
      writeFileSync(join(gitRepoDir, "user_wt_unstaged.ts"), "export const userUnstaged = 'protect_me';\n");

      const taskId = `task-wt-d-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Agent work",
        taskPrompt: "Create agent_d.ts",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Create agent_d.ts",
        },
      });

      assert.ok(task.worktreePath);
      writeFileSync(join(task.worktreePath, "agent_d.ts"), "export const agentD = true;\n");
      await subagentManager.handleSubagentCompletion(taskId);

      // Finalize with mutation error
      const finalizeRes = await subagentManager.finalizeRun(sessionId, {
        mode: "working_tree",
        _injectMutationError: true,
      });

      assert.equal(finalizeRes.success, false);
      assert.equal(finalizeRes.status, "ERROR");

      // Verify user staged & unstaged intact
      const statusOut = execFileSync("git", ["-C", gitRepoDir, "status", "--porcelain"]).toString();
      assert.ok(statusOut.includes("A  user_wt_staged.ts") || statusOut.includes("A user_wt_staged.ts"));
      assert.ok(statusOut.includes("?? user_wt_unstaged.ts"));
      assert.equal(readFileSync(join(gitRepoDir, "user_wt_staged.ts"), "utf8"), "export const userStaged = 'protect_me';\n");
      assert.equal(readFileSync(join(gitRepoDir, "user_wt_unstaged.ts"), "utf8"), "export const userUnstaged = 'protect_me';\n");

      // Clean
      execFileSync("git", ["-C", gitRepoDir, "reset", "HEAD", "user_wt_staged.ts"]);
      rmSync(join(gitRepoDir, "user_wt_staged.ts"), { force: true });
      rmSync(join(gitRepoDir, "user_wt_unstaged.ts"), { force: true });
    });
  });

  // -------------------------------------------------------------------------
  // 26. working_tree Rollback: Scenario E - Injected Rollback Failure Reporting
  // -------------------------------------------------------------------------
  describe("26. working_tree Rollback: Scenario E - Injected Rollback Failure Reporting", () => {
    it("should report FINALIZE_ROLLBACK_FAILED and preserve worktree when rollback fails", async () => {
      const sessionId = `session-wt-scen-e-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      const taskId = `task-wt-e-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Agent work",
        taskPrompt: "Create agent_e.ts",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Create agent_e.ts",
        },
      });

      assert.ok(task.worktreePath);
      writeFileSync(join(task.worktreePath, "agent_e.ts"), "export const agentE = true;\n");
      await subagentManager.handleSubagentCompletion(taskId);

      // Injected mutation error AND rollback failure
      const finalizeRes = await subagentManager.finalizeRun(sessionId, {
        mode: "working_tree",
        _injectMutationError: true,
        _injectRollbackError: true,
      });

      assert.equal(finalizeRes.success, false);
      assert.equal(finalizeRes.status, "ERROR");
      assert.ok(finalizeRes.error?.includes("FINALIZE_ROLLBACK_FAILED"));
      assert.ok(finalizeRes.conflictFiles?.includes("agent_e.ts"));

      // Verify integration worktree is NOT cleaned up
      const integration = (subagentManager as any).integrations.get(sessionId);
      assert.ok(integration);
      assert.ok(existsSync(integration.worktreePath));
    });
  });

  // -------------------------------------------------------------------------
  // 27. Snapshot Failure Fail-Closed (No Mutation Started, Original File Safe)
  // -------------------------------------------------------------------------
  describe("27. Snapshot Failure Fail-Closed", () => {
    it("should abort finalize without starting mutations when snapshot capture fails", async () => {
      const sessionId = `session-snap-fail-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      writeFileSync(join(gitRepoDir, "snap_original.ts"), "export const original = 'protected';\n");
      execFileSync("git", ["-C", gitRepoDir, "add", "snap_original.ts"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "add snap_original.ts"]);

      const taskId = `task-snap-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Edit snap_original",
        taskPrompt: "Edit snap_original",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Edit snap_original",
        },
      });

      assert.ok(task.worktreePath);
      writeFileSync(join(task.worktreePath, "snap_original.ts"), "export const mutated = true;\n");
      await subagentManager.handleSubagentCompletion(taskId);

      // Injected snapshot capture failure
      const finalizeRes = await subagentManager.finalizeRun(sessionId, {
        mode: "working_tree",
        _injectSnapshotError: true,
      });

      assert.equal(finalizeRes.success, false);
      assert.equal(finalizeRes.status, "ERROR");
      assert.ok(finalizeRes.error?.includes("Failed to capture working tree snapshots"));

      // Verify original file is completely intact
      assert.equal(readFileSync(join(gitRepoDir, "snap_original.ts"), "utf8"), "export const original = 'protected';\n");

      // Verify integration worktree preserved
      const integration = (subagentManager as any).integrations.get(sessionId);
      assert.ok(integration);
      assert.ok(existsSync(integration.worktreePath));

      // Clean
      execFileSync("git", ["-C", gitRepoDir, "rm", "-f", "snap_original.ts"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "clean snap_original"]);
    });
  });

  // -------------------------------------------------------------------------
  // 28. squash_commit Rollback Failure Reporting
  // -------------------------------------------------------------------------
  describe("28. squash_commit Rollback Failure Reporting", () => {
    it("should report FINALIZE_ROLLBACK_FAILED when squash rollback fails and preserve resources", async () => {
      const sessionId = `session-squash-rbfail-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      const taskId = `task-sq-fail-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Agent squash fail",
        taskPrompt: "Create sq_fail.ts",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Create sq_fail.ts",
        },
      });

      assert.ok(task.worktreePath);
      writeFileSync(join(task.worktreePath, "sq_fail.ts"), "export const sq = 1;\n");
      await subagentManager.handleSubagentCompletion(taskId);

      // Injected mutation error AND squash rollback failure
      const finalizeRes = await subagentManager.finalizeRun(sessionId, {
        mode: "squash_commit",
        _injectMutationError: true,
        _injectRollbackError: true,
      });

      assert.equal(finalizeRes.success, false);
      assert.equal(finalizeRes.status, "ERROR");
      assert.ok(finalizeRes.error?.includes("FINALIZE_ROLLBACK_FAILED"));

      // Verify resources preserved
      const integration = (subagentManager as any).integrations.get(sessionId);
      assert.ok(integration);
      assert.ok(existsSync(integration.worktreePath));
    });
  });

  // -------------------------------------------------------------------------
  // 29. Executable Bit Preservation & Restoration
  // -------------------------------------------------------------------------
  describe("29. Executable Bit Preservation & Restoration", () => {
    it("should preserve and restore executable mode (0o755) during working_tree rollback", async () => {
      const sessionId = `session-exec-mode-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      const scriptPath = join(gitRepoDir, "script_tool.sh");
      writeFileSync(scriptPath, "#!/bin/sh\necho 'v1'\n");
      chmodSync(scriptPath, 0o755);
      execFileSync("git", ["-C", gitRepoDir, "add", "script_tool.sh"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "add executable script"]);

      const taskId = `task-exec-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Modify script",
        taskPrompt: "Modify script",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Modify script",
        },
      });

      assert.ok(task.worktreePath);
      writeFileSync(join(task.worktreePath, "script_tool.sh"), "#!/bin/sh\necho 'v2 mutated'\n");
      await subagentManager.handleSubagentCompletion(taskId);

      // Finalize with mutation failure to trigger rollback
      const finalizeRes = await subagentManager.finalizeRun(sessionId, {
        mode: "working_tree",
        _injectMutationError: true,
      });

      assert.equal(finalizeRes.success, false);

      // Verify content and executable bit restored
      assert.equal(readFileSync(scriptPath, "utf8"), "#!/bin/sh\necho 'v1'\n");
      const stat = lstatSync(scriptPath);
      assert.equal(stat.mode & 0o777, 0o755, "Executable mode 0o755 must be preserved");

      // Clean
      execFileSync("git", ["-C", gitRepoDir, "rm", "-f", "script_tool.sh"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "clean script"]);
    });
  });

  // -------------------------------------------------------------------------
  // 30. Symlink Preservation & Restoration
  // -------------------------------------------------------------------------
  describe("30. Symlink Preservation & Restoration", () => {
    it("should preserve and restore symlink as a symbolic link with original target", async () => {
      const sessionId = `session-symlink-${Date.now()}`;
      const subagentManager = new SubagentManager(mockModelRuntime);

      const targetPath = join(gitRepoDir, "target_for_link.txt");
      const linkPath = join(gitRepoDir, "active_link.txt");

      writeFileSync(targetPath, "target content\n");
      try { unlinkSync(linkPath); } catch {}
      symlinkSync("target_for_link.txt", linkPath);

      execFileSync("git", ["-C", gitRepoDir, "add", "target_for_link.txt", "active_link.txt"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "add target and symlink"]);

      const taskId = `task-sym-${Date.now()}`;
      const task = await subagentManager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Edit link",
        taskPrompt: "Edit active_link.txt",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Edit active_link.txt",
        },
      });

      assert.ok(task.worktreePath);
      // In task worktree, replace symlink with regular file
      unlinkSync(join(task.worktreePath, "active_link.txt"));
      writeFileSync(join(task.worktreePath, "active_link.txt"), "regular file mutated\n");
      await subagentManager.handleSubagentCompletion(taskId);

      // Finalize with mutation error to trigger rollback
      const finalizeRes = await subagentManager.finalizeRun(sessionId, {
        mode: "working_tree",
        _injectMutationError: true,
      });

      assert.equal(finalizeRes.success, false);

      // Verify linkPath is STILL a symlink pointing to target_for_link.txt
      const linkStat = lstatSync(linkPath);
      assert.ok(linkStat.isSymbolicLink(), "Must be restored as a symlink");
      assert.equal(readlinkSync(linkPath), "target_for_link.txt", "Symlink target must be preserved");

      // Clean
      execFileSync("git", ["-C", gitRepoDir, "rm", "-f", "target_for_link.txt", "active_link.txt"]);
      execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "clean symlink"]);
    });
  });

  // -------------------------------------------------------------------------
  // 31. Unsupported Special File Types Fail-Closed
  // -------------------------------------------------------------------------
  describe("31. Unsupported Special File Types Fail-Closed", () => {
    it("should throw fail-closed error when snapshotting a directory path", () => {
      const dirPath = join(gitRepoDir, "sample_dir");
      mkdirSync(dirPath, { recursive: true });

      assert.throws(
        () => {
          captureWorkingTreePathSnapshots(gitRepoDir, ["sample_dir"]);
        },
        {
          message: /Unsupported directory path sample_dir/,
        },
      );

      rmSync(dirPath, { recursive: true, force: true });
    });
  });

  // -------------------------------------------------------------------------
  // 32. Runtime Resource Ownership & Dual Gate Branch Deletion
  // -------------------------------------------------------------------------

}

// Allow running standalone
if (process.argv[1] && process.argv[1].endsWith("finalize-rollback.test.ts")) {
  describe("22 - 31 Finalize Rollback & File System Integrity", () => {
    let repo: { gitRepoDir: string; cleanup: () => void };
    before(() => {
      repo = setupTestGitRepo();
    });
    after(() => {
      repo.cleanup();
    });
    registerFinalizeRollbackTests(() => repo.gitRepoDir);
  });
}
