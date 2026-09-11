import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";

export const STRUCTURED_COMPACTION_PROMPT = `
Produce a concise coding-agent continuation summary that allows the next model turn to continue
the task correctly. Summarize execution state, not conversation history.

Output exactly one summary wrapped as:

<continuation_summary schema="1.2">

# Task Goal
# Current State
# Completed Work
# Unresolved / Failed Work
# Failed Attempts / Do Not Retry
# Key Decisions / Reasons
# Modified Files
# Verification State
# Next Actions
# Critical Evidence / Artifact Refs

</continuation_summary>

Requirements:

- Prioritize the current execution state and the next actionable step.
- Preserve unresolved failures, blockers, important negative knowledge, and reasons a failed
  approach should not be repeated.
- Prefer newer raw conversation evidence over older summaries when they conflict.
- Do not preserve stale failures or states that were superseded by later successful results.
- Do not invent files, changes, commands, test results, verifier state, decisions, failures,
  or artifact references.
- If an important fact is unknown or not established by the available context, state that
  explicitly instead of guessing.
- Preserve exact file paths, command names, important error messages, failure reasons, and
  artifact references when they are necessary for continuation.
- Distinguish completed, unresolved, failed, and not-yet-verified work.
- In Verification State, distinguish passed, failed, and not run / not verified checks when known.
- Next Actions should reflect the actual remaining execution frontier, not generic advice.
- Only include evidence or artifact references that actually appear in the available context.
- This summary is a continuation hint for the next turn. Preserve artifact references so durable
  facts can be recovered; do not treat the summary as a replacement for those facts.
- Do not call tools.
- Do not copy complete tool output or reproduce unnecessary historical detail.
- Keep the summary compact while retaining enough information to safely continue the task.
`;

export type CompactionMode = "native" | "structured";

export function getCompactionMode(): CompactionMode {
  const mode = process.env.COMPACTION_MODE?.trim().toLowerCase();
  return mode === "native" ? "native" : "structured";
}

export function getCompactionInstructions(mode: CompactionMode = getCompactionMode()): string | undefined {
  return mode === "native" ? undefined : STRUCTURED_COMPACTION_PROMPT;
}

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
  const effectiveInstructions = customInstructions !== undefined ? customInstructions : getCompactionInstructions();
  const result = await session.compact(effectiveInstructions);
  return {
    summary: result.summary,
    firstKeptEntryId: result.firstKeptEntryId,
    messagesCountAfter: session.messages.length,
  };
}

