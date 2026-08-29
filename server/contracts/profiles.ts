/**
 * PermissionProfile: 角色权限配置策略
 *
 * 将“角色身份/职责”与“运行时权限”解耦。
 * 具体运行时有效权限（如实际 worktree 目录、实际 writablePaths）由运行时动态生成。
 */

export type WritableScopeKind =
  | "none"            // 完全只读（不允许任何文件写入或修改）
  | "worktree-only"   // 仅允许在当前分配的独立 Git Worktree 内写入
  | "test-only"       // 仅允许在测试目录、测试脚本与 mock 数据中写入
  | "deploy-only"     // 仅允许在部署配置文件与发布流水线中写入
  | "all";            // 允许在整个工作区自由修改

export interface PermissionProfile {
  id: string;
  name: string;
  description: string;
  /** 允许使用的工具名称列表（白名单） */
  allowedTools: string[];
  /** 显式禁止的工具名称列表 */
  disallowedTools?: string[];
  /** 写权限范围策略 */
  writableScope: WritableScopeKind;
  /** 是否强制要求在独立的 Git Worktree 中执行 */
  requiresWorktree: boolean;
}

export const DEFAULT_PERMISSION_PROFILES: Record<string, PermissionProfile> = {
  "coordinator-readonly": {
    id: "coordinator-readonly",
    name: "统筹者调度权限 (只读调度)",
    description: "具备架构规划、信息检索与子智能体调度权限，严禁直接修改业务代码",
    allowedTools: [
      "read",
      "bash",
      "list_available_roles",
      "spawn_subagent",
      "abort_subagent",
      "list_subagents",
    ],
    writableScope: "none",
    requiresWorktree: false,
  },
  "reviewer-readonly": {
    id: "reviewer-readonly",
    name: "审查者只读权限 (只审不改)",
    description: "只读审查权限，仅允许阅读代码与检索信息，严禁任何写操作与代码修改",
    allowedTools: ["read", "bash"],
    writableScope: "none",
    requiresWorktree: false,
  },
  "frontend-standard": {
    id: "frontend-standard",
    name: "前端开发标准权限 (Worktree 隔离)",
    description: "标准前端开发权限，强制在独立 Git Worktree 隔离分支中执行代码编写",
    allowedTools: ["read", "bash", "edit", "write"],
    writableScope: "worktree-only",
    requiresWorktree: true,
  },
  "backend-standard": {
    id: "backend-standard",
    name: "后端开发标准权限 (Worktree 隔离)",
    description: "标准后端开发权限，强制在独立 Git Worktree 隔离分支中执行代码编写",
    allowedTools: ["read", "bash", "edit", "write"],
    writableScope: "worktree-only",
    requiresWorktree: true,
  },
  "fullstack-standard": {
    id: "fullstack-standard",
    name: "全栈开发标准权限 (Worktree 隔离)",
    description: "全栈开发权限，强制在独立 Git Worktree 隔离分支中执行端到端代码编写",
    allowedTools: ["read", "bash", "edit", "write"],
    writableScope: "worktree-only",
    requiresWorktree: true,
  },
  "tester-test-write": {
    id: "tester-test-write",
    name: "测试者权限 (限定测试用例编写与打流)",
    description: "允许编写测试用例与执行测试验证，禁止修改生产业务逻辑代码",
    allowedTools: ["read", "bash", "edit", "write"],
    writableScope: "test-only",
    requiresWorktree: false,
  },
  "deployer-infra": {
    id: "deployer-infra",
    name: "实施部署权限 (发布与远程验证)",
    description: "允许执行部署与发布相关命令与配置，不可擅自修改业务逻辑代码",
    allowedTools: ["read", "bash"],
    writableScope: "deploy-only",
    requiresWorktree: false,
  },
  "standard-dev": {
    id: "standard-dev",
    name: "标准开发权限",
    description: "通用全功能开发权限",
    allowedTools: ["read", "bash", "edit", "write"],
    writableScope: "all",
    requiresWorktree: false,
  },
};

const activeProfiles: Map<string, PermissionProfile> = new Map(
  Object.entries(DEFAULT_PERMISSION_PROFILES),
);

export function getPermissionProfile(profileId: string): PermissionProfile {
  const profile = activeProfiles.get(profileId);
  if (!profile) {
    throw new Error(
      `[PermissionProfile] Unknown permission profile ID: "${profileId}". Fail-closed: refusing execution with unconfigured profile.`,
    );
  }
  return profile;
}

export function getAllPermissionProfiles(): PermissionProfile[] {
  return Array.from(activeProfiles.values());
}

export function registerPermissionProfile(profile: PermissionProfile): void {
  activeProfiles.set(profile.id, profile);
}
