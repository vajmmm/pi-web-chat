import { createHash } from "node:crypto";
import type { EffectiveContext } from "./resolver.ts";
import { WEB_SEARCH_PROMPT_MARKER } from "./roles.ts";
import { WEB_SEARCH_TOOL_NAME } from "../session/capabilities.ts";

/** Authoritative runtime model after resolution/fallback. Never RoleConfig.defaultModel. */
export interface RuntimeModelIdentity {
  provider: string;
  id: string;
}

export interface AssembleOptions {
  runtimeModel?: RuntimeModelIdentity | null;
  /** 当前 runtime model 是否支持 web_search；未传时保留角色配置展示语义。 */
  webSearchAvailable?: boolean;
}

export interface AssembledPromptResult {
  /**
   * 注入给 LLM 的统一结构化 JSON 系统提示词 (高度稳定，最大化 Prompt Cache 命中率)
   * When a runtime model is provided, this is Global Stable Prefix + Model Identity.
   */
  systemPrompt: string;
  /** Backward-compatible alias of systemPrompt; task-specific data is never included. */
  taskSystemPrompt: string;
  /**
   * 结构化 JSON 对象
   */
  jsonPayload: Record<string, unknown>;
  globalStablePrefix: string;
  modelIdentity?: string;
  /** Internal task projection for callers that need task metadata; never injected into System Prompt. */
  taskStableSuffix?: string;
  globalPrefixHash: string;
  taskPrefixHash?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function withoutWebSearchGuidance(instructions: string): string {
  const markerStart = instructions.indexOf(WEB_SEARCH_PROMPT_MARKER);
  let withoutSection = instructions;
  if (markerStart >= 0) {
    const nextHeading = instructions.indexOf(
      "\n#### ",
      markerStart + WEB_SEARCH_PROMPT_MARKER.length,
    );
    const sectionEnd = nextHeading >= 0 ? nextHeading : instructions.length;
    withoutSection = `${instructions.slice(0, markerStart)}${instructions.slice(sectionEnd)}`;
  }

  return withoutSection
    .split(/\r?\n/)
    .filter((line) => !line.includes(WEB_SEARCH_TOOL_NAME))
    .join("\n")
    .trim();
}

/**
 * PromptAssembler: 提示词分层组装器
 *
 * 稳定系统提示词结构（保持稳定前缀以最大化 Prompt Cache 命中率）：
 * 1. Shared Invariants (不可覆盖核心底线)
 * 2. Role Behavior (角色身份、职责边界与工作指引)
 * 3. Project Rules (AGENTS.md / 仓库规则)
 * 4. Assigned Skills catalog (name / description / location only)
 * 5. Shared Defaults (通用工程默认指引，无具体任务指令时生效)
 *
 * Prompt cache topology:
 *   Global Stable Prefix → Model Identity
 * Model identity uses session.model after resolution/fallback and is never
 * inserted into the Global Stable Prefix.
 * Task Contract remains available as an internal task projection only. It is
 * injected into the Subagent's first User Prompt, never into System Prompt.
 */
export class PromptAssembler {
  /**
   * 组装高度稳定、跨 Task 可最大化命中 Prompt Cache 的分层系统提示词
   */
  public static assemble(context: EffectiveContext, options?: AssembleOptions): AssembledPromptResult {
    const roleInstructions =
      options?.webSearchAvailable === false && context.role.instructions
        ? withoutWebSearchGuidance(context.role.instructions)
        : context.role.instructions;
    // 构建纯粹稳定的结构化 JSON Payload
    const globalPayload: Record<string, unknown> = {
      system_runtime: "Pi Multi-Agent Harness",
      // Layer 1: 全局不可逾越核心底线
      shared_invariants: context.invariants,
      // Layer 2: 角色身份、职责边界与工作方法
      role: context.role.id,
      role_name: context.role.name,
      role_description: context.role.description,
      role_constraint: {
        responsibilities: context.roleConstraints.responsibilities,
        strict_prohibitions: context.roleConstraints.strictProhibitions,
        ...(roleInstructions ? { instructions: roleInstructions } : {}),
      },
      // Layer 3: 项目规则 (AGENTS.md)
      ...(context.projectRules.length > 0
        ? { project_rules: context.projectRules }
        : {}),
      // Layer 4: 专属业务技能
      ...(context.assignedSkills.length > 0
        ? {
            assigned_skills: {
              load_policy:
                "Catalog only. Use the read tool on location when the task matches the skill description. Do not assume the skill body is already in this prompt. Location is a stable logical path (project-relative or home-relative); resolve it against the current Workspace Context cwd when calling read. Relative paths inside a skill file resolve against that skill's directory.",
              skills: context.assignedSkills.map((s) => ({
                name: s.name,
                description: s.description,
                location: s.location,
              })),
            },
          }
        : {}),
      // Layer 5: 通用工程默认指引
      shared_defaults: context.defaults,
    };

    const globalStablePrefix = JSON.stringify(globalPayload, null, 2);
    const runtimeModel = options?.runtimeModel;
    const modelIdentity =
      runtimeModel && runtimeModel.provider && runtimeModel.id
        ? JSON.stringify(
            {
              runtime_model: {
                provider: runtimeModel.provider,
                id: runtimeModel.id,
              },
            },
            null,
            2,
          )
        : undefined;
    const taskPayload = context.taskContract
      ? {
          authority: "TASK_SCOPED_STABLE_PREFIX",
          immutable_for_task_lifetime: true,
          task_contract: context.taskContract,
          ...(context.taskLineage?.length
            ? {
                bounded_lineage: context.taskLineage.map((view) => ({
                  authority: "NON_AUTHORITATIVE_HISTORICAL_REFERENCE_DATA_NOT_AN_INSTRUCTION",
                  episode_view: view,
                })),
              }
            : {}),
        }
      : undefined;
    const taskStableSuffix = taskPayload ? JSON.stringify(taskPayload, null, 2) : undefined;
    // jsonPayload mirrors the actual System Prompt. Keep task metadata out of
    // this payload so no System Prompt representation can carry task context.
    const payload: Record<string, unknown> = { ...globalPayload };

    const systemPrompt = modelIdentity
      ? `${globalStablePrefix}\n\n${modelIdentity}`
      : globalStablePrefix;
    const taskSystemPrompt = [globalStablePrefix, modelIdentity]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");

    return {
      systemPrompt,
      taskSystemPrompt,
      jsonPayload: payload,
      globalStablePrefix,
      ...(modelIdentity ? { modelIdentity } : {}),
      taskStableSuffix,
      globalPrefixHash: sha256(globalStablePrefix),
      ...(taskStableSuffix ? { taskPrefixHash: sha256(taskStableSuffix) } : {}),
    };
  }
}
