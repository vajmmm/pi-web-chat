import type { ReviewResult, TaskResult } from "../contracts/index.ts";
import { getRoleConfig } from "../roles.ts";
import { resolveExpectedEffects, runVerification } from "../runtime-verifier.ts";
import { sanitizeProviderErrorMessage, serializeMessages } from "../serialize.ts";
import {
  buildBoundedCompletionReport,
  extractLastAssistantText,
  normalizeFinishReason,
} from "../subagent-report.ts";
import {
  commitWorktreeChanges,
  getWorktreeDiff,
  mergeTaskToIntegration,
  tryMergeWorktree,
} from "../worktree.ts";
import { isPendingDeletion } from "../session/deletion-tombstone.ts";
import {
  assistantContentHasType,
  assistantHasVisibleText,
  hasSuccessfulFileMutation,
  isPrematureEmptyStopAfterTools,
} from "./terminal-result.ts";
import { computeDurationMs, persistTask, subagentTasks } from "./task-store.ts";
import type { SubagentInstance } from "./types.ts";
import { detectWorkspaceMutations } from "./workspace-baseline.ts";
import { tryParseReviewResult } from "./review-result.ts";
import { queuePendingTerminal } from "./runtime-control.ts";
import type { SubagentManagerHost } from "./manager-host.ts";

  /**
   * 终态处理 Helper：完成状态结算 (completed / conflict)
   */
