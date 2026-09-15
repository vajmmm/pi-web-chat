import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { UISubagentTask } from "../../shared/protocol.ts";
import {
  CANONICAL_ROLES,
  ConstraintResolver,
  getDefaultTaskContractFields,
  isCanonicalRole,
  isPathContained,
  resolveWorkspaceMode,
  type TaskContract,
  type TaskExecutionStatus,
  type WorkspaceContextDetails,
} from "../contracts/index.ts";
import { runGit } from "../git/git.ts";
import { getRoleConfig } from "../roles.ts";
import { serializeMessages } from "../serialize.ts";
import {
  createWorktree,
  removeWorktree,
  resolveGitRepoRoot,
  unregisterRuntimeResource,
} from "../worktree.ts";
import { buildContinueBoundaryPrompt } from "../reusable-subagent.ts";
import {
  initializeTaskFactStore,
  persistToolOutput,
} from "../runtime-artifacts.ts";
import { buildSubagentUserPrompt } from "./prompt-builder.ts";
import { createSubagentSessionRuntime } from "./agent-runtime.ts";
import { createAgySessionRuntime } from "./agy/agy-adapter.ts";
import { computeDurationMs, persistTask, subagentTasks } from "./task-store.ts";
import type { ContinueSubagentOptions, SpawnSubagentOptions, SubagentInstance } from "./types.ts";
import { captureWorkspaceBaseline } from "./workspace-baseline.ts";
import { queuePendingTerminal } from "./runtime-control.ts";
import type { SubagentManagerHost } from "./manager-host.ts";
import { buildTaskEpisodeCard, buildTaskEpisodeView, boundTaskLineage } from "./episode-card.ts";
import { createShadowTranscriptRecorder } from "./shadow-transcript.ts";
import {
  createStallTelemetryState,
  observeToolExecution,
  recordContextPressure,
} from "./stall-arbiter.ts";

/**
 * Arm (or re-arm) the per-task wall-clock watchdog. Called at task start and
 * again after the max_tokens auto-continuation, so a stalled continuation can
 * still be aborted instead of pinning the task (and its worktree) in `running`.
 */
export function armTimeout(instance: SubagentInstance, mgr: SubagentManagerHost): void {
  const timeoutMs = instance.timeoutMs;
  if (!timeoutMs || timeoutMs <= 0) return;

  if (instance.timeoutTimer) {
    clearTimeout(instance.timeoutTimer);
    instance.timeoutTimer = undefined;
  }

  const taskId = instance.task.taskId;
  instance.timeoutTimer = setTimeout(() => {
    console.warn(`[SubagentManager] Task ${taskId} timed out after ${timeoutMs}ms`);
    void mgr.abort(taskId, { source: "timeout" });
  }, timeoutMs);
  instance.timeoutTimer.unref?.();
}

/**
 * 空闲(stall)看门狗超时:一个正在 running 的子任务在此毫秒数内没有产生任何
 * 会话事件(无 token 流、无工具事件),即判定其底层模型流已挂起并强制终止。
 * 0 表示禁用。可用 PI_SUBAGENT_STALL_TIMEOUT_MS 覆盖,默认 6 分钟。
 *
 * 这是纯兜底,不是主路径:挂起流的主处理是 3 分钟的 HTTP idle 超时
 * (见 index.ts HTTP_IDLE_TIMEOUT_MS)——流静默 3 分钟即中止并自动重试。
 * 每次 idle 重试都会发事件复位本看门狗,故健康的重试周期永远不会触发它。
 * 本看门狗必须高于 idle 超时,只在连 idle 重试都不触发(全程零事件、退无可退)
 * 的病态情况下兜底终止,避免任务永久卡在 running。健康生成持续吐 token,不误触发。
 */
export const SUBAGENT_STALL_TIMEOUT_MS = (() => {
  const raw = process.env.PI_SUBAGENT_STALL_TIMEOUT_MS;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 360_000;
})();

/**
 * (重新)武装空闲看门狗。每收到一个会话事件都调用一次以复位计时器。
 * 触发时:若仍有工具在执行(长命令是合法的静默),仅重新武装;否则强制终止。
 * 自守卫——任务已进入终态时静默返回,故终态后残留的一次晚触发是无害空操作。
 */
export function bumpStallWatchdog(instance: SubagentInstance, mgr: SubagentManagerHost): void {
  if (SUBAGENT_STALL_TIMEOUT_MS <= 0) return;
  if (instance.stallTimer) {
    clearTimeout(instance.stallTimer);
    instance.stallTimer = undefined;
  }
  if (instance.task.status !== "running") return;
  const taskId = instance.task.taskId;
  instance.stallTimer = setTimeout(() => {
    instance.stallTimer = undefined;
    if (
      instance.reported ||
      instance.aborting ||
      instance.terminalizing ||
      instance.task.status !== "running"
    ) {
      return;
    }
    // 工具仍在执行:模型没挂,是命令跑得久。重新武装,不误杀。
    if (mgr.listActiveToolNames(instance).length > 0) {
      bumpStallWatchdog(instance, mgr);
      return;
    }
    console.warn(
      `[SubagentManager] Task ${taskId} stalled for ${SUBAGENT_STALL_TIMEOUT_MS}ms with no activity (likely a hung provider stream); aborting.`,
    );
    void mgr.abort(taskId, { source: "timeout" });
  }, SUBAGENT_STALL_TIMEOUT_MS);
  instance.stallTimer.unref?.();
}

  /**
   * 严格校验返工关联目标 (rework_of_task_id) 的合法性，收敛为线性返工链 (Fail-closed)
   */
