import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const testAgentDir = mkdtempSync(join(tmpdir(), "pi-contracts-test-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

import {
  canonicalizePath,
  CHINESE_LANGUAGE_GUIDANCE,
  ConstraintResolver,
  DEFAULT_ROLES_V2,
  convertDefinitionToConfig,
  CURRENT_ROLE_DEFINITION_VERSION,
  CANONICAL_ROLES,
  getAllRoleDefinitions,
  getRoleConfig,
  getRoleDefinition,
  isCanonicalRole,
  isPathContained,
  PromptAssembler,
  RoleRegistry,
  rolesPath,
  SHARED_DEFAULTS,
  SHARED_INVARIANTS,
  type RoleConfigV2,
  type TaskContract,
} from "../server/contracts/index.ts";
import { saveRolesConfig } from "../server/roles.ts";
import { tryParseReviewResult } from "../server/subagent-manager.ts";
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
import { adjustSkillsInBasePrompt } from "../server/skills.ts";
import type { TaskContract as SharedTaskContract } from "../shared/protocol.ts";

describe("Pi Multi-Agent Execution Contracts & Prompts", () => {
  after(() => {
    try {
      rmSync(testAgentDir, { recursive: true, force: true });
    } catch {}
  });

  describe("1. Shared Invariants & Defaults", () => {
    it("should provide immutable non-overridable core invariants", () => {
      assert.ok(SHARED_INVARIANTS.length >= 5);
      assert.ok(SHARED_INVARIANTS.includes(CHINESE_LANGUAGE_GUIDANCE));
      assert.match(CHINESE_LANGUAGE_GUIDANCE, /中文回答/);
      assert.match(CHINESE_LANGUAGE_GUIDANCE, /thinking/);
      assert.ok(SHARED_INVARIANTS.some((i) => i.includes("不得伪造文件内容")));
      assert.ok(SHARED_INVARIANTS.some((i) => i.includes("不得破坏、静默覆盖")));
      assert.ok(SHARED_INVARIANTS.some((i) => i.includes("不得在代码、提交信息、日志或回复中泄露 Secret")));
    });

    it("should include the Chinese language constraint in every role prompt projection", () => {
      for (const role of CANONICAL_ROLES) {
        const config = getRoleConfig(role);
        assert.ok(config.systemPrompt.includes(CHINESE_LANGUAGE_GUIDANCE), `${role} config prompt must include language guidance`);

        const context = ConstraintResolver.resolve({ role, cwd: "/tmp/project" });
        const assembled = PromptAssembler.assemble(context);
        const parsed = JSON.parse(assembled.systemPrompt);
        assert.ok(parsed.shared_invariants.includes(CHINESE_LANGUAGE_GUIDANCE), `${role} runtime prompt must include language guidance`);
      }
    });

    it("should provide concise engineering defaults including baseline-first for fixing tasks and symbol-first evidence", () => {
      assert.ok(SHARED_DEFAULTS.length >= 8);
      assert.ok(SHARED_DEFAULTS.some((d) => d.includes("保持简洁直接")));
      assert.ok(SHARED_DEFAULTS.some((d) => d.includes("优先进行最小化修改")));
      assert.ok(SHARED_DEFAULTS.some((d) => d.includes("针对修复型任务") && d.includes("Baseline")));
      assert.ok(SHARED_DEFAULTS.some((d) => d.includes("简明交付报告")));
      assert.ok(SHARED_DEFAULTS.some((d) => d.includes("file + class + method/symbol") && d.includes("行号仅作辅助参考")));
      assert.ok(
        SHARED_DEFAULTS.some(
          (d) =>
            d.includes("recovery_manifest") &&
            d.includes("read_artifact") &&
            d.includes("continuation hint"),
        ),
      );
      assert.equal(
        SHARED_DEFAULTS.some((d) => d.includes("Evidence Index")),
        false,
        "request-time recovery is recovery_manifest, not Evidence Index",
      );
    });
  });

  describe("2. RoleDefinition V2 & Converged 4-Role System", () => {
    it("1. should have only Coordinator, Developer, Verifier, Researcher (and default) as default built-in V2 roles", () => {
      RoleRegistry.getInstance().reload();

      const defaultRoleKeys = Object.keys(DEFAULT_ROLES_V2).sort();
      assert.deepEqual(
        defaultRoleKeys,
        ["coordinator", "default", "developer", "researcher", "verifier"].sort(),
        "DEFAULT_ROLES_V2 must only contain coordinator, developer, verifier, researcher, and default",
      );

      const definitions = getAllRoleDefinitions();
      const defIds = definitions.map((d) => d.id).sort();
      assert.deepEqual(
        defIds,
        ["coordinator", "default", "developer", "researcher", "verifier"].sort(),
        "Built-in role definitions must only be coordinator, developer, verifier, researcher, and default",
      );

      for (const def of definitions) {
        assert.ok(def.description.length > 0, `${def.id} must have non-empty description`);
        assert.ok(def.responsibilities.length >= 1, `${def.id} must have at least 1 responsibility`);
        assert.ok(typeof def.instructions === "string" && def.instructions.length > 0, `${def.id} must have non-empty instructions`);
        assert.match(
          def.instructions ?? "",
          /#### Context recovery/,
          `${def.id} instructions must teach request-time recovery_manifest`,
        );
        assert.doesNotMatch(
          def.instructions ?? "",
          /recovery_manifest\.boundary/,
          `${def.id} must not teach a nested recovery_manifest.boundary field`,
        );
      }
    });

    it("2. should reject legacy role IDs as invalid and refuse execution (fail-closed)", () => {
      const legacyIds = [
        "junior_fe",
        "junior_be",
        "fullstack",
        "deployer",
        "frontend_developer",
        "backend_developer",
        "implementer",
        "debugger",
        "reviewer",
        "tester",
        "acceptance",
        "acceptance_reviewer",
      ];

      for (const id of legacyIds) {
        assert.equal(isCanonicalRole(id), false, `${id} must not be a canonical role`);
        assert.throws(
          () => getRoleDefinition(id as any),
          /Unknown or invalid role/,
          `getRoleDefinition(${id}) must throw`,
        );
        assert.throws(
          () => getRoleConfig(id as any),
          /Unknown or invalid role/,
          `getRoleConfig(${id}) must throw`,
        );
      }
    });

    it("4 & 5. Coordinator role instructions explicitly state delegation is optional and prioritize doing it themselves when small/localized", () => {
      const coordinator = getRoleDefinition("coordinator");
      const coordinatorCfg = getRoleConfig("coordinator");
      assert.ok(
        coordinator.instructions?.includes("Delegation is optional, not a goal"),
        "Coordinator instructions must explicitly declare 'Delegation is optional, not a goal'",
      );
      assert.ok(
        coordinator.instructions?.includes("优先自己完成"),
        "Coordinator instructions must detail when to finish tasks themselves without subagents",
      );
      assert.ok(
        coordinator.instructions?.includes("Direct Path"),
        "Coordinator instructions must define Direct Path",
      );
      assert.ok(
        coordinator.instructions?.includes("Delegated Path"),
        "Coordinator instructions must define Delegated Path",
      );
      assert.ok(
        coordinator.instructions?.includes("Promotion Rule"),
        "Coordinator instructions must define Promotion Rule",
      );
      assert.ok(
        coordinator.instructions?.includes("Mutation Ownership"),
        "Coordinator instructions must define Mutation Ownership",
      );
      assert.ok(
        coordinator.instructions?.includes("Worktree Reclamation"),
        "Coordinator instructions must define Worktree Reclamation after sync",
      );
      assert.ok(
        coordinator.instructions?.includes("Prefer promotion before the first repository mutation"),
        "Coordinator instructions must prefer promotion before the first repository mutation",
      );
      assert.equal(coordinator.responsibilities.length, 6);
      assert.ok(
        coordinator.instructions?.includes("Behavior-Complete Outcome"),
        "Coordinator instructions must emphasize behavior-complete task decomposition",
      );
      assert.ok(
        coordinator.instructions?.includes("Risk-Based Verification"),
        "Coordinator instructions must define risk-based verification rather than mandatory verifier",
      );
      assert.ok(
        coordinator.instructions?.includes("#### Scout Gate"),
        "Coordinator instructions must define the Researcher-first gate",
      );
      assert.ok(
        coordinator.instructions?.includes("报告已被消费"),
        "Coordinator must consume the Researcher report before contract/developer dispatch",
      );
      assert.ok(
        coordinator.instructions?.includes("不得据自己的亲读结论编写依赖该调查的 Task Contract"),
        "Coordinator must not use overlapping self-investigation to bypass the Scout Gate",
      );
      assert.ok(
        coordinator.responsibilities.some((r) => r.includes("Delegation is optional")),
        "Coordinator responsibilities must include 'Delegation is optional'",
      );
      assert.ok(
        coordinator.strictProhibitions.some((p) => p.includes("禁止默认将所有工作拆分并委派给 Subagent")),
        "Coordinator must prohibit defaulting to subagent delegation",
      );
      assert.ok(
        coordinator.strictProhibitions.some((p) => p.includes("禁止拆分缺乏独立验证与验收闭环的微任务")),
        "Coordinator must prohibit decomposing micro-tasks without independent closure",
      );
      assert.ok(
        coordinator.strictProhibitions.some((p) => p.includes("禁止在已通过 Task Contract 委派的同一 scope 上同时进行 repository mutation")),
        "Coordinator must prohibit mutating a delegated scope",
      );
      assert.ok(
        coordinator.strictProhibitions.some((p) => p.includes("禁止在改动已同步到主工作区后遗留本轮创建的 Task/Integration Worktree")),
        "Coordinator must prohibit leaving this-run worktrees after sync",
      );
      assert.ok(
        coordinator.responsibilities.some((r) => r.includes("回收本轮创建的 Task/Integration Worktree")),
        "Coordinator responsibilities must include reclaiming this-run worktrees after sync",
      );
      assert.doesNotMatch(
        coordinator.instructions ?? "",
        /禁止修改代码|不得修改代码|readonly role/i,
        "Coordinator prompt must not declare a readonly/no-code-change ban",
      );
      assert.equal(
        coordinator.strictProhibitions.some((p) => /禁止修改代码|不得修改代码/.test(p)),
        false,
        "Coordinator must not prohibit modifying code",
      );
      assert.equal(coordinator.requiresWorktree, false, "Coordinator must not require worktree");
      assert.equal((coordinator as any).allowedTools, undefined);
      assert.ok(coordinatorCfg.allowedTools?.includes("spawn_subagent"));
      assert.ok(coordinatorCfg.allowedTools?.includes("edit"), "Coordinator must have edit for Direct Path");
      assert.ok(coordinatorCfg.allowedTools?.includes("write"), "Coordinator must have write for Direct Path");
      assert.ok(coordinatorCfg.allowedTools?.includes("web_search"), "Coordinator must have web_search");
      assert.equal(coordinatorCfg.allowedTools?.includes("url_context"), false);
      assert.match(coordinator.instructions ?? "", /#### Web search/);
      assert.match(coordinator.instructions ?? "", /#### Context recovery/);
      assert.match(coordinator.instructions ?? "", /firstCompactedEntryId/);
      assert.doesNotMatch(coordinator.instructions ?? "", /recovery_manifest\.boundary/);
      assert.match(coordinator.instructions ?? "", /get_task_summary/);
      assert.match(coordinator.instructions ?? "", /TaskEpisodeView/);
      assert.match(coordinator.instructions ?? "", /current run\/task only/);
      assert.doesNotMatch(
        coordinator.instructions ?? "",
        /pass ArtifactRef via the new Task Contract|由执行角色在其任务范围内用 read_artifact/,
      );
      assert.ok(
        coordinator.strictProhibitions.some((p) =>
          p.includes("read_artifact") && p.includes("其他 Task"),
        ),
      );
    });

    it("6. Developer Role handles frontend, backend, and debug tasks with root cause and baseline evidence", () => {
      const developer = getRoleDefinition("developer");
      const developerCfg = getRoleConfig("developer");
      assert.equal(developer.id, "developer");
      assert.equal(developer.name, "开发工程师 (Developer)");
      assert.equal(developer.requiresWorktree, true, "Developer requires isolated worktree");
      assert.equal((developer as any).allowedTools, undefined);
      assert.deepEqual(developerCfg.allowedTools, ["read", "bash", "edit", "write", "report_blocker", "read_transcript", "search_transcript", "read_artifact"]);
      assert.ok(developer.responsibilities.some((r) => r.includes("前端、后端或全栈")));
      assert.ok(developer.responsibilities.some((r) => r.includes("Baseline")));
      assert.ok(developer.instructions?.includes("Contract → Root Cause → Minimal Change → Verification → Evidence"));
      assert.ok(developer.instructions?.includes("Baseline"));
      assert.match(developer.instructions ?? "", /#### Context recovery/);
      assert.match(developer.instructions ?? "", /firstCompactedEntryId/);
      assert.ok(developer.strictProhibitions.some((p) => p.includes("禁止在没有复现或代码证据的情况下盲目猜测修改")));
    });

    it("7. Verifier Role only performs verification without implementing code", () => {
      const verifier = getRoleDefinition("verifier");
      const verifierCfg = getRoleConfig("verifier");
      assert.equal(verifier.id, "verifier");
      assert.equal(verifier.name, "验证者 (Verifier)");
      assert.equal(verifier.requiresWorktree, false, "Verifier does not require separate task worktree");
      assert.equal((verifier as any).allowedTools, undefined);
      assert.deepEqual(verifierCfg.allowedTools, ["read", "bash", "report_blocker", "read_transcript", "search_transcript", "read_artifact"]);
      assert.ok(verifier.strictProhibitions.some((p) => p.includes("默认禁止直接修改业务代码或替 Developer 修复问题")));
      assert.ok(verifier.instructions?.includes("PASS"));
      assert.ok(verifier.instructions?.includes("REWORK"));
      assert.ok(verifier.instructions?.includes("verdict"));
      assert.match(verifier.instructions ?? "", /#### Context recovery/);
    });

    it("8. Researcher Role performs technical research without implementation", () => {
      const researcher = getRoleDefinition("researcher");
      const researcherCfg = getRoleConfig("researcher");
      assert.equal(researcher.id, "researcher");
      assert.equal(researcher.name, "探子 (Scout)");
      assert.equal(researcher.requiresWorktree, false, "Researcher does not require worktree");
      assert.equal((researcher as any).allowedTools, undefined);
      assert.deepEqual(researcherCfg.allowedTools, ["read", "bash", "report_blocker", "read_transcript", "search_transcript", "read_artifact", "web_search"]);
      assert.equal(researcherCfg.allowedTools?.includes("url_context"), false);
      assert.match(researcher.instructions ?? "", /#### Web search/);
      assert.ok(researcher.strictProhibitions.some((p) => p.includes("禁止改动任何文件或项目状态")));
      assert.ok(researcher.strictProhibitions.some((p) => p.includes("禁止做方案取舍")));
      assert.match(researcher.instructions ?? "", /只读/);
      assert.match(researcher.instructions ?? "", /file:line/);
      assert.match(researcher.instructions ?? "", /探子/);
      assert.match(researcher.instructions ?? "", /#### Context recovery/);
    });
  });

  describe("3. ConstraintResolver & Runtime Config", () => {
    it("should resolve effective runtime configuration without rewriting task constraints", () => {
      const contract: TaskContract = {
        taskId: "task-001",
        parentSessionId: "session-001",
        role: "verifier",
        goal: "重构登录模块",
        constraints: [
          "禁止使用外部依赖",
          "不得伪造测试结果",
          "遵循代码风格规范",
        ],
        acceptanceCriteria: ["完成 Review 报告"],
      };

      const context = ConstraintResolver.resolve({
        role: "verifier",
        cwd: "/tmp/project",
        taskContract: contract,
      });

      assert.equal(context.role.id, "verifier");
      assert.deepEqual(context.runtime.activeTools, ["read", "bash", "report_blocker", "read_transcript", "search_transcript", "read_artifact"]);
      assert.equal(context.runtime.requiresWorktree, false);
      assert.deepEqual(context.taskContract?.constraints, contract.constraints);
    });

    it("should keep activeTools as empty array when allowedTools is explicitly [] without falling back to full tools", () => {
      const registry = RoleRegistry.getInstance();
      const verifier = registry.getRole("verifier");
      const emptyToolsRole: RoleConfigV2 = {
        ...verifier,
        allowedTools: [],
        definition: {
          ...verifier.definition,
        },
      };

      saveRolesConfig([emptyToolsRole]);
      RoleRegistry.getInstance().reload();
      const context = ConstraintResolver.resolve({
        role: "verifier",
        cwd: "/tmp/project",
      });

      assert.deepEqual(context.runtime.activeTools, []);
      assert.equal(context.runtime.activeTools.length, 0);

      // 恢复正常 roles
      saveRolesConfig(Object.values(DEFAULT_ROLES_V2).map((d) => convertDefinitionToConfig(d)));
      RoleRegistry.getInstance().reload();
    });

    it("should refuse to overwrite canonical Role Definition when disk roles.json has outdated definitionVersion", () => {
      const registry = RoleRegistry.getInstance();
      const rolesFile = rolesPath();
      const outdatedDiskPayload = [
        {
          schemaVersion: 2,
          roleDefinitionVersion: 1, // 旧版本号
          id: "coordinator",
          name: "Old Coordinator Name",
          definition: {
            id: "coordinator",
            definitionVersion: 1,
            name: "Old Coordinator",
            description: "Old description",
            responsibilities: ["根据 Reviewer / Tester 的结果组织返工与协调。"],
            strictProhibitions: ["禁止让 Reviewer / Tester 演变成负责修复问题的第二个 Fullstack Agent。"],
            instructions: "根据任务专业领域选择最合适的角色：Frontend (junior_fe), Backend (junior_be), Fullstack, Reviewer, Tester, Deployer",
          },
        },
      ];

      writeFileSync(rolesFile, JSON.stringify(outdatedDiskPayload, null, 2), "utf8");
      registry.reload();

      const coordinatorDef = registry.getDefinition("coordinator");
      assert.equal(coordinatorDef.definitionVersion, CURRENT_ROLE_DEFINITION_VERSION);
      // 验证旧角色体系被彻底拒绝，未覆盖 canonical
      assert.ok(!coordinatorDef.instructions?.includes("junior_fe"));
      assert.ok(!coordinatorDef.instructions?.includes("junior_be"));
      assert.ok(!coordinatorDef.instructions?.includes("Deployer"));
      assert.ok(coordinatorDef.instructions?.includes("Developer"));
      assert.ok(coordinatorDef.instructions?.includes("Verifier"));
      assert.ok(coordinatorDef.instructions?.includes("Researcher"));
      assert.ok(!coordinatorDef.responsibilities.some((r) => r.includes("Reviewer")));

      // 恢复正常 roles
      saveRolesConfig(Object.values(DEFAULT_ROLES_V2).map((d) => convertDefinitionToConfig(d)));
      registry.reload();
    });

    it("should parse Verifier PASS as canonical APPROVE and REWORK as canonical REQUEST_CHANGES", () => {
      const passOutput = `\`\`\`json
{
  "verdict": "PASS",
  "findings": []
}
\`\`\``;
      const passResult = tryParseReviewResult(passOutput);
      assert.ok(passResult);
      assert.equal(passResult.verdict, "APPROVE");
      assert.equal(passResult.onlyMinorFindings, true);

      const reworkOutput = `\`\`\`json
{
  "verdict": "REWORK",
  "findings": [
    {
      "id": "finding-1",
      "severity": "blocker",
      "file": "server/index.ts",
      "problem": "Uncaught null pointer",
      "evidence": "index.ts:42",
      "suggestedFix": "Add null check"
    }
  ]
}
\`\`\``;
      const reworkResult = tryParseReviewResult(reworkOutput);
      assert.ok(reworkResult);
      assert.equal(reworkResult.verdict, "REQUEST_CHANGES");
      assert.equal(reworkResult.findings[0]?.suggestedFix, "Add null check");
      assert.equal(reworkResult.onlyMinorFindings, false);

      // 文本 fallback
      const passFallback = tryParseReviewResult("经过仔细测试验证，所有检查全部 PASS！");
      assert.equal(passFallback?.verdict, "APPROVE");

      const reworkFallback = tryParseReviewResult("测试失败，需要 REWORK 并修复！");
      assert.equal(reworkFallback?.verdict, "REQUEST_CHANGES");
    });

    it("should verify Standard Mode default role has no report_blocker tool", () => {
      const context = ConstraintResolver.resolve({
        role: "default",
        cwd: "/tmp/project",
      });
      assert.deepEqual(context.runtime.activeTools, ["read", "bash", "edit", "write", "read_transcript", "search_transcript", "read_artifact"]);
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
        role: "developer",
        goal: "全栈特性",
        acceptanceCriteria: ["通过联调"],
      };

      const context = ConstraintResolver.resolve({
        role: "developer",
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

    it("projects assigned skills as a catalog and never inlines SKILL.md bodies into any prompt", () => {
      const project = mkdtempSync(join(tmpdir(), "pi-skill-catalog-"));
      const skillDir = join(project, ".agents", "skills", "harness-catalog-only-fixture");
      mkdirSync(skillDir, { recursive: true });
      const bodyMarker = "UNIQUE_SKILL_BODY_MUST_NEVER_ENTER_THE_SYSTEM_PROMPT";
      writeFileSync(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: harness-catalog-only-fixture",
          "description: Use when running the catalog-only skill projection fixture.",
          "---",
          "",
          `# Playbook`,
          bodyMarker,
          "Follow these long workflow instructions in every turn.",
        ].join("\n"),
        "utf8",
      );

      const registry = RoleRegistry.getInstance();
      const coordinator = registry.getRole("coordinator");
      saveRolesConfig([
        {
          ...coordinator,
          allowedSkills: ["harness-catalog-only-fixture"],
          definition: {
            ...coordinator.definition,
            allowedSkills: ["harness-catalog-only-fixture"],
          },
        },
      ]);
      RoleRegistry.getInstance().reload();

      try {
        const context = ConstraintResolver.resolve({
          role: "coordinator",
          cwd: project,
        });
        const assembled = PromptAssembler.assemble(context);
        const parsed = JSON.parse(assembled.systemPrompt);
        const catalog = parsed.assigned_skills;

        assert.equal(catalog.skills.length, 1);
        assert.equal(catalog.skills[0].name, "harness-catalog-only-fixture");
        assert.match(catalog.skills[0].description, /catalog-only skill projection fixture/);
        assert.equal(
          catalog.skills[0].location,
          ".agents/skills/harness-catalog-only-fixture/SKILL.md",
        );
        assert.equal(catalog.skills[0].workflow_instructions, undefined);
        assert.equal(catalog.skills[0].content, undefined);
        assert.match(String(catalog.load_policy), /read/i);
        assert.equal(assembled.systemPrompt.includes(bodyMarker), false);
        assert.equal(assembled.taskSystemPrompt.includes(bodyMarker), false);
        assert.equal(JSON.stringify(assembled.jsonPayload).includes(bodyMarker), false);
        assert.deepEqual(context.assignedSkills, [
          {
            name: "harness-catalog-only-fixture",
            description: "Use when running the catalog-only skill projection fixture.",
            location: ".agents/skills/harness-catalog-only-fixture/SKILL.md",
          },
        ]);
        assert.equal(assembled.globalStablePrefix.includes(skillDir), false);

        const native = adjustSkillsInBasePrompt("You are a coding agent.", ["harness-catalog-only-fixture"], project);
        assert.match(native, /harness-catalog-only-fixture/);
        assert.match(native, /<location>/);
        assert.equal(native.includes(bodyMarker), false);
      } finally {
        saveRolesConfig(Object.values(DEFAULT_ROLES_V2).map((d) => convertDefinitionToConfig(d)));
        RoleRegistry.getInstance().reload();
        rmSync(project, { recursive: true, force: true });
      }
    });

    it("should guarantee System Prompt prefix stability across consecutive tasks with different worktrees, branches, and taskIds", () => {
      // Task A
      const contextA = ConstraintResolver.resolve({
        role: "verifier",
        cwd: "/Users/dev/project/.pi/agent/worktrees/task-A",
        projectRoot: "/Users/dev/project",
        branchName: "pi-subagent-task-A",
        worktreePath: "/Users/dev/project/.pi/agent/worktrees/task-A",
        taskContract: {
          taskId: "task-A",
          parentSessionId: "session-1",
          role: "verifier",
          goal: "Verify subagent CK isolation",
        },
      });

      // Task B
      const contextB = ConstraintResolver.resolve({
        role: "verifier",
        cwd: "/Users/dev/project/.pi/agent/worktrees/task-B",
        projectRoot: "/Users/dev/project",
        branchName: "pi-subagent-task-B",
        worktreePath: "/Users/dev/project/.pi/agent/worktrees/task-B",
        taskContract: {
          taskId: "task-B",
          parentSessionId: "session-1",
          role: "verifier",
          goal: "Verify subagent MinIO backup",
        },
      });

      // Task C
      const contextC = ConstraintResolver.resolve({
        role: "verifier",
        cwd: "/Users/dev/project/.pi/agent/worktrees/task-C",
        projectRoot: "/Users/dev/project",
        branchName: "pi-subagent-task-C",
        worktreePath: "/Users/dev/project/.pi/agent/worktrees/task-C",
        taskContract: {
          taskId: "task-C",
          parentSessionId: "session-1",
          role: "verifier",
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
      assert.equal(userPromptA.includes("Run CK tests"), false);
    });

    it("places resolved runtime model identity between global prefix and task suffix", () => {
      const context = ConstraintResolver.resolve({
        role: "developer",
        cwd: "/tmp/project",
        taskContract: {
          taskId: "task-model-1",
          parentSessionId: "session-1",
          role: "developer",
          goal: "implement",
        },
      });
      const assembled = PromptAssembler.assemble(context, {
        runtimeModel: { provider: "anthropic", id: "claude-fallback-sonnet" },
      });

      assert.equal(assembled.globalStablePrefix.includes("claude-fallback-sonnet"), false);
      assert.equal(assembled.globalStablePrefix.includes("runtime_model"), false);
      assert.ok(assembled.taskSystemPrompt.startsWith(assembled.globalStablePrefix));
      const modelIdx = assembled.taskSystemPrompt.indexOf("claude-fallback-sonnet");
      const taskIdx = assembled.taskSystemPrompt.indexOf("TASK_SCOPED_STABLE_PREFIX");
      assert.ok(modelIdx > assembled.globalStablePrefix.length);
      assert.ok(taskIdx > modelIdx);
      assert.match(assembled.systemPrompt, /"provider": "anthropic"/);
      assert.equal(assembled.systemPrompt.includes("configured-target-model"), false);
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

  describe("7. Subagent kickoff and task-stable boundaries", () => {
    it("keeps legacy memory out of the kickoff user turn", () => {
      const prompt = buildSubagentUserPrompt(
        "Investigate ClickHouse clean config",
        {
          taskId: "task-test-mem-1",
          parentSessionId: "parent-1",
          role: "developer",
          goal: "Verify CK isolation",
        },
      );

      assert.ok(prompt.includes("## Task Kickoff"));
      assert.ok(prompt.includes("assigned immutable Task Contract"));
      assert.equal(prompt.includes("Investigate ClickHouse clean config"), false);
      assert.equal(prompt.includes("Initial instruction:"), false);
      assert.equal(prompt.includes("Working Memory"), false);
      assert.equal(prompt.includes("Process Journal"), false);
    });
  });
});
