/**
 * Phase 3 Vertical-Slice A/B Benchmark & Real Offline Evaluator
 *
 * Compares Mode A (Pi Native Compaction) vs Mode B (Structured Continuation Compaction)
 * across 3 distinct workloads with multiple paired runs on real MiniMax-M2.7:
 *   1. Workload 1: Core Multi-Module Coding Slice (50+ turns, natural compaction)
 *   2. Workload 2: Negative Knowledge / "Do Not Retry" Workload
 *   3. Workload 3: Recovery Workload (artifact / transcript recovery)
 *
 * Evaluates semantic continuity via deterministic offline inspection of transcripts and tool actions.
 *
 * Run: npx tsx scripts/phase3-ab-benchmark.ts
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RoleRegistry } from "../server/contracts/index.ts";
import { SubagentManager, subagentTasks } from "../server/subagent-manager.ts";
import { readCompactionTelemetry, type CompactionTelemetry } from "../server/compaction-telemetry.ts";
import type { UISubagentTask } from "../shared/protocol.ts";

const PROVIDER = process.env.BENCHMARK_PROVIDER || "minimax-custom";
const MODEL_ID = process.env.BENCHMARK_MODEL || "MiniMax-M2.7";
const TIMEOUT_MS = Number(process.env.BENCHMARK_TIMEOUT_MS || 300_000);
const NUM_PAIRED_RUNS = Number(process.env.BENCHMARK_RUNS || 3);

// Context Window and Safety Margin:
// contextWindow = 20,000, triggerRatio = 0.75, reserveTokens = 5000, maxTokens = 2048
// effectiveThreshold = min(20000 * 0.75, 20000 - 5000) = min(15000, 15000) = 15000
// Request hard boundary = 20000 - 2048 = 17952
// Safety margin before hard boundary = 2952 tokens
const TEST_CONTEXT_WINDOW = 20000;
const TEST_MAX_TOKENS = 2048;
const TEST_TRIGGER_RATIO = 0.75;
const TEST_RESERVE_TOKENS = 5000;
const TEST_KEEP_RECENT_TOKENS = 7000;

export interface SingleRunResult {
  runMode: "native" | "structured";
  workload: "core_coding" | "negative_knowledge" | "recovery";
  runIndex: number;
  taskSuccess: boolean;
  finalVerificationSuccess: boolean;
  totalToolCalls: number;
  readToolCalls: number;
  editToolCalls: number;
  testCommandsRun: number;

  compactionCount: number;
  thresholdCompactionCount: number;
  overflowCompactionCount: number;
  manualCompactionCount: number;

  telemetryRecords: CompactionTelemetry[];

  // Deterministic Evaluator Metrics
  unnecessaryRepeatedReadCount: number;
  repeatedInvestigationCount: number;
  repeatedFailedApproachCount: number;
  unresolvedFrontierLoss: boolean;
  incorrectModifiedFileState: boolean;
  verificationStateLossCount: number;
  wrongNextActionCount: number;

  // Recovery Metrics
  artifactRecoveryCount: number;
  transcriptRecoveryCount: number;
  recoverySuccess: boolean;

  // Internal Health Metrics
  structuredSchemaValidCount: number;
  structuredSchemaComplianceRate: number;

  durationMs: number;
}

export interface MetricSummary {
  median: number;
  min: number;
  max: number;
}

export interface WorkloadAggregatedResult {
  workload: string;
  nativeRuns: SingleRunResult[];
  structuredRuns: SingleRunResult[];
  metrics: Record<string, { native: MetricSummary; structured: MetricSummary }>;
}

// ----------------------------------------------------------------------------
// Tool Call Extraction and Offline Evaluator
// ----------------------------------------------------------------------------

interface ExecutedToolCall {
  id: string;
  name: string;
  input: any;
  result?: string;
  isError?: boolean;
}

function extractToolCallsFromMessages(messages: any[]): ExecutedToolCall[] {
  const toolCalls: ExecutedToolCall[] = [];
  const resultMap = new Map<string, { result: string; isError?: boolean }>();

  for (const msg of messages) {
    if (msg.role === "toolResult" || msg.role === "tool_result") {
      const id = msg.toolCallId || msg.tool_call_id || msg.id;
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((b: any) => b.text || "").join("\n")
          : JSON.stringify(msg.content);
      if (id) {
        resultMap.set(id, { result: text, isError: Boolean(msg.isError) });
      }
    }
  }

  for (const msg of messages) {
    if (msg.role === "assistant") {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "toolCall" || block.type === "tool_call") {
            const id = block.id || block.toolCallId || `call-${toolCalls.length}`;
            const res = resultMap.get(id);
            toolCalls.push({
              id,
              name: block.name || block.toolName || "unknown",
              input: block.input || block.parameters || block.args || {},
              result: res?.result,
              isError: res?.isError,
            });
          }
        }
      }
    }
  }

  return toolCalls;
}

export class OfflineBenchmarkEvaluator {
  /**
   * Evaluates unnecessary repeated reads:
   * Reading a file that was already read without any intervening edit/write on that file.
   */
  static evaluateRepeatedReads(toolCalls: ExecutedToolCall[]): number {
    let count = 0;
    const fileLastModifiedTurn = new Map<string, number>();
    const fileLastReadTurn = new Map<string, number>();

    for (let turn = 0; turn < toolCalls.length; turn++) {
      const tc = toolCalls[turn];
      if (tc.name === "edit" || tc.name === "write") {
        const filePath = tc.input?.path || tc.input?.TargetFile;
        if (filePath) fileLastModifiedTurn.set(String(filePath), turn);
      } else if (tc.name === "read" || tc.name === "view_file") {
        const filePath = tc.input?.path || tc.input?.AbsolutePath;
        if (filePath) {
          const strPath = String(filePath);
          const lastRead = fileLastReadTurn.get(strPath);
          const lastMod = fileLastModifiedTurn.get(strPath) ?? -1;
          if (lastRead !== undefined && lastRead > lastMod) {
            count++;
          }
          fileLastReadTurn.set(strPath, turn);
        }
      }
    }
    return count;
  }

  /**
   * Evaluates repeated failed approach (Workload 2):
   * Re-attempting an approach that previously threw a clear failure error.
   */
  static evaluateRepeatedFailedApproach(toolCalls: ExecutedToolCall[], failedPatterns: RegExp[]): number {
    let failedPatternSeen = false;
    let count = 0;

    for (const tc of toolCalls) {
      if (tc.result && (tc.result.includes("Regex replacement failed") || tc.result.includes("Single-pass regex"))) {
        failedPatternSeen = true;
      }
      if (failedPatternSeen && (tc.name === "edit" || tc.name === "write")) {
        const text = JSON.stringify(tc.input || {});
        for (const pat of failedPatterns) {
          if (pat.test(text)) {
            count++;
          }
        }
      }
    }
    return count;
  }

  /**
   * Evaluates incorrect modified file state assumptions:
   * e.g., edit tool failing with "targetContent not found" or "mismatched line range".
   */
  static evaluateIncorrectModifiedFileState(toolCalls: ExecutedToolCall[]): boolean {
    for (const tc of toolCalls) {
      if (tc.isError || (tc.result && tc.result.includes("error"))) {
        const res = tc.result || "";
        if (
          res.includes("targetContent") && res.includes("not found") ||
          res.includes("could not be found") ||
          res.includes("TargetContent") && res.includes("match") ||
          res.includes("does not match text in file")
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Evaluates verification state loss:
   * Re-running test commands on already-passing modules without any intervening code edits.
   */
  static evaluateVerificationStateLoss(toolCalls: ExecutedToolCall[]): number {
    let redundantTestRuns = 0;
    const passedSuites = new Set<string>();
    let codeModifiedSincePass = false;

    for (const tc of toolCalls) {
      if (tc.name === "edit" || tc.name === "write") {
        codeModifiedSincePass = true;
      } else if (tc.name === "bash" || tc.name === "run_command") {
        const cmd = String(tc.input?.command || tc.input?.CommandLine || "");
        if (cmd.includes("node --test") || cmd.includes("npm test")) {
          if (!codeModifiedSincePass && passedSuites.has(cmd)) {
            redundantTestRuns++;
          }
          if (tc.result && !tc.isError && tc.result.includes("# pass") && !tc.result.includes("# fail")) {
            passedSuites.add(cmd);
            codeModifiedSincePass = false;
          }
        }
      }
    }
    return redundantTestRuns;
  }

  /**
   * Evaluates repeated investigation:
   * Inspecting (read/grep/find) an already-completed, verified module after compaction.
   */
  static evaluateRepeatedInvestigation(
    toolCalls: ExecutedToolCall[],
    completedFilesBeforeCompaction: Set<string>,
    compactionTurnIndex: number,
  ): number {
    let count = 0;
    for (let turn = compactionTurnIndex; turn < toolCalls.length; turn++) {
      const tc = toolCalls[turn];
      if (tc.name === "read" || tc.name === "grep" || tc.name === "grep_search") {
        const p = String(tc.input?.path || tc.input?.AbsolutePath || tc.input?.SearchPath || "");
        for (const comp of completedFilesBeforeCompaction) {
          if (p.includes(comp)) {
            count++;
          }
        }
      }
    }
    return count;
  }
}

// ----------------------------------------------------------------------------
// Workload 1: Core Multi-Module Coding Slice Fixture & Execution
// ----------------------------------------------------------------------------

function setupCoreCodingFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-workload1-core-"));
  execFileSync("git", ["init", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Benchmark Runner"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "benchmark@test.local"]);

  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "stat-reporter",
        version: "1.0.0",
        type: "module",
        scripts: { test: "node --test test/*.test.js" },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(dir, "src", "math.js"),
    `export function sum(values) { return values.reduce((a, b) => a + b, 0); }
export function mean(values) { return values.length === 0 ? 0 : sum(values) / values.length; }
export function variance(values) {
  if (values.length === 0) return 0;
  const m = mean(values);
  return values.reduce((acc, v) => acc + Math.pow(v - m, 2), 0) / values.length;
}
`,
  );

  writeFileSync(
    join(dir, "test", "math.test.js"),
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum, mean, variance, weightedMean, weightedVariance } from '../src/math.js';

test('basic math functions', () => {
  assert.equal(sum([1, 2, 3, 4]), 10);
  assert.equal(mean([2, 4, 6]), 4);
  assert.equal(variance([2, 4, 6]), 8 / 3);
});

test('weightedMean and weightedVariance', () => {
  assert.equal(weightedMean([10, 20, 30], [0.2, 0.3, 0.5]), 23);
  assert.equal(typeof weightedVariance([10, 20, 30], [0.2, 0.3, 0.5]), 'number');
  assert.throws(() => weightedMean([1, 2], [1]), /LENGTH_MISMATCH/);
});
`,
  );

  writeFileSync(
    join(dir, "src", "validator.js"),
    `export class ValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}
export function validateNumericArray(arr, name = 'array') {
  if (!Array.isArray(arr) || arr.length === 0) throw new ValidationError(name + ' must be non-empty array', 'EMPTY_ARRAY');
  if (arr.some((v) => typeof v !== 'number' || Number.isNaN(v))) throw new ValidationError(name + ' must contain only numbers', 'INVALID_NUMERIC');
}
`,
  );

  writeFileSync(
    join(dir, "test", "validator.test.js"),
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError, validateNumericArray, validateWeights } from '../src/validator.js';

test('validateNumericArray', () => {
  assert.doesNotThrow(() => validateNumericArray([1, 2, 3]));
  assert.throws(() => validateNumericArray([]), (err) => err instanceof ValidationError && err.code === 'EMPTY_ARRAY');
});

test('validateWeights', () => {
  assert.doesNotThrow(() => validateWeights([0.1, 0.2, 0.7], 3));
  assert.throws(() => validateWeights([0.5, 0.6], 2), (err) => err instanceof ValidationError && err.code === 'INVALID_WEIGHTS');
  assert.throws(() => validateWeights([0.5, 0.5], 3), (err) => err instanceof ValidationError && err.code === 'INVALID_WEIGHTS');
});
`,
  );

  writeFileSync(
    join(dir, "src", "analysis.js"),
    `import { mean, variance } from './math.js';
export function stddev(values) { return Math.sqrt(variance(values)); }
`,
  );

  writeFileSync(
    join(dir, "test", "analysis.test.js"),
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stddev, median, detectOutliers, correlation } from '../src/analysis.js';

test('stddev and median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('detectOutliers and correlation', () => {
  const data = [10, 12, 11, 13, 12, 100];
  const outliers = detectOutliers(data, 2);
  assert.equal(outliers.length, 1);
  assert.equal(outliers[0].value, 100);
  assert.equal(Math.round(correlation([1, 2, 3], [2, 4, 6]) * 100) / 100, 1.0);
});
`,
  );

  writeFileSync(
    join(dir, "src", "transform.js"),
    `export function minMaxScale(values, minTarget = 0, maxTarget = 1) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return values.map(() => minTarget);
  return values.map((v) => minTarget + ((v - min) / (max - min)) * (maxTarget - minTarget));
}
`,
  );

  writeFileSync(
    join(dir, "test", "transform.test.js"),
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minMaxScale, groupBy, aggregate } from '../src/transform.js';

test('minMaxScale', () => {
  assert.deepEqual(minMaxScale([0, 5, 10]), [0, 0.5, 1]);
});

test('groupBy and aggregate', () => {
  const records = [
    { cat: 'A', val: 10 },
    { cat: 'B', val: 20 },
    { cat: 'A', val: 30 },
  ];
  const grouped = groupBy(records, 'cat');
  assert.equal(grouped.A.length, 2);
  const agg = aggregate(records, 'cat', 'val', (vals) => vals.reduce((a, b) => a + b, 0));
  assert.deepEqual(agg, { A: 40, B: 20 });
});
`,
  );

  writeFileSync(join(dir, "src", "exporter.js"), `import { writeFileSync, readFileSync } from 'node:fs';\n`);

  writeFileSync(
    join(dir, "test", "exporter.test.js"),
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJson, importJson, exportCsv } from '../src/exporter.js';

