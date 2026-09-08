import { readFileSync, openSync, readSync, closeSync } from "node:fs";
import { persistToolOutput, type PersistedToolOutput } from "../runtime-artifacts.ts";

function positiveBudget(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 1024 ? Math.floor(parsed) : fallback;
}

export const DEFAULT_OUTPUT_BUDGETS = Object.freeze({
  coordinator: positiveBudget("HARNESS_COORDINATOR_OUTPUT_BUDGET_BYTES", 24 * 1024),
  subagent: positiveBudget("HARNESS_SUBAGENT_OUTPUT_BUDGET_BYTES", 32 * 1024),
  verifier: positiveBudget("HARNESS_VERIFIER_OUTPUT_BUDGET_BYTES", 40 * 1024),
});

function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

function utf8Suffix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(text.length - mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return text.slice(text.length - low);
}

export function buildOutputPreview(
  raw: string,
  pointer: PersistedToolOutput,
  maxBytes: number,
): string {
  const pointerText = `\n\n[${pointer.completeness === "complete" ? "Full output" : "Partial output only"}: ${pointer.artifactRef}]\n[Runtime path: ${pointer.runtimePath}]`;
  const pointerBytes = Buffer.byteLength(pointerText, "utf8");
  if (pointerBytes + Buffer.byteLength("\n\n… [middle omitted] …\n\n") > maxBytes) {
    throw new RangeError("Output budget cannot contain the recovery pointer");
  }
  if (Buffer.byteLength(raw, "utf8") + pointerBytes <= maxBytes) return `${raw}${pointerText}`;
  const bodyBudget = Math.max(0, maxBytes - pointerBytes - Buffer.byteLength("\n\n… [middle omitted] …\n\n"));
  const headBudget = Math.ceil(bodyBudget * 0.6);
  const tailBudget = bodyBudget - headBudget;
  return `${utf8Prefix(raw, headBudget)}\n\n… [middle omitted] …\n\n${utf8Suffix(raw, tailBudget)}${pointerText}`;
}

export function persistAndVirtualizeToolResult(options: {
  runId: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  content: readonly any[];
  details?: unknown;
  input?: unknown;
  isError?: boolean;
  maxBytes: number;
}): { content: any[]; pointer: PersistedToolOutput; virtualized: boolean } {
  const pointer = persistToolOutput(options);
  const textBytes = options.content.reduce(
    (sum, block) => sum + (block?.type === "text" && typeof block.text === "string"
      ? Buffer.byteLength(block.text, "utf8")
      : 0),
    0,
  );
  if (textBytes <= options.maxBytes && pointer.source !== "pi_full_output") {
    return { content: [...options.content], pointer, virtualized: false };
  }
  // Reading the preview must be bounded too; logs can be hundreds of MB.
  const raw = readPreviewSource(pointer, options.maxBytes);
  const originalText = options.content.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
  const shellStatus = /Command (?:exited with code \d+|aborted|timed out after [\d.]+ seconds)\s*$/.exec(originalText)?.[0].trim();
  const status = options.isError
    ? `\n[Execution failed${shellStatus ? `: ${shellStatus}` : ""}]`
    : "";
  const preview = buildOutputPreview(raw + status, pointer, options.maxBytes);
  const nonText = options.content.filter((block) => block?.type !== "text");
  return {
    content: [{ type: "text", text: preview }, ...nonText],
    pointer,
    virtualized: true,
  };
}

function readPreviewSource(pointer: PersistedToolOutput, maxBytes: number): string {
  if (pointer.rawBytes <= maxBytes * 2) return readFileSync(pointer.runtimePath, "utf8");
  const fd = openSync(pointer.runtimePath, "r");
  try {
    const head = Buffer.alloc(maxBytes);
    const tail = Buffer.alloc(maxBytes);
    const headSize = readSync(fd, head, 0, maxBytes, 0);
    const tailSize = readSync(fd, tail, 0, maxBytes, pointer.rawBytes - maxBytes);
    return head.subarray(0, headSize).toString("utf8") + "\n… [middle omitted] …\n" + tail.subarray(0, tailSize).toString("utf8");
  } finally { closeSync(fd); }
}
