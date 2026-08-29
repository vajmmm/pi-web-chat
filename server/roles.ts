import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentRole, RoleConfig } from "../shared/protocol.ts";
import {
  ConstraintResolver,
  DEFAULT_ROLES_V2,
  PromptAssembler,
  RoleRegistry,
  type RoleDefinition,
  type TaskContract,
} from "./contracts/index.ts";

const HOME = homedir();

export function rolesPath(): string {
  return join(getAgentDir(), "roles.json");
}

function shorten(p: string): string {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

export const DEFAULT_ROLE_CONFIGS: Record<AgentRole, RoleConfig> = Object.fromEntries(
  Object.entries(DEFAULT_ROLES_V2).map(([id]) => [
    id,
    RoleRegistry.getInstance().getRole(id as AgentRole),
  ]),
) as unknown as Record<AgentRole, RoleConfig>;

export function loadRolesConfig(): { roles: RoleConfig[]; path: string } {
  const registry = RoleRegistry.getInstance();
  registry.reload();
  return {
    roles: registry.getAllRoles(),
    path: shorten(rolesPath()),
  };
}

export function saveRolesConfig(roles: RoleConfig[]): void {
  const registry = RoleRegistry.getInstance();
  registry.saveRoles(roles as any);
}

export function getRoleConfig(role: AgentRole = "default"): RoleConfig {
  return RoleRegistry.getInstance().getRole(role);
}

export function getAllRoleConfigs(): RoleConfig[] {
  return RoleRegistry.getInstance().getAllRoles();
}

export function buildRoleAugmentedSystemPrompt(role: AgentRole, basePrompt?: string): string {
  const config = getRoleConfig(role);
  if (!config.systemPrompt) return basePrompt ?? "";
  if (!basePrompt) return config.systemPrompt;
  return `${config.systemPrompt}\n\n${basePrompt}`;
}

export interface WorkspaceContextInfo {
  cwd: string;
  isWorktree?: boolean;
  branchName?: string;
  isCoordinator?: boolean;
  targetCwd?: string;
}

export function buildWorkspaceContextPrompt(info: WorkspaceContextInfo): string {
  const payload: Record<string, unknown> = {
    workspace_context: {
      type: info.isCoordinator ? "main_project" : "subagent_worktree",
      cwd: info.cwd,
      ...(info.branchName ? { git_branch: info.branchName } : {}),
      ...(info.isWorktree ? { is_worktree: true } : {}),
      ...(info.targetCwd ? { target_cwd: info.targetCwd } : {}),
    },
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * 组装统一的系统提示词（通过 ConstraintResolver 与 PromptAssembler 分层构建）
 */
export function buildUnifiedSystemPrompt(options: {
  role: AgentRole;
  cwd: string;
  projectRoot?: string;
  isCoordinator?: boolean;
  branchName?: string;
  isWorktree?: boolean;
  targetCwd?: string;
  taskContract?: TaskContract;
  currentTaskText?: string;
}): string {
  const context = ConstraintResolver.resolve({
    role: options.role,
    cwd: options.cwd,
    projectRoot: options.projectRoot,
    branchName: options.branchName,
    worktreePath: options.isWorktree ? options.cwd : undefined,
    targetCwd: options.targetCwd,
    taskContract: options.taskContract,
  });

  const assembled = PromptAssembler.assemble(context, options.currentTaskText);
  return assembled.systemPrompt;
}
