import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const testAgentDir = mkdtempSync(join(tmpdir(), "pi-integration-test-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

import {
  canonicalizePath,
  ConstraintResolver,
  getRoleDefinition,
  isPathContained,
  PromptAssembler,
  RoleRegistry,
  type RoleConfigV2,
  type TaskContract,
} from "../server/contracts/index.ts";
import { createCoordinatorExtension } from "../server/coordinator-tools.ts";
import { getRoleConfig, saveRolesConfig } from "../server/roles.ts";
import { buildSubagentUserPrompt, subagentTasks, SubagentManager } from "../server/subagent-manager.ts";
import { buildBoundedCompletionReport } from "../server/subagent-report.ts";
import { getSessionTurns, installTurnRecorderOnSession } from "../server/turn-recorder.ts";

describe("Pi Multi-Agent Runtime Integration Tests", () => {
  after(() => {
    try {
      rmSync(testAgentDir, { recursive: true, force: true });
    } catch {}
  });
  describe("1. Tool Assignment & Direct Session Configuration", () => {
    it("should configure active tools directly via session.setActiveToolsByName", async () => {
      let activeTools: string[] = [];
      const mockSession = {
        setActiveToolsByName(tools: string[]) {
          activeTools = tools;
        },
      };

      const resolved = ConstraintResolver.resolve({
        role: "verifier",
        cwd: "/tmp/project",
      });

      if (typeof mockSession.setActiveToolsByName === "function") {
        mockSession.setActiveToolsByName(resolved.runtime.activeTools);
      }

      assert.ok(activeTools.includes("read"));
      assert.ok(activeTools.includes("bash"));
      assert.ok(activeTools.includes("report_blocker"));
    });

    it("should dynamically transition active toolsets when roles switch", async () => {
      let activeTools: string[] = [];
      const mockSession = {
        setActiveToolsByName(tools: string[]) {
          activeTools = tools;
        },
      };

      // 1. 切换至 Coordinator (具备调度与 Direct Path 修改工具)
      const coordTools = ConstraintResolver.resolve({
        role: "coordinator",
        cwd: "/tmp/project",
      }).runtime.activeTools;
      mockSession.setActiveToolsByName(coordTools);
      assert.ok(activeTools.includes("spawn_subagent"));

      // 2. 切换至 Fullstack (包含开发写工具)
      const fullstackTools = ConstraintResolver.resolve({
        role: "developer",
        cwd: "/tmp/project",
      }).runtime.activeTools;
      mockSession.setActiveToolsByName(fullstackTools);
      assert.ok(activeTools.includes("edit") && activeTools.includes("write"));

      // 3. 切换至 Reviewer
      const reviewerTools = ConstraintResolver.resolve({
        role: "verifier",
        cwd: "/tmp/project",
      }).runtime.activeTools;
      mockSession.setActiveToolsByName(reviewerTools);
      assert.ok(activeTools.includes("read") && activeTools.includes("bash"));
    });
  });

  describe("2. Worktree Fail-Closed & TargetCwd Boundary Checks", () => {
    it("should fail-closed when requiresWorktree=true in a non-git directory", async () => {
      const mockModelRuntime = {} as any;
      const manager = new SubagentManager(mockModelRuntime);

      await assert.rejects(
        async () => {
          await manager.spawn({
            parentSessionId: "session-test",
            role: "developer",
            executionOptions: { requiresWorktree: true },
            taskTitle: "前端任务",
            taskPrompt: "实现按钮",
            parentCwd: "/tmp/non-git-dir-for-test-12345",
          });
        },
        /requires worktree isolation|requires a git repository/i,
      );
    });

    it("should fail-closed when targetCwd attempts to escape the root boundary", async () => {
      const mockModelRuntime = {} as any;
      const manager = new SubagentManager(mockModelRuntime);

      await assert.rejects(
        async () => {
          await manager.spawn({
            parentSessionId: "session-test",
            role: "default",
            taskTitle: "通用任务",
            taskPrompt: "做测试",
            parentCwd: "/tmp/project",
            targetCwd: "../../etc/passwd",
          });
        },
        /escapes the assigned worktree\/repo boundary/i,
      );
    });

    it("should fail-closed and reject invalid roles without silent fallback", async () => {
      const mockModelRuntime = {} as any;
      const manager = new SubagentManager(mockModelRuntime);

      await assert.rejects(
        async () => {
          await manager.spawn({
            parentSessionId: "session-test",
            role: "unknown_hack_role" as any,
            taskTitle: "非法角色",
            taskPrompt: "做测试",
            parentCwd: "/tmp/project",
          });
        },
        /Unknown or invalid role/i,
      );
    });

    it("should correctly validate path containment and prevent symlink escape", () => {
      assert.equal(isPathContained("/tmp/repo", "/tmp/repo/src/index.ts"), true);
      assert.equal(isPathContained("/tmp/repo", "/tmp/repo/../secret.txt"), false);
      assert.equal(isPathContained("/tmp/repo", "/etc/passwd"), false);
    });
  });

  describe("3. Unified Role Registry Persistence & V2 Single Source of Truth", () => {
    it("should sync UI modifications and preserve them across registry reloads", () => {
      const registry = RoleRegistry.getInstance();
      const devRole = registry.getRole("developer");

      // 修改配置
      const updated: RoleConfigV2 = {
        ...devRole,
        description: "已通过 UI 更新的开发者角色描述",
        allowedTools: ["read", "bash", "grep"],
        definition: {
          ...devRole.definition,
          description: "已通过 UI 更新的开发者角色描述",
          responsibilities: ["编写组件", "样式对齐", "页面调试"],
        },
      };

      saveRolesConfig([updated]);

      // 验证单一数据源立即同步
      const fetchedConfig = getRoleConfig("developer");
      const fetchedDef = getRoleDefinition("developer");

      assert.equal(fetchedConfig.description, "已通过 UI 更新的开发者角色描述");
      assert.equal(fetchedDef.description, "已通过 UI 更新的开发者角色描述");
      assert.deepEqual(fetchedDef.responsibilities, ["编写组件", "样式对齐", "页面调试"]);
      assert.deepEqual(fetchedConfig.allowedTools, ["read", "bash", "grep"]);
      assert.equal((fetchedDef as any).allowedTools, undefined, "RoleDefinition must not duplicate allowedTools");

      // 重新从磁盘载入
      registry.reload();
      assert.equal(registry.getRole("developer").description, "已通过 UI 更新的开发者角色描述");
      assert.deepEqual(registry.getDefinition("developer").responsibilities, ["编写组件", "样式对齐", "页面调试"]);
      assert.deepEqual(registry.getRole("developer").allowedTools, ["read", "bash", "grep"]);
      assert.equal((registry.getDefinition("developer") as any).allowedTools, undefined);
    });
  });

  describe("4. Subagent Task Stable Prefix + Kickoff Assembly", () => {
    it("keeps contract fields out of the ordinary kickoff history", () => {
      const contract: TaskContract = {
        taskId: "task-123",
        parentSessionId: "session-abc",
        role: "developer",
        goal: "重构登录体系保障安全性 (Goal)",
        scope: {
          include: ["src/components/Login.tsx"],
          exclude: ["src/legacy/**"],
        },
        acceptanceCriteria: ["通过单元测试", "支持密码遮罩"],
        contextFiles: ["src/types/auth.ts"],
        constraints: ["不得引入外部新状态库"],
      };

      const userPrompt = buildSubagentUserPrompt("请实现用户登录组件具体UI逻辑 (Task)", contract);
      assert.ok(userPrompt.includes("## Task Kickoff"));
      assert.ok(userPrompt.includes("assigned immutable Task Contract"));
      assert.equal(userPrompt.includes("请实现用户登录组件具体UI逻辑 (Task)"), false);
      assert.equal(userPrompt.includes("Initial instruction:"), false);
      assert.equal(userPrompt.includes("## Goal"), false);
      assert.equal(userPrompt.includes("## Scope"), false);
      const assembled = PromptAssembler.assemble(ConstraintResolver.resolve({
        role: "developer",
        cwd: process.cwd(),
        taskContract: contract,
      }));
      assert.ok(assembled.taskSystemPrompt.includes("重构登录体系保障安全性 (Goal)"));
      assert.ok(assembled.taskSystemPrompt.includes("src/components/Login.tsx"));
    });
  });

  describe("5. TurnRecorder & Coordinator Extension Lifecycle", () => {
    it("should capture tools from context.tools when recording session turns", async () => {
      const mockSession: any = {
        agent: {
          streamFn: async () => {},
        },
      };

      const testSessionId = `test-turn-${Date.now()}`;
      installTurnRecorderOnSession(mockSession, () => testSessionId);

      const fakeTools = [
        { name: "read", description: "Read file" },
        { name: "bash", description: "Execute bash" },
      ];

      await mockSession.agent.streamFn(
        { provider: "test", id: "test-model" },
        {
          systemPrompt: JSON.stringify({ role: "coordinator", test: true }),
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          tools: fakeTools,
        },
        { reasoning: "off" },
      );

      const turns = getSessionTurns(testSessionId);
      assert.ok(turns.length > 0);
      assert.equal(turns[0].tools.length, 2);
      assert.equal(turns[0].tools[0].name, "read");
      assert.equal(turns[0].tools[1].name, "bash");
      assert.equal(typeof turns[0].systemPrompt, "object");
      assert.equal((turns[0].systemPrompt as any).role, "coordinator");
    });

    it("should inject structured layered prompt in before_agent_start hook", async () => {
      const subagentManager = new SubagentManager({} as any);
      let capturedRole = "coordinator";
      const ext = createCoordinatorExtension(subagentManager, () => ({
        parentSessionId: "session-123",
        parentCwd: "/tmp/project",
        activeRole: capturedRole as any,
      }));

      const handlers = new Map<string, Function>();
      const mockPi: any = {
        registerTool: () => {},
        on: (event: string, handler: Function) => {
          handlers.set(event, handler);
        },
      };

      ext.factory(mockPi);
      const beforeStart = handlers.get("before_agent_start");
      assert.ok(beforeStart, "before_agent_start handler must be registered");

      // 1. Coordinator role
      const resCoordinator = await beforeStart({ systemPrompt: "base" });
      assert.ok(resCoordinator.systemPrompt);
      const parsed = JSON.parse(resCoordinator.systemPrompt);
      assert.equal(parsed.role, "coordinator");
      assert.ok(parsed.role_constraint.responsibilities.length > 0);
      assert.ok(parsed.role_constraint.instructions.includes("Delegation is optional"));

      // 2. Switch to developer role
      capturedRole = "developer";
      const resDeveloper = await beforeStart({ systemPrompt: "base" });
      const parsedDeveloper = JSON.parse(resDeveloper.systemPrompt);
      assert.equal(parsedDeveloper.role, "developer");
      assert.equal(parsedDeveloper.runtime_permissions, undefined, "runtime_permissions must NOT be present in prompt");

      // 3. Switch to default role (Standard Mode)
      capturedRole = "default";
      const resDefault = await beforeStart({ systemPrompt: "base" });
      assert.ok(resDefault.systemPrompt.includes("You are the primary software engineering agent in Pi Standard Mode"));
      assert.ok(resDefault.systemPrompt.includes("base"));
    });

    it("should verify Standard Mode does NOT duplicate behavior prompt across multiple turns", async () => {
      const subagentManager = new SubagentManager({} as any);
      const ext = createCoordinatorExtension(subagentManager, () => ({
        parentSessionId: "session-multi-turn",
        parentCwd: "/tmp/project",
        activeRole: "default",
      }));

      const handlers = new Map<string, Function>();
      const mockPi: any = {
        registerTool: () => {},
        on: (event: string, handler: Function) => {
          handlers.set(event, handler);
        },
      };

      ext.factory(mockPi);
      const beforeStart = handlers.get("before_agent_start");
      assert.ok(beforeStart);

      // Turn 1: 初始原生 base prompt
      const turn1 = await beforeStart({ systemPrompt: "Pi Native Base Prompt\nTools & Guidelines" });
      assert.ok(turn1.systemPrompt.includes("You are the primary software engineering agent in Pi Standard Mode"));

      // Turn 2: 第二轮传入上一轮已经合成的 systemPrompt
      const turn2 = await beforeStart({ systemPrompt: turn1.systemPrompt });

      // Turn 3: 第三轮再次触发
      const turn3 = await beforeStart({ systemPrompt: turn2.systemPrompt });

      // 验证 Standard Mode Behavior 在多轮后仍然只出现恰好一次
      const targetPhrase = "You are the primary software engineering agent in Pi Standard Mode";
      const matches = turn3.systemPrompt.split(targetPhrase).length - 1;
      assert.equal(matches, 1, `Expected target phrase to appear exactly 1 time in systemPrompt, but found ${matches} times`);
      assert.ok(turn3.systemPrompt.includes("Pi Native Base Prompt\nTools & Guidelines"));
    });
  });

  describe("6. Subagent Terminal State onReport & Lifecycle Isolation", () => {
    it("should actively call onReport exactly once when subagent execution fails", async () => {
      const subagentManager = new SubagentManager({} as any);
      let reportCallCount = 0;
      let reportedText = "";
      let reportedStatus = "";

      const taskId = `task-mock-fail-${Date.now()}`;
      const mockTask: UISubagentTask = {
        taskId,
        parentSessionId: "session-parent-1",
        role: "developer",
        taskTitle: "失败测试任务",
        taskPrompt: "触发错误",
        status: "running",
        createdAt: new Date().toISOString(),
      };

      const instance: any = {
        task: mockTask,
        onReport: (t: UISubagentTask, text: string) => {
          reportCallCount++;
          reportedText = text;
          reportedStatus = t.status;
        },
      };

      subagentTasks.set(taskId, instance);

      // 模拟 session.prompt 异常触发的 catch 路径
      const err = new Error("Simulated prompt rate limit failure");
      instance.reported = true;
      mockTask.status = "failed";
      mockTask.error = String(err.message);
      mockTask.completedAt = new Date().toISOString();
      mockTask.summary = `执行异常终止: ${mockTask.error}`;
      mockTask.taskResult = {
        taskId: mockTask.taskId,
        role: mockTask.role,
        status: "failed",
        summary: mockTask.summary,
        completedAt: mockTask.completedAt,
        meta: { error: mockTask.error },
      };

      const roleConfig = getRoleConfig(mockTask.role);
      const report = buildBoundedCompletionReport({
        taskId: mockTask.taskId,
        taskTitle: mockTask.taskTitle,
        role: mockTask.role,
        roleName: roleConfig.name,
        branch: mockTask.branchName,
        status: "failed",
        error: mockTask.error,
        completedAt: mockTask.completedAt,
        lastAssistantText: mockTask.summary,
        taskResult: mockTask.taskResult,
      });

      instance.onReport(mockTask, report.parentReport);

      // 验证防重复上报：再次调用 abort 或 handleSubagentCompletion 不应重复触发
      const abortRes = await subagentManager.abort(taskId);
      assert.equal(abortRes, false);
      assert.equal(reportCallCount, 1, "Terminal onReport must be called exactly once");
      assert.equal(reportedStatus, "failed");
      assert.ok(reportedText.includes('"status": "failed"'));
      assert.ok(reportedText.includes("Simulated prompt rate limit failure"));
    });

    it("should pass real UISubagentTask object instead of TaskContract to onReport when report_blocker is called", async () => {
      let reportedTask: any = null;
      let reportedReportText = "";

      const taskId = `task-blocker-${Date.now()}`;
      const mockTask: UISubagentTask = {
        taskId,
        parentSessionId: "session-parent-blocker",
        role: "developer",
        taskTitle: "前端阻塞任务",
        taskPrompt: "实现组件",
        status: "running",
        createdAt: new Date().toISOString(),
        logs: ["log line 1"],
      };

      const mockOnReport = (t: UISubagentTask, text: string) => {
        reportedTask = t;
        reportedReportText = text;
      };

      // 模拟 report_blocker 的工具执行逻辑
      const severityTag = "[BLOCKING] ";
      const blockerMessage = "依赖的后端接口缺少 user_id 字段";
      const blockerContext = "src/api/user.ts:45";

      mockOnReport(
        mockTask,
        `[Subagent 报告阻塞] 角色 ${mockTask.role} 上报: ${severityTag}${blockerMessage}\n上下文: ${blockerContext}`,
      );

      // 验证传给 onReport 的是真实 UISubagentTask，拥有状态与运行时字段，而非仅 TaskContract
      assert.ok(reportedTask);
      assert.equal(reportedTask.taskId, taskId);
      assert.equal(reportedTask.status, "running");
      assert.equal(reportedTask.role, "developer");
      assert.equal(reportedTask.taskTitle, "前端阻塞任务");
      assert.deepEqual(reportedTask.logs, ["log line 1"]);
      assert.ok(reportedReportText.includes("[BLOCKING] 依赖的后端接口缺少 user_id 字段"));
    });

    it("Test 1: agent_end arrives during abort, abort subsequently fails (pending completed replay)", async () => {
      const subagentManager = new SubagentManager({} as any);
      let reportCallCount = 0;
      let reportedStatus = "";
      let reportedText = "";

      const taskId = `task-race-end-fail-${Date.now()}`;
      const mockTask: UISubagentTask = {
        taskId,
        parentSessionId: "session-parent-race-1",
        role: "developer",
        taskTitle: "竞态恢复测试1",
        taskPrompt: "处理数据",
        status: "running",
        createdAt: new Date().toISOString(),
      };

      const mockSession = {
        abort: async () => {
          // 模拟在 abort 执行中，agent_end 事件到达
          await subagentManager.handleSubagentCompletion(taskId);
          // 随后 session.abort 抛出异常失败
          throw new Error("Simulated session abort timeout failure");
        },
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "数据处理完毕，自测通过。" }],
          },
        ],
      };

      const instance: any = {
        task: mockTask,
        runtime: { session: mockSession },
        onReport: (t: UISubagentTask, text: string) => {
          reportCallCount++;
          reportedStatus = t.status;
          reportedText = text;
        },
      };

      subagentTasks.set(taskId, instance);

      // 调用 abort（其内部会在 abort 期间触发 handleSubagentCompletion 并最终 abort 失败）
      const abortResult = await subagentManager.abort(taskId);

      // 验证：abort 失败返回 false，但自动 replay 了 pending completion，进入 completed 状态
      assert.equal(abortResult, false, "abort() should return false on rejection");
      assert.equal(mockTask.status, "completed", "Task status must recover to completed via pending replay");
      assert.equal(reportedStatus, "completed");
      assert.equal(reportCallCount, 1, "Exactly 1 completion report must be sent");
      assert.equal(instance.reported, true);
      assert.equal(instance.pendingTerminal, undefined);
      assert.ok(reportedText.includes('"status": "completed"'));
    });

    it("Test 2: failed arrives during abort, abort subsequently fails (pending failed replay)", async () => {
      const subagentManager = new SubagentManager({} as any);
      let reportCallCount = 0;
      let reportedStatus = "";
      let reportedText = "";

      const taskId = `task-race-error-fail-${Date.now()}`;
      const mockTask: UISubagentTask = {
        taskId,
        parentSessionId: "session-parent-race-2",
        role: "developer",
        taskTitle: "竞态恢复测试2",
        taskPrompt: "构建UI",
        status: "running",
        createdAt: new Date().toISOString(),
      };

      const mockSession = {
        abort: async () => {
          // 模拟在 abort 执行中，prompt catch 异常触发
          const inst = subagentTasks.get(taskId)!;
          inst.pendingTerminal = {
            type: "failed",
            error: "Simulated prompt rate limit 429",
          };
          // 随后 session.abort 抛出异常失败
          throw new Error("Simulated abort socket closed");
        },
        messages: [],
      };

      const instance: any = {
        task: mockTask,
        runtime: { session: mockSession },
        onReport: (t: UISubagentTask, text: string) => {
          reportCallCount++;
          reportedStatus = t.status;
          reportedText = text;
        },
      };

      subagentTasks.set(taskId, instance);

      const abortResult = await subagentManager.abort(taskId);

      assert.equal(abortResult, false);
      assert.equal(mockTask.status, "failed");
      assert.equal(reportedStatus, "failed");
      assert.equal(reportCallCount, 1);
      assert.equal(mockTask.error, "Simulated prompt rate limit 429");
      assert.ok(reportedText.includes('"status": "failed"'));
      assert.ok(reportedText.includes("Simulated prompt rate limit 429"));
      assert.equal(instance.reported, true);
      assert.equal(instance.pendingTerminal, undefined);
    });

    it("Test 3: agent_end arrives during abort, abort succeeds (aborted wins)", async () => {
      const subagentManager = new SubagentManager({} as any);
      let reportCallCount = 0;
      let reportedStatus = "";
      let reportedText = "";

      const taskId = `task-race-end-success-${Date.now()}`;
      const mockTask: UISubagentTask = {
        taskId,
        parentSessionId: "session-parent-race-3",
        role: "developer",
        taskTitle: "竞态成功测试3",
        taskPrompt: "耗时操作",
        status: "running",
        createdAt: new Date().toISOString(),
      };

      const mockSession = {
        abort: async () => {
          // 在 abort 中 handleSubagentCompletion 到达
          await subagentManager.handleSubagentCompletion(taskId);
        },
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "已提前结束。" }],
          },
        ],
      };

      const instance: any = {
        task: mockTask,
        runtime: { session: mockSession },
        onReport: (t: UISubagentTask, text: string) => {
          reportCallCount++;
          reportedStatus = t.status;
          reportedText = text;
        },
      };

      subagentTasks.set(taskId, instance);

      const abortResult = await subagentManager.abort(taskId);
      assert.equal(abortResult, true);
      assert.equal(mockTask.status, "aborted");
      assert.equal(reportedStatus, "aborted");
      assert.equal(reportCallCount, 1);
      assert.ok(reportedText.includes('"status": "aborted"'));
      assert.equal(instance.reported, true);
      assert.equal(instance.pendingTerminal, undefined);

      // 随后任何 handleSubagentCompletion 不应再次触发
      await subagentManager.handleSubagentCompletion(taskId);
      assert.equal(reportCallCount, 1);
    });

    it("Test 4: failed arrives during abort, abort succeeds (aborted wins)", async () => {
      const subagentManager = new SubagentManager({} as any);
      let reportCallCount = 0;
      let reportedStatus = "";
      let reportedText = "";

      const taskId = `task-race-error-success-${Date.now()}`;
      const mockTask: UISubagentTask = {
        taskId,
        parentSessionId: "session-parent-race-4",
        role: "verifier",
        taskTitle: "竞态成功测试4",
        taskPrompt: "执行测试",
        status: "running",
        createdAt: new Date().toISOString(),
      };

      const mockSession = {
        abort: async () => {
          // 在 abort 过程中发生 prompt 错误
          const inst = subagentTasks.get(taskId)!;
          inst.pendingTerminal = {
            type: "failed",
            error: "Model connection reset",
          };
        },
        messages: [],
      };

      const instance: any = {
        task: mockTask,
        runtime: { session: mockSession },
        onReport: (t: UISubagentTask, text: string) => {
          reportCallCount++;
          reportedStatus = t.status;
          reportedText = text;
        },
      };

      subagentTasks.set(taskId, instance);

      const abortResult = await subagentManager.abort(taskId);
      assert.equal(abortResult, true);
      assert.equal(mockTask.status, "aborted");
      assert.equal(reportedStatus, "aborted");
      assert.equal(reportCallCount, 1);
      assert.ok(reportedText.includes('"status": "aborted"'));
      assert.equal(instance.reported, true);
      assert.equal(instance.pendingTerminal, undefined);
    });
  });

  describe("7. Subagent Execution Duration & Timing Tracking", () => {
    it("should compute accurate durationMs on normal task completion and propagate to taskResult and report", async () => {
      const subagentManager = new SubagentManager({} as any);
      const taskId = `task-duration-success-${Date.now()}`;
      const startTime = new Date(Date.now() - 5500).toISOString();
      const mockTask: UISubagentTask = {
        taskId,
        parentSessionId: "session-duration-1",
        role: "verifier",
        taskTitle: "耗时统计成功测试",
        taskPrompt: "执行单元测试",
        status: "running",
        createdAt: startTime,
        startedAt: startTime,
        logs: [],
        messages: [],
      };

      const mockSession = {
        messages: [
          { role: "user", content: "执行测试" },
          { role: "assistant", content: "所有测试已通过" },
        ],
      };

      let reportedReport = "";
      const instance: any = {
        task: mockTask,
        runtime: { session: mockSession },
        onReport: (_t: UISubagentTask, text: string) => {
          reportedReport = text;
        },
      };

      subagentTasks.set(taskId, instance);

      await subagentManager.handleSubagentCompletion(taskId);

      assert.ok(mockTask.completedAt, "completedAt should be defined");
      assert.ok(mockTask.durationMs !== undefined, "durationMs should be recorded");
      assert.ok(mockTask.durationMs >= 5000, `durationMs should be at least 5000ms, got ${mockTask.durationMs}`);
      assert.equal(mockTask.taskResult?.durationMs, mockTask.durationMs);
      assert.equal(mockTask.taskResult?.startedAt, startTime);
      assert.ok(reportedReport.includes('"duration_ms"'), "Report metadata should contain duration_ms");
    });

    it("should compute accurate durationMs on abort and record startedAt and completedAt", async () => {
      const subagentManager = new SubagentManager({} as any);
      const taskId = `task-duration-abort-${Date.now()}`;
      const startTime = new Date(Date.now() - 3200).toISOString();
      const mockTask: UISubagentTask = {
        taskId,
        parentSessionId: "session-duration-2",
        role: "developer",
        taskTitle: "耗时统计中断测试",
        taskPrompt: "执行开发",
        status: "running",
        createdAt: startTime,
        startedAt: startTime,
        logs: [],
        messages: [],
      };

      const mockSession = {
        abort: async () => {},
        messages: [],
      };

      let reportedReport = "";
      const instance: any = {
        task: mockTask,
        runtime: { session: mockSession },
        onReport: (_t: UISubagentTask, text: string) => {
          reportedReport = text;
        },
      };

      subagentTasks.set(taskId, instance);

      const abortSuccess = await subagentManager.abort(taskId);
      assert.equal(abortSuccess, true);
      assert.equal(mockTask.status, "aborted");
      assert.ok(mockTask.completedAt, "completedAt should be defined on abort");
      assert.ok(mockTask.durationMs !== undefined, "durationMs should be defined on abort");
      assert.ok(mockTask.durationMs >= 3000, `durationMs should be at least 3000ms, got ${mockTask.durationMs}`);
      assert.equal(mockTask.taskResult?.durationMs, mockTask.durationMs);
      assert.ok(reportedReport.includes('"duration_ms"'), "Abort report metadata should include duration_ms");
    });
  });
});