export function validateReworkTarget(
    mgr: SubagentManagerHost,
    parentSessionId: string,
    newTaskId: string,
    reworkOfTaskId: string,
  ): void {
    // 1. 不能指向新 Task 自己
    if (reworkOfTaskId === newTaskId) {
      throw new Error(
        `[SubagentManager] Cannot rework task "${reworkOfTaskId}": task cannot be a rework of itself.`,
      );
    }

    // 2. 目标 Task 必须存在
    const targetTask = subagentTasks.get(reworkOfTaskId)?.task;
    if (!targetTask) {
      throw new Error(
        `[SubagentManager] Cannot rework task "${reworkOfTaskId}": target task does not exist.`,
      );
    }

    // 3. 目标 Task 与新 Task 必须属于同一个 parentSessionId / Run
    if (targetTask.parentSessionId !== parentSessionId) {
      throw new Error(
        `[SubagentManager] Cannot rework task "${reworkOfTaskId}": target task belongs to another session "${targetTask.parentSessionId}" (expected "${parentSessionId}"). Cross-session rework is prohibited.`,
      );
    }

    // 4. 目标 Task 应为 terminal execution 状态，不能对仍在 running / ready / blocked / conflict 的 Task 创建 rework
    const nonTerminalStates: TaskExecutionStatus[] = [
      "running",
      "ready",
      "blocked",
      "conflict",
    ];
    if (nonTerminalStates.includes(targetTask.status)) {
      throw new Error(
        `[SubagentManager] Cannot rework task "${reworkOfTaskId}": target task is in non-terminal status "${targetTask.status}". Rework can only target terminal tasks.`,
      );
    }

    // 5. 不允许形成循环 lineage
    const visited = new Set<string>([newTaskId, targetTask.taskId]);
    let currentId = targetTask.reworkOfTaskId ?? targetTask.taskContract?.reworkOfTaskId;
    while (currentId) {
      if (currentId === newTaskId || visited.has(currentId)) {
        throw new Error(
          `[SubagentManager] Cannot rework task "${reworkOfTaskId}": circular rework lineage detected involving task "${currentId}".`,
        );
      }
      visited.add(currentId);
      const ancestor = subagentTasks.get(currentId)?.task;
      currentId = ancestor?.reworkOfTaskId ?? ancestor?.taskContract?.reworkOfTaskId;
    }

    // 6. 线性返工链：一个 Task 不允许同时存在多个有效 rework successor
    const sessionTasks = mgr.getTasksForParent(parentSessionId);
    const existingSuccessor = sessionTasks.find((t) => {
      const target = t.reworkOfTaskId ?? t.taskContract?.reworkOfTaskId;
      return target === reworkOfTaskId && t.taskId !== newTaskId;
    });
    if (existingSuccessor) {
      throw new Error(
        `[SubagentManager] Cannot rework task "${reworkOfTaskId}": task already has a rework successor "${existingSuccessor.taskId}". Rework lineage must be a linear chain. Specify rework_of_task_id="${existingSuccessor.taskId}" instead.`,
      );
    }
  }

  /**
   * 复用逻辑 Agent 的短 Knowledge，创建全新 TaskContract / Worktree / Session。
   */
