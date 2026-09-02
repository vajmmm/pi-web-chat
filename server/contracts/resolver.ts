import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRole } from "../../shared/protocol.ts";
import { loadSkillsContent } from "../skills.ts";
import { getRoleDefinition, type RoleDefinition } from "./roles.ts";
import { SHARED_DEFAULTS, SHARED_INVARIANTS } from "./rules.ts";
import type { SubagentExecutionOptions, TaskContract } from "./task.ts";

/** 运行时动态计算出的实际生效执行配置 */
export interface EffectiveRuntimeConfig {
  activeTools: string[];
  requiresWorktree: boolean;
  isWorktree: boolean;
  worktreePath?: string;
  targetCwd?: string;
  cwd?: string;
  taskScope?: {
    include?: string[];
    exclude?: string[];
  };
  model?: {
    provider?: string;
    modelId: string;
    thinkingLevel?: any;
  };
}

/** 经过解析后的最终有效上下文 */
export interface EffectiveContext {
  role: RoleDefinition;
  runtime: EffectiveRuntimeConfig;
  invariants: readonly string[];
  roleConstraints: {
    responsibilities: string[];
    strictProhibitions: string[];
  };
  projectRules: string[];
  defaults: readonly string[];
  assignedSkills: Array<{ name: string; content: string }>;
  taskContract?: TaskContract;
  environment: {
    cwd: string;
    projectRoot?: string;
    isGitRepo: boolean;
    gitBranch?: string;
    isWorktree: boolean;
    targetCwd?: string;
  };
}

export interface ResolveOptions {
  role: AgentRole;
  cwd: string;
  projectRoot?: string;
  isGitRepo?: boolean;
  branchName?: string;
  worktreePath?: string;
  targetCwd?: string;
  taskContract?: TaskContract;
  executionOptions?: SubagentExecutionOptions;
  parentModel?: { provider?: string; modelId: string; thinkingLevel?: any } | null;
}

/**
 * 尝试从当前目录或项目根目录加载 AGENTS.md 作为项目规则
 */
export function loadProjectRules(cwd: string, projectRoot?: string): string[] {
  const rules: string[] = [];
  const searchPaths = [
    join(cwd, "AGENTS.md"),
    join(cwd, ".pi", "AGENTS.md"),
    join(cwd, ".agents", "rules.md"),
  ];
  if (projectRoot && projectRoot !== cwd) {
    searchPaths.push(join(projectRoot, "AGENTS.md"));
  }

  for (const p of searchPaths) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf8").trim();
        if (content) {
          rules.push(content);
          break; // 找到优先规则即止
        }
      } catch {
        /* ignore */
      }
    }
  }

  return rules;
}

/**
 * ConstraintResolver: 约束与运行时配置解析器
 */
export class ConstraintResolver {
  public static resolve(options: ResolveOptions): EffectiveContext {
    // 1. 获取角色定义
    const role = getRoleDefinition(options.role);

    // 2. 计算实际运行时配置
    const isWorktree = !!options.worktreePath;
    const effectiveModel =
      options.executionOptions?.model ??
      role.defaultModel ??
      (options.parentModel
        ? {
            provider: options.parentModel.provider,
            modelId: options.parentModel.modelId,
            thinkingLevel: options.parentModel.thinkingLevel,
          }
        : undefined);

    const activeTools =
      Array.isArray(role.allowedTools)
        ? [...role.allowedTools]
        : role.isLegacy && Array.isArray(role.legacyAllowedTools)
          ? [...role.legacyAllowedTools]
          : ["read", "bash", "edit", "write", "report_blocker"];

    const runtime: EffectiveRuntimeConfig = {
      activeTools,
      requiresWorktree:
        options.executionOptions?.requiresWorktree !== undefined
          ? options.executionOptions.requiresWorktree
          : Boolean(role.requiresWorktree),
      isWorktree,
      worktreePath: options.worktreePath,
      targetCwd: options.targetCwd,
      cwd: options.cwd,
      taskScope: options.taskContract?.scope,
      model: effectiveModel,
    };

    // 3. 解析技能
    const allowedSkills = role.allowedSkills ?? [];
    const assignedSkills =
      allowedSkills.length > 0 ? loadSkillsContent(allowedSkills, options.cwd) : [];

    // 4. 解析项目规则
    const projectRules = loadProjectRules(options.cwd, options.projectRoot);

    return {
      role,
      runtime,
      invariants: SHARED_INVARIANTS,
      roleConstraints: {
        responsibilities: role.isLegacy && role.legacySystemPrompt
          ? [role.legacySystemPrompt, ...role.responsibilities]
          : [...role.responsibilities],
        strictProhibitions: [...role.strictProhibitions],
      },
      projectRules,
      defaults: SHARED_DEFAULTS,
      assignedSkills,
      taskContract: options.taskContract,
      environment: {
        cwd: options.cwd,
        projectRoot: options.projectRoot,
        isGitRepo: !!options.isGitRepo,
        gitBranch: options.branchName,
        isWorktree,
        targetCwd: options.targetCwd,
      },
    };
  }
}
