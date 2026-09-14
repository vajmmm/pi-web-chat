import type { AgentRole, UIThinkingLevel } from "../../shared/protocol.ts";

/** 允许修改的代码与路径范围 */
export interface TaskScope {
  /** 明确允许修改的文件或路径模式（例如 ["frontend/src/**", "package.json"]） */
  include?: string[];
  /** 明确禁止修改的文件或路径模式 */
  exclude?: string[];
}

/**
 * 机器可读的任务契约 (TaskContract)
 *
 * 由 Coordinator 派发，用于向 Subagent 描述任务目标与上下文。
 */
export interface TaskContract {
  taskId: string;
  parentSessionId: string;
  role: AgentRole;
  /** 任务明确目标与期望结果 (Goal) */
  goal: string;
  /** 任务允许修改的路径范围 (不同于只读上下文) */
  scope?: TaskScope;
  /** 推荐重点阅读的参考文件路径 (只读参考，非修改范围) */
  contextFiles?: string[];
  /** 任务专属约束条件 */
  constraints?: string[];
  /** 验收标准清单（可逐项核对的条件） */
  acceptanceCriteria?: string[];
  /** 显式任务依赖：此任务依赖的前置任务 ID 列表 */
  dependsOn?: string[];
  /** 预期效果类型（用于精准 Runtime Verification，避免将 analysis/test 误判为 NO_EFFECT） */
  expectedEffects?: ExpectedEffect[];
  /** 可选返工关系：指向被本次任务修复的先前任务 ID */
  reworkOfTaskId?: string;
}

/** 任务预期产出/效果类型 */
export type ExpectedEffect =
  | "code_change"
  | "test_execution"
  | "analysis"
  | "deployment"
  | "artifact";

/**
 * 未显式提供 TaskContract 字段时的最小角色默认值。
 * Researcher 的默认契约必须保持只读分析语义；其它角色沿用既有工程默认值。
 */
export function getDefaultTaskContractFields(
  role: AgentRole,
  implementationAcceptanceCriteria = ["完成指定实现并自测通过"],
): Pick<TaskContract, "expectedEffects" | "scope" | "acceptanceCriteria"> {
  if (role === "researcher") {
    return {
      expectedEffects: ["analysis"],
      scope: { include: [], exclude: [] },
      acceptanceCriteria: ["返回请求的事实结论、关键证据与出处"],
    };
  }

  return {
    scope: { include: ["*"], exclude: [] },
    acceptanceCriteria: implementationAcceptanceCriteria,
  };
}

/**
 * 任务运行时执行配置 (SubagentExecutionOptions)
 */
export interface SubagentExecutionOptions {
  timeoutMs?: number;
  maxTurns?: number;
  model?: {
    provider?: string;
    modelId: string;
    thinkingLevel?: UIThinkingLevel;
  };
  requiresWorktree?: boolean;
  worktree?: string;
}

/**
 * 任务运行时执行生命周期状态
 *
 * 状态流转：
 *   blocked → ready → running → completed
 *                       ↓           ↓
 *                    conflict     failed
 *
 *   任何运行中状态均可 → aborted / interrupted / incomplete
 */
export type TaskExecutionStatus =
  | "blocked"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted"
  | "incomplete"
  | "conflict";

/** Assistant 消息完成/终止原因（统一归一化） */
export type AssistantFinishReason =
  | "stop"
  | "tool_call"
  | "max_tokens"
  | "cancelled"
  | "error"
  | "unknown";

// ---------------------------------------------------------------------------
// Runtime Verification
// ---------------------------------------------------------------------------

export type VerificationStatus =
  | "pass"
  | "fail"
  | "not_run"
  | "blocked_by_environment"
  | "partially_verified";

/** 单项验证结果 */
export interface VerificationCheck {
  name: string;
  status: VerificationStatus;
  detail?: string;
}

/** 命令执行目的（区分探索与验证门禁） */
export type CommandPurpose =
  | "exploration"
  | "verification"
  | "build"
  | "test"
  | "deployment";

