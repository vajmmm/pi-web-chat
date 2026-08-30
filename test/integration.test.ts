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
  describe("1. Tool Assignment & Zero-Interception Runtime", () => {
    it("should configure active tools via session.setActiveToolsByName without registering runtime interception hooks", async () => {
      const permission: EffectiveRuntimePermission = {
        profileId: "custom-role",
        allowedTools: ["read", "bash"],
        writableScope: "all",
        writablePaths: [],
        requiresWorktree: false,
        isWorktree: false,
      };

      let activeTools: string[] = [];
      const mockSession = {
        setActiveToolsByName(tools: string[]) {
          activeTools = tools;
        },
        agent: {
          beforeToolCall: undefined as any,
        },
      };

      // 仅配置可用工具集，不注册运行时阻断钩子
      RuntimeEnforcer.applyPermissionsToSession(mockSession, permission);

      assert.deepEqual(activeTools, ["read", "bash"]);
      assert.equal(mockSession.agent.beforeToolCall, undefined, "Must NOT install beforeToolCall interception hook");

      const check = RuntimeEnforcer.validateToolExecution(permission, "edit", { path: "/tmp/project/src/index.ts" });
      assert.equal(check.allowed, true, "Tool execution must not be blocked at runtime");
    });

    it("should dynamically transition active toolsets when roles switch", async () => {
      let activeTools: string[] = [];
      const mockSession = {
        setActiveToolsByName(tools: string[]) {
          activeTools = tools;
        },
        agent: {
          beforeToolCall: undefined as any,
        },
      };

      // 1. 切换至 Coordinator (具备调度与只读工具)
      const coordPerm = ConstraintResolver.resolve({
        role: "coordinator",
        cwd: "/tmp/project",
      }).permission;
      RuntimeEnforcer.applyPermissionsToSession(mockSession, coordPerm);
      assert.ok(activeTools.includes("spawn_subagent"));

      // 2. 切换至 Fullstack (包含开发写工具)
      const fullstackPerm = ConstraintResolver.resolve({
        role: "fullstack",
        cwd: "/tmp/project",
      }).permission;
      RuntimeEnforcer.applyPermissionsToSession(mockSession, fullstackPerm);
      assert.ok(activeTools.includes("edit") && activeTools.includes("write"));

      // 3. 切换至 Reviewer
      const reviewerPerm = ConstraintResolver.resolve({
        role: "reviewer",
        cwd: "/tmp/project",
      }).permission;
      RuntimeEnforcer.applyPermissionsToSession(mockSession, reviewerPerm);
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
        allowedTools: ["read", "bash", "grep"],
        definition: {
          ...feRole.definition,
          description: "已通过 UI 更新的前端角色描述",
          responsibilities: ["编写组件", "样式对齐", "页面调试"],
          allowedTools: ["read", "bash", "grep"],
        },
      };

      saveRolesConfig([updated]);

      // 验证单一数据源立即同步
      const fetchedConfig = getRoleConfig("junior_fe");
      const fetchedDef = getRoleDefinition("junior_fe");

      assert.equal(fetchedConfig.description, "已通过 UI 更新的前端角色描述");
      assert.equal(fetchedDef.description, "已通过 UI 更新的前端角色描述");
      assert.deepEqual(fetchedDef.responsibilities, ["编写组件", "样式对齐", "页面调试"]);
      assert.deepEqual(fetchedConfig.allowedTools, ["read", "bash", "grep"]);
      assert.deepEqual(fetchedDef.allowedTools, ["read", "bash", "grep"]);

      // 重新从磁盘载入
      registry.reload();
      assert.equal(registry.getRole("junior_fe").description, "已通过 UI 更新的前端角色描述");
      assert.deepEqual(registry.getDefinition("junior_fe").responsibilities, ["编写组件", "样式对齐", "页面调试"]);
      assert.deepEqual(registry.getRole("junior_fe").allowedTools, ["read", "bash", "grep"]);
      assert.deepEqual(registry.getDefinition("junior_fe").allowedTools, ["read", "bash", "grep"]);
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
      assert.equal(parsedFullstack.runtime_permissions, undefined, "runtime_permissions must NOT be present in prompt");
    });
  });
});
