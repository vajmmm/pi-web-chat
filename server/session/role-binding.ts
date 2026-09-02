import type { AgentRole } from "../../shared/protocol.ts";
import {
  ConstraintResolver,
  DEFAULT_ROLES_V2,
  PromptAssembler,
} from "../contracts/index.ts";
import { adjustSkillsInBasePrompt } from "../skills.ts";
import type { SessionEntry } from "./session-registry.ts";

export function applyRoleToSession(entry: SessionEntry, role: AgentRole): void {
  entry.activeRole = role;
  const session = entry.runtime.session;

  const effectiveContext = ConstraintResolver.resolve({
    role,
    cwd: entry.cwd,
    branchName: entry.gitBranch,
    isGitRepo: entry.isGitRepo,
  });

  // 1. 设置有效工具集 (直接通过 setActiveToolsByName 暴露)
  if (typeof session.setActiveToolsByName === "function") {
    session.setActiveToolsByName(effectiveContext.runtime.activeTools);
  }

  // 2. 根据角色分层更新系统提示词 (System Prompt)
  if (role === "default") {
    // 标准模式：Standard Mode Behavior + Pi Native System Prompt (含 skills 过滤)
    (session as any)._systemPromptOverride = undefined;
    const basePrompt = (session as any)._baseSystemPrompt || "";
    const standardBehaviorPrompt =
      effectiveContext.role.instructions?.trim() ||
      DEFAULT_ROLES_V2.default.instructions?.trim() ||
      "";

    let cleanBasePrompt = basePrompt;
    if (standardBehaviorPrompt && cleanBasePrompt.startsWith(standardBehaviorPrompt)) {
      cleanBasePrompt = cleanBasePrompt.slice(standardBehaviorPrompt.length).trimStart();
    }

    const adjustedNativePrompt = adjustSkillsInBasePrompt(
      cleanBasePrompt,
      effectiveContext.role.allowedSkills ?? [],
      entry.cwd,
    );

    const combined = standardBehaviorPrompt
      ? `${standardBehaviorPrompt}\n\n${adjustedNativePrompt}`
      : adjustedNativePrompt;

    session.agent.state.systemPrompt = combined;
  } else {
    // 定制角色：注入分层组装的结构化提示词
    const assembled = PromptAssembler.assemble(effectiveContext);
    (session as any)._systemPromptOverride = assembled.systemPrompt;
    session.agent.state.systemPrompt = assembled.systemPrompt;
  }
}
