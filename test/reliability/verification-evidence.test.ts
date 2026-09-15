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


export function registerVerificationEvidenceTests(getGitRepoDir: () => string) {
  let gitRepoDir: string;
  beforeEach(() => {
    gitRepoDir = getGitRepoDir();
  });


  describe("12. Verification Improvements: Task Commit Fail-Closed, ExpectedEffects & Command Purpose", () => {
    it("should pass verification for analysis expectedEffects even when 0 files changed", () => {
      const contract: TaskContract = {
        taskId: "task-analysis-1",
        parentSessionId: "s-1",
        role: "verifier",
        goal: "Analyze architecture",
        expectedEffects: ["analysis"],
      };

      const result = runVerification([], contract, []);
      assert.equal(result.diff.status, "pass");
      assert.equal(result.overall, "pass");
    });

    it("should fail verification with NO_EFFECT when expectedEffects is code_change but 0 files changed", () => {
      const contract: TaskContract = {
        taskId: "task-code-1",
        parentSessionId: "s-1",
        role: "developer",
        goal: "Implement feature",
        expectedEffects: ["code_change"],
      };

      const result = runVerification([], contract, []);
      assert.equal(result.diff.status, "fail");
      assert.ok(result.diff.detail?.includes("NO_EFFECT"));
      assert.equal(result.overall, "fail");
    });

    it("should NOT fail verification when exploration command (grep) returns non-zero exitCode", () => {
      const mockMessages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-grep",
              name: "bash",
              arguments: { command: "grep 'non_existent_symbol' src/" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-grep",
          content: "",
          isError: true,
          details: { exitCode: 1 },
        },
      ];

      const contract: TaskContract = {
        taskId: "task-grep-1",
        parentSessionId: "s-1",
        role: "developer",
        goal: "Search and update",
        expectedEffects: ["code_change"],
      };

      const result = runVerification(["src/App.tsx"], contract, mockMessages);
      assert.equal(result.commands.length, 1);
      assert.equal(result.commands[0].purpose, "exploration");
      assert.equal(result.commands[0].passed, false);
      assert.equal(result.overall, "pass", "Exploration command failure must not fail overall verification");
    });

    it("should FAIL verification when test/verification command returns non-zero exitCode", () => {
      const mockMessages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-test",
              name: "bash",
              arguments: { command: "npm test" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-test",
          content: "FAIL: 1 test failed",
          isError: true,
          details: { exitCode: 1 },
        },
      ];

      const contract: TaskContract = {
        taskId: "task-test-fail-1",
        parentSessionId: "s-1",
        role: "verifier",
        goal: "Run test suite",
        expectedEffects: ["test_execution"],
      };

      const result = runVerification([], contract, mockMessages);
      assert.equal(result.commands[0].purpose, "test");
      assert.equal(result.overall, "fail", "Test command failure must fail overall verification");
    });
  });

  // -------------------------------------------------------------------------
  // 13. working_tree Finalize: File Deletion & Rename Support
  // -------------------------------------------------------------------------

  describe("38. ExpectedEffects Fallback, Test Execution Evidence & Fail-Closed FinishReason", () => {
    // -----------------------------------------------------------------------
    // A-F: test_execution 真实测试证据验证
    // -----------------------------------------------------------------------
    it("A. Tester with no diff + passing test command should PASS", () => {
      const contract: TaskContract = {
        taskId: "task-tester-pass-1",
        parentSessionId: "session-1",
        role: "verifier",
        goal: "Run test suite",
        expectedEffects: ["test_execution"],
      };
      const mockMessages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              args: { command: "pytest tests/" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          content: "10 passed in 0.5s",
          details: { exitCode: 0 },
        },
      ];
      const result = runVerification([], contract, mockMessages);
      assert.equal(result.diff.status, "pass");
      assert.equal(result.testExecution?.status, "pass");
      assert.equal(result.overall, "pass");
    });

    it("B. Tester with no executed commands must FAIL verification with NOT_RUN", () => {
      const contract: TaskContract = {
        taskId: "task-tester-empty-1",
        parentSessionId: "session-1",
        role: "verifier",
        goal: "Run test suite",
        expectedEffects: ["test_execution"],
      };
      const result = runVerification([], contract, []);
      assert.equal(result.diff.status, "pass", "Diff pass since no file changes expected");
      assert.equal(result.testExecution?.status, "not_run");
      assert.ok(result.testExecution?.detail?.includes("NO_TEST_EVIDENCE"));
      assert.equal(result.overall, "fail", "Overall verification must fail when tests were not run");
    });

    it("C. Tester with only exploration commands must have test_execution NOT_RUN and overall FAIL", () => {
      const contract: TaskContract = {
        taskId: "task-tester-explor-1",
        parentSessionId: "session-1",
        role: "verifier",
        goal: "Run test suite",
        expectedEffects: ["test_execution"],
      };
      const mockMessages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "c1", name: "bash", args: { command: "ls -la" } },
            { type: "toolCall", id: "c2", name: "bash", args: { command: "python --version" } },
            { type: "toolCall", id: "c3", name: "bash", args: { command: "git status" } },
          ],
        },
        { role: "toolResult", toolCallId: "c1", content: "file list", details: { exitCode: 0 } },
        { role: "toolResult", toolCallId: "c2", content: "Python 3.11.0", details: { exitCode: 0 } },
        { role: "toolResult", toolCallId: "c3", content: "clean", details: { exitCode: 0 } },
      ];
      const result = runVerification([], contract, mockMessages);
      assert.equal(result.testExecution?.status, "not_run");
      assert.equal(result.overall, "fail", "Exploration commands must not substitute for test execution");
    });

    it("D. Test command failure must result in test_execution FAIL and overall FAIL", () => {
      const contract: TaskContract = {
        taskId: "task-tester-fail-cmd-1",
        parentSessionId: "session-1",
        role: "verifier",
        goal: "Run test suite",
        expectedEffects: ["test_execution"],
      };
      const mockMessages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "c1", name: "bash", args: { command: "pytest" } },
          ],
        },
        { role: "toolResult", toolCallId: "c1", content: "1 failed", details: { exitCode: 1 } },
      ];
      const result = runVerification([], contract, mockMessages);
      assert.equal(result.testExecution?.status, "fail");
      assert.equal(result.overall, "fail");
    });

    it("E. Test command with unknown exitCode must be partially_verified and cannot PASS", () => {
      const contract: TaskContract = {
        taskId: "task-tester-unknown-exit-1",
        parentSessionId: "session-1",
        role: "verifier",
        goal: "Run test suite",
        expectedEffects: ["test_execution"],
      };
      const mockMessages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "c1", name: "bash", args: { command: "pytest" } },
          ],
        },
        { role: "toolResult", toolCallId: "c1", content: "Output with unverified exitCode" },
      ];
      const result = runVerification([], contract, mockMessages);
      assert.equal(result.testExecution?.status, "partially_verified");
      assert.equal(result.overall, "partially_verified");
      assert.notEqual(result.overall, "pass");
    });

    it("F. Combined code_change + test_execution must require both diff and test success", () => {
      const contract: TaskContract = {
        taskId: "task-dual-effects-1",
        parentSessionId: "session-1",
        role: "verifier",
        goal: "Modify and test",
        expectedEffects: ["code_change", "test_execution"],
      };

      const passingTestMessages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "c1", name: "bash", args: { command: "pytest" } },
          ],
        },
        { role: "toolResult", toolCallId: "c1", content: "pass", details: { exitCode: 0 } },
      ];

      // F1. Has diff, but no test -> FAIL
      const r1 = runVerification(["test/foo.test.ts"], contract, []);
      assert.equal(r1.diff.status, "pass");
      assert.equal(r1.testExecution?.status, "not_run");
      assert.equal(r1.overall, "fail");

      // F2. Has test, but no diff -> FAIL
      const r2 = runVerification([], contract, passingTestMessages);
      assert.equal(r2.diff.status, "fail");
      assert.equal(r2.testExecution?.status, "pass");
      assert.equal(r2.overall, "fail");

      // F3. Both diff and test present and passing -> PASS
      const r3 = runVerification(["test/foo.test.ts"], contract, passingTestMessages);
      assert.equal(r3.diff.status, "pass");
      assert.equal(r3.testExecution?.status, "pass");
      assert.equal(r3.overall, "pass");
    });

    // -----------------------------------------------------------------------
    // FinishReason 状态矩阵与 Fail-Closed
    // -----------------------------------------------------------------------
    it("FinishReason Matrix: normalizeFinishReason should fail-closed to unknown on missing or unmapped reason", () => {
      // 1. Explicit stop
      assert.equal(normalizeFinishReason({ role: "assistant", stopReason: "stop" }), "stop");
      assert.equal(normalizeFinishReason({ role: "assistant", rawStopReason: "end_turn" }), "stop");

      // 2. Max tokens / Length
      assert.equal(normalizeFinishReason({ role: "assistant", stopReason: "length" }), "max_tokens");
      assert.equal(normalizeFinishReason({ role: "assistant", rawStopReason: "max_tokens" }), "max_tokens");
      assert.equal(normalizeFinishReason({ role: "assistant", rawStopReason: "max_output_tokens" }), "max_tokens");

      // 3. Cancelled / Aborted
      assert.equal(normalizeFinishReason({ role: "assistant", stopReason: "aborted" }), "cancelled");
      assert.equal(normalizeFinishReason({ role: "assistant", rawStopReason: "cancelled" }), "cancelled");

      // 4. Error
      assert.equal(normalizeFinishReason({ role: "assistant", stopReason: "error" }), "error");

      // 5. Tool call
      assert.equal(normalizeFinishReason({ role: "assistant", stopReason: "toolUse" }), "tool_call");
      assert.equal(
        normalizeFinishReason({
          role: "assistant",
          content: [{ type: "toolCall", id: "1", name: "read", args: {} }],
        }),
        "tool_call",
      );

      // 6. Missing / Unmapped / Unknown (Must FAIL-CLOSED to unknown, NOT stop)
      assert.equal(normalizeFinishReason({ role: "assistant" }), "unknown");
      assert.equal(normalizeFinishReason({ role: "assistant", stopReason: "" }), "unknown");
      assert.equal(normalizeFinishReason({ role: "assistant", stopReason: "random_unknown_reason" }), "unknown");
      assert.equal(normalizeFinishReason(null), "unknown");
      assert.equal(normalizeFinishReason({ role: "user", text: "hi" }), "unknown");
    });

    it("FinishReason Matrix: extractLastAssistantText must return empty when finishReason is not stop", () => {
      const normalMsg = [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Final result" }] },
      ];
      assert.equal(extractLastAssistantText(normalMsg), "Final result");

      const unknownMsg = [
        { role: "assistant", stopReason: "unmapped_reason", content: [{ type: "text", text: "Unsafe text" }] },
      ];
      assert.equal(extractLastAssistantText(unknownMsg), "", "Must return empty for unknown finishReason");

      const missingMsg = [
        { role: "assistant", content: [{ type: "text", text: "Text without stop reason" }] },
      ];
      assert.equal(extractLastAssistantText(missingMsg), "", "Must return empty for missing stop reason");
    });

    it("FinishReason Matrix: handleSubagentCompletion should route each finishReason to its correct terminal state", async () => {
      const manager = new SubagentManager(mockModelRuntime);

      // Helper to simulate handleSubagentCompletion with different last assistant message finishReasons
      async function runCompletionWithFinishReason(msgProps: Record<string, unknown>) {
        const mockSession = {
          messages: [
            { role: "user", content: [{ type: "text", text: "task" }] },
            { role: "assistant", content: [{ type: "text", text: "response text" }], ...msgProps },
          ],
          subscribe: () => {},
          prompt: async () => {},
          setModel: async () => {},
          setThinkingLevel: () => {},
          setActiveToolsByName: () => {},
          model: { provider: "mock", id: "mock-model" },
        };

        let reportedReportText = "";
        const task = await manager.spawn({
          parentSessionId: `parent-${Date.now()}-${Math.random()}`,
          parentCwd: gitRepoDir,
          role: "verifier",
          taskTitle: "Finish reason test",
          taskPrompt: "Test finish reason routing",
          customSession: mockSession,
          onReport: (_t, r) => {
            reportedReportText = r;
          },
        });

        await manager.handleSubagentCompletion(task.taskId);
        return { task, reportText: reportedReportText };
      }

      // 1. stop -> Normal completion (completed)
      const rStop = await runCompletionWithFinishReason({ stopReason: "stop" });
      assert.equal(rStop.task.status, "completed");
      assert.ok(rStop.reportText.includes('"completion_reason": "normal"'));

      // 2. error -> failed
      const rError = await runCompletionWithFinishReason({ stopReason: "error" });
      assert.equal(rError.task.status, "failed");
      assert.ok(rError.reportText.includes('"completion_reason": "error"'));

      // 3. cancelled -> failed / cancelled
      const rCancelled = await runCompletionWithFinishReason({ stopReason: "aborted" });
      assert.equal(rCancelled.task.status, "failed");
      assert.ok(rCancelled.reportText.includes('"completion_reason": "error"'));

      // 4. tool_call -> failed (abnormal exit with pending tool call)
      const rTool = await runCompletionWithFinishReason({
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "c1", name: "bash", args: {} }],
      });
      assert.equal(rTool.task.status, "failed");
      assert.ok(rTool.task.error?.includes("tool call was still pending"));

      // 5. unknown (missing stopReason) -> incomplete (fail-closed safe)
      const rUnknown = await runCompletionWithFinishReason({});
      assert.equal(rUnknown.task.status, "incomplete");
      assert.ok(rUnknown.task.error?.includes("could not be determined safely"));
      assert.ok(rUnknown.reportText.includes('"status": "incomplete"'));

      // 6. mkdir-only then empty/thinking-only stop is not a successful completion.
      {
        const mockSession = {
          messages: [
            { role: "user", content: [{ type: "text", text: "create four docs" }] },
            {
              role: "assistant",
              stopReason: "toolUse",
              content: [
                { type: "text", text: "Let me create the four main documents." },
                {
                  type: "toolCall",
                  id: "mkdir-1",
                  name: "bash",
                  arguments: { command: "mkdir -p docs/evidence/spike-20260901" },
                },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "mkdir-1",
              content: [{ type: "text", text: "(no output)" }],
              isError: false,
            },
            {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "thinking", thinking: "I'll write the files next..." }],
            },
          ],
          subscribe: () => {},
          prompt: async () => {},
          setModel: async () => {},
          setThinkingLevel: () => {},
          setActiveToolsByName: () => {},
          model: { provider: "mock", id: "mock-model" },
        };
        let reportText = "";
        const task = await manager.spawn({
          parentSessionId: `parent-premature-${Date.now()}`,
          parentCwd: gitRepoDir,
          role: "verifier",
          taskTitle: "premature mkdir stop",
          taskPrompt: "write four docs",
          customSession: mockSession,
          taskContract: {
            taskId: `task-premature-${Date.now()}`,
            parentSessionId: `parent-premature-${Date.now()}`,
            role: "verifier",
            goal: "write four docs",
            expectedEffects: ["artifact"],
            acceptanceCriteria: ["four docs exist"],
          },
          onReport: (_t, r) => {
            reportText = r;
          },
        });
        await manager.handleSubagentCompletion(task.taskId);
        assert.equal(task.status, "incomplete");
        assert.ok(!reportText.includes("（子任务执行完成）"));
        assert.ok(!reportText.includes('"completion_reason": "normal"'));
      }
    });

    it("error after successful write+report is treated as completed, not failed", async () => {
      const manager = new SubagentManager(mockModelRuntime);
      const mockSession = {
        messages: [
          { role: "user", content: [{ type: "text", text: "write file" }] },
          {
            role: "assistant",
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "w1",
                name: "write",
                arguments: { path: "docs/a.md", content: "# ok" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "w1",
            content: [{ type: "text", text: "Successfully wrote 4 bytes" }],
            isError: false,
          },
          {
            role: "assistant",
            stopReason: "error",
            content: [{ type: "text", text: "# 交付报告\n文件已写入。" }],
          },
        ],
        subscribe: () => {},
        prompt: async () => {},
        setModel: async () => {},
        setThinkingLevel: () => {},
        setActiveToolsByName: () => {},
        model: { provider: "mock", id: "mock-model" },
      };
      const task = await manager.spawn({
        parentSessionId: `parent-err-ok-${Date.now()}`,
        parentCwd: gitRepoDir,
        role: "verifier",
        taskTitle: "write then error",
        taskPrompt: "write file",
        customSession: mockSession,
        taskContract: {
          taskId: `task-err-ok-${Date.now()}`,
          parentSessionId: `parent-err-ok-${Date.now()}`,
          role: "verifier",
          goal: "write file",
          expectedEffects: ["artifact"],
        },
      });
      await manager.handleSubagentCompletion(task.taskId);
      assert.equal(task.status, "completed");
      assert.notEqual(task.status, "failed");
    });

    it("verification fail verdict is decoupled from the coordinator report (evidence only)", async () => {
      const manager = new SubagentManager(mockModelRuntime);
      const mockSession = {
        messages: [
          { role: "user", content: [{ type: "text", text: "run tests" }] },
          {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "" }],
          },
        ],
        subscribe: () => {},
        prompt: async () => {},
        setModel: async () => {},
        setThinkingLevel: () => {},
        setActiveToolsByName: () => {},
        model: { provider: "mock", id: "mock-model" },
      };
      let reportText = "";
      const task = await manager.spawn({
        parentSessionId: `parent-verfail-${Date.now()}`,
        parentCwd: gitRepoDir,
        role: "verifier",
        taskTitle: "no tests run",
        taskPrompt: "expected tests",
        customSession: mockSession,
        taskContract: {
          taskId: `task-verfail-${Date.now()}`,
          parentSessionId: `parent-verfail-${Date.now()}`,
          role: "verifier",
          goal: "run tests",
          expectedEffects: ["test_execution"],
        },
        onReport: (_t, r) => {
          reportText = r;
        },
      });
      await manager.handleSubagentCompletion(task.taskId);
      // May be completed with fail, or incomplete if empty-stop heuristics apply
      if (task.status === "completed") {
        // 质量判决仍在 task 对象上计算(供 DAG 依赖门用),但不再被编织进
        // 给 coordinator 的报告 —— 避免锚定其自主判断。
        assert.equal(task.verification?.overall, "fail");
        assert.ok(!reportText.includes("（子任务执行完成）"));
        // 报告不再携带 pass/fail 总判决,也不再用"验证未通过"结论化措辞。
        assert.ok(!reportText.includes("verification_failed"));
        assert.ok(!reportText.includes("验证未通过"));
        assert.ok(!reportText.includes('"overall"'));
        // 报告改用中性 completion_reason,并保留客观证据块(runtime_verification)。
        assert.ok(reportText.includes('"completion_reason": "normal"'));
        assert.ok(reportText.includes("runtime_verification"));
      }
    });

    it("pytest Command Recognition: should classify all pytest command variants as 'test'", () => {
      const commands = [
        "pytest",
        "pytest tests/",
        "python -m pytest",
        "python -m pytest test/specific.py",
        "python3 -m pytest",
        "/opt/anaconda3/envs/py39/bin/python -m pytest",
        "/usr/bin/python3 -m pytest tests/unit",
        "npm test",
        "npm run test",
        "pnpm test",
        "yarn test",
      ];

      for (const cmd of commands) {
        const purpose = classifyCommandPurpose(cmd);
        assert.equal(purpose, "test", `Command "${cmd}" should be classified as "test"`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 39. Task State Machine Lineage, Quality Gate & Auto-Finalize (Scenarios 1 - 12)
  // -------------------------------------------------------------------------

}

// Allow running standalone
if (process.argv[1] && process.argv[1].endsWith("verification-evidence.test.ts")) {
  describe("12, 38 Verification Improvements & Evidence", () => {
    let repo: { gitRepoDir: string; cleanup: () => void };
    before(() => {
      repo = setupTestGitRepo();
    });
    after(() => {
      repo.cleanup();
    });
    registerVerificationEvidenceTests(() => repo.gitRepoDir);
  });
}
