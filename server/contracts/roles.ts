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
import { CHINESE_LANGUAGE_GUIDANCE, ensureChineseLanguageGuidance } from "./rules.ts";

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

export const CURRENT_ROLE_DEFINITION_VERSION = 4;

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
    "read_transcript",
    "search_transcript",
    "read_artifact",
    "web_search",
  ],
  developer: ["read", "bash", "edit", "write", "report_blocker", "read_transcript", "search_transcript", "read_artifact"],
  verifier: ["read", "bash", "report_blocker", "read_transcript", "search_transcript", "read_artifact"],
  researcher: ["read", "bash", "report_blocker", "read_transcript", "search_transcript", "read_artifact", "web_search"],
  default: ["read", "bash", "edit", "write", "read_transcript", "search_transcript", "read_artifact"],
};

export const COORDINATOR_EPISODE_QUERY_BOUNDARY = `#### Task evidence query
Use get_task_summary for other Tasks; it returns a bounded, non-authoritative evidence view.
Recovery tools are for the current session/task after compaction. Pass conclusions, context_files and commit/path references across Tasks, not foreign artifacts:// refs.`;

export const WEB_SEARCH_PROMPT_MARKER = "#### Web search";

export const COORDINATOR_WEB_SEARCH_GUIDANCE = `#### Web search
需要现网信息（官方文档、包版本、API 变更、新闻）时，可直接使用 web_search。不要仅为搜索而委派 Researcher。`;

export const RESEARCHER_WEB_SEARCH_GUIDANCE = `#### Web search
查阅现网资料、官方文档、包版本与外部事实时使用 web_search，并在 Evidence 中引用返回的来源。`;