export async function continueAgent(mgr: SubagentManagerHost, options: ContinueSubagentOptions): Promise<UISubagentTask> {
    if (mgr.deletingRuns.has(options.parentSessionId)) {
      throw new Error(
        `[SubagentManager] Cannot continue subagent for session ${options.parentSessionId}: session is being deleted (lifecycle gate locked).`,
      );
    }

    const agent = mgr.reusableAgents.get(options.agentId);
    if (!agent) {
      throw new Error(`[SubagentManager] continue_subagent failed: agent "${options.agentId}" not found`);
    }
    if (agent.parentSessionId !== options.parentSessionId) {
      throw new Error(
        `[SubagentManager] continue_subagent failed: agent "${options.agentId}" belongs to another parent session`,
      );
    }
    if (agent.state !== "idle_reusable") {
      throw new Error(
        `[SubagentManager] continue_subagent failed: agent "${options.agentId}" is not idle_reusable (state=${agent.state})`,
      );
    }

    const taskId = options.taskContract?.taskId || `task-${randomUUID()}`;
    const previous = {
      reuseCount: agent.reuseCount,
      lastTaskId: agent.lastTaskId,
      lastTaskTitle: agent.lastTaskTitle,
    };
    const gate = mgr.reusableAgents.beginContinue(options.agentId, taskId, options.taskTitle);
    if (!gate.ok) {
      throw new Error(`[SubagentManager] continue_subagent failed: ${gate.error}`);
    }

    const reworkOfTaskId = options.taskContract?.reworkOfTaskId ?? options.reworkOfTaskId;

    const contractDefaults = getDefaultTaskContractFields(agent.role);
    const contract: TaskContract = Object.freeze(structuredClone({
      ...options.taskContract,
      taskId,
      parentSessionId: options.parentSessionId,
      role: agent.role,
      goal: options.taskContract?.goal ?? options.taskPrompt,
      scope: options.taskContract?.scope ?? contractDefaults.scope,
      contextFiles: options.taskContract?.contextFiles ?? [],
      acceptanceCriteria:
        options.taskContract?.acceptanceCriteria ?? contractDefaults.acceptanceCriteria,
      dependsOn: options.taskContract?.dependsOn,
      expectedEffects: options.taskContract?.expectedEffects ?? contractDefaults.expectedEffects,
      constraints: options.taskContract?.constraints,
      reworkOfTaskId,
    }));

    try {
      return await mgr.spawn({
        parentSessionId: options.parentSessionId,
        role: agent.role,
        taskTitle: options.taskTitle,
        taskPrompt: options.taskPrompt,
        preferredBranch: options.preferredBranch,
        targetCwd: options.targetCwd,
        parentCwd: options.parentCwd,
        parentModel: options.parentModel,
        taskContract: contract,
        executionOptions: options.executionOptions,
        customSession: options.customSession,
        reuseAgentId: options.agentId,
        onUpdate: options.onUpdate,
        onReport: options.onReport,
      });
    } catch (err) {
      mgr.reusableAgents.rollbackContinue(options.agentId, previous);
      throw err;
    }
  }

  /**
   * startTaskExecution 失败时：清掉可能已创建的 worktree/runtime，并把任务从 running 打成 failed。
   * spawn 在 persist+notify 之后才启动，失败若不回滚，UI 会留下一条永远 RUNNING 的僵尸任务，Coordinator 重试就会表现为重复任务。
   */
async function rollbackFailedStart(
    mgr: SubagentManagerHost,
    instance: SubagentInstance,
    err: unknown,
  ): Promise<void> {
    const task = instance.task;
    const parentSessionId = task.parentSessionId;
    const repoRoot = instance.repoRoot;
    const errorMsg = String(err instanceof Error ? err.message : err);

    if (instance.timeoutTimer) {
      clearTimeout(instance.timeoutTimer);
      instance.timeoutTimer = undefined;
    }

    if (instance.runtime) {
      try {
        await instance.runtime.dispose();
      } catch (disposeErr) {
        console.warn(
          `[SubagentManager] Failed to dispose runtime during start rollback for ${task.taskId}:`,
          disposeErr,
        );
      }
      instance.runtime = undefined;
    }

    if (task.worktreePath && repoRoot) {
      try {
        await removeWorktree(repoRoot, task.worktreePath);
        unregisterRuntimeResource(parentSessionId, "task_worktree", task.worktreePath, repoRoot);
      } catch (cleanupErr) {
        console.warn(
          `[SubagentManager] Failed to remove worktree during start rollback for ${task.taskId}:`,
          cleanupErr,
        );
      }
      task.worktreePath = undefined;
    }

    if (task.branchName && repoRoot) {
      try {
        await runGit(repoRoot, ["branch", "-D", task.branchName]);
        unregisterRuntimeResource(parentSessionId, "task_branch", task.branchName, repoRoot);
      } catch (cleanupErr) {
        console.warn(
          `[SubagentManager] Failed to delete branch during start rollback for ${task.taskId}:`,
          cleanupErr,
        );
      }
      task.branchName = undefined;
    }

    task.status = "failed";
    task.error = errorMsg;
    task.summary = errorMsg;
    task.completedAt = new Date().toISOString();
    task.durationMs = computeDurationMs(task);
    persistTask(task);
    mgr.notifyUpdate(instance);
  }

  /**
   * 派发并异步启动一个 Subagent 子任务 (Fail-closed 严格隔离)
   */
