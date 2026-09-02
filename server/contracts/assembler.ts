import type { EffectiveContext } from "./resolver.ts";

export interface AssembledPromptResult {
  /**
   * 注入给 LLM 的统一结构化 JSON 系统提示词 (高度稳定，最大化 Prompt Cache 命中率)
   */
  systemPrompt: string;
  /**
   * 结构化 JSON 对象
   */
  jsonPayload: Record<string, unknown>;
}

/**
 * PromptAssembler: 提示词分层组装器
 *
 * 稳定系统提示词结构（保持稳定前缀以最大化 Prompt Cache 命中率）：
 * 1. Shared Invariants (不可覆盖核心底线)
 * 2. Role Behavior (角色身份、职责边界与工作指引)
 * 3. Project Rules (AGENTS.md / 仓库规则)
 * 4. Assigned Skills (角色专属技能)
 * 5. Shared Defaults (通用工程默认指引，无具体任务指令时生效)
 *
 * 注意：所有动态任务信息与工作区上下文 (Workspace Context / Goal / Scope / Acceptance Criteria / Context / Working Memory)
 * 统一通过 User Message / Task Context 传递，绝不污染系统提示词前缀。
 */
export class PromptAssembler {
  /**
   * 组装高度稳定、跨 Task 可最大化命中 Prompt Cache 的分层系统提示词
   */
  public static assemble(context: EffectiveContext): AssembledPromptResult {
    // 构建纯粹稳定的结构化 JSON Payload
    const payload: Record<string, unknown> = {
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
        ...(context.role.instructions ? { instructions: context.role.instructions } : {}),
      },
      // Layer 3: 项目规则 (AGENTS.md)
      ...(context.projectRules.length > 0
        ? { project_rules: context.projectRules }
        : {}),
      // Layer 4: 专属业务技能
      ...(context.assignedSkills.length > 0
        ? {
            assigned_skills: context.assignedSkills.map((s) => ({
              skill_name: s.name,
              workflow_instructions: s.content,
            })),
          }
        : {}),
      // Layer 5: 通用工程默认指引
      shared_defaults: context.defaults,
    };

    const systemPrompt = JSON.stringify(payload, null, 2);

    return {
      systemPrompt,
      jsonPayload: payload,
    };
  }
}
