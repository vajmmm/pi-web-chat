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


export function registerTaskLineageFinalizeTests(getGitRepoDir: () => string) {
  let gitRepoDir: string;
  beforeEach(() => {
    gitRepoDir = getGitRepoDir();
  });


  describe("39. Task State Machine Lineage, Quality Gate & Auto-Finalize (Scenarios 1 - 12)", () => {
    // 1. Rework 成功: A (completed + fail) -> B (reworkOf A + completed + pass) -> dependsOn A 的 C 从 blocked -> ready
    it("Scenario 1: Rework success unblocks downstream task depending on original task", async () => {
      const sessionId = `session-rework-ok-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      // Task A fails
      const taskA = await manager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      taskA.status = "completed";
      taskA.verification = {
        diff: { name: "diff", status: "pass" },
        scope: { name: "scope", status: "pass" },
        commands: [],
        overall: "fail",
      };

      // Task C dependsOn Task A -> starts as blocked
      const taskC = await manager.spawn({
        parentSessionId: sessionId,
        role: "verifier",
        taskTitle: "Task C",
        taskPrompt: "Test after A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId: `task-c-${Date.now()}`,
          parentSessionId: sessionId,
          role: "verifier",
          goal: "Test after A",
          dependsOn: [taskA.taskId],
        },
      });
      assert.equal(taskC.status, "blocked");

      // Task B rework of Task A
      const taskB = await manager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Task B (Rework A)",
        taskPrompt: "Fix A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId: `task-b-${Date.now()}`,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Fix A",
          reworkOfTaskId: taskA.taskId,
        },
      });
      assert.equal(taskB.reworkOfTaskId, taskA.taskId);

      // Complete B with pass verification
      taskB.status = "completed";
      taskB.verification = {
        diff: { name: "diff", status: "pass" },
        scope: { name: "scope", status: "pass" },
        commands: [],
        overall: "pass",
      };

      // Check lineage of A is now satisfied
      assert.equal(manager.isTaskLineageSatisfied(taskA.taskId, sessionId), true);

      // Check DAG unblocks C
      const unblocked = manager.taskGraph.getNewlyReadyTasks((depId) =>
        manager.isTaskLineageSatisfied(depId, sessionId),
      );
      assert.ok(unblocked.includes(taskC.taskId));
    });

    // 2. Rework 再次失败: A fail -> B reworkOf A fail -> C 仍然 blocked
    it("Scenario 2: Rework failure keeps downstream task blocked", async () => {
      const sessionId = `session-rework-fail-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      const taskA = await manager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      taskA.status = "completed";
      taskA.verification = {
        diff: { name: "diff", status: "pass" },
        scope: { name: "scope", status: "pass" },
        commands: [],
        overall: "fail",
      };

      const taskC = await manager.spawn({
        parentSessionId: sessionId,
        role: "verifier",
        taskTitle: "Task C",
        taskPrompt: "Test after A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId: `task-c-${Date.now()}`,
          parentSessionId: sessionId,
          role: "verifier",
          goal: "Test after A",
          dependsOn: [taskA.taskId],
        },
      });
      assert.equal(taskC.status, "blocked");

      // Task B rework of A, also fails
      const taskB = await manager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Task B (Rework A)",
        taskPrompt: "Fix A attempt 1",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId: `task-b-${Date.now()}`,
          parentSessionId: sessionId,
          role: "developer",
          goal: "Fix A attempt 1",
          reworkOfTaskId: taskA.taskId,
        },
      });
      taskB.status = "completed";
      taskB.verification = {
        diff: { name: "diff", status: "pass" },
        scope: { name: "scope", status: "pass" },
        commands: [],
        overall: "fail",
      };

      // Check lineage of A is still NOT satisfied
      assert.equal(manager.isTaskLineageSatisfied(taskA.taskId, sessionId), false);

      const unblocked = manager.taskGraph.getNewlyReadyTasks((depId) =>
        manager.isTaskLineageSatisfied(depId, sessionId),
      );
      assert.equal(unblocked.includes(taskC.taskId), false);
    });

    // 3. 多次 Rework: A fail -> B fail (reworkOf A) -> C pass (reworkOf B) -> A lineage satisfied
    it("Scenario 3: Chained multiple reworks satisfy original task lineage", async () => {
      const sessionId = `session-rework-chain-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      const taskA = await manager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      taskA.status = "completed";
      taskA.verification = {
        diff: { name: "diff", status: "pass" },
        scope: { name: "scope", status: "pass" },
        commands: [],
        overall: "fail",
      };

      const taskB = await manager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Task B",
        taskPrompt: "Rework A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        reworkOfTaskId: taskA.taskId,
      });
      taskB.status = "completed";
      taskB.verification = {
        diff: { name: "diff", status: "pass" },
        scope: { name: "scope", status: "pass" },
        commands: [],
        overall: "fail",
      };

      const taskC = await manager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Task C",
        taskPrompt: "Rework B",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        reworkOfTaskId: taskB.taskId,
      });
      taskC.status = "completed";
      taskC.verification = {
        diff: { name: "diff", status: "pass" },
        scope: { name: "scope", status: "pass" },
        commands: [],
        overall: "pass",
      };

      assert.equal(manager.isTaskLineageSatisfied(taskA.taskId, sessionId), true);
      assert.equal(manager.isTaskLineageSatisfied(taskB.taskId, sessionId), true);
      assert.equal(manager.isTaskLineageSatisfied(taskC.taskId, sessionId), true);
    });

    // 4. Verification Pass: completed + pass -> dependency satisfied
    it("Scenario 4: Task completed with verification pass satisfies dependency", () => {
      const task: UISubagentTask = {
        taskId: "t4",
        parentSessionId: "s4",
        role: "developer",
        taskTitle: "T4",
        taskPrompt: "P4",
        status: "completed",
        createdAt: new Date().toISOString(),
        verification: {
          diff: { name: "diff", status: "pass" },
          scope: { name: "scope", status: "pass" },
          commands: [],
          overall: "pass",
        },
      };
      assert.equal(isTaskExecutionSatisfied(task), true);
    });

    // 5. Verification Fail: completed + fail -> dependency not satisfied
    it("Scenario 5: Task completed with verification fail does not satisfy dependency", () => {
      const task: UISubagentTask = {
        taskId: "t5",
        parentSessionId: "s5",
        role: "developer",
        taskTitle: "T5",
        taskPrompt: "P5",
        status: "completed",
        createdAt: new Date().toISOString(),
        verification: {
          diff: { name: "diff", status: "fail" },
          scope: { name: "scope", status: "pass" },
          commands: [],
          overall: "fail",
        },
      };
      assert.equal(isTaskExecutionSatisfied(task), false);
    });

    // 6. Partially Verified: completed + partially_verified -> dependency not satisfied
    it("Scenario 6: Task completed with partially_verified does not satisfy dependency", () => {
      const task: UISubagentTask = {
        taskId: "t6",
        parentSessionId: "s6",
        role: "verifier",
        taskTitle: "T6",
        taskPrompt: "P6",
        status: "completed",
        createdAt: new Date().toISOString(),
        verification: {
          diff: { name: "diff", status: "pass" },
          scope: { name: "scope", status: "pass" },
          commands: [],
          overall: "partially_verified",
        },
      };
      assert.equal(isTaskExecutionSatisfied(task), false);
    });

    // 7. Review Request Changes: completed + review.verdict = REQUEST_CHANGES -> dependency not satisfied
    it("Scenario 7: Task with REQUEST_CHANGES review verdict does not satisfy dependency", () => {
      const task: UISubagentTask = {
        taskId: "t7",
        parentSessionId: "s7",
        role: "developer",
        taskTitle: "T7",
        taskPrompt: "P7",
        status: "completed",
        createdAt: new Date().toISOString(),
        verification: {
          diff: { name: "diff", status: "pass" },
          scope: { name: "scope", status: "pass" },
          commands: [],
          overall: "pass",
        },
        review: {
          verdict: "REQUEST_CHANGES",
          findings: [
            {
              id: "f1",
              severity: "blocker",
              problem: "Critical bug found",
              evidence: "Reproduced in review",
            },
          ],
          onlyMinorFindings: false,
        },
      };
      assert.equal(isTaskExecutionSatisfied(task), false);
    });

    // 8. 不允许提前 Finalize: A fail + B rework running -> Run 不允许 finalize
    it("Scenario 8: Run finalize is rejected when rework task is still running", async () => {
      const sessionId = `session-fin-early-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      const taskA = await manager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      taskA.status = "completed";
      taskA.verification = {
        diff: { name: "diff", status: "pass" },
        scope: { name: "scope", status: "pass" },
        commands: [],
        overall: "fail",
      };

      await manager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Task B",
        taskPrompt: "Rework A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        reworkOfTaskId: taskA.taskId,
      });

      const res = await manager.finalizeRun(sessionId);
      assert.equal(res.success, false);
      assert.ok(res.error?.includes("active or not in terminal state") || res.error?.includes("running"));
    });

    // 9. 未解决失败不能 Finalize: A completed + fail (no successful rework) -> Run 不允许 finalize
    it("Scenario 9: Run finalize is rejected when unresolved failed task exists", async () => {
      const sessionId = `session-fin-unresolved-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      const taskA = await manager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      taskA.status = "completed";
      taskA.verification = {
        diff: { name: "diff", status: "pass" },
        scope: { name: "scope", status: "pass" },
        commands: [],
        overall: "fail",
      };

      const res = await manager.finalizeRun(sessionId);
      assert.equal(res.success, false);
      assert.ok(res.error?.includes("unsatisfied task lineage") || res.error?.includes("Quality gate"));
    });

    // 10. Partially Verified 不能 Finalize: A completed + partially_verified -> Run 不允许 finalize
    it("Scenario 10: Run finalize is rejected when task is partially_verified", async () => {
      const sessionId = `session-fin-partially-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      const taskA = await manager.spawn({
        parentSessionId: sessionId,
        role: "verifier",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      taskA.status = "completed";
      taskA.verification = {
        diff: { name: "diff", status: "pass" },
        scope: { name: "scope", status: "pass" },
        commands: [],
        overall: "partially_verified",
      };

      const res = await manager.finalizeRun(sessionId);
      assert.equal(res.success, false);
      assert.ok(res.error?.includes("unsatisfied task lineage") || res.error?.includes("partially_verified"));
    });

    // 11. 全部 Lineage 满足后自动 Finalize: A fail -> B rework pass, C pass, D pass -> Runtime 自动 finalize
    it("Scenario 11: Auto-finalize triggers automatically when all lineages are satisfied without tool calls", async () => {
      const sessionId = `session-auto-fin-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime, { autoFinalize: true });

      // Task A fails
      const taskA = await manager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      taskA.status = "completed";
      taskA.verification = {
        diff: { name: "diff", status: "pass" },
        scope: { name: "scope", status: "pass" },
        commands: [],
        overall: "fail",
      };

      // Task B rework of A (passes)
      const taskB = await manager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Task B (Rework A)",
        taskPrompt: "Fix A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        reworkOfTaskId: taskA.taskId,
      });
      taskB.status = "completed";
      taskB.verification = {
        diff: { name: "diff", status: "pass" },
        scope: { name: "scope", status: "pass" },
        commands: [],
        overall: "pass",
      };

      // Task C passes
      const taskC = await manager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Task C",
        taskPrompt: "Do C",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      taskC.status = "completed";
      taskC.verification = {
        diff: { name: "diff", status: "pass" },
        scope: { name: "scope", status: "pass" },
        commands: [],
        overall: "pass",
      };

      // Task D passes
      const taskD = await manager.spawn({
        parentSessionId: sessionId,
        role: "verifier",
        taskTitle: "Task D",
        taskPrompt: "Do D",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      taskD.status = "completed";
      taskD.verification = {
        diff: { name: "diff", status: "pass" },
        scope: { name: "scope", status: "pass" },
        commands: [],
        overall: "pass",
      };

      // Verify all lineages are satisfied
      assert.equal(manager.isSessionLineageSatisfied(sessionId), true);

      // Trigger auto finalize
      const autoRes = await manager.tryAutoFinalizeRun(sessionId);
      assert.ok(autoRes);
      assert.equal(autoRes.success, true);
    });

    // 12. 历史不可变: A fail -> B rework pass -> A.status 仍 completed, A.verification 仍 fail
    it("Scenario 12: Historical task record remains strictly immutable across reworks", async () => {
      const sessionId = `session-immutability-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      const taskA = await manager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      taskA.status = "completed";
      taskA.verification = {
        diff: { name: "diff", status: "fail" },
        scope: { name: "scope", status: "pass" },
        commands: [],
        overall: "fail",
      };

      const taskB = await manager.spawn({
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Task B (Rework A)",
        taskPrompt: "Fix A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        reworkOfTaskId: taskA.taskId,
      });
      taskB.status = "completed";
      taskB.verification = {
        diff: { name: "diff", status: "pass" },
        scope: { name: "scope", status: "pass" },
        commands: [],
        overall: "pass",
      };

      // Query task A directly from manager
      const tasks = manager.getTasksForParent(sessionId);
      const queriedA = tasks.find((t) => t.taskId === taskA.taskId);
      const queriedB = tasks.find((t) => t.taskId === taskB.taskId);

      assert.ok(queriedA);
      assert.ok(queriedB);

      // Verify Task A's status and verification are untouched
      assert.equal(queriedA.status, "completed");
      assert.equal(queriedA.verification?.overall, "fail");
      assert.equal(queriedA.reworkOfTaskId, undefined);

      // Verify Task B exists as distinct task pointing to A
      assert.equal(queriedB.status, "completed");
      assert.equal(queriedB.verification?.overall, "pass");
      assert.equal(queriedB.reworkOfTaskId, taskA.taskId);
    });
  });


}

// Allow running standalone
if (process.argv[1] && process.argv[1].endsWith("task-lineage-finalize.test.ts")) {
  describe("39 Task State Machine Lineage & Quality Gate", () => {
    let repo: { gitRepoDir: string; cleanup: () => void };
    before(() => {
      repo = setupTestGitRepo();
    });
    after(() => {
      repo.cleanup();
    });
    registerTaskLineageFinalizeTests(() => repo.gitRepoDir);
  });
}
