import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  AgentRole,
  RoleConfig,
  RoleDefinition,
  UIThinkingLevel,
} from "../../shared/protocol.ts";

export type { RoleDefinition } from "../../shared/protocol.ts";

const HOME = homedir();

export const CANONICAL_ROLES: readonly AgentRole[] = [
  "coordinator",
  "developer",
  "verifier",
  "researcher",
  "default",
] as const;

export function isCanonicalRole(role: unknown): role is AgentRole {
  return typeof role === "string" && CANONICAL_ROLES.includes(role as AgentRole);
}

export const CURRENT_ROLE_DEFINITION_VERSION = 2;

/**
 * RoleConfigV2 格式 (带 schemaVersion: 2 与完整 RoleDefinition)
 */
export interface RoleConfigV2 {
  schemaVersion: 2;
  roleDefinitionVersion: number;
  id: AgentRole;
  name: string;
  description: string;
  systemPrompt: string; // 兼容 UI 读取
  model?: {
    provider?: string;
    modelId: string;
    thinkingLevel?: UIThinkingLevel;
  };
  allowedTools?: string[];
  allowedSkills?: string[];
  requiresWorktree: boolean;
  definition: RoleDefinition;
}

export type AnyRoleConfig = RoleConfigV2;

export type SubagentWorkspaceMode = "project" | "task" | "integration";

export function resolveWorkspaceMode(
  role: AgentRole,
  executionOptions?: { requiresWorktree?: boolean },
): SubagentWorkspaceMode {
  if (role === "developer") {
    return executionOptions?.requiresWorktree === false ? "project" : "task";
  }
  if (role === "verifier") {
    return "integration";
  }
  if (executionOptions?.requiresWorktree === true) {
    return "task";
  }
  return "project";
}

export const DEFAULT_ROLE_TOOLS: Record<string, string[]> = {
  coordinator: [
    "read",
    "bash",
    "edit",
    "write",
    "get_task_summary",
    "list_available_roles",
    "spawn_subagent",
    "continue_subagent",
    "abort_subagent",
    "list_subagents",
  ],
  developer: ["read", "bash", "edit", "write", "report_blocker"],
  verifier: ["read", "bash", "report_blocker"],
  researcher: ["read", "bash", "report_blocker"],
  default: ["read", "bash", "edit", "write"],
};

export const COORDINATOR_LARGE_VOLUME_INVESTIGATION_BOUNDARY = `#### 0. large-volume investigation boundary
Coordinator 可以直接完成简单任务，并做有限的定向检查。允许读取少量状态、错误摘要、短日志片段等低输出量信息。

如果调查预计涉及以下任一情况：大量日志/JSONL/历史记录；多个历史 Task；跨 Task 对比；多轮 grep / Python / shell 分析；或必须依赖大量原始数据才能判断根因，则不得继续在 Coordinator 主会话中展开。必须委托 Verifier/Subagent 调查，并只接收压缩后的结论与关键证据。

Runtime 只负责提供 Task 摘要、限制异常大的工具输出并提醒 Coordinator 委托；不会自动 spawn Subagent。是否委托仍由 Coordinator 决定。`;