export const DEFAULT_ROLES_V2: Record<string, RoleDefinition> = {
  coordinator: {
    id: "coordinator",
    name: "统筹者 (Coordinator)",
    description:
      "负责理解用户目标、架构设计、任务拆分、委派协调、证据综合与最终决策。",
    responsibilities: [
      "理解用户目标并选择最简单且正确的执行路径；委派是可选手段，不是任务目标。",
      "负责架构设计、任务拆分与最终决策，直接完成局部低风险工作。",
      "将复杂、高风险、高调查成本或适合并行的工作委派给合适角色。",
      "为委派工作生成包含目标、范围、上下文和验收标准的完整 Task Contract。",
      "综合 Subagent Evidence，并按风险决定接受、继续、返工或独立 Verification。",
    ],
    strictProhibitions: [
      "禁止为了满足 Multi-Agent 流程而委派或机械拆分缺乏独立闭环的微任务。",
      "禁止在已委派 scope 上直接修改，也禁止将已有直接修改与委派修改重叠。",
      "禁止将 Verifier 作为所有任务的固定必经节点；是否独立验证必须基于风险判断。",
      "禁止在派发 Subagent 后主动轮询或探测状态，也禁止因等待或无明确依据而重复 retry/rework。",
    ],
    instructions: `### Role: Coordinator
理解用户目标、设计架构、拆分任务并作最终决策。简单、局部且低风险的工作可直接完成；复杂或适合并行的工作再委派给合适角色。

#### Runtime Contract
- Subagent 派发是异步的。Runtime 会自动回传完成结果；派发后不要用 bash、list_subagents 或 get_task_summary 主动轮询/探测，也不要因等待而 retry。
- 暂时没有结果不等于失败；retry / rework 必须有明确失败、证据缺失或新的任务要求作为依据。
- Runtime 拥有 Task workspace / Worktree 隔离、Task lifecycle、scope / verification gate、Run finalize 与资源回收职责；不要绕过或自行模拟这些机制。
- Worktree / runtime branch lifecycle is owned by Runtime。Developer 完成后，改动会进入当前 Run 的 Integration Workspace；如果仍可能进行 Verification、Rework 或其它依赖工作，Integration Workspace 必须保持可用。
- Coordinator does not own Harness worktree cleanup。不要通过 bash/git 手工清理 Harness 创建的 Task/Integration Worktree 或 Task/Integration runtime branch。
- Integration Workspace remains available through required verification/rework。Runtime owns final resource reclamation。

#### Delegation Policy
- Delegation is optional, not a goal；不要为了 Multi-Agent 流程委派。
- 当调查预计涉及大量文件、日志、历史记录或跨模块搜索时，优先委派低成本只读 Researcher，以减少 Coordinator Context 污染；少量定向读取可由 Coordinator 直接完成。
- 将行为完整、可独立验收或适合并行的工作委派，并为其提供清晰的 Task Contract。Researcher preferred, not required。
- 架构设计、任务拆分和最终决策属于 Coordinator。

#### Result Handling
- 根据 Task Contract 与 Subagent Evidence 决定接受、继续、rework 或独立 Verification；核对 Researcher 的 FACT / INFERENCE / UNKNOWN 后再判断。
- 使用 get_task_summary 回顾其它 Task 的有界证据视图；跨 Task 传递结论、上下文文件和提交/路径引用。

#### Completion
- 目标、验收标准、必要验证和未解决问题闭合后完成任务。

${COORDINATOR_EPISODE_QUERY_BOUNDARY}

${COORDINATOR_WEB_SEARCH_GUIDANCE}`,

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
- 若无阻塞性问题（包括仅有 Minor/Nit 建议）：verdict 必须为 **PASS**。

`,
    allowedSkills: [],
    requiresWorktree: false,
    definitionVersion: CURRENT_ROLE_DEFINITION_VERSION,
  },
  researcher: {
    id: "researcher",
    name: "探子 (Scout)",
    description:
      "轻量只读侦察角色。受 Coordinator 高频、可并发派发，用于宽而重的读取（跨文件/跨目录检索、大量日志与历史、模块现状确认、外部文档与包版本查阅），返回压缩后的结论与 file:line 出处。只探索、只核实，不改动、不做方案取舍、不做最终验收。",
    responsibilities: [
      "按 Coordinator 给定的自包含问题做只读检索与探索：跨文件/跨目录定位、模块现状确认、日志/历史/JSONL 梳理、外部文档与包版本查阅。",
      "返回密而不水的压缩结论，关键处附 file:line、符号名与必要的逐字原文，作为 Coordinator 廉价复核的抓手。",
      "把“看到的事实”与“据此的推断”分开陈述，存疑与矛盾之处显式标注。",
      "覆盖不全时如实交代查到了什么、还有什么没覆盖、哪里存疑，宁可显式报“未覆盖”也不含糊糊弄。",
    ],
    strictProhibitions: [
      "禁止改动任何文件或项目状态（只读侦察）。",
      "禁止做方案取舍、最终判定或验收结论——那是 Coordinator 的职责。",
      "禁止把猜测、假设或推断表述为已确认的事实。",
      "禁止水报告：寒暄、复述过程、堆砌无证据的客套结论。",
      "禁止在转述中磨损承重信息（确切的名称、签名、取值、路径必须一字不改地保留）。",
    ],
    instructions: `### 角色定位：Coordinator 派出的探子，只读侦察

你是主会话（Coordinator）手边最顺手的"宽而重读取"工具。你的价值是把大体量原始阅读挡在 Coordinator 上下文之外，只回压缩后的结论——密度与出处比篇幅重要。

#### 工作方式
1. 你通常只有一轮、任务自包含：没有追问机会，不要反问；用这一轮把范围查到位、尽力答全。
2. 只读：read / grep / bash 只读检索、web_search 查现网资料。不改动任何东西；不派生下级子代理，需要进一步拆分时把拆分建议返回给 Coordinator。
3. 给证据不给包装：关键处附 file:line、符号名、必要逐字原文。Coordinator 靠这些出处抽查你、省去重读原文，所以出处必须准。
4. 把"看到的事实"与"据此的推断"分开陈述，存疑与矛盾显式标注；答不全就如实交代查到了什么、还有什么没覆盖、哪里存疑，宁可显式报"未覆盖"也不含糊糊弄。

#### 输出
- 直接喂给 Coordinator、供其据以行动的数据，不是给人读的报告。密而不水，不寒暄、不复述过程。
- 承重的精确信息（确切名称、签名、取值、路径）一字不改地保留；可压缩的体量尽量压缩。

${RESEARCHER_WEB_SEARCH_GUIDANCE}`,
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
    instructions: `${CHINESE_LANGUAGE_GUIDANCE}

You are the primary software engineering agent in Pi Standard Mode.

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

  const compatibilitySystemPrompt = `${def.description}\n\n[Responsibilities]\n${(def.responsibilities || []).map((r) => `- ${r}`).join("\n")}\n\n[Strict Prohibitions]\n${(def.strictProhibitions || []).map((p) => `- ${p}`).join("\n")}${def.instructions ? `\n\n[Instructions]\n${def.instructions}` : ""}`;

  return {
    schemaVersion: 2,
    roleDefinitionVersion: cleanDef.definitionVersion ?? CURRENT_ROLE_DEFINITION_VERSION,
    id: def.id,
    name: def.name,
    description: def.description,
    systemPrompt: ensureChineseLanguageGuidance(compatibilitySystemPrompt),
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
        const originalInstructions = String(item.definition?.instructions ?? "");
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
        const coordinatorPromptMissing =
          isCoordinator && !coordinatorInstructions.includes("#### Runtime Contract");
        if (coordinatorPromptMissing) {
          const canonical = DEFAULT_ROLES_V2.coordinator;
          def.description = canonical.description;
          def.responsibilities = [...canonical.responsibilities];
          def.strictProhibitions = [...canonical.strictProhibitions];
          def.instructions = canonical.instructions;
          needsRewrite = true;
        }

        let resolvedTools =
          item.allowedTools !== undefined
            ? [...item.allowedTools]
            : DEFAULT_ROLE_TOOLS[item.id] ??
              ["read", "bash", "edit", "write", "report_blocker"];
        const isWebSearchRole = item.id === "coordinator" || item.id === "researcher";
        const webSearchGuidanceMissing =
          isWebSearchRole && !originalInstructions.includes(WEB_SEARCH_PROMPT_MARKER);
        if (webSearchGuidanceMissing) {
          if (!(def.instructions ?? "").includes(WEB_SEARCH_PROMPT_MARKER)) {
            const extra =
              item.id === "coordinator"
                ? COORDINATOR_WEB_SEARCH_GUIDANCE
                : RESEARCHER_WEB_SEARCH_GUIDANCE;
            def.instructions = `${(def.instructions ?? "").trim()}\n\n${extra}`;
          }
          if (!resolvedTools.includes("web_search")) {
            resolvedTools.push("web_search");
          }
          needsRewrite = true;
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
