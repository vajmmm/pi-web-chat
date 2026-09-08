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
  VERIFICATION_FAILURE_SUMMARY_MAX_CHARS,
  VERIFICATION_SUCCESS_SUMMARY_MAX_CHARS,
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


export function registerSubagentLifecycleTests(getGitRepoDir: () => string) {
  let gitRepoDir: string;
  beforeEach(() => {
    gitRepoDir = getGitRepoDir();
  });


  describe("4. Task Status 仅表示执行结束，业务/Runtime 验证结果反映在 verification.overall", () => {
    it("should set status = completed but verification.overall = fail when verification fails (NO_EFFECT)", async () => {
      const subagentManager = new SubagentManager(mockModelRuntime);
      const taskId = `task-fail-block-${Date.now()}`;
      const session = createMockSession([
        { role: "assistant", content: [{ type: "text", text: "自称开发完成但实际没写任何代码" }] },
      ]);

      const task = await subagentManager.spawn({
        parentSessionId: "session-fail-block",
        role: "developer",
        taskTitle: "未实际编写代码的任务",
        taskPrompt: "开发功能",
        parentCwd: gitRepoDir,
        customSession: session,
        taskContract: {
          taskId,
          parentSessionId: "session-fail-block",
          role: "developer",
          goal: "开发功能",
        },
      });

      // No files changed in worktree -> NO_EFFECT -> verification.overall = fail, status = completed
      await subagentManager.handleSubagentCompletion(taskId);
      assert.equal(task.status, "completed");
      assert.equal(task.verification?.overall, "fail");
    });
  });

  // -------------------------------------------------------------------------
  // 5. 真实完整 Spawn E2E 测试 (A -> B unblock -> merge chain)
  // -------------------------------------------------------------------------
  describe("5. 真实完整 Spawn E2E 测试", () => {
    it("should execute task A, auto-merge, unblock task B with fresh worktree, and finalize both to user working tree", async () => {
      const subagentManager = new SubagentManager(mockModelRuntime);
      const taskAId = `task-a-${Date.now()}`;
      const taskBId = `task-b-${Date.now()}`;

      // 1. Spawn Task A (running)
      const taskA = await subagentManager.spawn({
        parentSessionId: "session-full-e2e",
        role: "developer",
        taskTitle: "后端接口开发",
        taskPrompt: "实现 /api/auth",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId: taskAId,
          parentSessionId: "session-full-e2e",
          role: "developer",
          goal: "实现 /api/auth",
        },
      });

      // 2. Spawn Task B (blocked on Task A)
      const taskB = await subagentManager.spawn({
        parentSessionId: "session-full-e2e",
        role: "developer",
        taskTitle: "前端界面开发",
        taskPrompt: "对接 /api/auth",
        parentCwd: gitRepoDir,
        customSession: createMockSession(),
        taskContract: {
          taskId: taskBId,
          parentSessionId: "session-full-e2e",
          role: "developer",
          goal: "对接 /api/auth",
          dependsOn: [taskAId],
        },
      });

      assert.equal(taskB.status, "blocked");
      assert.equal(taskB.worktreePath, undefined);

      // 3. Worker A writes files (no git commit)
      mkdirSync(join(taskA.worktreePath!, "server"), { recursive: true });
      writeFileSync(join(taskA.worktreePath!, "server", "service.ts"), "export const serviceName = 'AuthService';\n");

      // 4. Complete Task A -> automatically merges and unblocks Task B
      await subagentManager.handleSubagentCompletion(taskAId);
      assert.equal(taskA.status, "completed");
      assert.equal(taskA.verification?.overall, "pass");

      // 5. Verify Task B unblocked and created fresh worktree with Task A's files
      assert.equal(taskB.status, "running");
      assert.ok(taskB.worktreePath);
      assert.ok(existsSync(join(taskB.worktreePath!, "server", "service.ts")));
      assert.equal(
        readFileSync(join(taskB.worktreePath!, "server", "service.ts"), "utf8"),
        "export const serviceName = 'AuthService';\n",
      );

      // 6. Worker B writes files (no git commit)
      mkdirSync(join(taskB.worktreePath!, "client"), { recursive: true });
      writeFileSync(join(taskB.worktreePath!, "client", "App.tsx"), "export const App = () => 'Hello Auth';\n");

      // 7. Complete Task B -> automatically merges
      await subagentManager.handleSubagentCompletion(taskBId);
      assert.equal(taskB.status, "completed");
      assert.equal(taskB.verification?.overall, "pass");

      // 8. Finalize Run in working_tree mode -> applies to user workspace
      const finalizeRes = await subagentManager.finalizeRun("session-full-e2e", { mode: "working_tree" });
      assert.equal(finalizeRes.success, true);

      // User workspace contains both Task A and Task B changes
      assert.ok(existsSync(join(gitRepoDir, "server", "service.ts")), "server/service.ts must be in workspace");
      assert.ok(existsSync(join(gitRepoDir, "client", "App.tsx")), "client/App.tsx must be in workspace");

      // Clean up test files
      try {
        rmSync(join(gitRepoDir, "server"), { recursive: true, force: true });
        rmSync(join(gitRepoDir, "client"), { recursive: true, force: true });
      } catch {}
    });
  });

  // -------------------------------------------------------------------------
  // 6. Command Record 保真
  // -------------------------------------------------------------------------
  describe("6. Command Record 保真", () => {
    it("should accurately record real exitCode and exitCodeSource: runtime when exitCode is provided", () => {
      const mockMessages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "npm test" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          content: "PASS test/app.test.ts (2 passed)",
          isError: false,
          details: { exitCode: 0 },
        },
      ];

      const records = extractCommandRecords(mockMessages);
      assert.equal(records.length, 1);
      assert.equal(records[0].command, "npm test");
      assert.equal(records[0].exitCode, 0);
      assert.equal(records[0].exitCodeSource, "runtime");
      assert.equal(records[0].passed, true);
    });

    it("should set exitCode: null and exitCodeSource: unknown when exitCode details are missing", () => {
      const mockMessages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-no-details",
              name: "bash",
              arguments: { command: "npm run build" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-no-details",
          content: "Build completed",
          isError: false,
          // details missing exitCode
        },
      ];

      const records = extractCommandRecords(mockMessages);
      assert.equal(records.length, 1);
      assert.equal(records[0].command, "npm run build");
      assert.equal(records[0].exitCode, null);
      assert.equal(records[0].exitCodeSource, "unknown");

      // Runtime verification overall must be partially_verified, NOT pass
      const result = runVerification(["build/out.js"], {
        taskId: "t-1",
        parentSessionId: "s-1",
        role: "developer",
        goal: "build",
      }, mockMessages);
      assert.equal(result.overall, "partially_verified");
    });

    it("should record exitCode 1 and exitCodeSource: runtime when command fails with exitCode 1", () => {
      const mockMessages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-err-1",
              name: "bash",
              arguments: { command: "npm run lint" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-err-1",
          content: "Error: 2 lint errors found",
          isError: true,
          details: { exitCode: 1 },
        },
      ];

      const records = extractCommandRecords(mockMessages);
      assert.equal(records[0].command, "npm run lint");
      assert.equal(records[0].exitCode, 1);
      assert.equal(records[0].exitCodeSource, "runtime");
      assert.equal(records[0].passed, false);
      assert.ok(records[0].stderrSummary?.includes("lint errors"));
    });

    it("should keep successful command summaries small", () => {
      assert.equal(VERIFICATION_SUCCESS_SUMMARY_MAX_CHARS, 400);
      const text = `SUCCESS_HEAD\n${"x".repeat(1000)}\nSUCCESS_TAIL`;
      const records = extractCommandRecords([
        {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "call-success-summary",
            name: "bash",
            arguments: { command: "npm test" },
          }],
        },
        {
          role: "toolResult",
          toolCallId: "call-success-summary",
          content: text,
          isError: false,
          details: { exitCode: 0 },
        },
      ]);

      assert.ok(records[0].stdoutSummary);
      assert.equal(records[0].stdoutSummary!.length, VERIFICATION_SUCCESS_SUMMARY_MAX_CHARS);
      assert.match(records[0].stdoutSummary!, /SUCCESS_HEAD/);
      assert.doesNotMatch(records[0].stdoutSummary!, /SUCCESS_TAIL/);
      assert.equal(records[0].stderrSummary, undefined);
    });

    it("should preserve head and tail context for failed command summaries", () => {
      assert.equal(VERIFICATION_FAILURE_SUMMARY_MAX_CHARS, 1200);
      const text = `ERROR_TYPE_HEAD\n${"x".repeat(2400)}\nROOT_CAUSE_TAIL`;
      const records = extractCommandRecords([
        {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "call-failure-summary",
            name: "bash",
            arguments: { command: "npm run typecheck" },
          }],
        },
        {
          role: "toolResult",
          toolCallId: "call-failure-summary",
          content: text,
          isError: true,
          details: { exitCode: 2 },
        },
      ]);

      assert.ok(records[0].stderrSummary);
      assert.equal(records[0].stderrSummary!.length, VERIFICATION_FAILURE_SUMMARY_MAX_CHARS);
      assert.match(records[0].stderrSummary!, /ERROR_TYPE_HEAD/);
      assert.match(records[0].stderrSummary!, /middle omitted/);
      assert.match(records[0].stderrSummary!, /ROOT_CAUSE_TAIL/);
      assert.equal(records[0].stdoutSummary, undefined);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Reviewer Minor Normalization & Scope Enforcement
  // -------------------------------------------------------------------------
  describe("7. Reviewer Minor Normalization & Scope Enforcement", () => {
    it("should faithfully preserve explicit REQUEST_CHANGES without normalizing to APPROVE", async () => {
      const subagentManager = new SubagentManager(mockModelRuntime);
      const taskId = `task-rev-norm-${Date.now()}`;

      const reviewerOutput = `
\`\`\`json
{
  "verdict": "REQUEST_CHANGES",
  "findings": [
    {
      "id": "finding-1",
      "severity": "minor",
      "problem": "变量名建议加前缀",
      "evidence": "const val = 1;"
    },
    {
      "id": "finding-2",
      "severity": "nit",
      "problem": "末尾空行",
      "evidence": "\\n"
    }
  ]
}
\`\`\`
      `;

      const session = createMockSession([
        { role: "assistant", content: [{ type: "text", text: reviewerOutput }] },
      ]);

      const task = await subagentManager.spawn({
        parentSessionId: "session-rev-norm",
        role: "verifier",
        taskTitle: "Review",
        taskPrompt: "Review",
        parentCwd: gitRepoDir,
        customSession: session,
        taskContract: {
          taskId,
          parentSessionId: "session-rev-norm",
          role: "verifier",
          goal: "Review",
        },
      });

      await subagentManager.handleSubagentCompletion(taskId);

      assert.ok(task.review);
      assert.equal(task.review.onlyMinorFindings, true);
      assert.equal(
        task.review.verdict,
        "REQUEST_CHANGES",
        "Explicit REQUEST_CHANGES/REWORK must NOT be silently rewritten to APPROVE",
      );
    });

    it("should fail verification when scope.include is violated", () => {
      const contract: TaskContract = {
        taskId: "task-scope-v1",
        parentSessionId: "session-scope",
        role: "developer",
        goal: "修改前端",
        scope: { include: ["frontend/**"] },
      };

      const changed = ["frontend/Button.tsx", "backend/server.ts"];
      const result = runVerification(changed, contract, []);

      assert.equal(result.scope.status, "fail");
      assert.ok(result.scopeViolations?.includes("backend/server.ts"));
      assert.equal(result.overall, "fail");
    });
  });

  // -------------------------------------------------------------------------
  // 8. Coordinator Authority & Tools Verification
  // -------------------------------------------------------------------------
  describe("8. Coordinator Authority & Tools Verification", () => {
    it("should verify Coordinator has lifecycle tools plus edit/write, but NO accept/reject tools", () => {
      const coordContext = ConstraintResolver.resolve({
        role: "coordinator",
        cwd: "/tmp/project",
      });

      const tools = coordContext.runtime.activeTools;
      assert.ok(!tools.includes("accept_task"), "Coordinator must not have accept_task");
      assert.ok(!tools.includes("reject_task"), "Coordinator must not have reject_task");
      assert.ok(tools.includes("spawn_subagent"), "Coordinator must have spawn_subagent");
      assert.ok(tools.includes("continue_subagent"), "Coordinator must have continue_subagent");
      assert.ok(tools.includes("list_subagents"), "Coordinator must have list_subagents");
      assert.ok(tools.includes("abort_subagent"), "Coordinator must have abort_subagent");
      assert.ok(tools.includes("edit"), "Coordinator must have edit tool for Direct Path work");
      assert.ok(tools.includes("write"), "Coordinator must have write tool for Direct Path work");
    });
  });

  // -------------------------------------------------------------------------
  // 9. Integration Workspace & Zero Git Pollution Finalize (working_tree Mode)
  // -------------------------------------------------------------------------

}

// Allow running standalone
if (process.argv[1] && process.argv[1].endsWith("subagent-lifecycle.test.ts")) {
  describe("4 - 8 Subagent Lifecycle", () => {
    let repo: { gitRepoDir: string; cleanup: () => void };
    before(() => {
      repo = setupTestGitRepo();
    });
    after(() => {
      repo.cleanup();
    });
    registerSubagentLifecycleTests(() => repo.gitRepoDir);
  });
}