export async function finalizeCompleted(mgr: SubagentManagerHost, instance: SubagentInstance) {
    // terminalizing locks the event pipeline before reported is set, so the
    // AUTO_COMMIT_FAILED handoff can still enter finalizeFailed cleanly.
    if (instance.reported || instance.terminalizing) return;
    instance.terminalizing = true;
    instance.pendingTerminal = undefined;
    instance.aborting = false;

    if (instance.timeoutTimer) {
      clearTimeout(instance.timeoutTimer);
      instance.timeoutTimer = undefined;
    }

    // Stop writers before snapshot/commit so disk work cannot continue after
    // the harness has decided this run is terminal.
    await mgr.abortSessionAndQuiesceTools(instance, "completed");
    instance.pendingTerminal = undefined;

    const task = instance.task;
    task.completedAt = new Date().toISOString();
    task.durationMs = computeDurationMs(task);
    const rawMessages = mgr.getSerializableMessages(instance);
    task.messages = serializeMessages(rawMessages);

    // 1. Harness 权威观测 Git 状态与变更（自动生成 task commit，Fail-Closed 处理）
    let lastCommit: string | undefined;
    let autoCommitError: string | undefined;

    if (task.worktreePath) {
      try {
        const commitResult = await commitWorktreeChanges(task.worktreePath, `task/${task.taskId}: ${task.taskTitle}`);
        if (commitResult.error) {
          autoCommitError = commitResult.error;
        } else {
          const diffInfo = await getWorktreeDiff(task.worktreePath, instance.baseCommit);
          task.changedFiles = diffInfo.changedFiles;
          lastCommit = diffInfo.lastCommit;
        }
      } catch (err) {
        autoCommitError = String(err instanceof Error ? err.message : err);
      }
    }

    const roleConfig = getRoleConfig(task.role);
    const lastAssistantText = extractLastAssistantText(rawMessages);

    // 如果 task commit 失败，必须 Fail-Closed 阻止进入正常 completion / integration flow
    if (autoCommitError) {
      task.status = "failed";
      task.error = `AUTO_COMMIT_FAILED: ${autoCommitError}`;
      task.verification = {
        diff: { name: "diff", status: "fail", detail: `AUTO_COMMIT_FAILED: ${autoCommitError}` },
        scope: { name: "scope", status: "fail", detail: "Auto-commit failed" },
        commands: [],
        overall: "fail",
      };
      instance.terminalizing = false;
      await mgr.finalizeFailed(instance, task.error);
      return;
    }

    // 1.5 Verifier Mutation Guard (Fail-Closed)
    let verifierMutationError: string | undefined;
    let verifierMutatedFiles: string[] = [];
    if (instance.workspaceBaseline) {
      const mutationRes = await detectWorkspaceMutations(
        instance.workspaceBaseline.cwd,
        instance.workspaceBaseline,
      );
      if (!mutationRes.ok) {
        // Fail-closed: 若 baseline 采集或对比失败，无法确信工作区未被篡改，直接判 fail
        verifierMutationError = `MUTATION_GUARD_FAILURE: ${mutationRes.error || "Unknown workspace audit failure"}. Fail-closed: verification rejected.`;
      } else {
        verifierMutatedFiles = mutationRes.mutatedFiles;
        const effectiveEffects = resolveExpectedEffects(
          task.role,
          instance.taskContract?.expectedEffects,
        );
        if (!effectiveEffects.includes("code_change") && verifierMutatedFiles.length > 0) {
          verifierMutationError = `UNAUTHORIZED_MUTATION: Verifier produced unexpected file modifications in integration workspace (${verifierMutatedFiles.join(", ")}) without "code_change" contract authorization.`;
          task.changedFiles = verifierMutatedFiles;
        }
      }
    }

    // 2. Runtime 验证
    const changedFiles = task.changedFiles ?? (verifierMutatedFiles.length > 0 ? verifierMutatedFiles : []);
    const contract = instance.taskContract ?? {
      taskId: task.taskId,
      parentSessionId: task.parentSessionId,
      role: task.role,
      goal: task.taskTitle,
    };
    const verification = runVerification(changedFiles, contract, rawMessages, task.logs ?? []);
    if (verifierMutationError) {
      verification.overall = "fail";
      verification.diff = {
        name: "diff",
        status: "fail",
        detail: verifierMutationError,
      };
    }
    task.verification = verification;

    // 3. Worktree 自动合并至当前 Run 的 Integration 分支（不污染主分支）
    if (task.worktreePath && task.branchName && instance.repoRoot) {
      try {
        const integration = await mgr.getOrCreateIntegration(task.parentSessionId, instance.repoRoot);
        const mergeTest = await tryMergeWorktree(integration.worktreePath, task.branchName);
        if (!mergeTest.canMerge) {
          task.status = "conflict";
          verification.overall = "fail";
          verification.diff.detail =
            `CONFLICT: Git merge conflict detected against integration branch in: ${mergeTest.conflictFiles.join(", ") || "(unknown files)"}`;
        } else {
          const mergeResult = await mergeTaskToIntegration(integration, task.branchName);
          if (!mergeResult.success) {
            task.status = "conflict";
            verification.overall = "fail";
            verification.diff.detail = `Git merge to integration failed: ${mergeResult.output}`;
          } else {
            task.status = "completed";
          }
        }
      } catch (err) {
        task.status = "conflict";
        verification.overall = "fail";
        verification.diff.detail = `Integration merge error: ${String(err instanceof Error ? err.message : err)}`;
      }
    } else {
      task.status = "completed";
    }

    const verificationFailed =
      verification.overall === "fail" || verification.overall === "partially_verified";
    // Never use success-sounding fallback: agent_end / empty text ≠ task success.
    const cleanSummary =
      lastAssistantText ||
      (verificationFailed
        ? "（子任务已停止，Runtime 验证未通过，未形成成功交付）"
        : "（子任务已停止，未产出有效总结）");

    // 4. 尝试解析 Reviewer / Verifier 结构化结果
    let reviewResult: ReviewResult | undefined;
    if (task.role === "verifier") {
      reviewResult = tryParseReviewResult(lastAssistantText);
      if (verifierMutationError) {
        reviewResult = {
          verdict: "REQUEST_CHANGES",
          findings: [
            {
              id: "unauthorized-mutation",
              severity: "blocker",
              problem: verifierMutationError,
              evidence: `Mutated files: ${verifierMutatedFiles.join(", ")}`,
              expected: "Verifier must perform read-only verification without modifying workspace files.",
              actual: `Modified files: ${verifierMutatedFiles.join(", ")}`,
              suggestedFix: "Revert all unauthorized modifications in the integration workspace.",
            },
            ...(reviewResult?.findings || []),
          ],
          onlyMinorFindings: false,
        };
      }
      if (reviewResult) {
        task.review = reviewResult;
      }
    }

    const finalTaskResult: TaskResult = {
      taskId: task.taskId,
      role: task.role,
      status: task.status,
      summary: cleanSummary,
      changedFiles: task.changedFiles,
      commit: lastCommit,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      durationMs: task.durationMs,
      verification,
      review: reviewResult,
    };

    task.taskResult = finalTaskResult;
    task.summary = cleanSummary;

    // 5. 更新 Reusable Agent 沉淀知识
    if (task.agentId && task.status === "completed") {
      try {
        mgr.reusableAgents.markCompleted(task.agentId, task);
      } catch (err) {
        console.warn(`[SubagentManager] Failed to update reusable knowledge for ${task.agentId}:`, err);
      }
    }

    // 6. 检查并自动唤醒下游已就绪任务 (DAG Unblock via Lineage)
    if (task.status === "completed" && !mgr.deletingRuns.has(task.parentSessionId)) {
      const unblocked = mgr.taskGraph.getNewlyReadyTasks((depId) =>
        mgr.isTaskLineageSatisfied(depId, task.parentSessionId),
      );
      for (const unblockedId of unblocked) {
        if (!mgr.deletingRuns.has(task.parentSessionId)) {
          await mgr.startBlockedTask(unblockedId);
        }
      }
    }

    const report = buildBoundedCompletionReport({
      taskId: task.taskId,
      taskTitle: task.taskTitle,
      role: task.role,
      roleName: roleConfig.name,
      branch: task.branchName,
      status: task.status,
      completionReason: verificationFailed ? "verification_failed" : "normal",
      changedFiles: task.changedFiles,
      lastCommit,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      durationMs: task.durationMs,
      // Pass raw extracted text (may be empty) so report can choose non-success empty copy.
      lastAssistantText,
      taskResult: finalTaskResult,
    });

    instance.reported = true;
    persistTask(task);
    mgr.notifyUpdate(instance);
    await mgr.disposeRuntime(instance, "completed");
    instance.terminalizing = false;
    if (!mgr.deletingRuns.has(task.parentSessionId)) {
      await Promise.resolve(instance.onReport?.(task, report.parentReport, { kind: "terminal" }));
    }
  }

  /**
   * 终态处理 Helper：截断/未完成状态结算 (OUTPUT_TRUNCATED)
   */