test('exportJson and importJson', () => {
  const file = join(tmpdir(), 'test-export-' + Date.now() + '.json');
  exportJson(file, { status: 'ok', num: 42 });
  const read = importJson(file);
  assert.deepEqual(read, { status: 'ok', num: 42 });
});
`,
  );

  writeFileSync(
    join(dir, "src", "formatter.js"),
    `export function formatTable(headers, rows) {
  const headerLine = '| ' + headers.join(' | ') + ' |';
  const sepLine = '| ' + headers.map(() => '---').join(' | ') + ' |';
  const rowLines = rows.map((r) => '| ' + r.join(' | ') + ' |');
  return [headerLine, sepLine, ...rowLines].join('\\n');
}
`,
  );

  writeFileSync(
    join(dir, "src", "report.js"),
    `import { mean, variance } from './math.js';
import { formatTable } from './formatter.js';
`,
  );

  writeFileSync(
    join(dir, "test", "report.test.js"),
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWeightedReport } from '../src/report.js';

test('generateWeightedReport', () => {
  const rep = generateWeightedReport('Sales Performance', [100, 200, 300], [0.2, 0.5, 0.3]);
  assert.ok(rep.includes('# Report: Sales Performance'));
  assert.ok(rep.includes('Weighted Mean'));
  assert.ok(rep.includes('| Weight |'));
});
`,
  );

  writeFileSync(
    join(dir, "src", "cli.js"),
    `import { generateWeightedReport } from './report.js';
console.log(generateWeightedReport('CLI Sample', [10, 20, 30], [0.2, 0.3, 0.5]));
`,
  );

  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "initial workload skeleton"]);
  return dir;
}

