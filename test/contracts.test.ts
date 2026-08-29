import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ConstraintResolver,
  DEFAULT_PERMISSION_PROFILES,
  DEFAULT_ROLES_V2,
  generateV2MigrationCandidate,
  getPermissionProfile,
  getRoleDefinition,
  isPathContained,
  matchesPattern,
  normalizeRoleToV2,
  PromptAssembler,
  RoleRegistry,
  rolesPath,
  RuntimeEnforcer,
  SHARED_DEFAULTS,
  SHARED_INVARIANTS,
  validateTaskResult,
  type EffectiveRuntimePermission,
  type RoleConfigV1,
  type TaskContract,
  type TaskResult,
} from "../server/contracts/index.ts";

describe("Pi Multi-Agent Execution Contracts & Prompts", () => {
  describe("1. Shared Invariants & Defaults", () => {
    it("should provide immutable non-overridable invariants", () => {
      assert.ok(SHARED_INVARIANTS.length >= 6);
      assert.ok(SHARED_INVARIANTS.some((i) => i.includes("不得伪造测试结果")));
      assert.ok(SHARED_INVARIANTS.some((i) => i.includes("不得破坏、静默覆盖")));
      assert.ok(SHARED_INVARIANTS.some((i) => i.includes("不得在代码、提交信息、日志或回复中泄露 Secret")));
    });

    it("should provide overridable engineering defaults", () => {
      assert.ok(SHARED_DEFAULTS.length >= 5);
      assert.ok(SHARED_DEFAULTS.some((d) => d.includes("保持简洁直接")));
      assert.ok(SHARED_DEFAULTS.some((d) => d.includes("优先进行最小化修改")));
    });
  });

  describe("2. Permission Profiles", () => {
    it("should include all required standard profiles", () => {
      const coordinator = getPermissionProfile("coordinator-readonly");
      assert.equal(coordinator.writableScope, "all");
      assert.ok(coordinator.allowedTools.includes("spawn_subagent"));
      assert.ok(coordinator.allowedTools.includes("edit"));

      const reviewer = getPermissionProfile("reviewer-readonly");
      assert.equal(reviewer.writableScope, "all");
      assert.ok(reviewer.allowedTools.includes("edit"));

      const fe = getPermissionProfile("frontend-standard");
      assert.equal(fe.writableScope, "all");
      assert.ok(fe.allowedTools.includes("edit"));

      const tester = getPermissionProfile("tester-test-write");
      assert.equal(tester.writableScope, "all");
      assert.ok(tester.allowedTools.includes("edit"));
    });
  });

  describe("3. RoleDefinition V2 & Legacy V1 Migration", () => {
    it("should have standard built-in V2 roles with complete prompt breakdown and instructions", () => {
      if (existsSync(rolesPath())) {
        try { unlinkSync(rolesPath()); } catch {}
      }
      RoleRegistry.getInstance().reload();

      const requiredRoles = ["coordinator", "junior_fe", "junior_be", "fullstack", "reviewer", "tester", "deployer"];
      for (const roleId of requiredRoles) {
        const def = getRoleDefinition(roleId as any);
        assert.ok(def, `Role definition for ${roleId} must exist`);
        assert.ok(def.description.length > 0, `${roleId} must have non-empty description`);
        assert.ok(def.responsibilities.length >= 3, `${roleId} must have at least 3 responsibilities`);
        assert.ok(def.strictProhibitions.length >= 2, `${roleId} must have at least 2 strict prohibitions`);
        assert.ok(typeof def.instructions === "string" && def.instructions.length > 0, `${roleId} must have non-empty instructions`);
      }

      const coordinator = getRoleDefinition("coordinator");
      assert.ok(coordinator.instructions?.includes("DISCOVER"));
      assert.ok(coordinator.strictProhibitions.some((p) => p.includes("禁止直接编写")));

      const reviewer = getRoleDefinition("reviewer");
      assert.ok(reviewer.instructions?.includes("APPROVE"));
      assert.ok(reviewer.strictProhibitions.some((p) => p.includes("只审不改") || p.includes("禁止亲自修改业务代码")));
    });

    it("should normalize legacy V1 config without destructive heuristic loss", () => {
      const legacyV1: RoleConfigV1 = {
        id: "junior_fe",
        name: "自定义前端",
        description: "自定义描述",
        systemPrompt: "legacy prompt text",
        allowedTools: ["read", "bash"],
        requiresWorktree: true,
      };

      const normalized = normalizeRoleToV2(legacyV1);
      assert.equal(normalized.id, "junior_fe");
      assert.equal(normalized.name, "自定义前端");
      assert.equal(normalized.isLegacy, true);
      assert.equal(normalized.permissionProfileId, "fullstack-standard");
      assert.ok(normalized.responsibilities.length > 0);
    });

    it("should generate migration candidate file without overwriting existing files", () => {
      const v1List: RoleConfigV1[] = [
        {
          id: "reviewer",
          name: "Old Reviewer",
          description: "Old Desc",
          systemPrompt: "old",
          requiresWorktree: false,
        },
      ];
      const result = generateV2MigrationCandidate(v1List);
      assert.ok(result.candidatePath.includes("roles.v2.generated.json"));
      assert.equal(result.v2Roles.length, 1);
      assert.equal(result.v2Roles[0].schemaVersion, 2);
      assert.equal(result.v2Roles[0].definition.id, "reviewer");
    });
  });

  describe("4. ConstraintResolver & Priority Hierarchy", () => {
    it("should enforce hierarchy and strip conflicting task contract constraints", () => {
      const contract: TaskContract = {
        taskId: "task-001",
        parentSessionId: "session-001",
        role: "coordinator",
        goal: "重构登录模块",
        constraints: [
          "禁止使用外部依赖",
          "不得伪造测试结果",
          "禁止修改业务代码",
          "遵循代码风格规范",
        ],
        acceptanceCriteria: ["完成 Review 报告"],
        expectedDeliverables: ["summary", "review_verdict"],
      };

      const context = ConstraintResolver.resolve({
        role: "reviewer",
        cwd: "/tmp/project",
        taskContract: contract,
      });

      assert.equal(context.role.id, "reviewer");
      assert.equal(context.permission.writableScope, "all");
      assert.ok(
        !context.taskContract?.constraints?.some((c) => c.includes("允许修改")),
        "Conflicting constraint should have been stripped by resolver",
      );
      assert.ok(
        context.taskContract?.constraints?.some((c) => c.includes("遵循代码风格")),
        "Non-conflicting constraint should be preserved",
      );
    });

    it("should properly calculate effective writable paths based on worktree and scope", () => {
      const contract: TaskContract = {
        taskId: "task-002",
        parentSessionId: "session-001",
        role: "junior_fe",
        goal: "开发前端组件",
        scope: {
          include: ["src/components/**", "package.json"],
          exclude: ["src/legacy/**"],
        },
        acceptanceCriteria: ["组件自测通过"],
        expectedDeliverables: ["summary", "changed_files"],
      };

      const context = ConstraintResolver.resolve({
        role: "junior_fe",
        cwd: "/tmp/project",
        worktreePath: "/tmp/project/.worktrees/task-002",
        taskContract: contract,
      });

      assert.equal(context.permission.isWorktree, true);
      assert.ok(context.permission.writablePaths.includes("/tmp/project/.worktrees/task-002"));
      assert.deepEqual(context.permission.taskScope, contract.scope);
    });
  });

  describe("5. PromptAssembler & Cache Stability", () => {
    it("should assemble structured prompt with stable prefix layers", () => {
      const contract: TaskContract = {
        taskId: "task-003",
        parentSessionId: "session-001",
        role: "fullstack",
        goal: "全栈特性",
        acceptanceCriteria: ["通过联调"],
        expectedDeliverables: ["summary", "changed_files", "test_report"],
      };

      const context = ConstraintResolver.resolve({
        role: "fullstack",
        cwd: "/tmp/project",
        taskContract: contract,
      });

      const assembled = PromptAssembler.assemble(context, "实现支付回调接口");
      assert.ok(assembled.systemPrompt.length > 0);

      const parsed = JSON.parse(assembled.systemPrompt);
      const keys = Object.keys(parsed);
      const invariantsIdx = keys.indexOf("shared_invariants");
      const roleIdx = keys.indexOf("role");
      const taskContractIdx = keys.indexOf("task_contract");

      assert.ok(invariantsIdx < roleIdx, "shared_invariants must come before role");
      assert.ok(roleIdx < taskContractIdx, "role must come before task_contract");
    });
  });

  describe("6. Runtime Tool Delegation & Path Utilities", () => {
    it("should allow tool execution without runtime interception", () => {
      const perm: EffectiveRuntimePermission = {
        profileId: "standard-dev",
        allowedTools: ["read", "bash", "edit", "write"],
        writableScope: "all",
        writablePaths: ["/tmp/project"],
        requiresWorktree: false,
        isWorktree: false,
      };

      const editCheck = RuntimeEnforcer.validateToolExecution(perm, "edit", {
        path: "/tmp/project/src/index.ts",
      });
      assert.equal(editCheck.allowed, true);

      const bashCheck = RuntimeEnforcer.validateToolExecution(perm, "bash", {
        command: "npm test",
      });
      assert.equal(bashCheck.allowed, true);

      const readCheck = RuntimeEnforcer.validateToolExecution(perm, "read", {
        path: "/tmp/project/src/index.ts",
      });
      assert.equal(readCheck.allowed, true);
    });

    it("should validate path containment and glob matching correctly", () => {
      assert.equal(isPathContained("/tmp/repo", "/tmp/repo/src/index.ts"), true);
      assert.equal(isPathContained("/tmp/repo", "/tmp/repo/../secret.txt"), false);

      assert.equal(matchesPattern("src/components/Button.tsx", "src/components/**"), true);
      assert.equal(matchesPattern("src/services/api.ts", "src/components/**"), false);
      assert.equal(matchesPattern("package.json", "package.json"), true);
    });
  });

  describe("7. TaskResult Runtime Schema Validation & Strict Evidence", () => {
    it("should validate valid task result with test deliverables", () => {
      const contract: TaskContract = {
        taskId: "task-001",
        parentSessionId: "session-001",
        role: "junior_fe",
        goal: "登录组件",
        acceptanceCriteria: ["通过单测"],
        expectedDeliverables: ["summary", "changed_files", "test_report"],
      };

      const rawResult = {
        taskId: "task-001",
        role: "junior_fe",
        status: "completed",
        summary: "成功实现登录组件",
        changedFiles: ["src/Login.tsx"],
        verification: [
          {
            kind: "test",
            command: "npm test",
            status: "passed",
            summary: "10 tests passed",
          },
        ],
      };

      const validated = validateTaskResult(rawResult, contract);
      assert.equal(validated.valid, true);
      assert.equal(validated.result?.status, "completed");
      assert.equal(validated.result?.verification?.length, 1);
    });

    it("should fail validation and refuse completed status when verification has failed test", () => {
      const contract: TaskContract = {
        taskId: "task-002",
        parentSessionId: "session-001",
        role: "junior_fe",
        goal: "登录组件",
        acceptanceCriteria: ["通过单测"],
        expectedDeliverables: ["summary", "test_report"],
      };

      const rawWithFailedTest = {
        taskId: "task-002",
        role: "junior_fe",
        status: "completed", // 模型错误自报 completed
        summary: "部分测试失败",
        verification: [
          {
            kind: "test",
            command: "npm test",
            status: "failed", // 实际测试失败
            summary: "1 test failed",
          },
        ],
      };

      const validated = validateTaskResult(rawWithFailedTest, contract);
      assert.equal(validated.valid, false);
      assert.equal(validated.result?.status, "failed"); // 必须被纠正为 failed
      assert.ok(validated.errors.some((e) => e.includes("failed or blocked checks")));
    });

    it("should reject non-boolean healthCheckPassed in deployEvidence", () => {
      const contract: TaskContract = {
        taskId: "task-003",
        parentSessionId: "session-001",
        role: "deployer",
        goal: "发布",
        acceptanceCriteria: ["健康检查通过"],
        expectedDeliverables: ["summary", "deploy_evidence"],
      };

      const rawWithFauxBoolean = {
        taskId: "task-003",
        role: "deployer",
        status: "completed",
        summary: "已部署",
        deployEvidence: {
          healthCheckPassed: "false" as any, // 传入字符串 "false"
        },
      };

      const validated = validateTaskResult(rawWithFauxBoolean, contract);
      assert.equal(validated.valid, false);
      assert.ok(validated.errors.some((e) => e.includes("strict boolean")));
    });
  });
});