export async function finalizeIncomplete(mgr: SubagentManagerHost, instance: SubagentInstance, error: string) {
    if (instance.reported || instance.terminalizing) return;
    instance.terminalizing = true;
    instance.reported = true;
    instance.pendingTerminal = undefined;
    instance.aborting = false;

    if (instance.timeoutTimer) {
      clearTimeout(instance.timeoutTimer);
      instance.timeoutTimer = undefined;
    }

    await mgr.abortSessionAndQuiesceTools(instance, "incomplete");
    instance.pendingTerminal = undefined;

    const task = instance.task;
    task.status = "incomplete";
    task.error = error;
    task.completedAt = new Date().toISOString();
    task.durationMs = computeDurationMs(task);
    const rawMessages = mgr.getSerializableMessages(instance, error);
    task.messages = serializeMessages(rawMessages);
    task.summary = "";
    task.taskResult = {
      taskId: task.taskId,
      role: task.role,
      status: "incomplete",
      summary: "",
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      durationMs: task.durationMs,
      meta: { error: task.error },
    };

    const roleConfig = getRoleConfig(task.role);
    const report = buildBoundedCompletionReport({
      taskId: task.taskId,
      taskTitle: task.taskTitle,
      role: task.role,
      roleName: roleConfig.name,
      branch: task.branchName,
      status: "incomplete",
      completionReason: "output_truncated",
      error: task.error,
      changedFiles: task.changedFiles,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      durationMs: task.durationMs,
      lastAssistantText: "",
      taskResult: task.taskResult,
    });

    persistTask(task);
    mgr.notifyUpdate(instance);
    await mgr.disposeRuntime(instance, "incomplete");
    instance.terminalizing = false;
    if (!mgr.deletingRuns.has(task.parentSessionId)) {
      await Promise.resolve(instance.onReport?.(task, report.parentReport, { kind: "terminal" }));
    }
  }

  /**
   * 终态处理 Helper：失败状态结算
   */
