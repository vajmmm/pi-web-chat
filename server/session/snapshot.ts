import { basename } from "node:path";
import type { UISnapshot, UIThinkingLevel } from "../../shared/protocol.ts";
import { serializeMessages, TOOL_RESULT_SNAPSHOT_MAX_CHARS } from "../serialize.ts";
import type { SubagentManager } from "../subagent-manager.ts";
import { canUseProductDesign, getMainSessionCapabilities } from "./capabilities.ts";
import type { SessionEntry } from "./session-registry.ts";
import { calculateTokenUsage, supportedThinkingLevels } from "./usage.ts";

export function buildSnapshot(
  entry: SessionEntry,
  subagentManager: SubagentManager,
): UISnapshot {
  const session = entry.runtime.session;
  const model = session.model;
  const capabilities = getMainSessionCapabilities(model);
  return {
    messages: serializeMessages(session.messages, {
      maxToolResultChars: TOOL_RESULT_SNAPSHOT_MAX_CHARS,
    }),
    isStreaming: session.isStreaming,
    isCompacting: !!entry.isCompacting,
    model: model
      ? {
          provider: model.provider,
          id: model.id,
          name: (model as { name?: string }).name,
          reasoning: (model as { reasoning?: boolean }).reasoning,
        }
      : null,
    capabilities,
    productDesignAvailable: canUseProductDesign(capabilities),
    thinkingLevel: session.thinkingLevel as UIThinkingLevel,
    thinkingLevels: supportedThinkingLevels(model),
    sessionFile: session.sessionFile,
    sessionId: entry.id,
    cwd: entry.cwd,
    cwdName: basename(entry.cwd),
    isGitRepo: entry.isGitRepo,
    gitBranch: entry.gitBranch,
    activeRole: entry.activeRole,
    subagents: subagentManager.getTasksForParent(entry.id),
    tokenUsage: calculateTokenUsage(
      session.messages,
      model,
      subagentManager.getTasksForParent(entry.id),
      entry.activeRole,
    ),
    queuedMessages: entry.queuedMessages ?? [],
  };
}
