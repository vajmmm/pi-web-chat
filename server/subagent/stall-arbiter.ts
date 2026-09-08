import { createHash } from "node:crypto";

export interface StallTelemetryState {
  recentFingerprints: string[];
  commandLoopSignals: number;
  verificationStagnationSignals: number;
  codeOscillationSignals: number;
  contextPressure: number;
  warningCount: number;
  lastWarnedFingerprint?: string;
  recentEdits?: Array<{ path: string; before: string; after: string }>;
}

export function createStallTelemetryState(): StallTelemetryState {
  return {
    recentFingerprints: [],
    commandLoopSignals: 0,
    verificationStagnationSignals: 0,
    codeOscillationSignals: 0,
    contextPressure: 0,
    warningCount: 0,
  };
}

export function observeToolExecution(
  state: StallTelemetryState,
  event: { toolName: string; args?: unknown; isError?: boolean; content?: unknown },
): { warning?: string } {
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
  const args = event.args as Record<string, unknown> | undefined;
  if (!event.isError && (event.toolName === "edit" || event.toolName === "write")) {
    state.recentFingerprints = [];
    state.lastWarnedFingerprint = undefined;
    if (event.toolName === "edit" && typeof args?.path === "string" &&
        typeof args.oldText === "string" && typeof args.newText === "string") {
      const edit = { path: args.path, before: hash(args.oldText), after: hash(args.newText) };
      const recent = (state.recentEdits ?? []).filter((item) => item.path === edit.path);
      const last = recent.at(-1);
      const previous = recent.at(-2);
      state.recentEdits = [...(state.recentEdits ?? []), edit].slice(-8);
      if (last && previous && edit.before !== edit.after &&
          last.before === edit.after && last.after === edit.before &&
          previous.before === edit.before && previous.after === edit.after) {
        state.codeOscillationSignals += 1;
        state.warningCount += 1;
        return { warning: "[Stall warning] Repeated inverse edits in the same region; reassess the change. Execution was not aborted." };
      }
    } else {
      state.recentEdits = [];
    }
    return {};
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([event.toolName, event.args ?? null, Boolean(event.isError), hash(event.content)]))
    .digest("hex");
  state.recentFingerprints.push(fingerprint);
  if (state.recentFingerprints.length > 8) state.recentFingerprints.shift();
  const repeatCount = state.recentFingerprints.filter((item) => item === fingerprint).length;
  if (repeatCount < 3 || state.lastWarnedFingerprint === fingerprint) return {};
  state.lastWarnedFingerprint = fingerprint;
  state.commandLoopSignals += 1;
  if (event.isError && event.toolName === "bash" && typeof args?.command === "string" &&
      /\b(test|typecheck|lint|check|pytest|tsc)\b/.test(args.command)) {
    state.verificationStagnationSignals += 1;
  }
  state.warningCount += 1;
  return {
    warning:
      `[Stall warning] The same ${event.toolName} execution outcome repeated ${repeatCount} times ` +
      `without observable command-level progress. Reassess the approach; execution was not aborted.`,
  };
}

export function recordContextPressure(state: StallTelemetryState, compactionCount: number): void {
  // Context pressure is telemetry only and can never emit a warning by itself.
  state.contextPressure = Math.max(state.contextPressure, compactionCount);
}
