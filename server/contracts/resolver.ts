import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentRole } from "../../shared/protocol.ts";
import { loadSkillsContent } from "../skills.ts";
import { getPermissionProfile, type PermissionProfile, type WritableScopeKind } from "./profiles.ts";
import { getRoleDefinition, type RoleDefinition } from "./roles.ts";
import { SHARED_DEFAULTS, SHARED_INVARIANTS } from "./rules.ts";
import type { SubagentExecutionOptions, TaskContract } from "./task.ts";

/** 运行时动态计算出的实际生效权限 */
export interface EffectiveRuntimePermission {
  profileId: string;
  allowedTools: string[];
  disallowedTools?: string[];
  writableScope: WritableScopeKind;
  /** 允许写入的具体目录/路径列表 */
  writablePaths: string[];
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

/** 经过层级解析后的最终有效上下文 */
export interface EffectiveContext {
  role: RoleDefinition;
  permission: EffectiveRuntimePermission;
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
 * 计算动态的 Writable Paths
 */
function computeWritablePaths(
  profile: PermissionProfile,
  cwd: string,
  worktreePath?: string,
  taskContract?: TaskContract,
): string[] {
  if (profile.writableScope === "none") {
    return [];
  }

  const baseWritableDir = worktreePath || cwd;
  const paths: string[] = [baseWritableDir];

  // 如果 TaskContract 指定了包含范围，在不超越 baseWritableDir 的前提下增加记录
  if (taskContract?.scope?.include && taskContract.scope.include.length > 0) {
    for (const inc of taskContract.scope.include) {
      const resolved = isAbsolute(inc) ? inc : resolve(baseWritableDir, inc);
      paths.push(resolved);
    }
  }

  return paths;
}

/**
 * ConstraintResolver: 约束解析器
 *
 * 严格按照优先级合并并生成 EffectiveContext：
 * Runtime Enforcement > Shared Invariants > Role Constraints > Project Rules > Shared Defaults > Task Contract
 */
export class ConstraintResolver {
  public static resolve(options: ResolveOptions): EffectiveContext {
    // 1. 获取角色定义
    const role = getRoleDefinition(options.role);

    // 2. 获取权限 Profile
    const profileId =
      options.executionOptions?.permissionProfileId || role.permissionProfileId || "standard-dev";
    const profile = getPermissionProfile(profileId);

    // 3. 计算实际运行时权限
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

    const writablePaths = computeWritablePaths(
      profile,
      options.cwd,
      options.worktreePath,
      options.taskContract,
    );

    const allowedTools =
      role.isLegacy && role.legacyAllowedTools && role.legacyAllowedTools.length > 0
        ? [...role.legacyAllowedTools]
        : [...profile.allowedTools];

    const permission: EffectiveRuntimePermission = {
      profileId: profile.id,
      allowedTools,
      disallowedTools: profile.disallowedTools ? [...profile.disallowedTools] : undefined,
      writableScope: options.executionOptions?.writableScope ?? profile.writableScope,
      writablePaths,
      requiresWorktree:
        options.executionOptions?.requiresWorktree !== undefined
          ? options.executionOptions.requiresWorktree
          : profile.requiresWorktree,
      isWorktree,
      worktreePath: options.worktreePath,
      targetCwd: options.targetCwd,
      cwd: options.cwd,
      taskScope: options.taskContract?.scope,
      model: effectiveModel,
    };

    // 4. 解析技能
    const allowedSkills = role.allowedSkills ?? [];
    const assignedSkills =
      allowedSkills.length > 0 ? loadSkillsContent(allowedSkills, options.cwd) : [];

    // 5. 解析项目规则
    const projectRules = loadProjectRules(options.cwd, options.projectRoot);

    // 6. 任务契约冲突校验 (Task Contract 不能推翻 Role Strict Prohibitions)
    let sanitizedTaskContract = options.taskContract;
    if (sanitizedTaskContract?.constraints && role.strictProhibitions.length > 0) {
      // 保证角色禁令最高约束
      sanitizedTaskContract = {
        ...sanitizedTaskContract,
        constraints: sanitizedTaskContract.constraints.filter((tc) => {
          const isConflicting = role.strictProhibitions.some((p) =>
            tc.toLowerCase().includes("允许修改") && (p.includes("禁止") || p.includes("严禁")),
          );
          return !isConflicting;
        }),
      };
    }

    return {
      role,
      permission,
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
      taskContract: sanitizedTaskContract,
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