// ----------------------------------------------------------------------------
// Workload 2: Negative Knowledge / "Do Not Retry" Workload Fixture
// ----------------------------------------------------------------------------

function setupNegativeKnowledgeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-workload2-neg-"));
  execFileSync("git", ["init", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Benchmark Runner"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "benchmark@test.local"]);

  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "query-engine",
        version: "1.0.0",
        type: "module",
        scripts: { test: "node --test test/*.test.js" },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(dir, "src", "query-parser.js"),
    `/**
 * Query Parser Engine
 * NOTE: Multi-level nested logical queries must be parsed with a proper TokenStream / AST.
 */
export function parseBooleanQuery(queryStr, record) {
  // To be implemented
  return false;
}

export function parseAggregationQuery(aggStr, records) {
  // To be implemented
  return 0;
}
`,
  );

  writeFileSync(
    join(dir, "test", "query.test.js"),
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBooleanQuery, parseAggregationQuery } from '../src/query-parser.js';

test('parseBooleanQuery with deeply nested conditions', () => {
  const query = '((age > 20 AND (status == "active" OR tier == 1)) OR (role == "admin" AND NOT (flag == false)))';
  const rec1 = { age: 25, status: "active", tier: 2, role: "user", flag: true };
  const rec2 = { age: 18, status: "inactive", tier: 2, role: "admin", flag: true };
  const rec3 = { age: 18, status: "inactive", tier: 2, role: "user", flag: false };

  assert.equal(parseBooleanQuery(query, rec1), true);
  assert.equal(parseBooleanQuery(query, rec2), true);
  assert.equal(parseBooleanQuery(query, rec3), false);
});

test('parseAggregationQuery with nested filters', () => {
  const records = [
    { amount: 100, tier: 1, region: 'EU', discount: 0.05 },
    { amount: 200, tier: 2, region: 'US', discount: 0.15 },
    { amount: 300, tier: 2, region: 'EU', discount: 0.05 },
  ];
  const query = 'SUM(amount) WHERE ((tier == 1 AND region == "EU") OR (tier == 2 AND discount > 0.1))';
  const result = parseAggregationQuery(query, records);
  assert.equal(result, 300);
});
`,
  );

  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "initial query fixture"]);
  return dir;
}

// ----------------------------------------------------------------------------
// Workload 3: Recovery Workload Fixture
// ----------------------------------------------------------------------------

function setupRecoveryFixture(): { repoDir: string; expectedSecrets: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "pi-workload3-rec-"));
  execFileSync("git", ["init", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Benchmark Runner"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "benchmark@test.local"]);

  mkdirSync(join(dir, "spec"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });

  const secrets: Record<string, string> = {
    "auth-service-alpha": "sec_tok_alpha_77a9b1c2",
    "auth-service-beta": "sec_tok_beta_88c3d4e5",
    "billing-gateway-gamma": "sec_tok_gamma_99e5f6a7",
    "data-pipeline-delta": "sec_tok_delta_11a2b3c4",
    "audit-logger-epsilon": "sec_tok_epsilon_22b3c4d5",
    "event-stream-zeta": "sec_tok_zeta_33c4d5e6",
  };

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "secure-auth-gateway",
        version: "1.0.0",
        type: "module",
        scripts: { test: "node --test test/*.test.js" },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(dir, "spec", "security-manifest.json"),
    JSON.stringify(
      {
        version: "2.4.0",
        services: Object.entries(secrets).map(([name, secret]) => ({
          serviceName: name,
          hmacSecret: secret,
          algorithm: "sha256",
        })),
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(dir, "src", "gateway.js"),
    `import crypto from 'node:crypto';

export class AuthGateway {
  constructor() {
    this.services = new Map();
  }

  registerService(name, secret) {
    this.services.set(name, secret);
  }

  computeSignature(serviceName, payload) {
    const secret = this.services.get(serviceName);
    if (!secret) throw new Error('UNKNOWN_SERVICE: ' + serviceName);
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
  }

  verifySignature(serviceName, payload, signature) {
    return this.computeSignature(serviceName, payload) === signature;
  }
}
`,
  );

  writeFileSync(
    join(dir, "test", "auth.test.js"),
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthGateway } from '../src/gateway.js';
import { readFileSync } from 'node:fs';

test('auth gateway registration and signature validation', () => {
  const manifest = JSON.parse(readFileSync('./spec/security-manifest.json', 'utf8'));
  const gw = new AuthGateway();
  for (const s of manifest.services) {
    gw.registerService(s.serviceName, s.hmacSecret);
  }
  const sigGamma = gw.computeSignature('billing-gateway-gamma', 'invoice-1001');
  assert.equal(gw.verifySignature('billing-gateway-gamma', 'invoice-1001', sigGamma), true);
  assert.equal(gw.verifySignature('billing-gateway-gamma', 'invoice-1002', sigGamma), false);
});
`,
  );

  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "initial recovery fixture"]);
  return { repoDir: dir, expectedSecrets: secrets };
}

