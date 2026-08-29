import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  canonicalizePath,
  ConstraintResolver,
  DEFAULT_PERMISSION_PROFILES,
  getPermissionProfile,
  getRoleDefinition,
  isPathContained,
  RoleRegistry,
  RuntimeEnforcer,
  validateFilePathPermission,
  type EffectiveRuntimePermission,
  type RoleConfigV2,
  type TaskContract,
} from "../server/contracts/index.ts";
import { createCoordinatorExtension } from "../server/coordinator-tools.ts";
import { getRoleConfig, saveRolesConfig } from "../server/roles.ts";
import { parseTaskResultFromText, SubagentManager } from "../server/subagent-manager.ts";
import { getSessionTurns, installTurnRecorderOnSession } from "../server/turn-recorder.ts";
import { getWorktreeDiff } from "../server/worktree.ts";

describe("Pi Multi-Agent Runtime Integration Tests", () => {
  describe("1. Real Tool Execution Pipeline Hook (beforeToolCall)", () => {
    it("should intercept edit and write tool calls via session.agent.beforeToolCall for readonly roles", async () => {
      const permission: EffectiveRuntimePermission = {
        profileId: "custom-readonly",
        allowedTools: ["read", "bash"],
        writableScope: "none",
        writablePaths: [],
        requiresWorktree: false,
        isWorktree: false,
      };

      // 模拟 Pi AgentSession 运行时实例
      let activeTools: string[] = [];
      const mockSession = {
        setActiveToolsByName(tools: string[]) {
          activeTools = tools;
        },
        agent: {
          beforeToolCall: undefined as any,
        },
      };

      // 挂载运行时权限与拦截钩子
      RuntimeEnforcer.applyPermissionsToSession(mockSession, permission);

      assert.deepEqual(activeTools, ["read", "bash"]);
      assert.equal(typeof mockSession.agent.beforeToolCall, "function");

      // 1. 测试 edit 调用被拦截
      const editResult = await mockSession.agent.beforeToolCall({
        toolCall: { name: "edit", id: "call-1" },
        args: { path: "/tmp/project/src/index.ts" },
      });
      assert.equal(editResult?.block, true);
      assert.ok(editResult?.reason?.includes("白名单") || editResult?.reason?.includes("只读"));

      // 2. 测试 bash 写命令 (rm/git commit/重定向/eval 脚本) 被硬拦截
      const bashWriteResult = await mockSession.agent.beforeToolCall({
        toolCall: { name: "bash", id: "call-2" },
        args: { command: "git commit -m 'fix: test'" },
      });
      assert.equal(bashWriteResult?.block, true);
      assert.ok(bashWriteResult?.reason?.includes("只读角色"));

      const bashRedirectResult = await mockSession.agent.beforeToolCall({
        toolCall: { name: "bash", id: "call-3" },
        args: { command: "echo 'hacked' > src/index.ts" },
      });
      assert.equal(bashRedirectResult?.block, true);
      assert.ok(bashRedirectResult?.reason?.includes("只读角色"));

      const bashEvalResult = await mockSession.agent.beforeToolCall({
        toolCall: { name: "bash", id: "call-3b" },
        args: { command: "node -e 'fs.writeFileSync(\"hack.js\", \"\")'" },
      });
      assert.equal(bashEvalResult?.block, true);
      assert.ok(bashEvalResult?.reason?.includes("eval"));

      // 3. 测试 read 工具正常通过
      const readResult = await mockSession.agent.beforeToolCall({
        toolCall: { name: "read", id: "call-4" },
        args: { path: "/tmp/project/src/index.ts" },
      });
      assert.equal(readResult, undefined); // undefined 代表放行
    });

    it("should dynamically transition permissions without wrapper accumulation: Readonly -> Fullstack -> Custom Readonly", async () => {
      const mockSession = {
        setActiveToolsByName(_tools: string[]) {},
        agent: {
          beforeToolCall: undefined as any,
        },
      };

      const readonlyPerm: EffectiveRuntimePermission = {
        profileId: "test-readonly",
        allowedTools: ["read", "bash"],
        writableScope: "none",
        writablePaths: [],
        requiresWorktree: false,
        isWorktree: false,
      };

      // 1. 切换至 Readonly
      RuntimeEnforcer.applyPermissionsToSession(mockSession, readonlyPerm);

      const coordWrite = await mockSession.agent.beforeToolCall({
        toolCall: { name: "write", id: "c-1" },
        args: { TargetFile: "/tmp/project/src/App.tsx" },
      });
      assert.equal(coordWrite?.block, true, "Readonly must NOT be allowed to write");

      // 2. 切换至 Fullstack (标准开发写权限)
      const fullstackPerm = ConstraintResolver.resolve({
        role: "fullstack",
        cwd: "/tmp/project",
      }).permission;
      RuntimeEnforcer.applyPermissionsToSession(mockSession, fullstackPerm);

      const fullstackWrite = await mockSession.agent.beforeToolCall({
        toolCall: { name: "write", id: "c-2" },
        args: { TargetFile: "/tmp/project/src/App.tsx" },
      });
      assert.equal(fullstackWrite, undefined, "Fullstack MUST be allowed to write");

      // 3. 切换回 Readonly
      RuntimeEnforcer.applyPermissionsToSession(mockSession, readonlyPerm);

      const reviewerWrite = await mockSession.agent.beforeToolCall({
        toolCall: { name: "write", id: "c-3" },
        args: { TargetFile: "/tmp/project/src/App.tsx" },
      });
      assert.equal(reviewerWrite?.block, true, "Readonly MUST be blocked from writing");
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
            role: "junior_fe",
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

    it("should refuse automatic mkdir when targetCwd does not exist on readonly role", async () => {
      const mockModelRuntime = {} as any;
      const manager = new SubagentManager(mockModelRuntime);

      await assert.rejects(
        async () => {
          await manager.spawn({
            parentSessionId: "session-test",
            role: "reviewer",
            executionOptions: { writableScope: "none" },
            taskTitle: "审查任务",
            taskPrompt: "做审查",
            parentCwd: "/tmp/project",
            targetCwd: `non-existent-subfolder-${Date.now()}`,
          });
        },
        /Refusing automatic directory creation/i,
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

    it("should prevent parent symlink escape for non-existent new files by resolving nearest existing ancestor", () => {
      const tempBase = join(tmpdir(), `pi-symlink-test-${Date.now()}`);
      const repoDir = join(tempBase, "repo");
      const outsideDir = join(tempBase, "outside_secret");
      mkdirSync(repoDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });

      const symlinkPath = join(repoDir, "symlink_to_outside");
      try {
        symlinkSync(outsideDir, symlinkPath, "dir");
      } catch {
        /* ignore */
      }

      if (existsSync(symlinkPath)) {
        const nonExistentTarget = join(symlinkPath, "nested", "new_file.txt");
        const isContained = isPathContained(repoDir, nonExistentTarget);
        assert.equal(isContained, false, "Target through parent symlink MUST NOT be contained in repo");

        const worktreePerm: EffectiveRuntimePermission = {
          profileId: "frontend-standard",
          allowedTools: ["read", "bash", "edit", "write"],
          writableScope: "worktree-only",
          worktreePath: repoDir,
          writablePaths: [repoDir],
          requiresWorktree: true,
          isWorktree: true,
        };

        const check = validateFilePathPermission(worktreePerm, nonExistentTarget);
        assert.equal(check.allowed, false);
        assert.ok(check.reason?.includes("Symlink 逃逸") || check.reason?.includes("越界"));
      }

      rmSync(tempBase, { recursive: true, force: true });
    });
  });

  describe("3. Unified Role Registry Persistence & V2 Single Source of Truth", () => {
    it("should sync UI modifications and preserve them across registry reloads", () => {
      const registry = RoleRegistry.getInstance();
      const feRole = registry.getRole("junior_fe");

      // 修改配置
      const updated: RoleConfigV2 = {
        ...feRole,
        description: "已通过 UI 更新的前端角色描述",
        definition: {
          ...feRole.definition,
          description: "已通过 UI 更新的前端角色描述",
          responsibilities: ["编写组件", "样式对齐", "页面调试"],
        },
      };

      saveRolesConfig([updated]);

      // 验证单一数据源立即同步
      const fetchedConfig = getRoleConfig("junior_fe");
      const fetchedDef = getRoleDefinition("junior_fe");

      assert.equal(fetchedConfig.description, "已通过 UI 更新的前端角色描述");
      assert.equal(fetchedDef.description, "已通过 UI 更新的前端角色描述");
      assert.deepEqual(fetchedDef.responsibilities, ["编写组件", "样式对齐", "页面调试"]);

      // 重新从磁盘载入
      registry.reload();
      assert.equal(registry.getRole("junior_fe").description, "已通过 UI 更新的前端角色描述");
      assert.deepEqual(registry.getDefinition("junior_fe").responsibilities, ["编写组件", "样式对齐", "页面调试"]);
    });
  });

  describe("4. TaskResult Machine-Readable Protocol & Abort Lifecycle", () => {
    it("should parse structured <task_result> block from assistant output", () => {
      const sampleText = `
任务已完成！以下是执行详情：
<task_result>
{
  "status": "completed",
  "summary": "成功实现用户登录组件并完成单元测试",
  "verification": [
    {
      "kind": "test",
      "command": "npm test",
      "status": "passed",
      "summary": "12 tests passed"
    }
  ],
  "reviewReport": {
    "verdict": "APPROVE"
  }
}
</task_result>
`;

      const parsed = parseTaskResultFromText(
        sampleText,
        "task-123",
        "junior_fe",
        ["src/Login.tsx"],
        "commit-sha-123",
      );

      assert.ok(parsed);
      assert.equal(parsed?.status, "completed");
      assert.equal(parsed?.summary, "成功实现用户登录组件并完成单元测试");
      assert.equal(parsed?.verification?.length, 1);
      assert.equal(parsed?.verification?.[0].status, "passed");
      assert.equal(parsed?.reviewReport?.verdict, "APPROVE");
    });
  });

  describe("5. Permission Profile Fail-Closed Verification", () => {
    it("should throw error and fail-closed on unknown permission profile", () => {
      assert.throws(
        () => getPermissionProfile("non-existent-profile-xyz"),
        /Unknown permission profile ID/i,
      );
    });
  });

  describe("6. TurnRecorder & Coordinator Extension Lifecycle", () => {
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
      assert.ok(parsed.role_constraint.instructions.includes("DISCOVER"));

      // 2. Switch to fullstack role
      capturedRole = "fullstack";
      const resFullstack = await beforeStart({ systemPrompt: "base" });
      const parsedFullstack = JSON.parse(resFullstack.systemPrompt);
      assert.equal(parsedFullstack.role, "fullstack");
      assert.equal(parsedFullstack.runtime_permissions.writable_scope, "all");
    });
  });
});