export async function spawn(mgr: SubagentManagerHost, options: SpawnSubagentOptions): Promise<UISubagentTask> {
    return mgr.trackInFlightStart(options.parentSessionId, async () => {
      // 0. Deletion gate check (Fail-closed)
      if (mgr.deletingRuns.has(options.parentSessionId)) {
        throw new Error(
          `[SubagentManager] Cannot spawn subagent for session ${options.parentSessionId}: session is being deleted (lifecycle gate locked).`,
        );
      }

      // 1. 角色有效性严格校验 (Fail-closed，仅接受 Canonical Roles)
      if (!isCanonicalRole(options.role)) {
        throw new Error(
          `[SubagentManager] Unknown or invalid role "${options.role}". Available roles: ${CANONICAL_ROLES.join(", ")}. Fail-closed: refusing execution.`,
        );
      }

      const taskId = options.taskContract?.taskId || `task-${randomUUID()}`;
      const roleConfig = getRoleConfig(options.role);
      const repoRoot = await resolveGitRepoRoot(options.parentCwd);

      // 2. 确定初始 TaskContract
      const reworkOfTaskId = options.taskContract?.reworkOfTaskId ?? options.reworkOfTaskId;
      if (reworkOfTaskId) {
        validateReworkTarget(mgr, options.parentSessionId, taskId, reworkOfTaskId);
      }
      const contractDefaults = getDefaultTaskContractFields(
        options.role,
        ["实现对应需求并通过自测"],
      );
      let contract: TaskContract = {
        ...options.taskContract,
        taskId,
        parentSessionId: options.parentSessionId,
        role: options.role,
        goal: options.taskContract?.goal ?? options.taskPrompt,
        scope: options.taskContract?.scope ?? contractDefaults.scope,
        contextFiles: options.taskContract?.contextFiles ?? [],
        acceptanceCriteria: options.taskContract?.acceptanceCriteria ?? contractDefaults.acceptanceCriteria,
        expectedEffects: options.taskContract?.expectedEffects ?? contractDefaults.expectedEffects,
        reworkOfTaskId,
      };
      if (reworkOfTaskId && !contract.reworkOfTaskId) {
        contract = { ...contract, reworkOfTaskId };
      }
      contract = Object.freeze(structuredClone(contract));

      // 2.1 依赖环路严格检测 (Fail-closed)
      const deps = contract.dependsOn ?? [];
      if (deps.length > 0) {
        mgr.taskGraph.addTask(taskId, deps);
        const cycle = mgr.taskGraph.detectCycle();
        if (cycle) {
          mgr.taskGraph.removeTask(taskId);
          throw new Error(
            `[SubagentManager] Circular dependency detected in task graph: ${cycle.join(" -> ")}. Fail-closed: refusing execution.`,
          );
        }
      }

      // 2.2 确定初始状态：若依赖尚未全部满足，进入 BLOCKED 状态
      const hasDeps = deps.length > 0;
      const depsReady = hasDeps
        ? mgr.taskGraph.canStart(taskId, (id) => mgr.isTaskLineageSatisfied(id, options.parentSessionId))
        : true;
      const isRunning = !(hasDeps && !depsReady);
      const now = new Date().toISOString();

      // Logical reusable agent: create on fresh spawn, or attach when continuing.
      let agentId = options.reuseAgentId;
      if (agentId) {
        const existing = mgr.reusableAgents.get(agentId);
        if (!existing) {
          throw new Error(`[SubagentManager] reuseAgentId "${agentId}" not found`);
        }
        if (existing.role !== options.role) {
          throw new Error(
            `[SubagentManager] reuseAgentId "${agentId}" role mismatch: agent=${existing.role}, task=${options.role}`,
          );
        }
        if (existing.parentSessionId !== options.parentSessionId) {
          throw new Error(
            `[SubagentManager] reuseAgentId "${agentId}" belongs to a different parent session`,
          );
        }
      } else {
        const created = mgr.reusableAgents.create({
          parentSessionId: options.parentSessionId,
          role: options.role,
          taskId,
          taskTitle: options.taskTitle || `${roleConfig.name} - ${taskId}`,
          model: options.parentModel ? `${options.parentModel.provider}/${options.parentModel.id}` : undefined,
        });
        agentId = created.agentId;
      }

      const task: UISubagentTask = {
        taskId,
        parentSessionId: options.parentSessionId,
        role: options.role,
        agentId,
        taskTitle: options.taskTitle || `${roleConfig.name} - ${taskId}`,
        taskPrompt: options.taskPrompt,
        targetCwd: options.targetCwd,
        status: isRunning ? "running" : "blocked",
        createdAt: now,
        startedAt: isRunning ? now : undefined,
        logs: [],
        taskContract: contract,
        reworkOfTaskId,
        messages: [],
      };

      const instance: SubagentInstance = {
        task,
        repoRoot,
        taskContract: contract,
        spawnOptions: options,
        onUpdate: options.onUpdate,
        onReport: options.onReport,
        stallTelemetry: createStallTelemetryState(),
      };

      subagentTasks.set(taskId, instance);
      persistTask(task);
      mgr.notifyUpdate(instance);

      // 关键原则：BLOCKED 状态只记录元数据，绝对不得提前创建 Worktree 或 Session
      // 必须等待 dependency lineage satisfied 并 merge 到 integration 后，再基于最新 Integration HEAD 创建 Worktree
      if (task.status === "blocked") {
        return task;
      }

      // 依赖已满足或无依赖，立即启动执行
      try {
        await mgr.startTaskExecution(instance);
      } catch (err) {
        await rollbackFailedStart(mgr, instance, err);
        throw err;
      }
      return task;
    });
  }

  /**
   * 真正启动子任务执行（创建 Worktree、初始化 Runtime/Session 并发送提示词）
   */