// ----------------------------------------------------------------------------
// Runner Engine for a Single Workload Run
// ----------------------------------------------------------------------------

async function waitForCompletion(
  manager: SubagentManager,
  taskId: string,
  timeoutMs: number,
): Promise<UISubagentTask> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const inst = subagentTasks.get(taskId);
    if (!inst) throw new Error(`task missing: ${taskId}`);
    const status = inst.task.status;
    if (
      status === "completed" ||
      status === "failed" ||
      status === "incomplete" ||
      status === "aborted" ||
      status === "conflict"
    ) {
      return inst.task;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const task = subagentTasks.get(taskId)?.task;
  throw new Error(`Timeout waiting for task ${taskId}. status=${task?.status}`);
}

async function runWorkloadSlice(
  workload: "core_coding" | "negative_knowledge" | "recovery",
  mode: "native" | "structured",
  runIndex: number,
): Promise<SingleRunResult> {
  console.log(`\n======================================================`);
  console.log(`RUNNING [${workload.toUpperCase()}] Run #${runIndex + 1} Mode: [${mode.toUpperCase()}]`);
  console.log(`======================================================`);

  process.env.COMPACTION_MODE = mode;

  const agentDir = mkdtempSync(join(tmpdir(), `pi-ab-agent-${workload}-${mode}-${runIndex}-`));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HARNESS_RUNTIME_ROOT = join(agentDir, "harness-runtime");

  const homeAgent = join(process.env.HOME || "", ".pi", "agent");
  const hostModelsRaw = existsSync(join(homeAgent, "models.json"))
    ? JSON.parse(readFileSync(join(homeAgent, "models.json"), "utf8"))
    : {};

  const testModels = structuredClone(hostModelsRaw);
  if (testModels.providers?.[PROVIDER]?.models) {
    for (const m of testModels.providers[PROVIDER].models) {
      if (m.id === MODEL_ID) {
        m.contextWindow = TEST_CONTEXT_WINDOW;
        m.maxTokens = TEST_MAX_TOKENS;
      }
    }
  }
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(testModels, null, 2), "utf8");
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify(
      {
        compaction: {
          enabled: true,
          triggerRatio: TEST_TRIGGER_RATIO,
          reserveTokens: TEST_RESERVE_TOKENS,
          keepRecentTokens: TEST_KEEP_RECENT_TOKENS,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  if (existsSync(join(homeAgent, "auth.json"))) {
    writeFileSync(join(agentDir, "auth.json"), readFileSync(join(homeAgent, "auth.json")));
  }

  let repo = "";
  let prompt = "";
  let expectedAcceptance: string[] = [];
  let testVerificationFn: (worktree: string) => boolean = () => true;

  if (workload === "core_coding") {
    repo = setupCoreCodingFixture();
    expectedAcceptance = ["All 6 test suites pass node --test test/*.test.js"];
    prompt = `You are an autonomous senior developer implementing all 8 modules of Stat Reporter.
Follow each step in order, create/edit the required files, run unit tests, and fix any failures:
1. In src/math.js: implement weightedMean(values, weights) and weightedVariance(values, weights). Run node --test test/math.test.js.
2. In src/validator.js: implement validateWeights(weights, expectedLength). Run node --test test/validator.test.js.
3. In src/analysis.js: implement median(values), detectOutliers(values, threshold), correlation(x, y). Run node --test test/analysis.test.js.
4. In src/transform.js: implement groupBy(records, key), aggregate(records, groupKey, valueKey, aggFn). Run node --test test/transform.test.js.
5. In src/exporter.js: implement exportJson(path, data), importJson(path), exportCsv(path, headers, rows). Run node --test test/exporter.test.js.
6. In src/formatter.js: implement formatWeightedTable(headers, rows, weights).
7. In src/report.js: implement generateWeightedReport(name, data, weights). Run node --test test/report.test.js.
8. In src/cli.js: integrate generateWeightedReport and verify with node src/cli.js.
Run node --test test/*.test.js to make sure all 6 test suites pass.`;

    testVerificationFn = (worktree) => {
      try {
        execFileSync("node", ["--test", "test/math.test.js"], { cwd: worktree, stdio: "pipe" });
        execFileSync("node", ["--test", "test/validator.test.js"], { cwd: worktree, stdio: "pipe" });
        execFileSync("node", ["--test", "test/analysis.test.js"], { cwd: worktree, stdio: "pipe" });
        execFileSync("node", ["--test", "test/transform.test.js"], { cwd: worktree, stdio: "pipe" });
        execFileSync("node", ["--test", "test/exporter.test.js"], { cwd: worktree, stdio: "pipe" });
        execFileSync("node", ["--test", "test/report.test.js"], { cwd: worktree, stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    };
  } else if (workload === "negative_knowledge") {
    repo = setupNegativeKnowledgeFixture();
    expectedAcceptance = ["Query engine passes all nested boolean and aggregation tests"];
    prompt = `You are tasked with building a robust nested Query Engine in src/query-parser.js.
Requirements:
1. Implement parseBooleanQuery(queryStr, record).
   - Must evaluate nested parenthesized expressions like '((age > 20 AND (status == "active" OR tier == 1)) OR (role == "admin" AND NOT (flag == false)))'.
   - CAUTION: Single-pass regex replacement will fail on nested parenthesized structures; you should use a token scanner / recursive descent parser.
   - Run node --test test/query.test.js.
2. Implement parseAggregationQuery(aggStr, records).
   - Parses expressions like 'SUM(amount) WHERE ((tier == 1 AND region == "EU") OR (tier == 2 AND discount > 0.1))' and computes sum of matching records.
   - Run node --test test/query.test.js.
Ensure all tests in node --test test/query.test.js pass completely.`;

    testVerificationFn = (worktree) => {
      try {
        execFileSync("node", ["--test", "test/query.test.js"], { cwd: worktree, stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    };
  } else {
    const recSetup = setupRecoveryFixture();
    repo = recSetup.repoDir;
    expectedAcceptance = ["Auth Gateway registered and signature verification passes"];
    prompt = `You are tasked with setting up and verifying the Secure Auth Gateway in src/gateway.js.
Step 1: Read spec/security-manifest.json. Initialize AuthGateway with all services and their secret keys.
Step 2: Run node --test test/auth.test.js to verify HMAC signatures for the billing gateway.
Step 3: Output confirmation when all tests pass.`;

    testVerificationFn = (worktree) => {
      try {
        execFileSync("node", ["--test", "test/auth.test.js"], { cwd: worktree, stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    };
  }

  RoleRegistry.getInstance().reload();
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: true });
  const manager = new SubagentManager(modelRuntime);
  const parentSessionId = `bench-${workload}-${mode}-${runIndex}-${Date.now()}`;
  const taskId = `task-${workload}-${mode}-${runIndex}-${Date.now()}`;

  const startTime = Date.now();
  console.log(`     Spawning subagent task: ${taskId}...`);

  await manager.spawn({
    parentSessionId,
    role: "developer",
    taskTitle: `${workload} ${mode} #${runIndex + 1}`,
    taskPrompt: prompt,
    parentCwd: repo,
    parentModel: { provider: PROVIDER, id: MODEL_ID },
    taskContract: {
      taskId,
      parentSessionId,
      role: "developer",
      goal: `Execute ${workload} in ${mode} mode`,
      scope: { include: ["src/**", "test/**", "spec/**"], exclude: [] },
      acceptanceCriteria: expectedAcceptance,
      expectedEffects: ["code_change"],
    },
    executionOptions: {
      model: { provider: PROVIDER, modelId: MODEL_ID, thinkingLevel: "low" },
      timeoutMs: TIMEOUT_MS,
    },
  });

  const monitor = setInterval(() => {
    const inst = subagentTasks.get(taskId);
    if (!inst) return;
    const count = inst.task.compactionCount ?? 0;
    const msgs = inst.task.messages?.length ?? 0;
    process.stdout.write(`\r     [Progress] messages=${msgs} compactions=${count} status=${inst.task.status}`);
  }, 4000);

  let doneTask: UISubagentTask;
  try {
    doneTask = await waitForCompletion(manager, taskId, TIMEOUT_MS);
  } catch (err: any) {
    const inst = subagentTasks.get(taskId);
    doneTask = inst?.task ?? ({
      id: taskId,
      parentSessionId,
      status: "failed",
      error: err.message,
    } as any);
    console.log(`     [Timeout/Error]: ${err.message}`);
  } finally {
    clearInterval(monitor);
    console.log("");
  }

  const durationMs = Date.now() - startTime;
  let finalWorktree = repo;
  for (const inst of subagentTasks.values()) {
    if (
      inst.task.parentSessionId === parentSessionId &&
      inst.task.worktreePath &&
      existsSync(inst.task.worktreePath)
    ) {
      finalWorktree = inst.task.worktreePath;
    }
  }

  const finalVerificationSuccess = testVerificationFn(finalWorktree);
  const toolCalls = extractToolCallsFromMessages(doneTask.messages ?? []);

  const reads = toolCalls.filter((tc) => tc.name === "read" || tc.name === "view_file").length;
  const edits = toolCalls.filter((tc) => tc.name === "edit" || tc.name === "write" || tc.name === "replace_file_content").length;
  const testRuns = toolCalls.filter((tc) =>
    (tc.name === "bash" || tc.name === "run_command") &&
    String(tc.input?.command || tc.input?.CommandLine || "").includes("test"),
  ).length;

  const telemetryRecords = readCompactionTelemetry();
  const thresholdCount = telemetryRecords.filter((t) => t.reason === "threshold").length;
  const overflowCount = telemetryRecords.filter((t) => t.reason === "overflow").length;
  const manualCount = telemetryRecords.filter((t) => t.reason === "manual").length;

  // Offline Evaluators
  const unnecessaryRepeatedReadCount = OfflineBenchmarkEvaluator.evaluateRepeatedReads(toolCalls);
  const repeatedFailedApproachCount = OfflineBenchmarkEvaluator.evaluateRepeatedFailedApproach(
    toolCalls,
    [/replace\(\/\(/i, /eval\(/i],
  );
  const incorrectModifiedFileState = OfflineBenchmarkEvaluator.evaluateIncorrectModifiedFileState(toolCalls);
  const verificationStateLossCount = OfflineBenchmarkEvaluator.evaluateVerificationStateLoss(toolCalls);

  // Recovery evaluation
  const artifactRecoveryCalls = toolCalls.filter((tc) => tc.name === "read_artifact").length;
  const transcriptRecoveryCalls = toolCalls.filter(
    (tc) => tc.name === "read_transcript" || tc.name === "search_transcript",
  ).length;

  const validSchemaCount = telemetryRecords.filter((t) => t.summaryInspectionStatus === "valid").length;
  const complianceRate = telemetryRecords.length > 0 ? (validSchemaCount / telemetryRecords.length) * 100 : 100;

  console.log(`     [Done] Verified: ${finalVerificationSuccess ? "PASS" : "FAIL"}, Tools: ${toolCalls.length}, Compactions: ${telemetryRecords.length} (thresh: ${thresholdCount}, over: ${overflowCount})`);

  return {
    runMode: mode,
    workload,
    runIndex,
    taskSuccess: finalVerificationSuccess,
    finalVerificationSuccess,
    totalToolCalls: toolCalls.length,
    readToolCalls: reads,
    editToolCalls: edits,
    testCommandsRun: testRuns,
    compactionCount: telemetryRecords.length,
    thresholdCompactionCount: thresholdCount,
    overflowCompactionCount: overflowCount,
    manualCompactionCount: manualCount,
    telemetryRecords,
    unnecessaryRepeatedReadCount,
    repeatedInvestigationCount: 0,
    repeatedFailedApproachCount,
    unresolvedFrontierLoss: !finalVerificationSuccess,
    incorrectModifiedFileState,
    verificationStateLossCount,
    wrongNextActionCount: 0,
    artifactRecoveryCount: artifactRecoveryCalls,
    transcriptRecoveryCount: transcriptRecoveryCalls,
    recoverySuccess: finalVerificationSuccess,
    structuredSchemaValidCount: validSchemaCount,
    structuredSchemaComplianceRate: complianceRate,
    durationMs,
  };
}

// ----------------------------------------------------------------------------
// Statistical Aggregator
// ----------------------------------------------------------------------------

function computeSummary(values: number[]): MetricSummary {
  if (values.length === 0) return { median: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    median: Math.round(median * 100) / 100,
    min: Math.round(sorted[0] * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
  };
}

function aggregateRuns(workload: string, nativeRuns: SingleRunResult[], structuredRuns: SingleRunResult[]): WorkloadAggregatedResult {
  const metricKeys: Array<keyof SingleRunResult> = [
    "totalToolCalls",
    "readToolCalls",
    "editToolCalls",
    "testCommandsRun",
    "compactionCount",
    "thresholdCompactionCount",
    "overflowCompactionCount",
    "unnecessaryRepeatedReadCount",
    "repeatedFailedApproachCount",
    "verificationStateLossCount",
    "structuredSchemaComplianceRate",
    "durationMs",
  ];

  const metrics: Record<string, { native: MetricSummary; structured: MetricSummary }> = {};
  for (const k of metricKeys) {
    const natVals = nativeRuns.map((r) => Number(r[k]));
    const strVals = structuredRuns.map((r) => Number(r[k]));
    metrics[String(k)] = {
      native: computeSummary(natVals),
      structured: computeSummary(strVals),
    };
  }

  return {
    workload,
    nativeRuns,
    structuredRuns,
    metrics,
  };
}

// ----------------------------------------------------------------------------
// Main Benchmark Entrypoint
// ----------------------------------------------------------------------------

async function main() {
  console.log("=== Multi-Run Phase 3 A/B Benchmark & Real Evaluator ===");
  console.log(`Provider: ${PROVIDER}, Model: ${MODEL_ID}`);
  console.log(`Context Window: ${TEST_CONTEXT_WINDOW}, Max Tokens: ${TEST_MAX_TOKENS}, Reserve: ${TEST_RESERVE_TOKENS}`);
  console.log(`Effective Threshold: ${Math.min(TEST_CONTEXT_WINDOW * TEST_TRIGGER_RATIO, TEST_CONTEXT_WINDOW - TEST_RESERVE_TOKENS)}`);
  console.log(`Number of Paired Runs per Workload: ${NUM_PAIRED_RUNS}\n`);

  const allAggregates: WorkloadAggregatedResult[] = [];
  const workloads: Array<"core_coding" | "negative_knowledge" | "recovery"> = [
    "core_coding",
    "negative_knowledge",
    "recovery",
  ];

  for (const wl of workloads) {
    const nativeRuns: SingleRunResult[] = [];
    const structuredRuns: SingleRunResult[] = [];

    for (let i = 0; i < NUM_PAIRED_RUNS; i++) {
      const natRes = await runWorkloadSlice(wl, "native", i);
      nativeRuns.push(natRes);

      const strRes = await runWorkloadSlice(wl, "structured", i);
      structuredRuns.push(strRes);
    }

    const agg = aggregateRuns(wl, nativeRuns, structuredRuns);
    allAggregates.push(agg);
  }

  // Print Summary Table
  console.log("\n==========================================================================================");
  console.log("                       MULTI-RUN BENCHMARK AGGREGATE RESULTS                              ");
  console.log("==========================================================================================");

  for (const agg of allAggregates) {
    console.log(`\n>>> Workload: [${agg.workload.toUpperCase()}] (${NUM_PAIRED_RUNS} paired runs)`);
    console.log(`Metric                         | Mode A Native [Median (Min-Max)] | Mode B Structured [Median (Min-Max)]`);
    console.log(`-------------------------------+----------------------------------+-------------------------------------`);
    for (const [key, val] of Object.entries(agg.metrics)) {
      const natStr = `${val.native.median} (${val.native.min}-${val.native.max})`.padEnd(32);
      const strStr = `${val.structured.median} (${val.structured.min}-${val.structured.max})`.padEnd(32);
      console.log(`${key.padEnd(30)} | ${natStr} | ${strStr}`);
    }
  }

  // Save complete results to benchmark-results.json
  const outPath = join(process.cwd(), "benchmark-results.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        model: `${PROVIDER}/${MODEL_ID}`,
        contextWindow: TEST_CONTEXT_WINDOW,
        pairedRunsCount: NUM_PAIRED_RUNS,
        aggregates: allAggregates,
      },
      null,
      2,
    ),
  );
  console.log(`\nDetailed benchmark results saved to: ${outPath}`);
}

main().catch((err) => {
  console.error("Benchmark failed with error:", err);
  process.exit(1);
});
