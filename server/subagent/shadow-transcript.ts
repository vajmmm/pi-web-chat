import { appendShadowTranscript } from "../runtime-artifacts.ts";

/** Flush persisted entries, never infer an ID from a message_end notification. */
export function createShadowTranscriptRecorder(runId: string, taskId: string): (session: any) => void {
  const recorded = new Set<string>();
  return (session) => {
    const entries = session.sessionManager?.getBranch?.() || [];
    for (const entry of entries) {
      if (!entry.id || !entry.message || recorded.has(entry.id)) continue;
      appendShadowTranscript(runId, taskId, {
        entryId: entry.id,
        timestamp: entry.timestamp,
        message: entry.message,
      });
      recorded.add(entry.id);
    }
  };
}
