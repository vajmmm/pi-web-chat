/**
 * Runtime Verification Layer
 *
 * Pure functions that verify objective facts about subagent execution results.
 * No LLM calls. Checks: diff existence, scope compliance, command exit codes.
 */

import type {
  CommandPurpose,
  CommandRecord,
  ExpectedEffect,
  TaskContract,
  VerificationCheck,
  VerificationResult,
  VerificationStatus,
} from "./contracts/task.ts";

// ---------------------------------------------------------------------------
// Glob matching (basic, no external dependency)
// ---------------------------------------------------------------------------

/**
 * Match a file path against a glob pattern.
 * Supports: `*` (single segment), `**` (any depth), `?` (single char).
 */
function globToRegex(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches any depth
        if (pattern[i + 2] === "/") {
          re += "(?:.+/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        // * matches within a single segment
        re += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else if (".+^${}()|[]\\".includes(ch)) {
      re += `\\${ch}`;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re);
}

function matchesGlob(filePath: string, pattern: string): boolean {
  if (pattern === "*") return true;
  return globToRegex(pattern).test(filePath);
}

function matchesAnyGlob(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesGlob(filePath, p));
}

// ---------------------------------------------------------------------------
// Command classification
// ---------------------------------------------------------------------------

/**
 * 自动识别命令用途：区分探索型命令 (exploration) 与门禁验证型命令 (test/build/verification/deployment)
 */
export function classifyCommandPurpose(command: string): CommandPurpose {
  const c = command.trim().toLowerCase();
  if (!c || c === "unknown") return "exploration";

  // Test commands
  if (
    c.startsWith("npm test") ||
    c.startsWith("npm run test") ||
    c.startsWith("pnpm test") ||
    c.startsWith("pnpm run test") ||
    c.startsWith("yarn test") ||
    c.startsWith("yarn run test") ||
    c.startsWith("npm t ") ||
    c.startsWith("vitest") ||
    c.startsWith("jest") ||
    c.startsWith("pytest") ||
    /^(?:(?:\S*\/)?python[0-9.]*|py)\s+-m\s+pytest(?:\s|$)/.test(c) ||
    c.startsWith("cargo test") ||
    c.startsWith("go test") ||
    c.startsWith("playwright") ||
    c.startsWith("cypress") ||
    c.startsWith("node --test") ||
    c.includes("test:") ||
    c.endsWith(".test.ts") ||
    c.endsWith(".test.js")
  ) {
    return "test";
  }

  // Build commands
  if (
    c.startsWith("npm run build") ||
    c.startsWith("pnpm build") ||
    c.startsWith("pnpm run build") ||
    c.startsWith("yarn build") ||
    c.startsWith("yarn run build") ||
    c.startsWith("tsc") ||
    c.startsWith("cargo build") ||
    c.startsWith("go build") ||
    c.startsWith("make") ||
    c.startsWith("vite build") ||
    c.startsWith("webpack") ||
    c.startsWith("esbuild") ||
    c.startsWith("docker build")
  ) {
    return "build";
  }

  // Verification / Lint / Check commands
  if (
    c.startsWith("npm run check") ||
    c.startsWith("pnpm check") ||
    c.startsWith("pnpm run check") ||
    c.startsWith("npm run lint") ||
    c.startsWith("pnpm lint") ||
    c.startsWith("pnpm run lint") ||
    c.startsWith("npm run typecheck") ||
    c.startsWith("pnpm typecheck") ||
    c.startsWith("pnpm run typecheck") ||
    c.startsWith("eslint") ||
    c.startsWith("prettier --check") ||
    c.startsWith("git diff --check")
  ) {
    return "verification";
  }

  // Deployment commands
  if (
    c.startsWith("npm run deploy") ||
    c.startsWith("pnpm run deploy") ||
    c.startsWith("docker push") ||
    c.startsWith("kubectl") ||
    c.startsWith("terraform")
  ) {
    return "deployment";
  }

  // Default: exploration (grep, ls, cat, find, git status, git log, pwd, etc.)
  return "exploration";
}

// ---------------------------------------------------------------------------
// Diff verification
// ---------------------------------------------------------------------------

/** 各角色的默认 expectedEffects 兜底策略（显式 expectedEffects 优先） */
export const DEFAULT_ROLE_EXPECTED_EFFECTS: Record<string, ExpectedEffect[]> = {
  coordinator: ["analysis"],
  reviewer: ["analysis"],
  tester: ["test_execution"],
  junior_fe: ["code_change"],
  junior_be: ["code_change"],
  fullstack: ["code_change"],
  deployer: ["deployment"],
};

/** 解析任务生效的 expectedEffects（显式声明优先于角色默认兜底） */
export function resolveExpectedEffects(
  role: string,
  expectedEffects?: ExpectedEffect[],
): ExpectedEffect[] {
  if (expectedEffects && expectedEffects.length > 0) {
    return expectedEffects;
  }
  return DEFAULT_ROLE_EXPECTED_EFFECTS[role] ?? ["code_change"];
}

/**
 * Verify that the agent actually produced file changes according to expectedEffects.
 */
