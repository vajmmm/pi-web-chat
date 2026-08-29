import type {
  DeployEvidenceReport,
  ReviewVerdictReport,
  TaskResult,
  VerificationEvidence,
} from "./contracts/index.ts";

/**
 * Bounded completion reports for parent-session injection.
 *
 * Full subagent transcripts stay on the task record / UI.
 * The parent session only receives a last-assistant-message summary and structured evidence, hard-capped.
 */

export const MAX_SUBAGENT_REPORT_CHARS = 5000;

type AnyMessage = {
  role?: string;
  content?: unknown;
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

/** Last assistant message that actually contains text (skip tool-only turns). */
export function extractLastAssistantText(messages: unknown[]): string {
  const msgs = Array.isArray(messages) ? (messages as AnyMessage[]) : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "assistant") continue;
    const text = textFromContent(m.content).trim();
    if (text) return text;
  }
  return "";
}

export interface CompletionReportInput {
  taskId: string;
  taskTitle: string;
  role: string;
  roleName: string;
  branch?: string;
  status: string;
  changedFiles?: string[];
  lastCommit?: string;
  completedAt?: string;
  lastAssistantText: string;
  taskResult?: TaskResult;
  verification?: VerificationEvidence[];
  reviewReport?: ReviewVerdictReport;
  deployEvidence?: DeployEvidenceReport;
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
  const meta: Record<string, unknown> = {
    subagent_completion_report: {
      task_id: input.taskId,
      task_title: input.taskTitle,
      role: input.role,
      role_name: input.roleName,
      branch: input.branch ?? "main",
      status: input.status,
      truncated,
      changed_files: files,
      ...(filesOmitted > 0 ? { changed_files_omitted: filesOmitted } : {}),
      ...(input.lastCommit ? { commit: input.lastCommit } : {}),
      ...(input.verification && input.verification.length > 0
        ? { verification: input.verification }
        : {}),
      ...(input.reviewReport ? { review_verdict: input.reviewReport } : {}),
      ...(input.deployEvidence ? { deploy_evidence: input.deployEvidence } : {}),
      completed_at: input.completedAt ?? null,
    },
  };

  let extraSections = "";
  if (input.reviewReport) {
    extraSections += `\n\n**Review 审查结论**: ${input.reviewReport.verdict}`;
    if (input.reviewReport.issues && input.reviewReport.issues.length > 0) {
      extraSections += `\n**发现问题**:`;
      for (const issue of input.reviewReport.issues) {
        extraSections += `\n- [${issue.severity.toUpperCase()}] ${issue.file ? `${issue.file}: ` : ""}${issue.description}`;
      }
    }
  }

  if (input.verification && input.verification.length > 0) {
    extraSections += `\n\n**验证证据**:`;
    for (const v of input.verification) {
      extraSections += `\n- [${v.kind.toUpperCase()}] ${v.status.toUpperCase()} (${v.command || "N/A"}): ${v.summary || "无输出摘要"}`;
    }
  }

  return (
    `\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\`` +
    extraSections +
    `\n\n**执行总结与产出**：\n${summary}` +
    `\n\nThe full task transcript/result is available in ${input.taskId}.`
  );
}

export function buildBoundedCompletionReport(input: CompletionReportInput): BoundedCompletionReport {
  const fullSummary = input.lastAssistantText.trim();
  const files = (input.changedFiles ?? []).slice(0, 40);
  const filesOmitted = (input.changedFiles?.length ?? 0) - files.length;
  const emptySummary = "（子任务未输出文字内容）";
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
