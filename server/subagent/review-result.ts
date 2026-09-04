import type { ReviewFinding, ReviewResult, ReviewSeverity } from "../contracts/index.ts";

/**
 * Best-effort parse structured ReviewResult from reviewer's last assistant message.
 * Looks for JSON blocks containing verdict and findings.
 */
export function tryParseReviewResult(text: string): ReviewResult | undefined {
  // Try to find a JSON block with review structure
  const jsonMatch = text.match(/```(?:json)?\s*\n(\{[\s\S]*?"verdict"[\s\S]*?\})\s*\n```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      let rawVerdict = parsed.verdict;
      if (rawVerdict === "PASS") rawVerdict = "APPROVE";
      if (rawVerdict === "REWORK") rawVerdict = "REQUEST_CHANGES";

      if (rawVerdict && (rawVerdict === "APPROVE" || rawVerdict === "REQUEST_CHANGES")) {
        const findings: ReviewFinding[] = Array.isArray(parsed.findings)
          ? parsed.findings.map((f: Record<string, unknown>, i: number) => ({
              id: String(f.id ?? `finding-${i + 1}`),
              severity: validateSeverity(f.severity) ?? "minor",
              criterionId: typeof f.criterionId === "string" ? f.criterionId : undefined,
              invariantId: typeof f.invariantId === "string" ? f.invariantId : undefined,
              file: typeof f.file === "string" ? f.file : undefined,
              line: typeof f.line === "number" ? f.line : undefined,
              problem: String(f.problem ?? ""),
              evidence: String(f.evidence ?? ""),
              expected: typeof f.expected === "string" ? f.expected : undefined,
              actual: typeof f.actual === "string" ? f.actual : undefined,
              suggestedFix: typeof f.suggestedFix === "string" ? f.suggestedFix : undefined,
            }))
          : [];

        const onlyMinorFindings =
          findings.length === 0 ||
          findings.every((f) => f.severity === "minor" || f.severity === "nit");

        // Faithful canonicalization: Verifier prompt decides PASS vs REWORK.
        // Once Verifier explicitly outputs REWORK (mapped to REQUEST_CHANGES),
        // the runtime must NEVER silently rewrite it to APPROVE.
        return {
          verdict: rawVerdict,
          findings,
          onlyMinorFindings,
        };
      }
    } catch {
      /* parse failure is expected for non-structured output */
    }
  }

  // Fallback: detect simple APPROVE/REQUEST_CHANGES or PASS/REWORK keywords
  const hasApprove = /\bAPPROVE\b/.test(text) || /\bPASS\b/.test(text);
  const hasRequestChanges = /\bREQUEST_CHANGES\b/.test(text) || /\bREWORK\b/.test(text);
  if (hasApprove && !hasRequestChanges) {
    return { verdict: "APPROVE", findings: [], onlyMinorFindings: true };
  }
  if (hasRequestChanges && !hasApprove) {
    return { verdict: "REQUEST_CHANGES", findings: [], onlyMinorFindings: false };
  }

  return undefined;
}

function validateSeverity(val: unknown): ReviewSeverity | undefined {
  const valid: ReviewSeverity[] = ["blocker", "major", "minor", "nit"];
  return typeof val === "string" && valid.includes(val as ReviewSeverity)
    ? (val as ReviewSeverity)
    : undefined;
}