function verifyDiff(
  changedFiles: string[],
  role: string,
  expectedEffects?: ExpectedEffect[],
): VerificationCheck {
  const effectiveEffects = resolveExpectedEffects(role, expectedEffects);

  if (effectiveEffects.includes("code_change")) {
    if (changedFiles.length === 0) {
      return {
        name: "diff",
        status: "fail",
        detail: "NO_EFFECT: Expected code_change but no files were modified",
      };
    }
    return {
      name: "diff",
      status: "pass",
      detail: `${changedFiles.length} file(s) changed`,
    };
  }

  if (
    effectiveEffects.includes("analysis") ||
    effectiveEffects.includes("test_execution") ||
    effectiveEffects.includes("deployment") ||
    effectiveEffects.includes("artifact")
  ) {
    return {
      name: "diff",
      status: "pass",
      detail:
        changedFiles.length > 0
          ? `${changedFiles.length} file(s) changed (expected: ${effectiveEffects.join(", ")})`
          : `No file changes required (expected: ${effectiveEffects.join(", ")})`,
    };
  }

  return {
    name: "diff",
    status: changedFiles.length === 0 ? "fail" : "pass",
    detail:
      changedFiles.length === 0
        ? "NO_EFFECT: Implementation task completed but no files were changed"
        : `${changedFiles.length} file(s) changed`,
  };
}

// ---------------------------------------------------------------------------
// Scope verification
// ---------------------------------------------------------------------------

/**
 * Check that all changed files fall within the contract's scope.include
 * and none fall within scope.exclude.
 */
function verifyScope(
  changedFiles: string[],
  scope: { include?: string[]; exclude?: string[] } | undefined,
): { check: VerificationCheck; violations: string[] } {
  if (!scope || changedFiles.length === 0) {
    return {
      check: { name: "scope", status: "pass", detail: "No scope constraints or no changes" },
      violations: [],
    };
  }

  const violations: string[] = [];

  for (const file of changedFiles) {
    // Check exclude first (higher priority)
    if (scope.exclude && scope.exclude.length > 0) {
      if (matchesAnyGlob(file, scope.exclude)) {
        violations.push(file);
        continue;
      }
    }

    // Check include
    if (scope.include && scope.include.length > 0) {
      if (!matchesAnyGlob(file, scope.include)) {
        violations.push(file);
      }
    }
  }

  if (violations.length > 0) {
    return {
      check: {
        name: "scope",
        status: "fail",
        detail: `SCOPE_VIOLATION: ${violations.length} file(s) outside allowed scope: ${violations.join(", ")}`,
      },
      violations,
    };
  }

  return {
    check: { name: "scope", status: "pass", detail: "All changes within allowed scope" },
    violations: [],
  };
}

// ---------------------------------------------------------------------------
// Command log and message parsing
// ---------------------------------------------------------------------------

interface MessageBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  args?: Record<string, unknown>;
}

interface MessageItem {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  isError?: boolean;
  details?: Record<string, unknown>;
}

function truncateSummary(text: string, maxLen = 300): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen) + "...";
}

/**
 * Extract authentic command execution records from subagent conversation messages.
 * Obtains real command string, real exitCode, and stdout/stderr summaries.
 * Marks fields as "unknown" / "not_available" if they cannot be obtained.
 */
export function extractCommandRecords(
  messages?: unknown[],
  logs?: string[],
): CommandRecord[] {
  const records: CommandRecord[] = [];
  const msgs = Array.isArray(messages) ? (messages as MessageItem[]) : [];

  // Index toolResults by toolCallId
  const toolResults = new Map<
    string,
    { text: string; isError: boolean; exitCode?: number; details?: Record<string, unknown> }
  >();

  for (const m of msgs) {
    if (m.role === "toolResult" && typeof m.toolCallId === "string") {
      let text = "";
      if (typeof m.content === "string") {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        text = m.content
          .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
          .map((b) => (b as { text?: string }).text ?? "")
          .join("\n");
      }

      const exitCode = typeof m.details?.exitCode === "number" ? m.details.exitCode : undefined;
      toolResults.set(m.toolCallId, {
        text,
        isError: m.isError === true,
        exitCode,
        details: m.details,
      });
    }
  }

  // Find all bash tool calls in assistant messages
  for (const m of msgs) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;

    for (const b of m.content as MessageBlock[]) {
      if (b.type === "toolCall" && b.name === "bash") {
        const callId = b.id ?? "";
        const args = (b.arguments ?? b.args) as Record<string, unknown> | undefined;
        const command =
          typeof args?.command === "string"
            ? args.command.trim()
            : typeof args?.cmd === "string"
              ? args.cmd.trim()
              : "unknown";

        const purpose = classifyCommandPurpose(command);
        const result = toolResults.get(callId);
        if (result) {
          const hasRealExitCode = typeof result.exitCode === "number";
          const exitCode = hasRealExitCode ? result.exitCode! : null;
          const exitCodeSource = hasRealExitCode ? "runtime" : "unknown";
          const passed = !result.isError && (hasRealExitCode ? exitCode === 0 : true);
          records.push({
            command,
            exitCode,
            exitCodeSource,
            passed,
            purpose,
            stdoutSummary: !result.isError && result.text ? truncateSummary(result.text) : undefined,
            stderrSummary: result.isError && result.text ? truncateSummary(result.text) : undefined,
          });
        } else {
          // Tool call recorded but result not found
          records.push({
            command,
            exitCode: null,
            exitCodeSource: "unknown",
            passed: false,
            purpose,
            stdoutSummary: "not_available",
            stderrSummary: "Result unrecorded",
          });
        }
      }
    }
  }

  // Fallback: If no message-level toolCalls were found but logs exist with "[Tool] bash"
  if (records.length === 0 && Array.isArray(logs)) {
    for (const log of logs) {
      if (!log.startsWith("[Tool] bash")) continue;
      const isError = log.includes("Error");
      records.push({
        command: "unknown",
        exitCode: null,
        exitCodeSource: "unknown",
        passed: !isError,
        purpose: "exploration",
        stdoutSummary: "not_available",
        stderrSummary: isError ? "Execution failed" : "not_available",
      });
    }
  }

  return records;
}

