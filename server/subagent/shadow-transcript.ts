import { appendShadowTranscript, readTranscriptEntries } from "../runtime-artifacts.ts";

/** Flush persisted entries, never infer an ID from a message_end notification. */
export function createShadowTranscriptRecorder(runId: string, taskId: string): (session: any) => void {
  // A recorder is runtime-scoped but the transcript is session-scoped. Seed the
  // local dedupe set from durable entries so a recreated runtime cannot append its
  // already-persisted branch prefix again. This only reads IDs; it never projects
  // transcript history into model context.
  const recorded = new Set(
    readTranscriptEntries(runId, taskId, { limit: Number.MAX_SAFE_INTEGER })
      .map((entry: any) => entry?.entryId)
      .filter((entryId): entryId is string => typeof entryId === "string"),
  );
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
