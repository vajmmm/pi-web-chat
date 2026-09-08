import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Pi's shell error result omits details, but execution updates retain its raw file pointer. */
export function trackToolOutputMetadata(pi: ExtensionAPI): (id: string, details: unknown) => unknown {
  const pending = new Map<string, Record<string, unknown>>();
  pi.on("tool_execution_start", (event) => { pending.delete(event.toolCallId); });
  pi.on("tool_execution_update", (event) => {
    const details = (event.partialResult as any)?.details;
    if (details && typeof details === "object") pending.set(event.toolCallId, details);
  });
  pi.on("agent_end", () => { pending.clear(); });
  return (id, details) => {
    const streamed = pending.get(id);
    pending.delete(id);
    return streamed ? { ...streamed, ...(details && typeof details === "object" ? details : {}) } : details;
  };
}