export async function startTaskExecution(mgr: SubagentManagerHost, instance: SubagentInstance): Promise<void> {
    const options = instance.spawnOptions;
    if (!options) return;

    const taskId = instance.task.taskId;
    const contract = instance.taskContract;
    let worktreePath: string | undefined;
    let branchName: string | undefined;
    let baseCommit: string | undefined;
    let baseDir = options.parentCwd;
    let repoRoot: string | null | undefined = instance.repoRoot;
    let runtime: Awaited<ReturnType<typeof createSubagentSessionRuntime>>["runtime"] | undefined;

    const abortAndCleanupIfDeleted = async (): Promise<boolean> => {
      if (mgr.deletingRuns.has(options.parentSessionId) || instance.task.status === "aborted") {
        const cleanupErrors: string[] = [];

        if (runtime) {
          try {
            await runtime.dispose();
            runtime = undefined;
          } catch (err) {
            const msg = `Failed to dispose subagent session runtime during rollback for ${taskId}: ${String(err instanceof Error ? err.message : err)}`;
            console.warn(`[SubagentManager] ${msg}`);
            cleanupErrors.push(msg);
            // DO NOT drop runtime handle: keep it on instance so subsequent abort/quiescence can track/retry
            instance.runtime = runtime as any;
          }
        }

        if (worktreePath && repoRoot) {
          try {
            await removeWorktree(repoRoot, worktreePath);
            unregisterRuntimeResource(options.parentSessionId, "task_worktree", worktreePath, repoRoot);
            worktreePath = undefined;
            instance.task.worktreePath = undefined;
          } catch (err) {
            const msg = `Failed to remove worktree ${worktreePath} during rollback for ${taskId}: ${String(err instanceof Error ? err.message : err)}`;
            console.warn(`[SubagentManager] ${msg}`);
            cleanupErrors.push(msg);
            // DO NOT unregister ownership!
            instance.task.worktreePath = worktreePath;
          }

          if (branchName) {
            try {
              await runGit(repoRoot, ["branch", "-D", branchName]);
              unregisterRuntimeResource(options.parentSessionId, "task_branch", branchName, repoRoot);
              branchName = undefined;
              instance.task.branchName = undefined;
            } catch (err) {
              const msg = `Failed to delete branch ${branchName} during rollback for ${taskId}: ${String(err instanceof Error ? err.message : err)}`;
              console.warn(`[SubagentManager] ${msg}`);
              cleanupErrors.push(msg);
              // DO NOT unregister ownership!
              instance.task.branchName = branchName;
            }
          }
        }

        if (cleanupErrors.length > 0) {
          instance.initializationCleanupError = cleanupErrors.join("; ");
          instance.task.status = "failed";
          instance.task.summary = `Task initialization rollback failed: ${instance.initializationCleanupError}`;
          persistTask(instance.task);
          mgr.notifyUpdate(instance);
          return true;
        }

        instance.initializationCleanupError = undefined;
        instance.task.status = "aborted";
        instance.task.summary = "Parent session was deleted during task initialization";
        persistTask(instance.task);
        mgr.notifyUpdate(instance);
        return true;
      }
      return false;
    };

    if (await abortAndCleanupIfDeleted()) return;

    repoRoot = repoRoot ?? (await resolveGitRepoRoot(options.parentCwd));
    instance.repoRoot = repoRoot;

    if (await abortAndCleanupIfDeleted()) return;

    // 1. 基于 Effective Permission 判断是否必须启用 Worktree 隔离
    const preCheckContext = ConstraintResolver.resolve({
      role: options.role,
      cwd: options.parentCwd,
      projectRoot: repoRoot || undefined,
      isGitRepo: !!repoRoot,
      taskContract: contract,
      executionOptions: options.executionOptions,
      parentModel: options.parentModel
        ? { provider: options.parentModel.provider, modelId: options.parentModel.id }
        : null,
    });

    // 1. Workspace routing: project | task | integration
    // Coordinator -> project workspace
    // Researcher -> project workspace
    // Developer -> isolated Task Worktree ("task")
    // Verifier -> existing Session Integration Workspace ("integration")
    const wsMode = resolveWorkspaceMode(options.role, options.executionOptions);

    if (wsMode === "task") {
      if (!repoRoot) {
        throw new Error(
          `[SubagentManager] Role "${options.role}" requires worktree isolation (requiresWorktree=true), but parent directory "${options.parentCwd}" is not inside a Git repository. Fail-closed: refusing execution in unisolated workspace.`,
        );
      }
      try {
        // 基于当前 Run 的 Integration 分支最新状态创建独立 Worktree 与分支
        const integration = await mgr.getOrCreateIntegration(options.parentSessionId, repoRoot);
        const wt = await createWorktree(repoRoot, taskId, options.preferredBranch, integration.branch, options.parentSessionId);
        worktreePath = wt.worktreePath;
        branchName = wt.branch;
        baseCommit = wt.baseCommit;
        instance.task.worktreePath = worktreePath;
        instance.task.branchName = branchName;
        instance.baseCommit = baseCommit;
        instance.task.baseCommit = baseCommit;
        baseDir = worktreePath;
      } catch (err) {
        throw new Error(
          `[SubagentManager] Role "${options.role}" requires worktree isolation, but worktree creation failed for ${taskId}: ${String(err instanceof Error ? err.message : err)}. Fail-closed: refusing fallback to parent cwd.`,
        );
      }
    } else if (wsMode === "integration") {
      // Verifier: 直接复用当前 Session 的 Integration 工作区，不创建独立 branch/worktree，不参与 commit/merge
      if (repoRoot) {
        const integration = await mgr.getOrCreateIntegration(options.parentSessionId, repoRoot);
        instance.task.worktreePath = undefined;
        instance.task.branchName = undefined;
        baseDir = integration.worktreePath;
        instance.workspaceBaseline = await captureWorkspaceBaseline(baseDir);
      } else {
        baseDir = options.parentCwd;
        instance.workspaceBaseline = await captureWorkspaceBaseline(baseDir);
      }
    } else {
      // "project": coordinator, researcher, etc.
      baseDir = options.parentCwd;
    }

    if (await abortAndCleanupIfDeleted()) return;

    let effectiveCwd = baseDir;

    // 2. targetCwd 规范化边界检查 (Fail-closed)
    if (options.targetCwd) {
      const resolved = isAbsolute(options.targetCwd)
        ? options.targetCwd
        : resolve(baseDir, options.targetCwd);

      if (!isPathContained(baseDir, resolved)) {
        throw new Error(
          `[SubagentManager] targetCwd "${options.targetCwd}" escapes the assigned worktree/repo boundary "${baseDir}". Fail-closed.`,
        );
      }

      if (existsSync(resolved)) {
        effectiveCwd = resolved;
      } else {
        try {
          mkdirSync(resolved, { recursive: true });
          effectiveCwd = resolved;
        } catch (err) {
          throw new Error(
            `[SubagentManager] Failed to create targetCwd "${options.targetCwd}": ${String(err instanceof Error ? err.message : err)}`,
          );
        }
      }
    }

    // 3. 计算最终 EffectiveContext
    const lineageIds = [...new Set([
      ...(contract?.reworkOfTaskId ? [contract.reworkOfTaskId] : []),
      ...(contract?.dependsOn || []),
    ])];
    const lineageViews = lineageIds.flatMap((lineageTaskId) => {
      const prior = mgr.getTasksForParent(options.parentSessionId)
        .find((candidate) => candidate.taskId === lineageTaskId);
      const episode = prior ? buildTaskEpisodeCard(prior) : null;
      return episode
        ? [buildTaskEpisodeView(episode, { maxTotalBytes: 1500, maxSummaryBytes: 500, maxFiles: 10 })]
        : [];
    });

    const effectiveContext = ConstraintResolver.resolve({
      role: options.role,
      cwd: effectiveCwd,
      projectRoot: repoRoot || undefined,
      isGitRepo: !!repoRoot,
      branchName,
      worktreePath,
      targetCwd: options.targetCwd,
      taskContract: contract,
      taskLineage: boundTaskLineage(lineageViews),
      executionOptions: options.executionOptions,
      parentModel: options.parentModel
        ? { provider: options.parentModel.provider, modelId: options.parentModel.id }
        : null,
    });

    // 4. 先初始化脱离 Worktree 的 Durable Fact Store。
    initializeTaskFactStore(options.parentSessionId, taskId);

    const effectiveModel = effectiveContext.runtime.model;
    const isAgy =
      effectiveModel?.provider === "agy" ||
      options.role?.startsWith("agy");

    const runtimeOptions = {
      taskId,
      runId: options.parentSessionId,
      role: options.role,
      effectiveCwd,
      effectiveContext,
      modelRuntime: mgr.modelRuntime,
      parentModel: options.parentModel,
      customSession: options.customSession,
      executionOptions: options.executionOptions,
      onCompaction: (count: number) => {
        instance.task.compactionCount = count;
        if (instance.stallTelemetry) recordContextPressure(instance.stallTelemetry, count);
        persistTask(instance.task);
      },
      onReportBlocker: (message: string, severity?: "info" | "warning" | "blocking", context?: string) => {
        if (options.onReport && !mgr.deletingRuns.has(options.parentSessionId)) {
          const severityTag = severity ? `[${severity.toUpperCase()}] ` : "";
          options.onReport(
            instance.task,
            `[Subagent 报告阻塞] 角色 ${options.role} 上报: ${severityTag}${message}${context ? `\n上下文: ${context}` : ""}`,
            { kind: "blocker" },
          );
        }
      },
    };

    const subagentSession = isAgy
      ? await createAgySessionRuntime(runtimeOptions)
      : await createSubagentSessionRuntime(runtimeOptions);

    runtime = subagentSession.runtime;
    const { session, resolvedModelDetails } = subagentSession;
    const flushTranscript = createShadowTranscriptRecorder(options.parentSessionId, taskId);

    if (await abortAndCleanupIfDeleted()) return;

    instance.runtime = runtime as any;
    instance.task.model = resolvedModelDetails;
    instance.task.status = "running";

    if (options.executionOptions?.timeoutMs && options.executionOptions.timeoutMs > 0) {
      instance.timeoutMs = options.executionOptions.timeoutMs;
    }
    armTimeout(instance, mgr);
    bumpStallWatchdog(instance, mgr);

    persistTask(instance.task);
    mgr.notifyUpdate(instance);

    // 7. 订阅会话事件
    session.subscribe((event: any) => {
      // Once a terminal state wins, late events must not overwrite the final
      // task snapshot or restart completion handling. Exception: allow
      // tool_execution_end solely to clear the activeTools gate after abort.
      if (mgr.isTerminalLocked(instance)) {
        if (event.type === "tool_execution_end" && event.toolCallId) {
          mgr.clearActiveTool(instance, event.toolCallId);
        }
        return;
      }

      // Any activity (token stream, tool events, retries...) resets the
      // inactivity watchdog. Silence past the window => hung stream => abort.
      bumpStallWatchdog(instance, mgr);

      try {
        // Pi emits message_end before appending that message. Subsequent events,
        // especially turn_end/agent_end, flush the actual entries with their own IDs.
        if (["message_end", "turn_end", "agent_end", "compaction_start"].includes(event.type)) {
          flushTranscript(session);
        }
        if (event.type === "tool_execution_start") {
          mgr.registerActiveTool(instance, event);
          const logLine = `[Tool] ${event.toolName || "unknown"} start`;
          instance.task.logs?.push(logLine);
          persistTask(instance.task);
          mgr.notifyUpdate(instance);
        } else if (event.type === "tool_execution_end") {
          const activeTool = event.toolCallId
            ? instance.activeTools?.get(event.toolCallId)
            : undefined;
          mgr.clearActiveTool(instance, event.toolCallId);
          const logLine = `[Tool] ${event.toolName} -> ${event.isError ? "Error" : "Success"}`;
          instance.task.logs?.push(logLine);
          if (instance.stallTelemetry) {
            const signal = observeToolExecution(instance.stallTelemetry, {
              toolName: event.toolName,
              args: activeTool?.args,
              isError: event.isError,
              content: event.result?.content,
            });
            if (signal.warning) instance.task.logs?.push(signal.warning);
            instance.task.stallTelemetry = {
              commandLoopSignals: instance.stallTelemetry.commandLoopSignals,
              verificationStagnationSignals: instance.stallTelemetry.verificationStagnationSignals,
              codeOscillationSignals: instance.stallTelemetry.codeOscillationSignals,
              contextPressure: instance.stallTelemetry.contextPressure,
              warningCount: instance.stallTelemetry.warningCount,
            };
          }

          // Agent Core emits this event before creating/appending toolResult.
          // Keep the result as a fallback, but do not serialize session.messages
          // here because that would overwrite the task with a dangling toolCall.
          if (event.toolCallId) {
            let persistedPointer: ReturnType<typeof persistToolOutput> | undefined;
            if (!(session as any).__factStoreExtensionInstalled) {
              persistedPointer = persistToolOutput({
                runId: options.parentSessionId,
                taskId,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                content: Array.isArray(event.result?.content) ? event.result.content : [],
                details: event.result?.details,
                input: activeTool?.args,
                isError: event.isError,
              });
            }
            if (!instance.pendingToolResults) instance.pendingToolResults = new Map();
            const result = event.result ?? {};
            instance.pendingToolResults.set(event.toolCallId, {
              role: "toolResult",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              content: Array.isArray(result.content) ? result.content : [],
              details: persistedPointer
                ? { ...(result.details || {}), artifactRef: persistedPointer.artifactRef }
                : result.details,
              usage: result.usage,
              isError: Boolean(event.isError),
              timestamp: Date.now(),
            });
          }
          persistTask(instance.task);
          mgr.notifyUpdate(instance);
        } else if (event.type === "message_end" || event.type === "turn_end") {
          if (event.type === "message_end" && event.message?.role === "toolResult") {
            instance.pendingToolResults?.delete(event.message.toolCallId);
          }
          instance.task.messages = serializeMessages(mgr.getSerializableMessages(instance));
          persistTask(instance.task);
          mgr.notifyUpdate(instance);
        } else if (event.type === "agent_end") {
          instance.task.messages = serializeMessages(mgr.getSerializableMessages(instance));
          persistTask(instance.task);
          mgr.notifyUpdate(instance);

          // AgentSession may emit an intermediate agent_end while an automatic
          // provider retry is scheduled. Only the settled run may finalize.
          if (event.willRetry === true) {
            instance.task.logs?.push(
              `[SubagentManager] agent_end received; deferring finalization for automatic retry.`,
            );
            persistTask(instance.task);
            return;
          }

          // If tools are still in flight when the agent loop ends, record it.
          // Finalizers abort+wait so orphans are not left behind the harness status.
          const inflight = mgr.listActiveToolNames(instance);
          if (inflight.length > 0) {
            instance.task.logs?.push(
              `[SubagentManager] agent_end with in-flight tools: ${inflight.join(", ")}`,
            );
            persistTask(instance.task);
          }

          void mgr.handleSubagentCompletion(taskId).catch((err: unknown) => {
            console.error(`[SubagentManager] Completion handling failed for ${taskId}:`, err);
            void mgr.finalizeFailed(
              instance,
              String(err instanceof Error ? err.message : err),
            );
          });
        }
      } catch (err) {
        // This callback runs inside Agent Core's awaited event pipeline. A UI
        // publication or serialization failure must be observable, but must
        // not turn a completed tool into a provider-style agent error.
        console.warn(`[SubagentManager] Session event handling failed for ${taskId}:`, err);
      }
    });

    // 8. 异步启动提示词（continue 时注入 NEW TASK 边界 + 短 Knowledge，不复用底层 Session）
    let continueBoundary: string | undefined;
    if (options.reuseAgentId) {
      const reusable = mgr.reusableAgents.get(options.reuseAgentId);
      if (reusable) {
        continueBoundary = buildContinueBoundaryPrompt({
          taskId,
          goal: contract?.goal || options.taskTitle || options.taskPrompt,
          scopeInclude: contract?.scope?.include,
          acceptanceCriteria: contract?.acceptanceCriteria,
          knowledge: reusable.knowledge,
        });
      }
    }
    const workspaceContext: WorkspaceContextDetails = {
      cwd: effectiveCwd,
      projectRoot: effectiveContext.environment.projectRoot,
      workspaceType: effectiveContext.environment.isWorktree
        ? "isolated_worktree"
        : options.role === "coordinator"
          ? "coordinator_workspace"
          : "main_project",
      gitBranch: effectiveContext.environment.gitBranch,
      targetCwd: effectiveContext.environment.targetCwd,
      isWorktree: effectiveContext.environment.isWorktree,
    };

    const userPrompt = buildSubagentUserPrompt(options.taskPrompt, contract, {
      continueBoundary,
      workspaceContext,
    });
    if (continueBoundary) {
      instance.task.taskPrompt = userPrompt;
      persistTask(instance.task);
    }

    if (await abortAndCleanupIfDeleted()) return;

    session.prompt(userPrompt).catch((err: unknown) => {
      console.error(`[SubagentManager] Subagent ${taskId} error:`, err);
      const errorMsg = String(err instanceof Error ? err.message : err);
      if (instance.timeoutTimer) {
        clearTimeout(instance.timeoutTimer);
        instance.timeoutTimer = undefined;
      }
      if (mgr.isTerminalLocked(instance) || instance.task.status === "aborted") {
        return;
      }
      if (instance.aborting) {
        queuePendingTerminal(instance, { type: "failed", error: errorMsg });
        return;
      }
      void mgr.finalizeFailed(instance, errorMsg);
    });
  }

  /**
   * 启动一个之前因依赖未满足而处于 blocked 状态的任务
   */
