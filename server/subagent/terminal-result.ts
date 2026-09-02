export function assistantContentHasType(msg: Record<string, unknown> | undefined, type: string): boolean {
  const content = msg?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b && typeof b === "object" && (b as { type?: string }).type === type);
}

export function assistantHasVisibleText(msg: Record<string, unknown> | undefined): boolean {
  const content = msg?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) =>
      b &&
      typeof b === "object" &&
      (b as { type?: string }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string" &&
      (b as { text: string }).text.trim().length > 0,
  );
}

/**
 * Detect premature session end: a stop turn with no deliverable text, after prior toolCall work.
 * Matches the real MiniMax case: "Let me create docs" + mkdir + empty/thinking-only stop.
 */
export function isPrematureEmptyStopAfterTools(
  rawMessages: unknown[],
  lastAssistantIndex: number,
  lastAssistantMsg: Record<string, unknown> | undefined,
): boolean {
  if (!lastAssistantMsg || lastAssistantIndex < 0) return false;
  // A stop that itself still contains toolCalls is handled by finishReason===tool_call.
  if (assistantContentHasType(lastAssistantMsg, "toolCall")) return false;
  if (assistantHasVisibleText(lastAssistantMsg)) return false;

  for (let i = lastAssistantIndex - 1; i >= 0; i--) {
    const m = rawMessages[i] as Record<string, unknown> | undefined;
    if (!m || m.role !== "assistant") continue;
    if (assistantContentHasType(m, "toolCall")) return true;
    // Stop scanning once we hit an earlier substantive text-only assistant
    if (assistantHasVisibleText(m)) return false;
  }
  return false;
}

export function hasSuccessfulFileMutation(rawMessages: unknown[], logs?: string[]): boolean {
  if ((logs ?? []).some((l) => /\[Tool\] (write|edit) -> Success/.test(l))) return true;
  const writeIds = new Set<string>();
  for (const raw of rawMessages) {
    const m = raw as Record<string, unknown>;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content as Record<string, unknown>[]) {
      if (block?.type !== "toolCall") continue;
      const name = String(block.name ?? "");
      if (name !== "write" && name !== "edit") continue;
      const result = block.result as { isError?: boolean } | undefined;
      if (result && result.isError === false) return true;
      const id = String(block.id ?? "");
      if (id) writeIds.add(id);
    }
  }
  for (const raw of rawMessages) {
    const m = raw as Record<string, unknown>;
    if (m?.role !== "toolResult") continue;
    const id = String(m.toolCallId ?? "");
    if (id && writeIds.has(id) && m.isError !== true) return true;
  }
  return false;
}
