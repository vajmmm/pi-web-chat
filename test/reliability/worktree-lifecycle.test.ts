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


export function registerWorktreeLifecycleTests(getGitRepoDir: () => string) {
  let gitRepoDir: string;
  beforeEach(() => {
    gitRepoDir = getGitRepoDir();
  });


  describe("1. Worktree Isolation Defaults", () => {
    it("should mandate requiresWorktree: true for developer role by default", () => {
      const def = getRoleDefinition("developer");
      assert.equal(
        def.requiresWorktree,
        true,
        "Role developer must default to requiresWorktree: true",
      );

      const resolved = ConstraintResolver.resolve({ role: "developer", cwd: gitRepoDir });
      assert.equal(
        resolved.runtime.requiresWorktree,
        true,
        "Resolved runtime for developer must require worktree",
      );
    });

    it("should set requiresWorktree: false for read-only non-isolated roles (researcher & coordinator)", () => {
      const readRoles = ["researcher", "coordinator"] as const;
      for (const roleId of readRoles) {
        const def = getRoleDefinition(roleId);
        assert.equal(
          def.requiresWorktree,
          false,
          `Read-only role ${roleId} must default to requiresWorktree: false`,
        );

        const resolved = ConstraintResolver.resolve({ role: roleId, cwd: gitRepoDir });
        assert.equal(
          resolved.runtime.requiresWorktree,
          false,
          `Resolved runtime for read-only role ${roleId} must not require worktree`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. BLOCKED 任务不得提前创建 Worktree，解除后基于最新 HEAD 创建
  // -------------------------------------------------------------------------
  describe("2. BLOCKED 任务不得提前创建 Worktree，解除后基于最新 HEAD 创建", () => {
    it("should NOT create worktree for blocked task until parent task completes and merges", async () => {
      const subagentManager = new SubagentManager(mockModelRuntime);
      const taskAId = `task-dep-a-${Date.now()}`;
      const taskBId = `task-dep-b-${Date.now()}`;

      const sessionA = createMockSession([
        { role: "assistant", content: [{ type: "text", text: "已完成后端接口" }] },
      ]);
      const sessionB = createMockSession([
        { role: "assistant", content: [{ type: "text", text: "已绑定后端数据" }] },
      ]);

      // 1. Spawn Task A (running)
      const taskA = await subagentManager.spawn({
        parentSessionId: "session-dep-flow",
        role: "developer",
        taskTitle: "Task A: 创建后端接口",
        taskPrompt: "实现接口",
        parentCwd: gitRepoDir,
        customSession: sessionA,
        taskContract: {
          taskId: taskAId,
          parentSessionId: "session-dep-flow",
          role: "developer",
          goal: "创建后端接口",
        },
      });

      assert.equal(taskA.status, "running");
      assert.ok(taskA.worktreePath, "Task A must have worktree created immediately");

      // 2. Spawn Task B (depends on Task A -> BLOCKED)
      const taskB = await subagentManager.spawn({
        parentSessionId: "session-dep-flow",
        role: "developer",
        taskTitle: "Task B: 前端绑定",
        taskPrompt: "前端绑定",
        parentCwd: gitRepoDir,
        customSession: sessionB,
        taskContract: {
          taskId: taskBId,
          parentSessionId: "session-dep-flow",
          role: "developer",
          goal: "前端绑定",
          dependsOn: [taskAId],
        },
      });

      // Verification: BLOCKED task must NOT have worktree created upfront!
      assert.equal(taskB.status, "blocked");
      assert.equal(taskB.worktreePath, undefined, "Blocked task must NOT create worktree upfront");

      // 3. Worker A writes files in its worktree (without git commit)
      mkdirSync(join(taskA.worktreePath!, "src"), { recursive: true });
      writeFileSync(join(taskA.worktreePath!, "src", "api.ts"), "export const apiEndpoint = '/api/v1';\n");

      // Complete Task A -> automatically merges into integration and unblocks Task B
      await subagentManager.handleSubagentCompletion(taskAId);
      assert.equal(taskA.status, "completed");

      // Verify Task B is now running and has a worktree
      assert.equal(taskB.status, "running");
      assert.ok(taskB.worktreePath, "Task B must now have a worktree created after unblock");

      // CRITICAL CHECK: Task B's worktree MUST see Task A's merged code!
      const apiFileInB = join(taskB.worktreePath!, "src", "api.ts");
      assert.ok(existsSync(apiFileInB), "Task B must immediately see Task A's merged code in its worktree");
      assert.equal(readFileSync(apiFileInB, "utf8"), "export const apiEndpoint = '/api/v1';\n");
    });
  });

  // -------------------------------------------------------------------------
  // 3. Runtime 自动 Commit Worker 修改
  // -------------------------------------------------------------------------
  describe("3. Runtime 自动 Commit Worker 修改", () => {
    it("should automatically stage and commit worker edits without requiring worker to execute git commit", async () => {
      const subagentManager = new SubagentManager(mockModelRuntime);
      const taskId = `task-autocommit-${Date.now()}`;
      const session = createMockSession([
        { role: "assistant", content: [{ type: "text", text: "已修改配置文件" }] },
      ]);

      const task = await subagentManager.spawn({
        parentSessionId: "session-autocommit",
        role: "developer",
        taskTitle: "修改数据库配置",
        taskPrompt: "配置数据库",
        parentCwd: gitRepoDir,
        customSession: session,
        taskContract: {
          taskId,
          parentSessionId: "session-autocommit",
          role: "developer",
          goal: "配置数据库",
        },
      });

      // Worker only writes file (simulating edit/write tools, NO git add / git commit executed)
      writeFileSync(join(task.worktreePath!, "database.json"), '{"host": "localhost", "port": 5432}\n');

      // Worker finishes -> status becomes completed and auto-merges to integration
      await subagentManager.handleSubagentCompletion(taskId);
      assert.equal(task.status, "completed");
      assert.equal(task.verification?.diff.status, "pass");
      assert.ok(task.changedFiles?.includes("database.json"));

      // Finalize Run in working_tree mode -> writes to user workspace without polluting git history
      const finalizeResult = await subagentManager.finalizeRun("session-autocommit", { mode: "working_tree" });
      assert.equal(finalizeResult.success, true);

      // User workspace must genuinely contain database.json
      assert.ok(existsSync(join(gitRepoDir, "database.json")), "database.json must be written to user workspace");
      assert.equal(
        readFileSync(join(gitRepoDir, "database.json"), "utf8"),
        '{"host": "localhost", "port": 5432}\n',
      );

      // Clean up test file
      try {
        rmSync(join(gitRepoDir, "database.json"), { force: true });
      } catch {}
    });
  });

  describe("spawn start failure must not leave RUNNING zombies", () => {
    it("marks researcher spawn failed when targetCwd escapes, with no running leftover", async () => {
      const sessionId = `session-cwd-escape-researcher-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      await assert.rejects(
        () =>
          manager.spawn({
            parentSessionId: sessionId,
            role: "researcher",
            taskTitle: "复查扫描路径探测",
            taskPrompt: "test",
            parentCwd: gitRepoDir,
            targetCwd: "/tmp/pi-web-chat-cwd-escape",
          }),
        /escapes the assigned worktree\/repo boundary/i,
      );

      const leftover = manager.getTasksForParent(sessionId);
      assert.equal(
        leftover.filter((t) => t.status === "running").length,
        0,
        "failed spawn must not remain running",
      );
      assert.ok(leftover.length >= 1, "failed spawn should remain visible as failed, not vanish silently");
      assert.ok(
        leftover.every((t) => t.status === "failed"),
        `expected failed, got ${leftover.map((t) => t.status).join(",")}`,
      );
    });

    it("marks verifier spawn failed when cwd points outside integration worktree", async () => {
      const sessionId = `session-cwd-escape-verifier-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      await assert.rejects(
        () =>
          manager.spawn({
            parentSessionId: sessionId,
            role: "verifier",
            taskTitle: "复查扫描路径探测",
            taskPrompt: "test",
            parentCwd: gitRepoDir,
            targetCwd: join(gitRepoDir, ".worktrees", "task-does-not-belong"),
          }),
        /escapes the assigned worktree\/repo boundary/i,
      );

      const leftover = manager.getTasksForParent(sessionId);
      assert.equal(leftover.filter((t) => t.status === "running").length, 0);
      assert.ok(leftover.every((t) => t.status === "failed"));
    });

    it("rolls back developer worktree when targetCwd escapes after worktree create", async () => {
      const sessionId = `session-cwd-escape-developer-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      await assert.rejects(
        () =>
          manager.spawn({
            parentSessionId: sessionId,
            role: "developer",
            taskTitle: "实现功能",
            taskPrompt: "test",
            parentCwd: gitRepoDir,
            targetCwd: "/tmp/pi-web-chat-cwd-escape",
          }),
        /escapes the assigned worktree\/repo boundary/i,
      );

      const leftover = manager.getTasksForParent(sessionId);
      assert.equal(leftover.filter((t) => t.status === "running").length, 0);
      assert.ok(leftover.every((t) => t.status === "failed"));
      for (const task of leftover) {
        assert.equal(task.worktreePath, undefined, "failed start must drop worktree path");
        assert.equal(task.branchName, undefined, "failed start must drop branch name");
      }

      const listed = execFileSync("git", ["-C", gitRepoDir, "worktree", "list", "--porcelain"], {
        encoding: "utf8",
      });
      const taskId = leftover[0]?.taskId;
      assert.ok(taskId);
      assert.equal(
        listed.includes(taskId),
        false,
        "developer worktree created before cwd check must be removed",
      );
    });
  });

}

// Allow running standalone
if (process.argv[1] && process.argv[1].endsWith("worktree-lifecycle.test.ts")) {
  describe("1 - 3 Worktree Lifecycle", () => {
    let repo: { gitRepoDir: string; cleanup: () => void };
    before(() => {
      repo = setupTestGitRepo();
    });
    after(() => {
      repo.cleanup();
    });
    registerWorktreeLifecycleTests(() => repo.gitRepoDir);
  });
}
