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


export function registerTaskStateMachineFixesTests(getGitRepoDir: () => string) {
  let gitRepoDir: string;
  beforeEach(() => {
    gitRepoDir = getGitRepoDir();
  });


  describe("40. Task State Machine Closed-Loop Final Fixes (Scenarios 1 - 15)", () => {
    // 1. 普通知识复用不是 Rework: continue_subagent 不传 rework_of_task_id -> reworkOfTaskId === undefined
    it("Scenario 1: Normal knowledge reuse is not rework (reworkOfTaskId === undefined)", async () => {
      const sessionId = `session-scen1-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      const taskA = await manager.spawn({
        parentSessionId: sessionId,
        role: "tester",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      taskA.status = "completed";
      taskA.verification = { diff: { name: "diff", status: "pass" }, scope: { name: "scope", status: "pass" }, commands: [], overall: "pass" };
      manager.reusableAgents.markCompleted(taskA.agentId!, taskA);

      // continue_subagent without rework_of_task_id
      const taskB = await manager.continueAgent({
        agentId: taskA.agentId!,
        parentSessionId: sessionId,
        taskTitle: "Task B (Independent new task)",
        taskPrompt: "Do B",
        parentCwd: gitRepoDir,
        parentModel: null,
        customSession: createMockSession(),
      });

      assert.equal(taskB.reworkOfTaskId, undefined);
      assert.notEqual(taskA.taskId, taskB.taskId);
    });

    // 2. 显式 Rework: continue_subagent 传入 rework_of_task_id -> reworkOfTaskId === A.taskId
    it("Scenario 2: Explicit rework sets reworkOfTaskId === taskA.taskId", async () => {
      const sessionId = `session-scen2-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      const taskA = await manager.spawn({
        parentSessionId: sessionId,
        role: "junior_fe",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      taskA.status = "completed";
      taskA.verification = { diff: { name: "diff", status: "fail" }, scope: { name: "scope", status: "pass" }, commands: [], overall: "fail" };
      manager.reusableAgents.markCompleted(taskA.agentId!, taskA);

      const taskB = await manager.continueAgent({
        agentId: taskA.agentId!,
        parentSessionId: sessionId,
        taskTitle: "Task B (Fix A)",
        taskPrompt: "Fix A",
        parentCwd: gitRepoDir,
        parentModel: null,
        customSession: createMockSession(),
        reworkOfTaskId: taskA.taskId,
      });

      assert.equal(taskB.reworkOfTaskId, taskA.taskId);
    });

    // 3. Rework target 不存在: 应拒绝
    it("Scenario 3: Non-existent rework target is rejected", async () => {
      const sessionId = `session-scen3-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      await assert.rejects(
        () =>
          manager.spawn({
            parentSessionId: sessionId,
            role: "junior_fe",
            taskTitle: "Task B",
            taskPrompt: "Fix non-existent",
            parentCwd: gitRepoDir,
            customSession: createMockSession(),
            reworkOfTaskId: "non-existent-task-id",
          }),
        /target task does not exist/i,
      );
    });

    // 4. 跨 Session / Run Rework: 应拒绝
    it("Scenario 4: Cross-session rework is rejected", async () => {
      const session1 = `session-scen4-a-${Date.now()}`;
      const session2 = `session-scen4-b-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      const taskA = await manager.spawn({
        parentSessionId: session1,
        role: "junior_fe",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      taskA.status = "completed";

      await assert.rejects(
        () =>
          manager.spawn({
            parentSessionId: session2,
            role: "junior_fe",
            taskTitle: "Task B",
            taskPrompt: "Fix A in other session",
            parentCwd: gitRepoDir,
            customSession: createMockSession(),
            reworkOfTaskId: taskA.taskId,
          }),
        /Cross-session rework is prohibited/i,
      );
    });

    // 5. 对 Running Task 创建 Rework: 应拒绝
    it("Scenario 5: Creating rework for non-terminal running task is rejected", async () => {
      const sessionId = `session-scen5-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      const taskA = await manager.spawn({
        parentSessionId: sessionId,
        role: "junior_fe",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      assert.equal(taskA.status, "running");

      await assert.rejects(
        () =>
          manager.spawn({
            parentSessionId: sessionId,
            role: "junior_fe",
            taskTitle: "Task B",
            taskPrompt: "Fix running A",
            parentCwd: gitRepoDir,
            customSession: createMockSession(),
            reworkOfTaskId: taskA.taskId,
          }),
        /target task is in non-terminal status "running"/i,
      );
    });

    // 6. Rework 循环: 应拒绝
    it("Scenario 6: Circular rework lineage is rejected", async () => {
      const sessionId = `session-scen6-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      await assert.rejects(
        () =>
          manager.spawn({
            parentSessionId: sessionId,
            role: "junior_fe",
            taskTitle: "Task Self",
            taskPrompt: "Self",
            parentCwd: gitRepoDir,
            customSession: createMockSession(),
            taskContract: {
              taskId: "task-self-cycle",
              parentSessionId: sessionId,
              role: "junior_fe",
              goal: "Self",
              reworkOfTaskId: "task-self-cycle",
            },
          }),
        /cannot be a rework of itself/i,
      );
    });

    // 7. Rework 分叉: 已有 A -> B, 再尝试 A -> C 应拒绝
    it("Scenario 7: Forking rework from same parent is rejected (enforces linear chain)", async () => {
      const sessionId = `session-scen7-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      const taskA = await manager.spawn({
        parentSessionId: sessionId,
        role: "junior_fe",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      taskA.status = "completed";

      const taskB = await manager.spawn({
        parentSessionId: sessionId,
        role: "junior_fe",
        taskTitle: "Task B (Rework A)",
        taskPrompt: "Fix A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        reworkOfTaskId: taskA.taskId,
      });
      assert.equal(taskB.reworkOfTaskId, taskA.taskId);
      taskB.status = "completed";

      // Attempting to rework A directly again (forking)
      await assert.rejects(
        () =>
          manager.spawn({
            parentSessionId: sessionId,
            role: "junior_fe",
            taskTitle: "Task C (Fork Rework A)",
            taskPrompt: "Fork A",
            parentCwd: gitRepoDir,
            customSession: createMockSession(),
            reworkOfTaskId: taskA.taskId,
          }),
        /already has a rework successor/i,
      );
    });

    // 8. 旧 PASS 后存在 Running Rework: A PASS -> B running -> lineage(A) = false
    it("Scenario 8: Old PASS followed by running rework -> lineage(A) is false", async () => {
      const sessionId = `session-scen8-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      const taskA = await manager.spawn({
        parentSessionId: sessionId,
        role: "junior_fe",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      taskA.status = "completed";
      taskA.verification = { diff: { name: "diff", status: "pass" }, scope: { name: "scope", status: "pass" }, commands: [], overall: "pass" };

      assert.equal(manager.isTaskLineageSatisfied(taskA.taskId, sessionId), true);

      // Create rework B which is running
      const taskB = await manager.spawn({
        parentSessionId: sessionId,
        role: "junior_fe",
        taskTitle: "Task B",
        taskPrompt: "Rework A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        reworkOfTaskId: taskA.taskId,
      });
      assert.equal(taskB.status, "running");

      // Lineage A must be false because B (running leaf) supersedes A!
      assert.equal(manager.isTaskLineageSatisfied(taskA.taskId, sessionId), false);
    });

    // 9. 旧 PASS 后 Rework FAIL: A PASS -> B FAIL -> lineage(A) = false
    it("Scenario 9: Old PASS followed by rework FAIL -> lineage(A) is false", async () => {
      const sessionId = `session-scen9-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      const taskA = await manager.spawn({
        parentSessionId: sessionId,
        role: "junior_fe",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      taskA.status = "completed";
      taskA.verification = { diff: { name: "diff", status: "pass" }, scope: { name: "scope", status: "pass" }, commands: [], overall: "pass" };

      const taskB = await manager.spawn({
        parentSessionId: sessionId,
        role: "junior_fe",
        taskTitle: "Task B",
        taskPrompt: "Rework A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        reworkOfTaskId: taskA.taskId,
      });
      taskB.status = "completed";
      taskB.verification = { diff: { name: "diff", status: "fail" }, scope: { name: "scope", status: "pass" }, commands: [], overall: "fail" };

      assert.equal(manager.isTaskLineageSatisfied(taskA.taskId, sessionId), false);
    });

    // 10. 旧 PASS 后 Rework PASS: A PASS -> B PASS -> lineage(A) = true
    it("Scenario 10: Old PASS followed by rework PASS -> lineage(A) is true", async () => {
      const sessionId = `session-scen10-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      const taskA = await manager.spawn({
        parentSessionId: sessionId,
        role: "junior_fe",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      taskA.status = "completed";
      taskA.verification = { diff: { name: "diff", status: "pass" }, scope: { name: "scope", status: "pass" }, commands: [], overall: "pass" };

      const taskB = await manager.spawn({
        parentSessionId: sessionId,
        role: "junior_fe",
        taskTitle: "Task B",
        taskPrompt: "Rework A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        reworkOfTaskId: taskA.taskId,
      });
      taskB.status = "completed";
      taskB.verification = { diff: { name: "diff", status: "pass" }, scope: { name: "scope", status: "pass" }, commands: [], overall: "pass" };

      assert.equal(manager.isTaskLineageSatisfied(taskA.taskId, sessionId), true);
    });

    // 11. 多轮 Rework: A FAIL -> B FAIL -> C PASS -> lineage(A) = true
    it("Scenario 11: Multi-round rework A(FAIL) -> B(FAIL) -> C(PASS) -> lineage(A) is true", async () => {
      const sessionId = `session-scen11-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      const taskA = await manager.spawn({
        parentSessionId: sessionId,
        role: "junior_fe",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      taskA.status = "completed";
      taskA.verification = { diff: { name: "diff", status: "fail" }, scope: { name: "scope", status: "pass" }, commands: [], overall: "fail" };

      const taskB = await manager.spawn({
        parentSessionId: sessionId,
        role: "junior_fe",
        taskTitle: "Task B",
        taskPrompt: "Rework A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        reworkOfTaskId: taskA.taskId,
      });
      taskB.status = "completed";
      taskB.verification = { diff: { name: "diff", status: "fail" }, scope: { name: "scope", status: "pass" }, commands: [], overall: "fail" };

      const taskC = await manager.spawn({
        parentSessionId: sessionId,
        role: "junior_fe",
        taskTitle: "Task C",
        taskPrompt: "Rework B",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        reworkOfTaskId: taskB.taskId,
      });
      taskC.status = "completed";
      taskC.verification = { diff: { name: "diff", status: "pass" }, scope: { name: "scope", status: "pass" }, commands: [], overall: "pass" };

      assert.equal(manager.isTaskLineageSatisfied(taskA.taskId, sessionId), true);
      assert.equal(manager.isTaskLineageSatisfied(taskB.taskId, sessionId), true);
      assert.equal(manager.isTaskLineageSatisfied(taskC.taskId, sessionId), true);
    });

    // 12. 真实自动 Finalize: 不需要手工调用 tryAutoFinalizeRun, 模拟 Coordinator lifecycle 自动触发
    it("Scenario 12: Real lifecycle auto-finalizes at coordinator safe boundary without explicit finalize calls", async () => {
      const sessionId = `session-scen12-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      // Coordinator starts initial orchestration
      manager.notifyCoordinatorTurnStart(sessionId);

      // Spawn task
      const task = await manager.spawn({
        parentSessionId: sessionId,
        role: "tester",
        taskTitle: "Task E2E",
        taskPrompt: "Do E2E",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      await manager.getOrCreateIntegration(sessionId, gitRepoDir);

      // Subagent finishes and completes verification
      task.status = "completed";
      task.verification = { diff: { name: "diff", status: "pass" }, scope: { name: "scope", status: "pass" }, commands: [], overall: "pass" };

      // Subagent completion: report generated, but Coordinator has not finished turn
      assert.equal(manager.isRunFinalized(sessionId), false);

      // Coordinator consumes report and turn ends with no new tasks (Safe Boundary)
      const finRes = await manager.notifyCoordinatorTurnEnd(sessionId, { hasPendingReports: false });

      // Verified: Automatically finalized without calling tryAutoFinalizeRun or finalize tool!
      assert.ok(finRes);
      assert.equal(finRes.success, true);
      assert.equal(manager.isRunFinalized(sessionId), true);
    });

    // 13. Coordinator 尚未消费结果时不能提前 Finalize: 最后一个 Task PASS -> report 尚未交付 -> User Workspace 尚未 finalize
    it("Scenario 13: Cannot finalize early when coordinator has not consumed completion report", async () => {
      const sessionId = `session-scen13-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      manager.notifyCoordinatorTurnStart(sessionId);

      const task = await manager.spawn({
        parentSessionId: sessionId,
        role: "tester",
        taskTitle: "Task 1",
        taskPrompt: "Do 1",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      await manager.getOrCreateIntegration(sessionId, gitRepoDir);

      task.status = "completed";
      task.verification = { diff: { name: "diff", status: "pass" }, scope: { name: "scope", status: "pass" }, commands: [], overall: "pass" };

      // Pending report queued for coordinator
      manager.notifyCoordinatorReportPending(sessionId, 1);

      // Coordinator turn ends temporarily, but pending reports remain!
      const finRes = await manager.notifyCoordinatorTurnEnd(sessionId, { hasPendingReports: true });

      // Must NOT finalize because report is not consumed yet
      assert.equal(finRes, null);
      assert.equal(manager.isRunFinalized(sessionId), false);
    });

    // 14. Coordinator 消费结果后创建 Rework: continue_subagent 创建 B -> 不能在 B 创建前抢先 finalize
    it("Scenario 14: When coordinator consumes result and creates rework, runtime must not finalize before rework", async () => {
      const sessionId = `session-scen14-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      manager.notifyCoordinatorTurnStart(sessionId);

      const taskA = await manager.spawn({
        parentSessionId: sessionId,
        role: "junior_fe",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      await manager.getOrCreateIntegration(sessionId, gitRepoDir);

      taskA.status = "completed";
      taskA.verification = { diff: { name: "diff", status: "fail" }, scope: { name: "scope", status: "pass" }, commands: [], overall: "fail" };
      manager.reusableAgents.markCompleted(taskA.agentId!, taskA);

      // Coordinator is running turn to consume result and decides to rework
      // In this turn, coordinator calls continueAgent
      const taskB = await manager.continueAgent({
        agentId: taskA.agentId!,
        parentSessionId: sessionId,
        taskTitle: "Task B (Rework A)",
        taskPrompt: "Fix A",
        parentCwd: gitRepoDir,
        parentModel: null,
        customSession: createMockSession(),
        reworkOfTaskId: taskA.taskId,
      });

      // Task B is running
      assert.equal(taskB.status, "running");

      // Coordinator turn ends
      const finRes = await manager.notifyCoordinatorTurnEnd(sessionId, { hasPendingReports: false });

      // Must NOT finalize because task B is running!
      assert.equal(finRes, null);
      assert.equal(manager.isRunFinalized(sessionId), false);
    });

    // 15. Coordinator 完成且没有后续工作: 所有 lineage leaf PASS -> Runtime 自动 finalize
    it("Scenario 15: When all lineage leaves PASS and coordinator has no further work, runtime auto finalizes", async () => {
      const sessionId = `session-scen15-${Date.now()}`;
      const manager = new SubagentManager(mockModelRuntime);

      manager.notifyCoordinatorTurnStart(sessionId);

      // Task A failed, Task B reworked A and passed
      const taskA = await manager.spawn({
        parentSessionId: sessionId,
        role: "junior_fe",
        taskTitle: "Task A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
      });
      await manager.getOrCreateIntegration(sessionId, gitRepoDir);
      taskA.status = "completed";
      taskA.verification = { diff: { name: "diff", status: "fail" }, scope: { name: "scope", status: "pass" }, commands: [], overall: "fail" };
      manager.reusableAgents.markCompleted(taskA.agentId!, taskA);

      const taskB = await manager.continueAgent({
        agentId: taskA.agentId!,
        parentSessionId: sessionId,
        taskTitle: "Task B",
        taskPrompt: "Fix A",
        parentCwd: gitRepoDir,
        parentModel: null,
        customSession: createMockSession(),
        reworkOfTaskId: taskA.taskId,
      });
      taskB.status = "completed";
      taskB.verification = { diff: { name: "diff", status: "pass" }, scope: { name: "scope", status: "pass" }, commands: [], overall: "pass" };

      // Coordinator turn finishes, all lineage leaves PASS, no remaining tasks
      const finRes = await manager.notifyCoordinatorTurnEnd(sessionId, { hasPendingReports: false });

      assert.ok(finRes);
      assert.equal(finRes.success, true);
      assert.equal(manager.isRunFinalized(sessionId), true);
    });
  });

}

// Allow running standalone
if (process.argv[1] && process.argv[1].endsWith("task-state-machine-fixes.test.ts")) {
  describe("40 Task State Machine Closed-Loop Final Fixes", () => {
    let repo: { gitRepoDir: string; cleanup: () => void };
    before(() => {
      repo = setupTestGitRepo();
    });
    after(() => {
      repo.cleanup();
    });
    registerTaskStateMachineFixesTests(() => repo.gitRepoDir);
  });
}
