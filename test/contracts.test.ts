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

  describe("6. RuntimeEnforcer Hard Sandboxing & TaskScope Enforcement", () => {
    it("should block write/edit operations for readonly roles", () => {
      const readonlyPerm: EffectiveRuntimePermission = {
        profileId: "custom-readonly",
        allowedTools: ["read", "bash"],
        writableScope: "none",
        writablePaths: [],
        requiresWorktree: false,
        isWorktree: false,
      };

      const editCheck = RuntimeEnforcer.validateToolExecution(readonlyPerm, "edit", {
        path: "/tmp/project/src/index.ts",
      });
      assert.equal(editCheck.allowed, false);
      assert.ok(
        editCheck.reason?.includes("白名单") || editCheck.reason?.includes("只读权限"),
      );

      const readCheck = RuntimeEnforcer.validateToolExecution(readonlyPerm, "read", {
        path: "/tmp/project/src/index.ts",
      });
      assert.equal(readCheck.allowed, true);
    });

    it("should allow safe readonly bash commands with 2>/dev/null redirects", () => {
      const readonlyPerm: EffectiveRuntimePermission = {
        profileId: "custom-readonly",
        allowedTools: ["read", "bash"],
        writableScope: "none",
        writablePaths: [],
        requiresWorktree: false,
        isWorktree: false,
      };

      const check = RuntimeEnforcer.validateToolExecution(readonlyPerm, "bash", {
        command: "ls -la /tmp/project/.worktrees/ 2>/dev/null || echo 'No worktrees directory'",
      });
      assert.equal(check.allowed, true);
    });

    it("should block tester from modifying production business logic", () => {
      const testerPerm: EffectiveRuntimePermission = {
        profileId: "tester-test-write",
        allowedTools: ["read", "bash", "edit", "write"],
        writableScope: "test-only",
        writablePaths: ["/tmp/project"],
        requiresWorktree: false,
        isWorktree: false,
      };

      const prodEditCheck = RuntimeEnforcer.validateToolExecution(testerPerm, "edit", {
        path: "/tmp/project/src/services/user.ts",
      });
      assert.equal(prodEditCheck.allowed, false);
      assert.ok(prodEditCheck.reason?.includes("严禁修改生产业务路径"));

      const testEditCheck = RuntimeEnforcer.validateToolExecution(testerPerm, "edit", {
        path: "/tmp/project/test/user.test.ts",
      });
      assert.equal(testEditCheck.allowed, true);
    });

    it("should block worktree subagents from modifying outside the worktree directory", () => {
      const worktreePerm: EffectiveRuntimePermission = {
        profileId: "worktree-profile",
        allowedTools: ["read", "bash", "edit", "write"],
        writableScope: "worktree-only",
        worktreePath: "/tmp/main-repo/.worktrees/task-fe-1",
        writablePaths: ["/tmp/main-repo/.worktrees/task-fe-1"],
        requiresWorktree: true,
        isWorktree: true,
      };

      const outsideCheck = RuntimeEnforcer.validateToolExecution(worktreePerm, "write", {
        path: "/tmp/main-repo/src/App.tsx",
      });
      assert.equal(outsideCheck.allowed, false);
      assert.ok(outsideCheck.reason?.includes("严禁越界修改主工作区文件"));

      const insideCheck = RuntimeEnforcer.validateToolExecution(worktreePerm, "write", {
        path: "/tmp/main-repo/.worktrees/task-fe-1/src/App.tsx",
      });
      assert.equal(insideCheck.allowed, true);
    });

    it("should enforce TaskContract.scope.include and exclude boundaries", () => {
      const scopedPerm: EffectiveRuntimePermission = {
        profileId: "frontend-standard",
        allowedTools: ["read", "bash", "edit", "write"],
        writableScope: "worktree-only",
        worktreePath: "/tmp/repo",
        writablePaths: ["/tmp/repo"],
        taskScope: {
          include: ["src/components/**", "package.json"],
          exclude: ["src/components/legacy/**", "**/*.env"],
        },
        requiresWorktree: true,
        isWorktree: true,
      };

      // 1. 允许 include 内的文件
      assert.equal(
        RuntimeEnforcer.validateToolExecution(scopedPerm, "edit", {
          path: "/tmp/repo/src/components/Button.tsx",
        }).allowed,
        true,
      );

      // 2. 拦截不在 include 内的文件
      const notIncluded = RuntimeEnforcer.validateToolExecution(scopedPerm, "edit", {
        path: "/tmp/repo/src/services/api.ts",
      });
      assert.equal(notIncluded.allowed, false);
      assert.ok(notIncluded.reason?.includes("不在 TaskContract.scope.include 明确允许的修改范围内"));

      // 3. 拦截匹配 exclude 的文件 (即便在 include 内部)
      const excluded = RuntimeEnforcer.validateToolExecution(scopedPerm, "edit", {
        path: "/tmp/repo/src/components/legacy/OldButton.tsx",
      });
      assert.equal(excluded.allowed, false);
      assert.ok(excluded.reason?.includes("匹配 TaskContract.scope.exclude 规则"));

      const secretExcluded = RuntimeEnforcer.validateToolExecution(scopedPerm, "write", {
        path: "/tmp/repo/secret.env",
      });
      assert.equal(secretExcluded.allowed, false);
      assert.ok(secretExcluded.reason?.includes("匹配 TaskContract.scope.exclude 规则"));
    });

    it("should block worktree-only bash writing absolute path outside the worktree", () => {
      const worktreePerm: EffectiveRuntimePermission = {
        profileId: "frontend-standard",
        allowedTools: ["read", "bash", "edit", "write"],
        writableScope: "worktree-only",
        worktreePath: "/tmp/repo/.worktrees/task-fe-1",
        writablePaths: ["/tmp/repo/.worktrees/task-fe-1"],
        requiresWorktree: true,
        isWorktree: true,
      };

      const outsideRedirect = RuntimeEnforcer.validateToolExecution(worktreePerm, "bash", {
        command: "echo 'hack' > /tmp/repo/src/index.ts",
      });
      assert.equal(outsideRedirect.allowed, false);
      assert.ok(outsideRedirect.reason?.includes("超出了分配的 Worktree") || outsideRedirect.reason?.includes("未授权"));

      const outsideCp = RuntimeEnforcer.validateToolExecution(worktreePerm, "bash", {
        command: "cp src/index.ts /tmp/repo/src/index.ts",
      });
      assert.equal(outsideCp.allowed, false);
      assert.ok(outsideCp.reason?.includes("超出了分配的 Worktree") || outsideCp.reason?.includes("未授权"));
    });

    it("should block tester bash from writing to src/ or production files", () => {
      const testerPerm: EffectiveRuntimePermission = {
        profileId: "tester-test-write",
        allowedTools: ["read", "bash", "edit", "write"],
        writableScope: "test-only",
        writablePaths: ["/tmp/repo"],
        requiresWorktree: false,
        isWorktree: false,
      };

      const writeSrc = RuntimeEnforcer.validateToolExecution(testerPerm, "bash", {
        command: "echo 'modified' > src/services/user.ts",
      });
      assert.equal(writeSrc.allowed, false);
      assert.ok(writeSrc.reason?.includes("严禁修改生产业务路径"));

      const rmSrc = RuntimeEnforcer.validateToolExecution(testerPerm, "bash", {
        command: "rm src/main.ts",
      });
      assert.equal(rmSrc.allowed, false);
      assert.ok(rmSrc.reason?.includes("严禁修改生产业务路径"));

      const writeTest = RuntimeEnforcer.validateToolExecution(testerPerm, "bash", {
        command: "echo 'ok' > test/user.test.ts",
      });
      assert.equal(writeTest.allowed, true);
    });

    it("should block deployer bash from modifying business source code", () => {
      const deployerPerm: EffectiveRuntimePermission = {
        profileId: "deployer-infra",
        allowedTools: ["read", "bash"],
        writableScope: "deploy-only",
        writablePaths: ["/tmp/repo"],
        requiresWorktree: false,
        isWorktree: false,
      };

      const writeSrc = RuntimeEnforcer.validateToolExecution(deployerPerm, "bash", {
        command: "echo 'hack' > src/app.ts",
      });
      assert.equal(writeSrc.allowed, false);
      assert.ok(writeSrc.reason?.includes("严禁修改业务源码"));

      const writeDeploy = RuntimeEnforcer.validateToolExecution(deployerPerm, "bash", {
        command: "echo 'FROM node' > Dockerfile",
      });
      assert.equal(writeDeploy.allowed, true);
    });

    it("should block reviewer from executing node/npm scripts with potential filesystem side effects", () => {
      const reviewerPerm: EffectiveRuntimePermission = {
        profileId: "reviewer-readonly",
        allowedTools: ["read", "bash"],
        writableScope: "none",
        writablePaths: [],
        requiresWorktree: false,
        isWorktree: false,
      };

      const nodeScript = RuntimeEnforcer.validateToolExecution(reviewerPerm, "bash", {
        command: "node build.js",
      });
      assert.equal(nodeScript.allowed, false);
      assert.ok(nodeScript.reason?.includes("副作用的脚本文件"));

      const npmBuild = RuntimeEnforcer.validateToolExecution(reviewerPerm, "bash", {
        command: "npm run build",
      });
      assert.equal(npmBuild.allowed, false);
      assert.ok(npmBuild.reason?.includes("变更命令"));

      const npmTest = RuntimeEnforcer.validateToolExecution(reviewerPerm, "bash", {
        command: "npm test",
      });
      assert.equal(npmTest.allowed, true);
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
