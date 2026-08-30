import type { EffectiveContext } from "./resolver.ts";

export interface PromptMessageBlock {
  role: "system" | "developer" | "user";
  title: string;
  content: string;
}

export interface AssembledPromptResult {
  /**
   * 注入给 LLM 的统一结构化 JSON 提示词 (稳定前缀优先，便于 Prompt Cache)
   */
  systemPrompt: string;
  /**
   * 纯粹的结构化 JSON 对象（未 stringify 转义）
   */
  jsonPayload: Record<string, unknown>;
  /**
   * 按 Codex 风格分层的消息块（供调试、透明展示或高级 Provider 直接分发）
   */
  layeredBlocks: PromptMessageBlock[];
}

/**
 * PromptAssembler: 提示词分层组装器
 *
 * 组装结构：
 * [Stable Prefix for Prompt Cache]
 * 1. Model & Meta Instructions
 * 2. Shared Invariants (不可覆盖硬约束)
 * 3. Role Constraints (角色职责与严禁事项)
 * 4. Runtime Permission Context (工具与权限边界)
 * 5. Project Instructions (AGENTS.md / 仓库规则)
 * 6. Assigned Skills (角色专属技能)
 * 7. Shared Defaults (通用工程规范默认指引)
 *
 * [Dynamic Suffix]
 * 8. Environment Context (工作区、Worktree、分支)
 * 9. Task Contract (机器可读的任务目标与验收标准)
 * 10. Current Task (本次执行指令)
 */
export class PromptAssembler {
  /**
   * 组装完整的分层提示词结果
   */
  public static assemble(
    context: EffectiveContext,
    currentTaskText?: string,
  ): AssembledPromptResult {
    // 1. 构建结构化 JSON Payload (前缀保持高度稳定，最大化 Prompt Cache 命中率)
    const payload: Record<string, unknown> = {
      system_runtime: "Pi Multi-Agent Harness",
      hierarchy_priority: [
        "1. Shared Invariants (Non-overridable Core Rules)",
        "2. Role Constraints (Role Responsibilities & Strict Prohibitions)",
        "3. Project Rules (AGENTS.md / Repository Instructions)",
        "4. Shared Defaults (Engineering Guidelines)",
        "5. Task Contract (Dynamic Task Input & Expected Deliverables)",
      ],
      // Stable Layer 1: 全局不可覆盖硬约束
      shared_invariants: context.invariants,
      // Stable Layer 2: 角色定义与严格禁令
      role: context.role.id,
      role_name: context.role.name,
      role_description: context.role.description,
      role_constraint: {
        responsibilities: context.roleConstraints.responsibilities,
        strict_prohibitions: context.roleConstraints.strictProhibitions,
        ...(context.role.instructions ? { instructions: context.role.instructions } : {}),
      },
      // Stable Layer 3: 项目规则
      ...(context.projectRules.length > 0
        ? { project_rules: context.projectRules }
        : {}),
      // Stable Layer 4: 专属业务技能
      ...(context.assignedSkills.length > 0
        ? {
            assigned_skills: context.assignedSkills.map((s) => ({
              skill_name: s.name,
              workflow_instructions: s.content,
            })),
          }
        : {}),
      // Stable Layer 5: 通用工程规范默认指引
      shared_defaults: context.defaults,
      // Dynamic Layer 6: 环境与工作区上下文
      workspace_context: {
        cwd: context.environment.cwd,
        project_root: context.environment.projectRoot ?? null,
        type: context.environment.isWorktree
          ? "isolated_worktree"
          : context.role.id === "coordinator"
            ? "coordinator_workspace"
            : "main_project",
        git_branch: context.environment.gitBranch ?? null,
        target_cwd: context.environment.targetCwd ?? null,
      },
      // Dynamic Layer 7: 机器可读的任务契约
      ...(context.taskContract
        ? {
            task_contract: {
              task_id: context.taskContract.taskId,
              role: context.taskContract.role,
              goal: context.taskContract.goal,
              scope: context.taskContract.scope ?? {
                include: ["*"],
                exclude: [],
              },
              context_files: context.taskContract.contextFiles ?? [],
              acceptance_criteria: context.taskContract.acceptanceCriteria,
              expected_deliverables: context.taskContract.expectedDeliverables,
              constraints: context.taskContract.constraints ?? [],
            },
          }
        : {}),
      guidelines: [
        "Use bash for executing terminal commands and git operations.",
        "Use read to examine files.",
        "Be concise, technical, and direct.",
        ...(context.role.id === "coordinator"
          ? [
              "When a task has already been delegated to a subagent, avoid duplicating the same investigation unless needed for coordination, conflict resolution, evidence gaps, or final verification.",
              "已经委派给 Subagent 的调查任务，默认不要重复执行；只有在协调、结果冲突、证据不足或最终验证时再自行检查。",
            ]
          : [
              "Your last assistant message is the only text sent back to the parent. Provide structured conclusions and verification evidence.",
              "When completing, include a <task_result> JSON block matching the TaskResult schema (status: completed/blocked/failed, summary, verification: [{kind, command, status, summary}], reviewReport, deployEvidence, unresolvedItems) so the system and Coordinator can machine-read your deliverables without ambiguity.",
              "Do not recap intermediate reasoning, tool narration, or raw tool logs. The full transcript stays in the task UI.",
            ]),
      ],
    };

    const systemPrompt = JSON.stringify(payload, null, 2);

    // 2. 构建分层 Message Blocks (逻辑分层表示 Logical Layers，供审计、透明化展示与多消息分层扩展)
    const layeredBlocks: PromptMessageBlock[] = [
      {
        role: "developer",
        title: "Shared Invariants",
        content: context.invariants.map((inv, i) => `${i + 1}. ${inv}`).join("\n"),
      },
      {
        role: "developer",
        title: "Role Constraints & Instructions",
        content: `Role: ${context.role.name} (${context.role.id})\n\nDescription:\n${context.role.description}\n\nResponsibilities:\n${context.roleConstraints.responsibilities.map((r) => `- ${r}`).join("\n")}\n\nStrict Prohibitions:\n${context.roleConstraints.strictProhibitions.map((p) => `- ${p}`).join("\n")}${context.role.instructions ? `\n\nInstructions & Methodologies:\n${context.role.instructions}` : ""}`,
      },
    ];

    if (context.projectRules.length > 0) {
      layeredBlocks.push({
        role: "user",
        title: "Project Instructions / AGENTS.md",
        content: context.projectRules.join("\n\n"),
      });
    }

    layeredBlocks.push({
      role: "user",
      title: "Shared Defaults",
      content: context.defaults.map((d, i) => `${i + 1}. ${d}`).join("\n"),
    });

    layeredBlocks.push({
      role: "user",
      title: "Environment Context",
      content: `CWD: ${context.environment.cwd}\nBranch: ${context.environment.gitBranch ?? "none"}\nIs Worktree: ${context.environment.isWorktree}`,
    });

    if (context.taskContract) {
      layeredBlocks.push({
        role: "user",
        title: "Task Contract",
        content: JSON.stringify(context.taskContract, null, 2),
      });
    }

    if (currentTaskText) {
      layeredBlocks.push({
        role: "user",
        title: "Current Task",
        content: currentTaskText,
      });
    }

    return {
      systemPrompt,
      jsonPayload: payload,
      layeredBlocks,
    };
  }
}
