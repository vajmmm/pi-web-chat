import type { SessionRegistry, SessionEntry } from "../session/session-registry.ts";
import type { SubagentManager } from "../subagent-manager.ts";
import { broadcastTo } from "../ws/index.ts";

export interface PendingSubagentReport {
  task: any;
  reportText: string;
  metadata?: { kind?: "terminal" | "blocker" };
}

export interface ReportDispatcherOptions {
  sessionRegistry: SessionRegistry;
  subagentManager: SubagentManager;
  isPendingDeletion: (sessionId: string) => boolean;
  broadcastSnapshot: (entry: SessionEntry) => void;
}

export class SubagentReportDispatcher {
  public readonly sessionReportQueues = new Map<string, PendingSubagentReport[]>();
  public readonly sessionReportProcessing = new Set<string>();

  constructor(private readonly options: ReportDispatcherOptions) {}

  public async handleReport(
    currentEntry: SessionEntry,
    task: any,
    reportText: string,
    metadata?: { kind?: "terminal" | "blocker" },
  ): Promise<void> {
    broadcastTo(currentEntry, { type: "subagent_reported", task, reportText });

    if (
      this.options.subagentManager.isDeleting(currentEntry.id) ||
      this.options.isPendingDeletion(currentEntry.id)
    ) {
      return;
    }

    // Interrupt in-flight coordinator session immediately to prevent probing subtask results
    if (
      !this.sessionReportProcessing.has(currentEntry.id) &&
      currentEntry.runtime?.session?.isStreaming
    ) {
      try {
        await currentEntry.runtime.session.abort();
      } catch (abortErr) {
        console.error(
          `[SubagentReportDispatcher] Error aborting streaming session ${currentEntry.id}:`,
          abortErr,
        );
      }
    }

    let queue = this.sessionReportQueues.get(currentEntry.id);
    if (!queue) {
      queue = [];
      this.sessionReportQueues.set(currentEntry.id, queue);
    }
    queue.push({ task, reportText, metadata });

    void this.dispatch(currentEntry.id);
  }

  public async dispatch(sessionId: string): Promise<void> {
    if (this.sessionReportProcessing.has(sessionId)) return;
    this.sessionReportProcessing.add(sessionId);

    try {
      while (true) {
        const queue = this.sessionReportQueues.get(sessionId);
        if (!queue || queue.length === 0) break;

        const currentEntry = this.options.sessionRegistry.get(sessionId);
        if (!currentEntry) break;
        if (
          this.options.subagentManager.isDeleting(sessionId) ||
          this.options.isPendingDeletion(sessionId)
        ) {
          queue.length = 0;
          break;
        }

        const session = currentEntry.runtime?.session;
        if (!session) break;

        // Interrupt in-flight streaming session immediately
        if (session.isStreaming) {
          try {
            await session.abort();
          } catch (abortErr) {
            console.error(
              `[SubagentReportDispatcher] Error aborting streaming session ${sessionId}:`,
              abortErr,
            );
          }
        }

        if (
          this.options.subagentManager.isDeleting(sessionId) ||
          this.options.isPendingDeletion(sessionId)
        ) {
          queue.length = 0;
          break;
        }

        const reports = queue.splice(0, queue.length);
        if (reports.length === 0) break;

        // Clean up any stale subagent items in queuedMessages and clear session internal queue
        const remainingUserMessages = (currentEntry.queuedMessages ?? []).filter(
          (m) => m.source !== "subagent",
        );
        if (typeof session.clearQueue === "function") {
          session.clearQueue();
        }
        currentEntry.queuedMessages = remainingUserMessages;
        for (const item of remainingUserMessages) {
          if (item.mode === "steer") {
            void session.steer(item.text);
          } else {
            void session.followUp(item.text);
          }
        }
        this.options.broadcastSnapshot(currentEntry);

        const promptText = reports.map((r) => r.reportText).join("\n\n---\n\n");

        await this.options.sessionRegistry.trackInFlightOp(sessionId, async () => {
          try {
            await session.prompt(promptText);
          } catch (err) {
            console.error(`[SubagentReportDispatcher] Failed to prompt report for ${sessionId}:`, err);
          }
        });
      }
    } finally {
      this.sessionReportProcessing.delete(sessionId);
      const remaining = this.sessionReportQueues.get(sessionId);
      if (remaining && remaining.length > 0) {
        void this.dispatch(sessionId);
      } else {
        this.sessionReportQueues.delete(sessionId);
      }
    }
  }
}