export async function finalizeFailed(mgr: SubagentManagerHost, instance: SubagentInstance, error: string) {
    if (instance.reported || instance.terminalizing) return;
    instance.terminalizing = true;
    instance.reported = true;
    instance.pendingTerminal = undefined;
    instance.aborting = false;

    if (instance.timeoutTimer) {
      clearTimeout(instance.timeoutTimer);
      instance.timeoutTimer = undefined;
    }

    await mgr.abortSessionAndQuiesceTools(instance, "failed");
    instance.pendingTerminal = undefined;

    const task = instance.task;
    task.status = "failed";
    task.error = error;
    task.completedAt = new Date().toISOString();
    task.durationMs = computeDurationMs(task);
    const rawMessages = mgr.getSerializableMessages(instance, error);
    task.messages = serializeMessages(rawMessages);
    task.summary = `执行异常终止: ${task.error}`;
    task.taskResult = {
      taskId: task.taskId,
      role: task.role,
      status: "failed",
      summary: task.summary,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      durationMs: task.durationMs,
      meta: { error: task.error },
    };
    if (task.agentId) {
      mgr.reusableAgents.markFailed(task.agentId);
    }

    const roleConfig = getRoleConfig(task.role);
    const report = buildBoundedCompletionReport({
      taskId: task.taskId,
      taskTitle: task.taskTitle,
      role: task.role,
      roleName: roleConfig.name,
      branch: task.branchName,
      status: "failed",
      completionReason: "error",
      error: task.error,
      changedFiles: task.changedFiles,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      durationMs: task.durationMs,
      lastAssistantText: task.summary,
      taskResult: task.taskResult,
    });

    persistTask(task);
    mgr.notifyUpdate(instance);
    await mgr.disposeRuntime(instance, "failed");
    instance.terminalizing = false;
    if (!mgr.deletingRuns.has(task.parentSessionId)) {
      await Promise.resolve(instance.onReport?.(task, report.parentReport, { kind: "terminal" }));
    }
  }

  /**
   * 子智能体运行结束后的处理：提取最终文本产出并向父会话汇报
   */
export async function handleSubagentCompletion(mgr: SubagentManagerHost, taskId: string): Promise<void> {
    const instance = subagentTasks.get(taskId);
    if (!instance) return;

    const parentSessionId = instance.task.parentSessionId;
    if (mgr.deletingRuns.has(parentSessionId) || isPendingDeletion(parentSessionId)) {
      await mgr.finalizeIncomplete(instance, "Subagent execution cancelled due to parent session deletion.");
      return;
    }

    let completions = mgr.inFlightCompletions.get(parentSessionId);
    if (!completions) {
      completions = new Set();
      mgr.inFlightCompletions.set(parentSessionId, completions);
    }

    const p = mgr.executeSubagentCompletion(instance).finally(() => {
      completions?.delete(p);
      if (completions?.size === 0) {
        mgr.inFlightCompletions.delete(parentSessionId);
      }
    });
    completions.add(p);
    return p;
  }