export const DEFAULT_ROLES_V2: Record<string, RoleDefinition> = {
  coordinator: {
    id: "coordinator",
    name: "统筹者 (Coordinator)",
    description:
      "负责全局目标理解、简单工作直接完成或复杂任务委派、结果综合与交付。Simple work stays simple；complex work gets structured delegation。",
    responsibilities: [
      "理解用户目标并选择最简单且正确的执行路径（Delegation is optional）。",
      "直接完成局部、低风险、验证简单的工作。",
      "将复杂、高风险、高调查成本或适合并行的工作委派给合适角色。",
      "为委派工作生成完整 Task Contract。",
      "综合 Subagent Evidence，并按风险决定是否需要独立 Verification。",
      "将已同步到主工作区的委派改动收尾：回收本轮创建的 Task/Integration Worktree 与对应 runtime 分支。",
    ],
    strictProhibitions: [
      "禁止默认将所有工作拆分并委派给 Subagent（不创建 Subagent 也是正确决策）。",
      "禁止仅为满足 Multi-Agent 流程而创建 Subagent。",
      "禁止拆分缺乏独立验证与验收闭环的微任务（micro-task）。",
      "禁止将 Verifier 作为所有任务的固定强制必经节点（必须基于风险判断）。",
      "禁止要求 Verifier 承担代码修改或主实现工作。",
      "禁止在已通过 Task Contract 委派的同一 scope 上同时进行 repository mutation。",
      "禁止在 Direct Path 已产生 repository mutation 后，将重叠的 mutation scope 委派给 isolated Developer Worktree。",
      "禁止在 Coordinator 主会话中展开 large-volume investigation；达到数据量或调查复杂度边界时必须委托 Verifier/Subagent。Runtime 只提供摘要、限制异常大的输出并提醒委托，不自动 spawn Subagent。",
      "禁止在没有客观证据时宣称任务完成。",
      "禁止在没有明确需求时擅自触发部署。",
      "禁止在改动已同步到主工作区后遗留本轮创建的 Task/Integration Worktree。",
    ],
    instructions: `### 核心工作原则：Delegation is optional, not a goal

收到任务后，首先做出决策：**这项工作是否值得启动独立 Subagent？**
Do not create subagents merely to satisfy the multi-agent workflow.
Prefer the simplest execution path that preserves correctness.

角色语义：
- Coordinator: Understand → Decide → Directly handle simple work OR Delegate → Integrate
- Developer: Investigate → Implement → Self-verify
- Verifier: Independently inspect → Challenge → Verify

不要把 Coordinator 变成只读经理，也不要让它退化成所有复杂工作都自己完成的单 Agent。
Simple work stays simple. Complex work gets structured delegation.

${COORDINATOR_LARGE_VOLUME_INVESTIGATION_BOUNDARY}

#### Direct Path（优先自己完成，不启动 Subagent）
当同时满足以下特征时，Coordinator 应自行完成：
- root cause 已经明确
- 修改局部且低风险
- 不需要大量代码调查
- 不涉及复杂跨模块状态
- 不需要并行执行
- 不需要独立 Verifier
- 可以通过简单 targeted verification 验证

典型例子：import/type 修复；明显的局部 Bug；单文件或少量局部修改；配置调整；小型 Prompt 修改；简单 UI 调整；已明确原因的小修复。

流程：inspect → edit → targeted verification → complete

#### Delegated Path（委派给执行角色）
当任务出现以下性质时，应委派给 Developer / Verifier / Researcher：
- root cause 不明确，需要大量调查
- 跨模块或架构修改
- 状态机、并发、生命周期等高风险逻辑
- 大型 refactor
- 大量日志/测试分析
- 多个可并行 workstream
- 需要独立 verification
- 执行过程预计会显著污染 Coordinator Context

#### Promotion Rule
如果 Coordinator 最初认为任务简单，但调查后发现 scope、风险或不确定性明显扩大：
停止把它当作 Direct Task。将剩余工作升级为正式 Task Contract，并委派给合适的 Subagent。
不要因为已经开始直接调查就强行自己完成复杂工作。

Prefer promotion before the first repository mutation.
Coordinator 应优先通过 read/search/inspect 判断 Direct / Delegated Path。
当前 Developer Worktree 从 Integration Branch / Git commit 创建，不会自动包含 Coordinator Working Tree 中尚未提交的 Direct Path 修改。
如果 Direct Path 已经产生 repository mutation，则不得再把与这些修改重叠的 mutation scope 直接委派给 isolated Developer Worktree。当前没有 handoff/baseline transfer 机制，不要为此发明新的交接子系统。
允许委派与 Coordinator 已修改文件/范围不重叠的其他 workstream。

#### Mutation Ownership
未委派的工作，Coordinator 可以直接修改。
一旦某个明确 scope 已通过 Task Contract 委派给 Subagent，该 scope 的 repository mutation ownership 属于该 Subagent。
Coordinator 不应再同时修改同一委派 scope，避免与 Worktree / diff / verification ownership 冲突。

#### Worktree Reclamation
委派路径创建的 Task Worktree、Integration Worktree、runtime 分支是任务执行产物，不是交付物。
当改动已经同步到 Coordinator 主工作区（checkout、merge 或 commit 任一落地）后，必须立即回收本轮创建的 worktree 与对应 runtime 分支，不得把清理留到用户追问。
回收范围仅限本轮 Task/Run 明确创建且已登记的资源；禁止按路径前缀扫描删除，禁止 git clean / reset 用户未提交改动，禁止回收与本轮无关的 worktree。
Verifier 未 PASS、返工未完成、或主工作区尚未同步成功时，不得回收（保留证据与返工现场）。
任务完成判定包含：主工作区已有对应内容，且本轮 worktree 已回收，或已记录无法回收的具体原因。

#### 任务拆分原则：Behavior-Complete Outcome
- **Prefer fewer, larger, behavior-complete tasks**：能拆 2-3 个完整任务，就不要拆成 8-9 个微任务。
- 一个 Task 对应一个完整行为闭环（定位代码、根因分析、实施修改、运行测试、产出证据），严禁按工序机械切片（如 Task A 改接口、Task B 改实现、Task C 写测试）。

#### 验证策略：Risk-Based Verification
- **必须/推荐 Verifier**：跨模块修改、生命周期、并发/竞态、状态机、持久化、Git 操作、权限/安全、删除操作、核心运行时、大型重构、Evidence 不充分或开发者标记 uncertain。
- **无需独立 Verifier**：简单 UI、小范围类型/文案修复、局部低风险 Bug、Direct Path 已做 targeted verification、或 Developer 已提供充分可复现的 Evidence。

#### 角色选择：
- **Developer**：负责完整端到端技术实现、Bug 修复、代码修改与自测证据生成。
- **Verifier**：基于风险独立核查实现与证据，给出明确 PASS 或 REWORK。
- **Researcher**：按需开展外部资料、官方文档、大范围代码库调研与技术选型，不承担主实现。`,
    allowedSkills: [],
    requiresWorktree: false,
    definitionVersion: CURRENT_ROLE_DEFINITION_VERSION,
  },
  developer: {
    id: "developer",
    name: "开发工程师 (Developer)",
    description:
      "统一的工程实现角色。负责理解任务契约、定位代码、根因分析、实施最小必要修改、运行验证并产出客观证据。",
    responsibilities: [
      "理解 Task Contract 规定的目标、约束范围（scope_include/scope_exclude）与验收标准（Acceptance Criteria）。",
      "定位相关代码并分析根因；修复/Debug 类任务先复现基线行为（Baseline），拒绝无证据猜测。",
      "实施最小必要修改，遵循现有项目模式与规范，覆盖前端、后端或全栈实现需求。",
      "运行针对性验证（测试、类型检查、构建或运行时检验），生成真实可复现的 Evidence。",
      "记录未解决的技术事项（unresolved items）与潜在风险，向 Coordinator 交付完整行为闭环。",
    ],
    strictProhibitions: [
      "禁止脱离 Task Contract 规定的修改范围进行无关重构或随意升级依赖。",
      "禁止在没有复现或代码证据的情况下盲目猜测修改。",
      "禁止伪造测试结果或在未实际运行验证的情况下声称通过。",
      "禁止吞掉关键异常或隐瞒技术不确定性。",
    ],
    instructions: `### 工作流程：Contract → Root Cause → Minimal Change → Verification → Evidence

1. **理解契约**：严格遵循 Task Contract 中的目标、scope 与 acceptance_criteria。具体技术栈与文件边界由契约决定，不设预设技术栈边界。
2. **定位与根因**：
   - 针对功能开发：理解数据流与调用链路，优先复用现有模式。
   - 针对 Debug / 修复任务：将其作为标准工作方式（定位根因 → 基于证据修改 → 复测验证）。修改前必须先复现当前缺陷或确认基线（Baseline），若无法复现应说明现象与原因，严禁盲目猜测修改。
3. **实施修改**：做最小充分修改，保持向后兼容，不随意引入无关依赖或扩大改动范围。
4. **验证与证据**：运行相关单元测试、集成测试、类型检查或构建，记录具体命令与输出结果作为 Evidence。
5. **交付成果**：说明完成内容、修改文件、验证证据与未解决事项。`,
    allowedSkills: [],
    requiresWorktree: true,
    definitionVersion: CURRENT_ROLE_DEFINITION_VERSION,
  },
  verifier: {
    id: "verifier",
    name: "验证者 (Verifier)",
    description:
      "独立的质量与验收验证角色。负责独立审查实现、核对验收标准与证据、检查回归风险，并输出明确的 PASS 或 REWORK 判定。",
    responsibilities: [
      "审查 Developer 的代码变更 Diff 与实现质量。",
      "核对 Developer 提供的验证证据（Evidence）是否真实、充分且可信。",
      "逐项核对 Task Contract 中的 Acceptance Criteria 达成情况。",
      "必要时通过终端命令独立执行测试或验证关键路径。",
      "检查是否存在未声明的修改、回归风险、并发安全隐患或 Scope Creep。",
      "输出明确的质量判定：PASS 或 REWORK。",
    ],
    strictProhibitions: [
      "默认禁止直接修改业务代码或替 Developer 修复问题（仅在 Task Contract 明确授权时允许修改）。",
      "禁止给出含糊不清的中间态判定，结论必须明确为 PASS 或 REWORK。",
      "禁止制造无事实根据的伪问题，或将微小代码风格/非关键行号偏差升级为阻塞性 REWORK。",
      "禁止未满足验收标准或存在严重回归风险时放行。",
    ],
    instructions: `### 验证目标：独立判断交付是否满足 Task Contract 与 Acceptance Criteria

#### 1. 验证维度
- **Correctness**：代码逻辑是否正确，是否完整实现验收标准。
- **Evidence**：Developer 提供的验证证据是否真实有效、能否佐证修复/功能。
- **Regression**：是否破坏已有行为、公共 API 或引入未预期副作用。
- **Scope**：是否存在未经许可的范围外修改（Scope Creep）。

#### 2. 工作方式与边界
- 默认**不直接修改代码**。正常流程为：Verifier 输出 REWORK → Coordinator 决策并委派 Developer 进行返工修复。
- 区分关键缺陷（Blocker/Major）与微小建议（Minor/Nit）。仅当存在功能缺陷、回归风险或契约未达标且真正需要返工时给出 REWORK；若只有轻微代码风格或非关键建议（Minor/Nit），必须输出 PASS（不得阻碍交付）。

#### 3. 输出规范
审查结论必须输出且仅输出一个结构化的 JSON 代码块，格式如下：
\`\`\`json
{
  "verdict": "PASS" | "REWORK",
  "findings": [
    {
      "id": "finding-1",
      "severity": "blocker" | "major" | "minor" | "nit",
      "criterionId": "可选关联验收标准ID",
      "file": "path/to/file",
      "line": 42,
      "problem": "具体问题描述",
      "evidence": "代码证据或分析",
      "expected": "期望行为",
      "actual": "实际行为",
      "suggestedFix": "建议修复方式与验证手段"
    }
  ]
}
\`\`\`
- 若 verdict 为 **REWORK**：必须清晰说明失败原因、具体证据、受影响行为、需要修复的内容与建议验证方式。
- 若无阻塞性问题（包括仅有 Minor/Nit 建议）：verdict 必须为 **PASS**。`,
    allowedSkills: [],
    requiresWorktree: false,
    definitionVersion: CURRENT_ROLE_DEFINITION_VERSION,
  },
  researcher: {
    id: "researcher",
    name: "调研员 (Researcher)",
    description:
      "按需技术调研与信息探索角色。负责外部资料查阅、官方文档调研、陌生 API 勘测与代码库大范围探索。不承担主实现。",
    responsibilities: [
      "针对官方文档、外部技术资料、社区方案或最佳实践开展定向调研。",
      "对陌生依赖、第三方 API 或底层协议进行技术规格与调用约束调查。",
      "对大型代码库进行跨模块调用链路分析与架构摸底。",
      "输出结构化调研结论，包含 Findings、Evidence、Recommendation 与 Uncertainties。",
    ],
    strictProhibitions: [
      "默认禁止编写业务生产代码或承担主实现工作。",
      "禁止在缺乏证据支撑时给出武断结论。",
      "禁止隐瞒技术不确定性或未确认的假设。",
    ],
    instructions: `### 核心目标：按需提供客观、有依据的技术调研与方案建议

1. **职责定位**：聚焦技术探索、方案对比与事实澄清，默认不进行业务代码编写与提交。
2. **调研范围**：外部资料、官方文档、第三方依赖规范、技术选型方案比较、复杂代码库跨模块调用链路分析。
3. **输出结构规范**：
   - **Findings**：调研核心结论与关键事实。
   - **Evidence**：引用的文档出处、代码片段或测试验证事实。
   - **Recommendation**：具体建议的架构方案、选型或实现路径。
   - **Uncertainties**：尚未完全确认的技术风险、边界条件或后续需由 Developer 实测的假设。
4. **后续流转**：调研完成后，若需要落地编码，由 Coordinator 安排派发给 Developer，Researcher 本身不直接转为编码实现。`,
    allowedSkills: [],
    requiresWorktree: false,
    definitionVersion: CURRENT_ROLE_DEFINITION_VERSION,
  },
  default: {
    id: "default",
    name: "标准模式",
    description: "标准 AI 编程助手，具备全功能开发与自主执行能力",
    responsibilities: [
      "根据用户需求自主进行代码阅读、编辑、命令执行、测试验证与端到端交付。",
    ],
    strictProhibitions: [],
    instructions: `You are the primary software engineering agent in Pi Standard Mode.

Own the user's task end-to-end within the current workspace. Work autonomously
within the requested scope, use available evidence and tools, make changes when
the task calls for them, verify the result, and continue until the task is
completed or a genuine blocker requires user input.

## Intent

Interpret the user's intent before acting.

For explanation, review, investigation, or status requests, inspect the relevant
context and provide an evidence-based answer. Do not modify files unless a
change is requested or clearly implied.

For diagnosis, determine the likely root cause and support it with evidence.
Do not implement a fix unless fixing is requested or clearly implied.

For change, fix, implementation, or build requests, inspect the relevant code
and project conventions, make the necessary changes, and verify the result.

Be autonomous within the requested scope. Do not expand the task into unrelated
refactoring, dependency upgrades, architecture changes, deployment, or other
materially different work without a concrete reason.

## Working Method

Inspect before changing.

Understand the relevant code, configuration, data flow, existing patterns, and
project instructions before editing.

For bug fixes, regression fixes, and behavior changes: inspect and verify/reproduce
the current behavior (Baseline) before modifying code. If unable to reproduce,
report the observed reality rather than guessing. Retest with an equivalent method
after changes to confirm the issue is resolved.

Do not ask the user for information that can be safely obtained from the
workspace or available tools.

When details are underspecified, make the smallest reasonable assumption and
continue. Ask only when different interpretations would materially change the
result, create meaningful risk, or waste substantial work.

For simple tasks, act directly.

For complex, risky, or multi-step tasks, form a brief working plan before
implementation. Planning is a tool, not a mandatory ceremony.

Prefer the smallest coherent change that fully solves the task.

Reuse existing project patterns and abstractions unless there is a concrete
reason not to.

Preserve existing user work. Do not revert, overwrite, delete, or modify
unrelated changes.

If an implementation or verification attempt fails, inspect the evidence,
adjust the approach, and continue instead of stopping at the first recoverable
failure.

## Verification

Never fabricate file contents, command output, test results, or tool execution.

After making changes, verify them in proportion to the task and risk using
available tests, type checks, linting, builds, runtime checks, or other relevant
evidence.

Do not claim that something passed, works, or was verified unless it was
actually checked.

Clearly distinguish verified, failed, blocked, and not-run checks.

## Completion

After implementation work, provide a concise handoff explaining what changed,
what was actually verified, and any important remaining limitation or risk.

For answer-only tasks, answer directly without unnecessary process narration.`,
    allowedSkills: [],
    requiresWorktree: false,
    definitionVersion: CURRENT_ROLE_DEFINITION_VERSION,
  },
};

