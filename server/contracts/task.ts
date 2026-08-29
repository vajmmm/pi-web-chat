import type { UIThinkingLevel } from "../../shared/protocol.ts";

/** 期望交付物类型 */
export type DeliverableType =
  | "summary"
  | "changed_files"
  | "test_report"
  | "review_verdict"
  | "deploy_evidence";

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
 * 由 Coordinator 派发，或在 Subagent 间交接时使用。
 * 遵循约束优先级：TaskContract 处于最低优先级，绝不可覆盖 Role strict_prohibitions 或 Shared Invariants。
 */
export interface TaskContract {
  taskId: string;
  parentSessionId: string;
  role: string;
  /** 任务明确目标与背景 */
  goal: string;
  /** 任务允许修改的路径范围 (不同于只读上下文) */
  scope?: TaskScope;
  /** 推荐重点阅读的参考文件路径 (只读参考，非修改范围) */
  contextFiles?: string[];
  /** 任务专属约束条件（不可违背更高层级规则） */
  constraints?: string[];
  /** 验收标准清单（可逐项核对的条件） */
  acceptanceCriteria: string[];
  /** 明确要求产出的交付物类型 */
  expectedDeliverables: DeliverableType[];
  /** 依赖的前置 Task ID 列表 */
  dependencies?: string[];
  /** 附加元数据 */
  meta?: Record<string, unknown>;
}

/**
 * 任务运行时执行配置 (SubagentExecutionOptions)
 *
 * 与 TaskContract 解耦，专职控制运行时的超时、模型、思考深度、Worktree 路径等。
 */
export interface SubagentExecutionOptions {
  timeoutMs?: number;
  maxTurns?: number;
  model?: {
    provider?: string;
    modelId: string;
    thinkingLevel?: UIThinkingLevel;
  };
  permissionProfileId?: string;
  worktree?: string;
}

/** 任务执行状态 */
export type TaskExecutionStatus =
  | "completed"  // 正常完成并满足验收条件
  | "blocked"    // 外部依赖或前置条件阻塞
  | "failed"     // 执行过程异常或测试未通过
  | "rejected"   // 任务违反角色职责或权限边界被拒绝
  | "cancelled"; // 被用户或父 Agent 主动终止

/** 验证状态 */
export type VerificationStatus =
  | "passed"
  | "failed"
  | "blocked"
  | "not_run";

/** 结构化验证证据 */
export interface VerificationEvidence {
  kind: "test" | "build" | "typecheck" | "lint" | "command" | "manual";
  command?: string;
  status: VerificationStatus;
  exitCode?: number;
  summary?: string;
}

/** 审查严重等级 */
export type ReviewSeverity = "blocker" | "high" | "medium" | "low";

export interface ReviewIssue {
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  description: string;
  suggestion?: string;
}

/** 结构化 Review 报告 */
export interface ReviewVerdictReport {
  verdict: "APPROVE" | "REQUEST_CHANGES";
  summary?: string;
  issues?: ReviewIssue[];
}

/** 结构化部署与验证证据 */
export interface DeployEvidenceReport {
  targetHost?: string;
  releaseVersion?: string;
  healthCheckPassed: boolean;
  verifyLogSnippet?: string;
}

/**
 * 机器可读的任务交付结果 (TaskResult)
 *
 * Subagent 运行结束后的最终结构化输出。
 */
export interface TaskResult {
  taskId: string;
  role: string;
  status: TaskExecutionStatus;
  /** 核心执行总结 */
  summary: string;
  /** 修改的文件相对路径清单 */
  changedFiles?: string[];
  /** 产出的 Git Commit SHA (若已提交) */
  commit?: string;
  /** 结构化验证证据链 */
  verification?: VerificationEvidence[];
  /** 审查报告（针对 Reviewer 角色） */
  reviewReport?: ReviewVerdictReport;
  /** 部署证据（针对 Deployer 角色） */
  deployEvidence?: DeployEvidenceReport;
  /** 未解决或遗留风险项 */
  unresolvedItems?: string[];
  /** 完成时间 ISO 字符串 */
  completedAt: string;
  /** 附加元数据 */
  meta?: Record<string, unknown>;
}

export interface TaskResultValidationResult {
  valid: boolean;
  result?: TaskResult;
  errors: string[];
}

/**
 * 严格的运行时 TaskResult Schema 校验器
 * 绝不盲目信任 JSON.parse 结果，并逐项核对 expectedDeliverables 交付契约。
 */
