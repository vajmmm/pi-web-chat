import type { AssistantFinishReason, TaskResult } from "./contracts/index.ts";

/**
 * Bounded completion reports for parent-session injection.
 *
 * Full subagent transcripts stay on the task record / UI.
 * The parent session only receives a last-assistant-message summary and structured metadata, hard-capped.
 */

export const MAX_SUBAGENT_REPORT_CHARS = 5000;

type AnyMessage = {
  role?: string;
  content?: unknown;
  stopReason?: string;
  rawStopReason?: string;
};

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
      .map((b) => (typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * 归一化 Assistant Turn 的终止原因
 */
export function normalizeFinishReason(msg?: unknown): AssistantFinishReason {
  if (!msg || typeof msg !== "object") return "unknown";
  const m = msg as Record<string, unknown>;
  if (m.role !== "assistant") return "unknown";

  const stopReason = String(m.stopReason || "").toLowerCase();
  const rawStopReason = String(m.rawStopReason || "").toLowerCase();

  if (
    stopReason === "length" ||
    rawStopReason === "length" ||
    rawStopReason === "max_tokens" ||
    rawStopReason === "max_output_tokens" ||
    rawStopReason === "max_token"
  ) {
    return "max_tokens";
  }
  if (
    stopReason === "aborted" ||
    rawStopReason === "aborted" ||
    rawStopReason === "cancelled"
  ) {
    return "cancelled";
  }
  if (stopReason === "error" || rawStopReason === "error") {
    return "error";
  }
  if (
    stopReason === "tooluse" ||
    stopReason === "tool_call" ||
    stopReason === "toolcall"
  ) {
    return "tool_call";
  }

  const content = Array.isArray(m.content) ? m.content : [];
  const hasToolCalls = content.some(
    (b) => b && typeof b === "object" && (b as { type?: string }).type === "toolCall",
  );
  if (hasToolCalls) {
    return "tool_call";
  }

  if (stopReason === "stop" || rawStopReason === "stop" || rawStopReason === "end_turn") {
    return "stop";
  }

  return "unknown";
}

/**
 * 提取最后一次有效 Assistant Turn 的完成文本。
 * 严禁向历史倒序寻找较早轮次的过渡性文本冒充最终总结。
 * 仅当最后一轮为正常结束 (finishReason === "stop") 且包含有效文本时才返回内容。
 */
export function extractLastAssistantText(messages: unknown[]): string {
  const msgs = Array.isArray(messages) ? (messages as AnyMessage[]) : [];
  let lastAssistantMsg: AnyMessage | undefined;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === "assistant") {
      lastAssistantMsg = m;
      break;
    }
  }

  if (!lastAssistantMsg) return "";

  const finishReason = normalizeFinishReason(lastAssistantMsg);
  if (finishReason !== "stop") {
    return "";
  }

  return textFromContent(lastAssistantMsg.content).trim();
}

export interface CompletionReportInput {
  taskId: string;
  taskTitle: string;
  role: string;
  roleName: string;
  branch?: string;
  status: string;
  completionReason?: "normal" | "output_truncated" | "error" | "cancelled" | "verification_failed";
  error?: string;
  changedFiles?: string[];
  lastCommit?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  lastAssistantText: string;
  taskResult?: TaskResult;
}

export interface BoundedCompletionReport {
  /** Injected into the parent session via session.prompt(). */
  parentReport: string;
  /** Full last-assistant text; stored on the task for UI / debug. */
  fullSummary: string;
  truncated: boolean;
}

function truncateTo(text: string, maxChars: number, suffix: string): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - suffix.length);
  return text.slice(0, keep) + suffix;
}