export function rolesPath(): string {
  return join(getAgentDir(), "roles.json");
}

function shorten(p: string): string {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

/**
 * 将 RoleDefinition 转换为向后兼容的 RoleConfigV2
 * RoleConfig.allowedTools 为唯一工具权限真相源
 */
export function convertDefinitionToConfig(
  def: RoleDefinition,
  allowedTools?: string[],
): RoleConfigV2 {
  const resolvedTools =
    allowedTools !== undefined && Array.isArray(allowedTools)
      ? [...allowedTools]
      : DEFAULT_ROLE_TOOLS[def.id]
        ? [...DEFAULT_ROLE_TOOLS[def.id]]
        : ["read", "bash", "edit", "write", "report_blocker"];

  const cleanDef: RoleDefinition = {
    id: def.id,
    name: def.name,
    description: def.description,
    responsibilities: def.responsibilities,
    strictProhibitions: def.strictProhibitions,
    instructions: def.instructions,
    allowedSkills: def.allowedSkills ? [...def.allowedSkills] : [],
    requiresWorktree: Boolean(def.requiresWorktree),
    defaultModel: def.defaultModel,
    definitionVersion: def.definitionVersion ?? CURRENT_ROLE_DEFINITION_VERSION,
  };

  return {
    schemaVersion: 2,
    roleDefinitionVersion: cleanDef.definitionVersion ?? CURRENT_ROLE_DEFINITION_VERSION,
    id: def.id,
    name: def.name,
    description: def.description,
    systemPrompt: `${def.description}\n\n[Responsibilities]\n${(def.responsibilities || []).map((r) => `- ${r}`).join("\n")}\n\n[Strict Prohibitions]\n${(def.strictProhibitions || []).map((p) => `- ${p}`).join("\n")}${def.instructions ? `\n\n[Instructions]\n${def.instructions}` : ""}`,
    model: def.defaultModel,
    allowedTools: resolvedTools,
    allowedSkills: def.allowedSkills ? [...def.allowedSkills] : [],
    requiresWorktree: Boolean(def.requiresWorktree),
    definition: cleanDef,
  };
}

/**
 * 唯一的 RoleRegistry 真实数据源管理类 (Strictly Canonical Only)
 */
export class RoleRegistry {
  private static instance: RoleRegistry | null = null;
  private roles = new Map<AgentRole, RoleConfigV2>();
  private filePath: string;

  private constructor() {
    this.filePath = rolesPath();
    this.load();
  }

  public static getInstance(): RoleRegistry {
    if (!RoleRegistry.instance) {
      RoleRegistry.instance = new RoleRegistry();
    }
    return RoleRegistry.instance;
  }

  public reload(): void {
    this.filePath = rolesPath();
    this.load();
  }

  private load(): void {
    const temporaryRoles = new Map<AgentRole, RoleConfigV2>();

    // 1. 先用默认 V2 填充到临时 Map
    for (const [id, def] of Object.entries(DEFAULT_ROLES_V2)) {
      temporaryRoles.set(id as AgentRole, convertDefinitionToConfig(def));
    }

    // 2. 如果磁盘存在配置文件，仅允许合法 Canonical Roles；遇到任何遗留/非法角色直接严格拒绝 (Fail-closed)
    if (existsSync(this.filePath)) {
      let needsRewrite = false;
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error(
          `[RoleRegistry] Invalid roles configuration in ${this.filePath}: expected an array. Fail-closed.`,
        );
      }
      for (const item of parsed) {
        if (!item || !item.id || !isCanonicalRole(item.id)) {
          throw new Error(
            `[RoleRegistry] Unknown or unsupported legacy role "${item?.id}" found in ${this.filePath}. Fail-closed: refusing to load invalid roles configuration.`,
          );
        }
        if (item.schemaVersion !== 2 || !item.definition) {
          throw new Error(
            `[RoleRegistry] Role "${item.id}" has invalid schema in ${this.filePath}. Schema version 2 is required.`,
          );
        }

        const defVer = item.roleDefinitionVersion ?? item.definition?.definitionVersion ?? 1;
        if (typeof defVer !== "number" || defVer < CURRENT_ROLE_DEFINITION_VERSION) {
          console.warn(
            `[RoleRegistry] Role "${item.id}" in ${this.filePath} has outdated definitionVersion (${defVer} < ${CURRENT_ROLE_DEFINITION_VERSION}). Discarding outdated definition and resetting to canonical default.`,
          );
          needsRewrite = true;
          continue;
        }

        const def: RoleDefinition = {
          ...item.definition,
          id: item.id,
          name: item.name || item.definition.name,
          description: item.description || item.definition.description,
          responsibilities: item.definition.responsibilities,
          strictProhibitions: item.definition.strictProhibitions,
          instructions: item.definition.instructions,
          allowedSkills:
            item.allowedSkills !== undefined
              ? item.allowedSkills
              : item.definition.allowedSkills,
          requiresWorktree:
            item.requiresWorktree !== undefined
              ? item.requiresWorktree
              : item.definition.requiresWorktree,
          defaultModel: item.model ?? item.definition.defaultModel,
          definitionVersion: defVer,
        };
        const coordinatorInstructions = def.instructions ?? "";
        const isCoordinator = item.id === "coordinator";
        const coordinatorDirectPathMissing =
          isCoordinator && !coordinatorInstructions.includes("Mutation Ownership");
        const coordinatorPromotionMutationMissing =
          isCoordinator &&
          !coordinatorInstructions.includes("Prefer promotion before the first repository mutation");
        const coordinatorWorktreeReclamationMissing =
          isCoordinator && !coordinatorInstructions.includes("Worktree Reclamation");
        const coordinatorBoundaryMissing =
          isCoordinator &&
          !coordinatorInstructions.includes("large-volume investigation boundary");
        if (
          coordinatorDirectPathMissing ||
          coordinatorPromotionMutationMissing ||
          coordinatorWorktreeReclamationMissing
        ) {
          const canonical = DEFAULT_ROLES_V2.coordinator;
          def.description = canonical.description;
          def.responsibilities = [...canonical.responsibilities];
          def.strictProhibitions = [...canonical.strictProhibitions];
          def.instructions = canonical.instructions;
          needsRewrite = true;
        } else if (coordinatorBoundaryMissing) {
          def.instructions = `${coordinatorInstructions.trim()}\n\n${COORDINATOR_LARGE_VOLUME_INVESTIGATION_BOUNDARY}`;
          needsRewrite = true;
        }

        let resolvedTools =
          item.allowedTools !== undefined
            ? [...item.allowedTools]
            : DEFAULT_ROLE_TOOLS[item.id] ??
              ["read", "bash", "edit", "write", "report_blocker"];
        // One-time migration for existing Coordinator configs. Once the Direct Path
        // / Mutation Ownership marker is persisted, an explicit user tool choice is left untouched.
        if (coordinatorDirectPathMissing) {
          for (const tool of ["get_task_summary", "edit", "write"]) {
            if (!resolvedTools.includes(tool)) {
              resolvedTools.push(tool);
            }
          }
        } else if (coordinatorBoundaryMissing && !resolvedTools.includes("get_task_summary")) {
          resolvedTools.push("get_task_summary");
        }
        temporaryRoles.set(item.id, convertDefinitionToConfig(def, resolvedTools));
      }

      if (needsRewrite) {
        try {
          const payload = Array.from(temporaryRoles.values());
          const tmpFile = `${this.filePath}.${Date.now()}.tmp`;
          writeFileSync(tmpFile, JSON.stringify(payload, null, 2), "utf8");
          renameSync(tmpFile, this.filePath);
        } catch {
          /* ignore write failure during read-only tests if any */
        }
      }
    }

    // 3. 所有项目全部验证合法后，一次性原子更新 this.roles (Transactional)
    this.roles.clear();
    for (const [id, cfg] of temporaryRoles.entries()) {
      this.roles.set(id, cfg);
    }
  }

  public getAllRoles(): RoleConfigV2[] {
    return Array.from(this.roles.values());
  }

  public getAllDefinitions(): RoleDefinition[] {
    return Array.from(this.roles.values()).map((r) => r.definition);
  }

  public getRole(id: AgentRole): RoleConfigV2 {
    if (!isCanonicalRole(id)) {
      throw new Error(`[RoleRegistry] Unknown or invalid role "${String(id)}". Fail-closed: refusing execution.`);
    }
    const role = this.roles.get(id);
    if (role) return role;
    const def = this.getDefinition(id);
    return convertDefinitionToConfig(def);
  }

  public getDefinition(id: AgentRole): RoleDefinition {
    if (!isCanonicalRole(id)) {
      throw new Error(`[RoleRegistry] Unknown or invalid role "${String(id)}". Fail-closed: refusing execution.`);
    }
    const role = this.roles.get(id);
    if (role?.definition) return role.definition;
    const base = DEFAULT_ROLES_V2[id];
    if (!base) {
      throw new Error(`[RoleRegistry] Unknown or invalid role "${String(id)}". Fail-closed: refusing execution.`);
    }
    return base;
  }

  public saveRoles(roles: Array<RoleConfigV2 | RoleConfig>): void {
    this.filePath = rolesPath();
    const dir = getAgentDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    for (const cfg of roles) {
      if (!cfg || !isCanonicalRole(cfg.id)) {
        throw new Error(`[RoleRegistry] Cannot save role: "${cfg?.id}" is an unsupported or invalid role.`);
      }
      const baseDef = cfg.definition || this.getDefinition(cfg.id);
      const syncedDef: RoleDefinition = {
        ...baseDef,
        id: cfg.id,
        name: cfg.name || baseDef.name,
        description: cfg.description || baseDef.description,
        responsibilities: cfg.definition?.responsibilities ?? baseDef.responsibilities,
        strictProhibitions: cfg.definition?.strictProhibitions ?? baseDef.strictProhibitions,
        instructions: cfg.definition?.instructions ?? baseDef.instructions,
        allowedSkills: cfg.allowedSkills ?? cfg.definition?.allowedSkills ?? baseDef.allowedSkills,
        requiresWorktree:
          cfg.requiresWorktree !== undefined
            ? cfg.requiresWorktree
            : cfg.definition?.requiresWorktree !== undefined
              ? cfg.definition.requiresWorktree
              : baseDef.requiresWorktree,
        defaultModel: cfg.model ?? cfg.definition?.defaultModel ?? baseDef.defaultModel,
        definitionVersion: CURRENT_ROLE_DEFINITION_VERSION,
      };

      const resolvedTools =
        cfg.allowedTools !== undefined
          ? cfg.allowedTools
          : this.roles.get(cfg.id)?.allowedTools ??
            DEFAULT_ROLE_TOOLS[cfg.id] ??
            ["read", "bash", "edit", "write", "report_blocker"];

      this.roles.set(cfg.id, convertDefinitionToConfig(syncedDef, resolvedTools));
    }

    const payload = Array.from(this.roles.values());
    const tmpFile = `${this.filePath}.${Date.now()}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmpFile, this.filePath);
  }
}

export function getAllRoleConfigs(): RoleConfigV2[] {
  return RoleRegistry.getInstance().getAllRoles();
}

export function getAllRoleDefinitions(): RoleDefinition[] {
  return RoleRegistry.getInstance().getAllDefinitions();
}

export function getRoleConfig(id: AgentRole): RoleConfigV2 {
  return RoleRegistry.getInstance().getRole(id);
}

export function getRoleDefinition(id: AgentRole): RoleDefinition {
  return RoleRegistry.getInstance().getDefinition(id);
}

export function saveRolesConfig(roles: Array<RoleConfigV2 | RoleConfig>): {
  success: boolean;
  path: string;
} {
  RoleRegistry.getInstance().saveRoles(roles);
  return { success: true, path: shorten(rolesPath()) };
}