export async function startBlockedTask(mgr: SubagentManagerHost, taskId: string): Promise<boolean> {
    const instance = subagentTasks.get(taskId);
    if (!instance || instance.task.status !== "blocked") return false;
    const parentSessionId = instance.task.parentSessionId;
    if (mgr.deletingRuns.has(parentSessionId)) {
      console.warn(
        `[SubagentManager] Cannot start blocked task ${taskId}: parent session ${parentSessionId} is being deleted (lifecycle gate locked).`,
      );
      return false;
    }

    return mgr.trackInFlightStart(parentSessionId, async () => {
      const currentStatus = instance.task.status as TaskExecutionStatus;
      if (mgr.deletingRuns.has(parentSessionId) || currentStatus === "aborted") {
        return false;
      }

      if (instance.spawnOptions) {
        try {
          await mgr.startTaskExecution(instance);
        } catch (err) {
          await rollbackFailedStart(mgr, instance, err);
          throw err;
        }
        return (instance.task.status as TaskExecutionStatus) !== "aborted";
      }

      if (!instance.runtime) return false;

      if (!instance.task.startedAt) {
        instance.task.startedAt = new Date().toISOString();
      }
      instance.task.status = "running";
      persistTask(instance.task);
      mgr.notifyUpdate(instance);
      // Re-arm the inactivity watchdog for the reused (already-subscribed)
      // session now that this blocked task is running again.
      bumpStallWatchdog(instance, mgr);

      const contract = instance.taskContract;
      const userPrompt = buildSubagentUserPrompt(instance.task.taskPrompt, contract, {
        workspaceContext: {
          cwd: instance.task.worktreePath || instance.repoRoot || process.cwd(),
          projectRoot: instance.repoRoot,
          workspaceType: instance.task.worktreePath ? "isolated_worktree" : "main_project",
          gitBranch: instance.task.branchName,
          targetCwd: instance.task.targetCwd,
          isWorktree: Boolean(instance.task.worktreePath),
        },
      });
      instance.runtime.session.prompt(userPrompt).catch((err) => {
        console.error(`[SubagentManager] Blocked task ${taskId} start error:`, err);
        const errorMsg = String(err instanceof Error ? err.message : err);
        if (instance.reported || instance.task.status === "aborted") return;
        if (instance.aborting) {
          queuePendingTerminal(instance, { type: "failed", error: errorMsg });
          return;
        }
        void mgr.finalizeFailed(instance, errorMsg);
      });

      return true;
    });
  }