function formatReport(
  input: CompletionReportInput,
  files: string[],
  filesOmitted: number,
  summary: string,
  truncated: boolean,
): string {
  const defaultCompletionReason =
    input.completionReason ??
    (input.status === "incomplete"
      ? "output_truncated"
      : input.taskResult?.verification?.overall === "fail"
        ? "verification_failed"
        : input.error
          ? "error"
          : "normal");

  const meta: Record<string, unknown> = {
    subagent_completion_report: {
      task_id: input.taskId,
      task_title: input.taskTitle,
      role: input.role,
      role_name: input.roleName,
      branch: input.branch ?? "main",
      status: input.status,
      completion_reason: defaultCompletionReason,
      truncated,
      ...(input.error ? { error: input.error } : {}),
      changed_files: files,
      ...(filesOmitted > 0 ? { changed_files_omitted: filesOmitted } : {}),
      ...(input.lastCommit ? { commit: input.lastCommit } : {}),
      started_at: input.startedAt ?? null,
      completed_at: input.completedAt ?? null,
      ...(input.durationMs !== undefined ? { duration_ms: input.durationMs } : {}),
      // Runtime verification results (objective, not LLM-self-reported)
      ...(input.taskResult?.verification ? {
        runtime_verification: {
          overall: input.taskResult.verification.overall,
          diff: input.taskResult.verification.diff.status,
          scope: input.taskResult.verification.scope.status,
          ...(input.taskResult.verification.testExecution
            ? { test_execution: input.taskResult.verification.testExecution.status }
            : {}),
          ...(input.taskResult.verification.scopeViolations?.length
            ? { scope_violations: input.taskResult.verification.scopeViolations }
            : {}),
          commands_passed: input.taskResult.verification.commands.filter((c) => c.passed).length,
          commands_total: input.taskResult.verification.commands.length,
        },
      } : {}),
      // Structured review results (if reviewer role)
      ...(input.taskResult?.review ? {
        review: {
          verdict: input.taskResult.review.verdict,
          findings_count: input.taskResult.review.findings.length,
          blockers: input.taskResult.review.findings.filter((f) => f.severity === "blocker").length,
          majors: input.taskResult.review.findings.filter((f) => f.severity === "major").length,
          only_minor: input.taskResult.review.onlyMinorFindings,
        },
      } : {}),
    },
  };

  const errorSection = input.error ? `\n\n**异常/终止原因**：\n${input.error}` : "";

  return (
    `\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\`` +
    errorSection +
    `\n\n**执行总结与产出**：\n${summary}` +
    `\n\nThe full task transcript/result is available in ${input.taskId}.`
  );
}

export function buildBoundedCompletionReport(input: CompletionReportInput): BoundedCompletionReport {
  const fullSummary = input.lastAssistantText.trim();
  const files = (input.changedFiles ?? []).slice(0, 40);
  const filesOmitted = (input.changedFiles?.length ?? 0) - files.length;
  const emptySummary =
    input.status === "incomplete" || input.completionReason === "output_truncated"
      ? "（模型输出被截断，未能生成有效总结）"
      : input.completionReason === "verification_failed" ||
          input.taskResult?.verification?.overall === "fail"
        ? "（子任务已停止，Runtime 验证未通过，未形成成功交付）"
        : "（子任务已停止，未产出有效总结）";
  const rawSummary = fullSummary || emptySummary;

  const untruncated = formatReport(input, files, filesOmitted, rawSummary, false);
  if (untruncated.length <= MAX_SUBAGENT_REPORT_CHARS) {
    return { parentReport: untruncated, fullSummary, truncated: false };
  }

  const overflow = untruncated.length - MAX_SUBAGENT_REPORT_CHARS;
  const summaryBudget = Math.max(400, rawSummary.length - overflow - 32);
  const summary = truncateTo(rawSummary, summaryBudget, "\n... [truncated]");
  let parentReport = formatReport(input, files, filesOmitted, summary, true);
  if (parentReport.length > MAX_SUBAGENT_REPORT_CHARS) {
    parentReport = truncateTo(
      parentReport,
      MAX_SUBAGENT_REPORT_CHARS,
      `\n... [truncated; full result in ${input.taskId}]`,
    );
  }

  return { parentReport, fullSummary, truncated: true };
}

export function parseModelOverride(raw?: string | null): { provider: string; id: string } | null {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) return null;
  return { provider: s.slice(0, i), id: s.slice(i + 1) };
}