// ---------------------------------------------------------------------------
// Test Execution verification
// ---------------------------------------------------------------------------

/**
 * 验证测试执行效果（当任务 expectedEffects 包含 test_execution 时强制检查）
 */
export function verifyTestExecution(
  commands: CommandRecord[],
  effectiveEffects: ExpectedEffect[],
): VerificationCheck | undefined {
  if (!effectiveEffects.includes("test_execution")) {
    return undefined;
  }

  const testCommands = commands.filter((c) => c.purpose === "test");

  if (testCommands.length === 0) {
    return {
      name: "test_execution",
      status: "not_run",
      detail: "NO_TEST_EVIDENCE: Task expected test_execution but no test commands were executed",
    };
  }

  // 检查是否有失败的测试命令
  const failedTests = testCommands.filter(
    (c) => !c.passed || (c.exitCode !== null && c.exitCode !== 0),
  );
  if (failedTests.length > 0) {
    return {
      name: "test_execution",
      status: "fail",
      detail: `${failedTests.length} test command(s) failed`,
    };
  }

  // 检查是否有 exitCode 未知的测试命令
  const unknownTests = testCommands.filter((c) => c.exitCodeSource === "unknown" || c.exitCode === null);
  if (unknownTests.length > 0) {
    return {
      name: "test_execution",
      status: "partially_verified",
      detail: `${unknownTests.length} test command(s) had unverified exit code`,
    };
  }

  return {
    name: "test_execution",
    status: "pass",
    detail: `All ${testCommands.length} test command(s) passed`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all runtime verification checks on a completed task.
 *
 * This is called after agent_end during task completion finalization.
 */
export function runVerification(
  changedFiles: string[],
  contract: TaskContract,
  messagesOrLogs?: unknown[] | string[],
  fallbackLogs?: string[],
): VerificationResult {
  const effectiveEffects = resolveExpectedEffects(contract.role, contract.expectedEffects);
  const diffCheck = verifyDiff(changedFiles, contract.role, contract.expectedEffects);
  const { check: scopeCheck, violations } = verifyScope(changedFiles, contract.scope);

  let commands: CommandRecord[];
  if (Array.isArray(messagesOrLogs) && messagesOrLogs.length > 0 && typeof messagesOrLogs[0] === "object") {
    commands = extractCommandRecords(messagesOrLogs, fallbackLogs);
  } else if (Array.isArray(messagesOrLogs) && (messagesOrLogs.length === 0 || typeof messagesOrLogs[0] === "string")) {
    commands = extractCommandRecords(undefined, messagesOrLogs as string[]);
  } else {
    commands = extractCommandRecords(undefined, fallbackLogs);
  }

  const testExecutionCheck = verifyTestExecution(commands, effectiveEffects);

  // 区分探索命令与门禁命令：仅 test/build/verification/deployment 命令参与 fail 判定
  const gateCommands = commands.filter((c) => c.purpose !== "exploration");

  // Determine overall status
  let overall: VerificationStatus = "pass";
  if (diffCheck.status === "fail" || scopeCheck.status === "fail") {
    overall = "fail";
  } else if (testExecutionCheck && testExecutionCheck.status === "fail") {
    overall = "fail";
  } else if (testExecutionCheck && testExecutionCheck.status === "not_run") {
    overall = "fail";
  } else if (gateCommands.some((c) => !c.passed || (c.exitCode !== null && c.exitCode !== 0))) {
    overall = "fail";
  } else if (testExecutionCheck && testExecutionCheck.status === "partially_verified") {
    overall = "partially_verified";
  } else if (gateCommands.some((c) => c.exitCodeSource === "unknown")) {
    overall = "partially_verified";
  }

  return {
    diff: diffCheck,
    scope: scopeCheck,
    testExecution: testExecutionCheck,
    commands,
    overall,
    scopeViolations: violations.length > 0 ? violations : undefined,
    changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
  };
}

// Re-export for testing
export { globToRegex, matchesGlob, matchesAnyGlob };