/** 命令执行记录（客观事实，非 LLM 自述） */
export interface CommandRecord {
  command: string;
  exitCode: number | null;
  exitCodeSource: "runtime" | "unknown";
  passed: boolean;
  purpose: CommandPurpose;
  stdoutSummary?: string;
  stderrSummary?: string;
}

/** 任务人为覆核/审计信息 */
export interface TaskAudit {
  forceAccepted?: boolean;
  reason?: string;
  forcedAt?: string;
}

/** 完整的 Runtime 验证结果 */
export interface VerificationResult {
  /** 文件变更验证 */
  diff: VerificationCheck;
  /** Scope 合规验证 */
  scope: VerificationCheck;
  /** 测试执行验证（针对 expectedEffects 包含 test_execution 的任务） */
  testExecution?: VerificationCheck;
  /** 命令执行记录（test / lint / typecheck / build 等） */
  commands: CommandRecord[];
  /** 汇总判定 */
  overall: VerificationStatus;
  /** scope 违规文件列表 */
  scopeViolations?: string[];
  /** 实际变更文件列表 */
  changedFiles?: string[];
}

// ---------------------------------------------------------------------------
// Run Finalization
// ---------------------------------------------------------------------------

export type FinalizeMode = "working_tree" | "squash_commit" | "keep_commits";

export interface CleanupResult {
  success: boolean;
  removed: string[];
  skipped: string[];
  leftovers: string[];
  errors?: string[];
}

export interface QuiescenceResult {
  success: boolean;
  failedTaskIds?: string[];
}

export class QuiescenceError extends Error {
  failedTaskIds: string[];

  constructor(message: string, failedTaskIds: string[] = []) {
    super(message);
    this.name = "QuiescenceError";
    this.failedTaskIds = failedTaskIds;
  }
}

export interface FinalizeResult {
  success: boolean;
  status: "FINALIZED" | "FINALIZE_CONFLICT" | "NO_CHANGES" | "ERROR";
  mode: FinalizeMode;
  changedFiles: string[];
  conflictFiles?: string[];
  commitSha?: string;
  error?: string;
  cleanupResult?: CleanupResult;
}

// ---------------------------------------------------------------------------
// Structured Review
// ---------------------------------------------------------------------------

export type ReviewSeverity = "blocker" | "major" | "minor" | "nit";

export interface ReviewFinding {
  id: string;
  severity: ReviewSeverity;
  /** 关联的验收标准 ID（如果有） */
  criterionId?: string;
  /** 关联的 Shared Invariant ID（如果有） */
  invariantId?: string;
  file?: string;
  line?: number;
  problem: string;
  evidence: string;
  expected?: string;
  actual?: string;
  /** 建议修复方式与验证手段 (可选) */
  suggestedFix?: string;
}

export interface ReviewResult {
  verdict: "APPROVE" | "REQUEST_CHANGES";
  findings: ReviewFinding[];
  /** 是否仅包含 minor/nit 级别发现（用于防止低质量问题触发无限返工） */
  onlyMinorFindings: boolean;
}

// ---------------------------------------------------------------------------
// Task Result
// ---------------------------------------------------------------------------

/**
 * 任务交付结果 (TaskResult)
 *
 * Subagent 运行结束后的交付产出记录。
 */
export interface TaskResult {
  taskId: string;
  role: AgentRole;
  status: TaskExecutionStatus;
  /** 核心执行总结 */
  summary: string;
  /** 修改的文件相对路径清单 */
  changedFiles?: string[];
  /** 产出的 Git Commit SHA (若已提交) */
  commit?: string;
  /** 开始时间 ISO 字符串 */
  startedAt?: string;
  /** 完成时间 ISO 字符串 */
  completedAt: string;
  /** 运行耗时（毫秒） */
  durationMs?: number;
  /** 附加元数据 */
  meta?: Record<string, unknown>;
  /** Runtime 验证结果 */
  verification?: VerificationResult;
  /** 结构化 Review 结果（仅 reviewer 角色产出） */
  review?: ReviewResult;
}