export function validateTaskResult(
  raw: unknown,
  contract?: TaskContract,
): TaskResultValidationResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["TaskResult payload must be a non-null object"] };
  }

  const obj = raw as Record<string, unknown>;

  const validStatuses: TaskExecutionStatus[] = [
    "completed",
    "blocked",
    "failed",
    "rejected",
    "cancelled",
  ];
  const rawStatus = typeof obj.status === "string" ? (obj.status as TaskExecutionStatus) : undefined;
  const status: TaskExecutionStatus = rawStatus && validStatuses.includes(rawStatus)
    ? rawStatus
    : "failed";

  if (!rawStatus || !validStatuses.includes(rawStatus)) {
    errors.push(`Invalid status: "${obj.status}". Expected one of: ${validStatuses.join(", ")}`);
  }

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  if (!summary) {
    errors.push("Missing or empty summary in TaskResult");
  }

  const taskId = typeof obj.taskId === "string" ? obj.taskId : contract?.taskId || "unknown-task";
  const role = typeof obj.role === "string" ? obj.role : contract?.role || "unknown-role";

  let verification: VerificationEvidence[] | undefined;
  if (Array.isArray(obj.verification)) {
    verification = [];
    const validKinds = ["test", "build", "typecheck", "lint", "command", "manual"];
    const validVerifStatuses = ["passed", "failed", "blocked", "not_run"];
    for (let idx = 0; idx < obj.verification.length; idx++) {
      const v = obj.verification[idx];
      if (!v || typeof v !== "object") {
        errors.push(`verification[${idx}] must be a non-null object`);
        continue;
      }
      if (!v.kind || !validKinds.includes(v.kind)) {
        errors.push(
          `verification[${idx}].kind "${v.kind}" is invalid. Expected one of: ${validKinds.join(", ")}`,
        );
      }
      if (!v.status || !validVerifStatuses.includes(v.status)) {
        errors.push(
          `verification[${idx}].status "${v.status}" is invalid. Expected one of: ${validVerifStatuses.join(", ")}`,
        );
      }
      verification.push({
        kind: validKinds.includes(v.kind) ? v.kind : "command",
        status: validVerifStatuses.includes(v.status) ? v.status : "failed",
        command: typeof v.command === "string" ? v.command : undefined,
        exitCode: typeof v.exitCode === "number" ? v.exitCode : undefined,
        summary: typeof v.summary === "string" ? v.summary : undefined,
      });
    }
  }

  // completed 状态绝不允许存在 failed 或 blocked 验证项
  if (status === "completed" && verification && verification.length > 0) {
    const hasFailedOrBlocked = verification.some(
      (v) => v.status === "failed" || v.status === "blocked",
    );
    if (hasFailedOrBlocked) {
      errors.push(
        `Task status cannot be "completed" when verification evidence contains failed or blocked checks.`,
      );
    }
  }

  let reviewReport: ReviewVerdictReport | undefined;
  if (obj.reviewReport && typeof obj.reviewReport === "object") {
    const rr = obj.reviewReport as Record<string, unknown>;
    if (rr.verdict === "APPROVE" || rr.verdict === "REQUEST_CHANGES") {
      reviewReport = {
        verdict: rr.verdict,
        summary: typeof rr.summary === "string" ? rr.summary : undefined,
        issues: Array.isArray(rr.issues) ? rr.issues : undefined,
      };
    } else {
      errors.push(
        `reviewReport.verdict "${rr.verdict}" is invalid. Expected "APPROVE" or "REQUEST_CHANGES".`,
      );
    }
  }

  let deployEvidence: DeployEvidenceReport | undefined;
  if (obj.deployEvidence && typeof obj.deployEvidence === "object") {
    const de = obj.deployEvidence as Record<string, unknown>;
    if (typeof de.healthCheckPassed !== "boolean") {
      errors.push(
        `deployEvidence.healthCheckPassed must be a strict boolean (received ${typeof de.healthCheckPassed}).`,
      );
    }
    deployEvidence = {
      targetHost: typeof de.targetHost === "string" ? de.targetHost : undefined,
      releaseVersion: typeof de.releaseVersion === "string" ? de.releaseVersion : undefined,
      healthCheckPassed: typeof de.healthCheckPassed === "boolean" ? de.healthCheckPassed : false,
      verifyLogSnippet: typeof de.verifyLogSnippet === "string" ? de.verifyLogSnippet : undefined,
    };
  }

  const changedFiles = Array.isArray(obj.changedFiles)
    ? (obj.changedFiles.filter((f) => typeof f === "string") as string[])
    : undefined;

  // 逐项核对 expectedDeliverables 交付契约
  if (contract?.expectedDeliverables) {
    for (const deliv of contract.expectedDeliverables) {
      if (deliv === "summary" && !summary) {
        errors.push(`Deliverable "summary" required by contract is missing.`);
      }
      if (deliv === "changed_files" && (!changedFiles || changedFiles.length === 0)) {
        errors.push(`Deliverable "changed_files" required by contract has no changed files.`);
      }
      if (deliv === "test_report") {
        const passedTest =
          verification &&
          verification.some(
            (v) => ["test", "typecheck", "build"].includes(v.kind) && v.status === "passed",
          );
        if (!passedTest) {
          errors.push(
            `Deliverable "test_report" required by contract was not provided with passed verification evidence.`,
          );
        }
      }
      if (deliv === "review_verdict") {
        if (!reviewReport || !reviewReport.verdict) {
          errors.push(
            `Deliverable "review_verdict" required by contract was not provided in reviewReport.`,
          );
        }
      }
      if (deliv === "deploy_evidence") {
        if (!deployEvidence || typeof deployEvidence.healthCheckPassed !== "boolean") {
          errors.push(
            `Deliverable "deploy_evidence" required by contract was not provided in deployEvidence.`,
          );
        }
      }
    }
  }

  const completedAt =
    typeof obj.completedAt === "string" ? obj.completedAt : new Date().toISOString();

  const finalStatus: TaskExecutionStatus =
    errors.length > 0 && status === "completed" ? "failed" : status;

  const rawUnresolved = Array.isArray(obj.unresolvedItems)
    ? (obj.unresolvedItems.filter((item) => typeof item === "string") as string[])
    : [];

  const combinedUnresolved = Array.from(new Set([...rawUnresolved, ...errors]));

  return {
    valid: errors.length === 0,
    errors,
    result: {
      taskId,
      role,
      status: finalStatus,
      summary,
      changedFiles,
      commit: typeof obj.commit === "string" ? obj.commit : undefined,
      verification,
      reviewReport,
      deployEvidence,
      unresolvedItems: combinedUnresolved.length > 0 ? combinedUnresolved : undefined,
      completedAt,
    },
  };
}