export async function executeSubagentCompletion(mgr: SubagentManagerHost, instance: SubagentInstance): Promise<void> {
    const taskId = instance.task.taskId;
    const parentSessionId = instance.task.parentSessionId;

    if (instance.timeoutTimer) {
      clearTimeout(instance.timeoutTimer);
      instance.timeoutTimer = undefined;
    }

    if (mgr.isTerminalLocked(instance)) {
      return;
    }

    if (instance.aborting) {
      queuePendingTerminal(instance, { type: "completed" });
      return;
    }

    // 检查最新一轮 Assistant 消息的 finishReason
    const rawMessages = mgr.getSerializableMessages(instance);
    let lastAssistantMsg: Record<string, unknown> | undefined;
    let lastAssistantIndex = -1;
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      const m = rawMessages[i] as unknown as Record<string, unknown> | undefined;
      if (m && m.role === "assistant") {
        lastAssistantMsg = m;
        lastAssistantIndex = i;
        break;
      }
    }

    const finishReason = normalizeFinishReason(lastAssistantMsg);

    if (finishReason === "stop") {
      if (isPrematureEmptyStopAfterTools(rawMessages, lastAssistantIndex, lastAssistantMsg)) {
        await mgr.finalizeIncomplete(
          instance,
          "Subagent session stopped after intermediate tool work without a final deliverable summary. agent_end does not mean the task succeeded.",
        );
        return;
      }
      await mgr.finalizeCompleted(instance);
      return;
    }

    if (finishReason === "max_tokens") {
      if (mgr.deletingRuns.has(parentSessionId) || isPendingDeletion(parentSessionId)) {
        await mgr.finalizeIncomplete(
          instance,
          "Subagent output was truncated and continuation was blocked due to session deletion.",
        );
        return;
      }

      const currentContinuation = instance.autoContinuationCount ?? 0;
      if (currentContinuation < 1 && instance.runtime?.session) {
        instance.autoContinuationCount = currentContinuation + 1;
        const logLine = `[SubagentManager] Subagent ${taskId} output truncated by max_tokens. Auto-continuing (1/1)...`;
        instance.task.logs?.push(logLine);
        instance.task.messages = serializeMessages(mgr.getSerializableMessages(instance));
        persistTask(instance.task);
        mgr.notifyUpdate(instance);

        const continuationPrompt =
          "上一轮因达到模型输出 Token 上限而被截断。\n\n不要重新进行完整分析。\n从未完成的位置继续。\n优先执行必要工具调用和实际任务。\n控制思考长度，尽快完成任务并给出最终结果。";

        instance.runtime.session.prompt(continuationPrompt).catch((err: unknown) => {
          console.error(`[SubagentManager] Subagent ${taskId} continuation error:`, err);
          void mgr.finalizeIncomplete(
            instance,
            "Subagent output was truncated because the model reached its maximum output token limit. No valid final result was produced.",
          );
        });
        return;
      }

      await mgr.finalizeIncomplete(
        instance,
        "Subagent output was truncated because the model reached its maximum output token limit. No valid final result was produced.",
      );
      return;
    }

    if (finishReason === "cancelled") {
      await mgr.finalizeFailed(instance, "Subagent execution was cancelled or aborted.");
      return;
    }

    if (finishReason === "error") {
      const mutated = hasSuccessfulFileMutation(rawMessages, instance.task.logs);
      if (
        mutated &&
        assistantHasVisibleText(lastAssistantMsg) &&
        !assistantContentHasType(lastAssistantMsg, "toolCall")
      ) {
        await mgr.finalizeCompleted(instance);
        return;
      }
      const errorDetail =
        typeof lastAssistantMsg?.errorMessage === "string"
          ? sanitizeProviderErrorMessage(lastAssistantMsg.errorMessage)
          : undefined;
      await mgr.finalizeFailed(
        instance,
        errorDetail
          ? `Subagent encountered an error during execution: ${errorDetail}`
          : "Subagent encountered an error during execution.",
      );
      return;
    }

    if (finishReason === "tool_call") {
      await mgr.finalizeFailed(
        instance,
        "Subagent session ended unexpectedly while a tool call was still pending.",
      );
      return;
    }

    // Fail-closed for unknown or unmapped finish reasons
    await mgr.finalizeIncomplete(
      instance,
      "Subagent termination reason could not be determined safely.",
    );
  }

