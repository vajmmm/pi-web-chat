import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Compatibility wrapper for the web command path.
 * Pi owns cut-point selection, summarization, persistence, and message reload.
 */
export async function performSessionCompaction(
  session: AgentSession,
  _modelRuntime?: ModelRuntime,
  customInstructions?: string,
  _taskId?: string,
): Promise<{ summary: string; firstKeptEntryId: string; messagesCountAfter: number }> {
  if (!session.model) {
    throw new Error("当前会话未选择可用模型，无法执行压缩");
  }
  const result = await session.compact(customInstructions);
  return {
    summary: result.summary,
    firstKeptEntryId: result.firstKeptEntryId,
    messagesCountAfter: session.messages.length,
  };
}
