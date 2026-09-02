import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const testAgentDir = mkdtempSync(join(tmpdir(), "pi-contracts-test-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

import {
  canonicalizePath,
  ConstraintResolver,
  DEFAULT_ROLES_V2,
  generateV2MigrationCandidate,
  getRoleDefinition,
  isPathContained,
  normalizeRoleToV2,
  PromptAssembler,
  RoleRegistry,
  rolesPath,
  SHARED_DEFAULTS,
  SHARED_INVARIANTS,
  type RoleConfigV1,
  type RoleConfigV2,
  type TaskContract,
} from "../server/contracts/index.ts";
import { saveRolesConfig } from "../server/roles.ts";
import {
  deleteAuthCredential,
  readAuthCredentials,
  sanitizeEmptyAvailableModelIds,
  writeAuthApiKey,
} from "../server/auth-config.ts";
import {
  hideSubscriptionModel,
  readHiddenModelsMap,
  unhideAllSubscriptionModels,
  unhideSubscriptionModel,
} from "../server/subscription-preferences.ts";
import { buildSubagentUserPrompt } from "../server/subagent-manager.ts";
import type { TaskContract as SharedTaskContract } from "../shared/protocol.ts";

describe("Pi Multi-Agent Execution Contracts & Prompts", () => {
  after(() => {
    try {
      rmSync(testAgentDir, { recursive: true, force: true });
    } catch {}
  });

  describe("1. Shared Invariants & Defaults", () => {
    it("should provide immutable non-overridable core invariants", () => {
      assert.ok(SHARED_INVARIANTS.length === 4);
      assert.ok(SHARED_INVARIANTS.some((i) => i.includes("不得伪造文件内容")));
      assert.ok(SHARED_INVARIANTS.some((i) => i.includes("不得破坏、静默覆盖")));
      assert.ok(SHARED_INVARIANTS.some((i) => i.includes("不得在代码、提交信息、日志或回复中泄露 Secret")));
    });

    it("should provide concise engineering defaults including baseline-first for fixing tasks and symbol-first evidence", () => {
      assert.ok(SHARED_DEFAULTS.length >= 8);
      assert.ok(SHARED_DEFAULTS.some((d) => d.includes("保持简洁直接")));
      assert.ok(SHARED_DEFAULTS.some((d) => d.includes("优先进行最小化修改")));
      assert.ok(SHARED_DEFAULTS.some((d) => d.includes("针对修复型任务") && d.includes("Baseline")));
      assert.ok(SHARED_DEFAULTS.some((d) => d.includes("简明交付报告")));
      assert.ok(SHARED_DEFAULTS.some((d) => d.includes("file + class + method/symbol") && d.includes("行号仅作辅助参考")));
      assert.ok(SHARED_DEFAULTS.some((d) => d.includes("Verified Facts") && d.includes("Working Memory")));
    });
  });

  describe("2. RoleDefinition V2 & Standard Mode", () => {
    it("should have standard built-in V2 roles with clean prompt breakdown, baseline-first and instructions", () => {
      RoleRegistry.getInstance().reload();

      const requiredRoles = ["coordinator", "junior_fe", "junior_be", "fullstack", "reviewer", "tester", "deployer", "default"];
      for (const roleId of requiredRoles) {
        const def = getRoleDefinition(roleId as any);
        assert.ok(def, `Role definition for ${roleId} must exist`);
        assert.ok(def.description.length > 0, `${roleId} must have non-empty description`);
        assert.ok(def.responsibilities.length >= 1, `${roleId} must have at least 1 responsibility`);
        assert.ok(typeof def.instructions === "string" && def.instructions.length > 0, `${roleId} must have non-empty instructions`);
      }

      const defaultRole = getRoleDefinition("default");
      assert.ok(defaultRole.instructions?.includes("You are the primary software engineering agent in Pi Standard Mode"));
      assert.ok(defaultRole.instructions?.includes("Baseline"));

      const fe = getRoleDefinition("junior_fe");
      assert.equal(fe.name, "前端开发 (Frontend Engineer)");
      assert.equal(fe.requiresWorktree, true, "Write role junior_fe must default to requiresWorktree: true");
      assert.ok(fe.instructions?.includes("Baseline"));

      const be = getRoleDefinition("junior_be");
      assert.equal(be.name, "后端开发 (Backend Engineer)");
      assert.equal(be.requiresWorktree, true, "Write role junior_be must default to requiresWorktree: true");
      assert.ok(be.instructions?.includes("Baseline"));

      const fullstack = getRoleDefinition("fullstack");
      assert.ok(fullstack.instructions?.includes("Baseline"));

      const coordinator = getRoleDefinition("coordinator");
      assert.ok(coordinator.instructions?.includes("DISCOVER → DELEGATE → VERIFY → COMPLETE"));
      assert.ok(coordinator.instructions?.includes("Baseline"));
      assert.ok(coordinator.instructions?.includes("任务粒度与拆分原则"));
      assert.ok(coordinator.instructions?.includes("Working Memory 不跨 Task 继承"));
      assert.ok(!coordinator.instructions?.includes("200k"));
      assert.ok(!coordinator.instructions?.includes("200+"));
      assert.ok(coordinator.responsibilities.some((r) => r.includes("任务粒度原则")));
      assert.ok(coordinator.responsibilities.some((r) => r.includes("跨 Task 则通过 ReusableSubagent Knowledge")));
      assert.ok(coordinator.strictProhibitions.some((p) => p.includes("禁止直接编写")));
      assert.ok(coordinator.strictProhibitions.some((p) => p.includes("无法复现")));
      assert.ok(coordinator.strictProhibitions.some((p) => p.includes("禁止将多个可以独立调查验证交付的异构子系统")));
      assert.equal(coordinator.requiresWorktree, false, "Coordinator must not require worktree");

      const reviewer = getRoleDefinition("reviewer");
      assert.ok(reviewer.instructions?.includes("APPROVE"));
      assert.ok(reviewer.instructions?.includes("baseline"));
      assert.ok(reviewer.instructions?.includes("行号仅为定位辅助"));
      assert.ok(reviewer.strictProhibitions.some((p) => p.includes("禁止因报告缺少固定 Baseline 模板")));
      assert.ok(reviewer.strictProhibitions.some((p) => p.includes("禁止因非关键源码行号轻微偏差")));
      assert.equal(reviewer.requiresWorktree, false, "Reviewer must not require worktree");

      const tester = getRoleDefinition("tester");
      assert.ok(tester.instructions?.includes("Before / After"));
      assert.ok(tester.instructions?.includes("源码证据与符号锚定"));
      assert.ok(tester.responsibilities.some((r) => r.includes("Before / After")));
      assert.ok(tester.strictProhibitions.some((p) => p.includes("禁止在源码未变化时，为了反复核对微小行号差异重复读取源码")));
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
      assert.equal(normalized.requiresWorktree, true);
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

  describe("3. ConstraintResolver & Runtime Config", () => {
    it("should resolve effective runtime configuration without rewriting task constraints", () => {
      const contract: TaskContract = {
        taskId: "task-001",
        parentSessionId: "session-001",
        role: "reviewer",
        goal: "重构登录模块",
        constraints: [
          "禁止使用外部依赖",
          "不得伪造测试结果",
          "遵循代码风格规范",
        ],
        acceptanceCriteria: ["完成 Review 报告"],
      };

      const context = ConstraintResolver.resolve({
        role: "reviewer",
        cwd: "/tmp/project",
        taskContract: contract,
      });

      assert.equal(context.role.id, "reviewer");
      assert.deepEqual(context.runtime.activeTools, ["read", "bash", "report_blocker"]);
      assert.equal(context.runtime.requiresWorktree, false);
      assert.deepEqual(context.taskContract?.constraints, contract.constraints);
    });

    it("should keep activeTools as empty array when allowedTools is explicitly [] without falling back to full tools", () => {
      const registry = RoleRegistry.getInstance();
      const reviewer = registry.getRole("reviewer");
      const emptyToolsRole: RoleConfigV2 = {
        ...reviewer,
        allowedTools: [],
        definition: {
          ...reviewer.definition,
          allowedTools: [],
        },
      };

      saveRolesConfig([emptyToolsRole]);
      RoleRegistry.getInstance().reload();
      const context = ConstraintResolver.resolve({
        role: "reviewer",
        cwd: "/tmp/project",
      });

      assert.deepEqual(context.runtime.activeTools, []);
      assert.equal(context.runtime.activeTools.length, 0);

      // 恢复正常 roles
      saveRolesConfig(Object.values(DEFAULT_ROLES_V2));
      RoleRegistry.getInstance().reload();
    });

    it("should verify Standard Mode default role has no report_blocker tool", () => {
      const context = ConstraintResolver.resolve({
        role: "default",
        cwd: "/tmp/project",
      });
      assert.deepEqual(context.runtime.activeTools, ["read", "bash", "edit", "write"]);
      assert.equal(context.runtime.activeTools.includes("report_blocker"), false);
    });

    it("should guarantee TaskContract definitions are synchronized between server and shared without dead fields", () => {
      const serverContract: TaskContract = {
        taskId: "task-sync-1",
        parentSessionId: "session-1",
        role: "junior_fe",
        goal: "重构组件",
        scope: { include: ["src/*"], exclude: [] },
        contextFiles: ["src/index.ts"],
        constraints: ["不得修改已有公共API"],
        acceptanceCriteria: ["通过单元测试"],
      };

      // 验证类型相互兼容
      const sharedContract: SharedTaskContract = serverContract;
      assert.equal(sharedContract.taskId, "task-sync-1");
      assert.equal(sharedContract.goal, "重构组件");
      assert.equal((serverContract as any).dependencies, undefined, "server TaskContract must not contain dependencies");
      assert.equal((serverContract as any).meta, undefined, "server TaskContract must not contain meta");
      assert.equal((sharedContract as any).dependencies, undefined, "shared TaskContract must not contain dependencies");
      assert.equal((sharedContract as any).meta, undefined, "shared TaskContract must not contain meta");
    });
  });

  describe("4. PromptAssembler & Cache Stability", () => {
    it("should assemble stable structured prompt without hierarchy_priority or task_contract in system prompt", () => {
      const contract: TaskContract = {
        taskId: "task-003",
        parentSessionId: "session-001",
        role: "fullstack",
        goal: "全栈特性",
        acceptanceCriteria: ["通过联调"],
      };

      const context = ConstraintResolver.resolve({
        role: "fullstack",
        cwd: "/tmp/project",
        taskContract: contract,
      });

      const assembled = PromptAssembler.assemble(context);
      assert.ok(assembled.systemPrompt.length > 0);

      const parsed = JSON.parse(assembled.systemPrompt);
      const keys = Object.keys(parsed);
      const invariantsIdx = keys.indexOf("shared_invariants");
      const roleIdx = keys.indexOf("role");

      assert.ok(invariantsIdx < roleIdx, "shared_invariants must come before role");
      assert.equal((parsed as any).hierarchy_priority, undefined, "hierarchy_priority must be deleted");
      assert.equal((parsed as any).task_contract, undefined, "task_contract must not be in system prompt");
      assert.equal((parsed as any).current_task, undefined, "Dynamic task must not be in system prompt");
      assert.equal((parsed as any).workspace_context, undefined, "workspace_context must not be in system prompt");
    });

    it("should guarantee System Prompt prefix stability across consecutive tasks with different worktrees, branches, and taskIds", () => {
      // Task A
      const contextA = ConstraintResolver.resolve({
        role: "tester",
        cwd: "/Users/dev/project/.pi/agent/worktrees/task-A",
        projectRoot: "/Users/dev/project",
        branchName: "pi-subagent-task-A",
        worktreePath: "/Users/dev/project/.pi/agent/worktrees/task-A",
        taskContract: {
          taskId: "task-A",
          parentSessionId: "session-1",
          role: "tester",
          goal: "Verify subagent CK isolation",
        },
      });

      // Task B
      const contextB = ConstraintResolver.resolve({
        role: "tester",
        cwd: "/Users/dev/project/.pi/agent/worktrees/task-B",
        projectRoot: "/Users/dev/project",
        branchName: "pi-subagent-task-B",
        worktreePath: "/Users/dev/project/.pi/agent/worktrees/task-B",
        taskContract: {
          taskId: "task-B",
          parentSessionId: "session-1",
          role: "tester",
          goal: "Verify subagent MinIO backup",
        },
      });

      // Task C
      const contextC = ConstraintResolver.resolve({
        role: "tester",
        cwd: "/Users/dev/project/.pi/agent/worktrees/task-C",
        projectRoot: "/Users/dev/project",
        branchName: "pi-subagent-task-C",
        worktreePath: "/Users/dev/project/.pi/agent/worktrees/task-C",
        taskContract: {
          taskId: "task-C",
          parentSessionId: "session-1",
          role: "tester",
          goal: "Verify subagent log allowlist",
        },
      });

      const assembledA = PromptAssembler.assemble(contextA);
      const assembledB = PromptAssembler.assemble(contextB);
      const assembledC = PromptAssembler.assemble(contextC);

      // 1. System Prompt 字节级完全相同（稳定前缀最大化 Provider Prompt Cache 命中率）
      assert.equal(
        assembledA.systemPrompt,
        assembledB.systemPrompt,
        "System prompt for Task A and B must be byte-for-byte identical",
      );
      assert.equal(
        assembledB.systemPrompt,
        assembledC.systemPrompt,
        "System prompt for Task B and C must be byte-for-byte identical",
      );

      // 2. 验证 System Prompt 不含任何动态字段
      const parsedA = JSON.parse(assembledA.systemPrompt);
      assert.equal((parsedA as any).workspace_context, undefined, "workspace_context must not be in system prompt");
      assert.equal((parsedA as any).taskId, undefined);
      assert.equal((parsedA as any).cwd, undefined);
      assert.equal((parsedA as any).worktree, undefined);

      // 3. 验证各自的 Workspace Context 位于各自的 User Message
      const userPromptA = buildSubagentUserPrompt("Run CK tests", contextA.taskContract, {
        workspaceContext: {
          cwd: contextA.environment.cwd,
          projectRoot: contextA.environment.projectRoot,
          gitBranch: contextA.environment.gitBranch,
          isWorktree: contextA.environment.isWorktree,
        },
      });
      const userPromptB = buildSubagentUserPrompt("Run MinIO tests", contextB.taskContract, {
        workspaceContext: {
          cwd: contextB.environment.cwd,
          projectRoot: contextB.environment.projectRoot,
          gitBranch: contextB.environment.gitBranch,
          isWorktree: contextB.environment.isWorktree,
        },
      });

      assert.notEqual(userPromptA, userPromptB, "User prompts must differ with dynamic task and workspace context");
      assert.ok(userPromptA.includes("/Users/dev/project/.pi/agent/worktrees/task-A"));
      assert.ok(userPromptA.includes("pi-subagent-task-A"));
      assert.ok(userPromptB.includes("/Users/dev/project/.pi/agent/worktrees/task-B"));
      assert.ok(userPromptB.includes("pi-subagent-task-B"));
    });
  });

  describe("5. Path Utilities", () => {
    it("should validate path containment correctly", () => {
      assert.equal(isPathContained("/tmp/repo", "/tmp/repo/src/index.ts"), true);
      assert.equal(isPathContained("/tmp/repo", "/tmp/repo/../secret.txt"), false);
      assert.equal(isPathContained("/tmp/repo", "/etc/passwd"), false);
    });

    it("should canonicalize paths accurately", () => {
      const p = canonicalizePath("/tmp");
      assert.ok(typeof p === "string" && p.length > 0);
    });
  });

  describe("6. Auth & Subscription Provider Credentials", () => {
    it("should safely write, read, and delete API key credentials in isolated agent directory", () => {
      // 1. 写入 opencode-go
      writeAuthApiKey("opencode-go", "sk-test-opencode-key-12345");
      let creds = readAuthCredentials();
      assert.ok(creds["opencode-go"]);
      assert.equal(creds["opencode-go"].type, "api_key");
      assert.equal(creds["opencode-go"].key, "sk-test-opencode-key-12345");

      // 2. 写入 openai-codex
      writeAuthApiKey("openai-codex", "sk-test-codex-key");
      creds = readAuthCredentials();
      assert.ok(creds["openai-codex"]);
      assert.equal(creds["openai-codex"].key, "sk-test-codex-key");

      // 3. 删除 opencode-go
      deleteAuthCredential("opencode-go");
      creds = readAuthCredentials();
      assert.equal(creds["opencode-go"], undefined);
      assert.ok(creds["openai-codex"]); // 其他凭据不受影响

      // 4. 清理 openai-codex
      deleteAuthCredential("openai-codex");
      creds = readAuthCredentials();
      assert.equal(creds["openai-codex"], undefined);
    });

    it("should strip empty availableModelIds so OAuth providers are not hidden from pickers", () => {
      const authFile = join(getAgentDir(), "auth.json");
      writeFileSync(
        authFile,
        JSON.stringify(
          {
            "github-copilot": {
              type: "oauth",
              access: "token-access",
              refresh: "token-refresh",
              expires: Date.now() + 60_000,
              availableModelIds: [],
            },
            "openai-codex": {
              type: "oauth",
              access: "codex-access",
              refresh: "codex-refresh",
              expires: Date.now() + 60_000,
              availableModelIds: ["gpt-5.4"],
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      assert.equal(sanitizeEmptyAvailableModelIds(), true);
      assert.equal(sanitizeEmptyAvailableModelIds(), false);

      const creds = readAuthCredentials();
      assert.equal(creds["github-copilot"]?.availableModelIds, undefined);
      assert.deepEqual(creds["openai-codex"]?.availableModelIds, ["gpt-5.4"]);
      assert.equal(creds["github-copilot"]?.access, "token-access");

      deleteAuthCredential("github-copilot");
      deleteAuthCredential("openai-codex");
    });

    it("should hide and restore individual subscription models in preferences", () => {
      hideSubscriptionModel("github-copilot", "gpt-4.1");
      hideSubscriptionModel("github-copilot", "claude-haiku-4.5");
      hideSubscriptionModel("github-copilot", "gpt-4.1"); // idempotent

      let map = readHiddenModelsMap();
      assert.equal(map.get("github-copilot")?.has("gpt-4.1"), true);
      assert.equal(map.get("github-copilot")?.has("claude-haiku-4.5"), true);
      assert.equal(map.get("github-copilot")?.size, 2);

      unhideSubscriptionModel("github-copilot", "gpt-4.1");
      map = readHiddenModelsMap();
      assert.equal(map.get("github-copilot")?.has("gpt-4.1"), false);
      assert.equal(map.get("github-copilot")?.has("claude-haiku-4.5"), true);

      unhideAllSubscriptionModels("github-copilot");
      map = readHiddenModelsMap();
      assert.equal(map.has("github-copilot"), false);
    });
  });

  describe("7. Subagent User Prompt & Working Memory Boundaries", () => {
    it("should build subagent user prompt with authoritative memory guidelines and task-scoped lifecycle", () => {
      const prompt = buildSubagentUserPrompt(
        "Investigate ClickHouse clean config",
        {
          taskId: "task-test-mem-1",
          parentSessionId: "parent-1",
          role: "tester",
          goal: "Verify CK isolation",
        },
        {
          memoryPaths: {
            workingMemoryPath: "/tmp/working-memory.md",
            processJournalPath: "/tmp/process-journal.md",
          },
        },
      );

      assert.ok(prompt.includes("## Working Memory & Process Journal"));
      assert.ok(prompt.includes("current task rolling state"));
      assert.ok(prompt.includes("current real evidence is authoritative"));
      assert.ok(prompt.includes("Working Memory is maintained for this task"));
      assert.ok(prompt.includes("directly reuse these facts instead of unconditionally re-reading source code"));
    });
  });
});

