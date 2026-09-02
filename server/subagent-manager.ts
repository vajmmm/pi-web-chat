import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentRole, UISubagentTask } from "../shared/protocol.ts";
import {
  ConstraintResolver,
  formatWorkspaceContext,
  getAllRoleDefinitions,
  isPathContained,
  type SubagentExecutionOptions,
  type TaskContract,
  type TaskExecutionStatus,
  type TaskResult,
  type VerificationResult,
  type ReviewResult,
  type ReviewFinding,
  type ReviewSeverity,
  type WorkspaceContextDetails,
} from "./contracts/index.ts";
import { getRoleConfig } from "./roles.ts";
import { runVerification } from "./runtime-verifier.ts";
import { serializeMessages } from "./serialize.ts";
import {
  buildBoundedCompletionReport,
  extractLastAssistantText,
  normalizeFinishReason,
} from "./subagent-report.ts";
import {
  isTaskExecutionSatisfied,
  isTaskLineageSatisfied,
  TaskGraph,
} from "./task-graph.ts";
import {
  cleanupRunResources,
  commitWorktreeChanges,
  createWorktree,
  finalizeRun,
  getOrCreateIntegrationWorkspace,
  getWorktreeDiff,
  mergeTaskToIntegration,
  mergeWorktreeBranch,
  resolveGitRepoRoot,
  tryMergeWorktree,
  type FinalizeMode,
  type FinalizeResult,
  type IntegrationWorkspace,
} from "./worktree.ts";
import {
  buildContinueBoundaryPrompt,
  ReusableSubagentRegistry,
  toReusableAgentListItem,
  type ReusableAgentListItem,
  type ReusableSubagent,
} from "./reusable-subagent.ts";
import {
  initTaskMemory,
  buildCompactionMemoryBlock,
  getWorkingMemoryPath,
  getProcessJournalPath,
  removeTaskMemory,
} from "./task-memory.ts";
import {
  assistantContentHasType,
  assistantHasVisibleText,
  buildSubagentUserPrompt,
  computeDurationMs,
  createSubagentSessionRuntime,
  deleteTaskFile,
  hasSuccessfulFileMutation,
  isPrematureEmptyStopAfterTools,
  loadPersistedTasks,
  persistTask,
  subagentTasks,
  subagentsDir,
  taskFilePath,
  type ContinueSubagentOptions,
  type SpawnSubagentOptions,
  type SubagentInstance,
} from "./subagent/index.ts";

function queuePendingTerminal(
  instance: SubagentInstance,
  next: { type: "completed" | "failed"; error?: string },
): void {
  if (!instance.pendingTerminal) {
    instance.pendingTerminal = next;
    return;
  }
  // failed 优先级高于 completed
  if (instance.pendingTerminal.type === "completed" && next.type === "failed") {
    instance.pendingTerminal = next;
  }
}

export {
  buildSubagentUserPrompt,
  subagentTasks,
  type ContinueSubagentOptions,
  type SpawnSubagentOptions,
  type WorkspaceContextDetails,
};

import { CoordinatorStateTracker } from "./coordinator/coordinator-state.ts";

export class SubagentManager {
  private modelRuntime: ModelRuntime;
  public readonly taskGraph = new TaskGraph();
  public readonly reusableAgents = new ReusableSubagentRegistry();
  private readonly coordinatorState = new CoordinatorStateTracker();
  private integrations = new Map<string, IntegrationWorkspace>();
  private finalizedRuns = new Map<string, FinalizeResult>();
  public autoFinalize: boolean = true;

  constructor(modelRuntime: ModelRuntime, options?: { autoFinalize?: boolean }) {
    this.modelRuntime = modelRuntime;
    this.autoFinalize = options?.autoFinalize ?? true;
    const persisted = loadPersistedTasks();
    for (const [id, task] of persisted) {
      if (!subagentTasks.has(id)) {
        subagentTasks.set(id, { task, taskContract: task.taskContract });
      }
      // Reconstruct dependency graph from persisted task contracts
      if (task.taskContract?.dependsOn && task.taskContract.dependsOn.length > 0) {
        this.taskGraph.addTask(task.taskId, task.taskContract.dependsOn);
      }
    }
  }

  public updateModelRuntime(modelRuntime: ModelRuntime) {
    this.modelRuntime = modelRuntime;
  }

  public listReusableAgents(parentSessionId: string): ReusableSubagent[] {
    return this.reusableAgents.listForParent(parentSessionId);
  }

  public listReusableAgentSummaries(parentSessionId: string): ReusableAgentListItem[] {
    return this.listReusableAgents(parentSessionId).map(toReusableAgentListItem);
  }

  public getTask(taskId: string): UISubagentTask | undefined {
    return subagentTasks.get(taskId)?.task;
  }

  public isRunFinalized(parentSessionId: string): boolean {
    return this.finalizedRuns.has(parentSessionId);
  }

  public getFinalizeResult(parentSessionId: string): FinalizeResult | undefined {
    return this.finalizedRuns.get(parentSessionId);
  }

  public getCoordinatorState(parentSessionId: string): { isExecuting: boolean; pendingReportsCount: number } {
    return this.coordinatorState.getState(parentSessionId);
  }

  public isCoordinatorActive(parentSessionId: string): boolean {
    return this.coordinatorState.isActive(parentSessionId);
  }

  public notifyCoordinatorTurnStart(parentSessionId: string): void {
    this.coordinatorState.turnStarted(parentSessionId);
  }

  public async notifyCoordinatorTurnEnd(
    parentSessionId: string,
    options?: { hasPendingReports?: boolean },
  ): Promise<FinalizeResult | null> {
    this.coordinatorState.turnEnded(parentSessionId, options);
    if (this.coordinatorState.isSafeBoundary(parentSessionId) && this.autoFinalize) {
      return await this.tryAutoFinalizeRun(parentSessionId);
    }
    return null;
  }

  public notifyCoordinatorReportPending(parentSessionId: string, countDelta: number = 1): void {
    this.coordinatorState.reportPending(parentSessionId, countDelta);
  }

  public notifyCoordinatorReportConsumed(parentSessionId: string): void {
    this.coordinatorState.reportConsumed(parentSessionId);
  }

  public isTaskExecutionSatisfied(task: UISubagentTask): boolean {
    return isTaskExecutionSatisfied(task);
  }

  public isTaskLineageSatisfied(taskId: string, parentSessionId?: string): boolean {
    const tasks = parentSessionId
      ? this.getTasksForParent(parentSessionId)
      : Array.from(subagentTasks.values()).map((inst) => inst.task);
    return isTaskLineageSatisfied(
      taskId,
      (id) => subagentTasks.get(id)?.task,
      tasks,
    );
  }

  public isSessionLineageSatisfied(parentSessionId: string): boolean {
    const tasks = this.getTasksForParent(parentSessionId);
    if (tasks.length === 0) return false;

    const nonTerminalStates: TaskExecutionStatus[] = [
      "blocked",
      "ready",
      "running",
      "conflict",
    ];

    if (tasks.some((t) => nonTerminalStates.includes(t.status))) {
      return false;
    }

    return tasks.every((t) => this.isTaskLineageSatisfied(t.taskId, parentSessionId));
  }

  /**
   * 自动检查当前会话的所有子任务生命周期与质量 Gate。
   * 触发点必须位于 Coordinator Safe Boundary（Coordinator 不在执行中，且无 pending reports）。
   * 当且仅当所有任务 lineage 均已通过、无未决冲突、无运行中任务时，自动写回用户工作区。
   */
  public async tryAutoFinalizeRun(parentSessionId: string): Promise<FinalizeResult | null> {
    if (this.isCoordinatorActive(parentSessionId)) {
      return null;
    }

    if (this.finalizedRuns.has(parentSessionId)) {
      return this.finalizedRuns.get(parentSessionId)!;
    }

    const integration = this.integrations.get(parentSessionId);
    if (!integration) return null;

    if (!this.isSessionLineageSatisfied(parentSessionId)) {
      return null;
    }

    try {
      return await this.finalizeRun(parentSessionId, { mode: "working_tree" });
    } catch (err) {
      console.warn(`[SubagentManager] Auto finalizeRun failed for session ${parentSessionId}:`, err);
      return null;
    }
  }

  /**
   * 获取或创建当前 Session/Run 的独立 Integration 工作区 (runtime/run-<runId>)
   */
  public async getOrCreateIntegration(
    parentSessionId: string,
    repoRoot: string,
  ): Promise<IntegrationWorkspace> {
    let integration = this.integrations.get(parentSessionId);
    if (!integration) {
      integration = await getOrCreateIntegrationWorkspace(repoRoot, parentSessionId);
      this.integrations.set(parentSessionId, integration);
    }
    return integration;
  }

  /**
   * 严格校验返工关联目标 (rework_of_task_id) 的合法性，收敛为线性返工链 (Fail-closed)
   */
  private validateReworkTarget(
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
    const sessionTasks = this.getTasksForParent(parentSessionId);
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
  public async continueAgent(options: ContinueSubagentOptions): Promise<UISubagentTask> {
    const agent = this.reusableAgents.get(options.agentId);
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
    const gate = this.reusableAgents.beginContinue(options.agentId, taskId, options.taskTitle);
    if (!gate.ok) {
      throw new Error(`[SubagentManager] continue_subagent failed: ${gate.error}`);
    }

    const reworkOfTaskId = options.taskContract?.reworkOfTaskId ?? options.reworkOfTaskId;

    const contract: TaskContract = {
      taskId,
      parentSessionId: options.parentSessionId,
      role: agent.role,
      goal: options.taskContract?.goal || options.taskTitle || options.taskPrompt,
      scope: options.taskContract?.scope ?? { include: ["*"], exclude: [] },
      contextFiles: options.taskContract?.contextFiles ?? [],
      acceptanceCriteria:
        options.taskContract?.acceptanceCriteria ?? ["完成指定实现并自测通过"],
      dependsOn: options.taskContract?.dependsOn,
      expectedEffects: options.taskContract?.expectedEffects,
      constraints: options.taskContract?.constraints,
      reworkOfTaskId,
    };

    try {
      return await this.spawn({
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
      this.reusableAgents.rollbackContinue(options.agentId, previous);
      throw err;
    }
  }

  /**
   * 派发并异步启动一个 Subagent 子任务 (Fail-closed 严格隔离)
   */
  public async spawn(options: SpawnSubagentOptions): Promise<UISubagentTask> {
    // 1. 角色有效性严格校验 (Fail-closed，禁止静默回退)
    const validRoleIds = getAllRoleDefinitions().map((r) => r.id);
    if (!validRoleIds.includes(options.role)) {
      throw new Error(
        `[SubagentManager] Unknown or invalid role "${options.role}". Available roles: ${validRoleIds.join(", ")}. Fail-closed: refusing execution.`,
      );
    }

    const taskId = options.taskContract?.taskId || `task-${randomUUID()}`;
    const roleConfig = getRoleConfig(options.role);
    const repoRoot = await resolveGitRepoRoot(options.parentCwd);

    // 2. 确定初始 TaskContract
    const reworkOfTaskId = options.taskContract?.reworkOfTaskId ?? options.reworkOfTaskId;
    if (reworkOfTaskId) {
      this.validateReworkTarget(options.parentSessionId, taskId, reworkOfTaskId);
    }
    const contract: TaskContract = options.taskContract ?? {
      taskId,
      parentSessionId: options.parentSessionId,
      role: options.role,
      goal: options.taskTitle || options.taskPrompt,
      scope: { include: ["*"], exclude: [] },
      contextFiles: [],
      acceptanceCriteria: ["实现对应需求并通过自测"],
      reworkOfTaskId,
    };
    if (reworkOfTaskId && !contract.reworkOfTaskId) {
      contract.reworkOfTaskId = reworkOfTaskId;
    }

    // 2.1 依赖环路严格检测 (Fail-closed)
    const deps = contract.dependsOn ?? [];
    if (deps.length > 0) {
      this.taskGraph.addTask(taskId, deps);
      const cycle = this.taskGraph.detectCycle();
      if (cycle) {
        this.taskGraph.removeTask(taskId);
        throw new Error(
          `[SubagentManager] Circular dependency detected in task graph: ${cycle.join(" -> ")}. Fail-closed: refusing execution.`,
        );
      }
    }

    // 2.2 确定初始状态：若依赖尚未全部满足，进入 BLOCKED 状态
    const hasDeps = deps.length > 0;
    const depsReady = hasDeps
      ? this.taskGraph.canStart(taskId, (id) => this.isTaskLineageSatisfied(id, options.parentSessionId))
      : true;
    const isRunning = !(hasDeps && !depsReady);
    const now = new Date().toISOString();

    // Logical reusable agent: create on fresh spawn, or attach when continuing.
    let agentId = options.reuseAgentId;
    if (agentId) {
      const existing = this.reusableAgents.get(agentId);
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
      const created = this.reusableAgents.create({
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
    };

    subagentTasks.set(taskId, instance);
    persistTask(task);
    options.onUpdate?.(task);

    // 关键原则：BLOCKED 状态只记录元数据，绝对不得提前创建 Worktree 或 Session
    // 必须等待 dependency lineage satisfied 并 merge 到 integration 后，再基于最新 Integration HEAD 创建 Worktree
    if (task.status === "blocked") {
      return task;
    }

    // 依赖已满足或无依赖，立即启动执行
    await this.startTaskExecution(instance);
    return task;
  }

  /**
   * 真正启动子任务执行（创建 Worktree、初始化 Runtime/Session 并发送提示词）
   */
  private async startTaskExecution(instance: SubagentInstance): Promise<void> {
    const options = instance.spawnOptions;
    if (!options) return;

    const taskId = instance.task.taskId;
    const contract = instance.taskContract;
    const repoRoot = instance.repoRoot ?? (await resolveGitRepoRoot(options.parentCwd));
    instance.repoRoot = repoRoot;

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

    let worktreePath: string | undefined;
    let branchName: string | undefined;
    let baseCommit: string | undefined;

    const effectiveRequiresWorktree =
      options.executionOptions?.requiresWorktree !== undefined
        ? options.executionOptions.requiresWorktree
        : options.requiresWorktree !== undefined
          ? options.requiresWorktree
          : preCheckContext.runtime.requiresWorktree;

    if (effectiveRequiresWorktree) {
      if (!repoRoot) {
        throw new Error(
          `[SubagentManager] Role "${options.role}" requires worktree isolation (requiresWorktree=true), but parent directory "${options.parentCwd}" is not inside a Git repository. Fail-closed: refusing execution in unisolated workspace.`,
        );
      }
      try {
        // 基于当前 Run 的 Integration 分支最新状态创建独立 Worktree 与分支
        const integration = await this.getOrCreateIntegration(options.parentSessionId, repoRoot);
        const wt = await createWorktree(repoRoot, taskId, options.preferredBranch, integration.branch, options.parentSessionId);
        worktreePath = wt.worktreePath;
        branchName = wt.branch;
        baseCommit = wt.baseCommit;
        instance.task.worktreePath = worktreePath;
        instance.task.branchName = branchName;
        instance.baseCommit = baseCommit;
      } catch (err) {
        throw new Error(
          `[SubagentManager] Role "${options.role}" requires worktree isolation, but worktree creation failed for ${taskId}: ${String(err instanceof Error ? err.message : err)}. Fail-closed: refusing fallback to parent cwd.`,
        );
      }
    }

    const baseDir = worktreePath && existsSync(worktreePath) ? worktreePath : options.parentCwd;
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
    const effectiveContext = ConstraintResolver.resolve({
      role: options.role,
      cwd: effectiveCwd,
      projectRoot: repoRoot || undefined,
      isGitRepo: !!repoRoot,
      branchName,
      worktreePath,
      targetCwd: options.targetCwd,
      taskContract: contract,
      executionOptions: options.executionOptions,
      parentModel: options.parentModel
        ? { provider: options.parentModel.provider, modelId: options.parentModel.id }
        : null,
    });

    // 4. 初始化 Task Working Memory & Process Journal
    const memoryPaths = initTaskMemory(
      taskId,
      contract?.goal || options.taskTitle || options.taskPrompt,
    );

    const { runtime, session, resolvedModelDetails } = await createSubagentSessionRuntime({
      taskId,
      role: options.role,
      effectiveCwd,
      effectiveContext,
      modelRuntime: this.modelRuntime,
      parentModel: options.parentModel,
      customSession: options.customSession,
      onReportBlocker: (message, severity, context) => {
        if (options.onReport) {
          const severityTag = severity ? `[${severity.toUpperCase()}] ` : "";
          options.onReport(
            instance.task,
            `[Subagent 报告阻塞] 角色 ${options.role} 上报: ${severityTag}${message}${context ? `\n上下文: ${context}` : ""}`,
          );
        }
      },
    });

    instance.runtime = runtime as any;
    instance.task.model = resolvedModelDetails;
    instance.task.status = "running";

    if (options.executionOptions?.timeoutMs && options.executionOptions.timeoutMs > 0) {
      instance.timeoutTimer = setTimeout(() => {
        console.warn(`[SubagentManager] Task ${taskId} timed out after ${options.executionOptions!.timeoutMs}ms`);
        void this.abort(taskId);
      }, options.executionOptions.timeoutMs);
    }

    persistTask(instance.task);
    options.onUpdate?.(instance.task);

    // 7. 订阅会话事件
    session.subscribe((event: any) => {
      if (event.type === "tool_execution_end") {
        const logLine = `[Tool] ${event.toolName} -> ${event.isError ? "Error" : "Success"}`;
        instance.task.logs?.push(logLine);
        instance.task.messages = serializeMessages(session.messages);
        persistTask(instance.task);
        options.onUpdate?.(instance.task);
      } else if (event.type === "message_end" || event.type === "turn_end") {
        instance.task.messages = serializeMessages(session.messages);
        persistTask(instance.task);
        options.onUpdate?.(instance.task);
      } else if (event.type === "agent_end") {
        instance.task.messages = serializeMessages(session.messages);
        persistTask(instance.task);
        void this.handleSubagentCompletion(taskId);
      }
    });

    // 8. 异步启动提示词（continue 时注入 NEW TASK 边界 + 短 Knowledge，不复用底层 Session）
    let continueBoundary: string | undefined;
    if (options.reuseAgentId) {
      const reusable = this.reusableAgents.get(options.reuseAgentId);
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
      memoryPaths,
      workspaceContext,
    });
    if (continueBoundary) {
      instance.task.taskPrompt = userPrompt;
      persistTask(instance.task);
    }
    session.prompt(userPrompt).catch((err: unknown) => {
      console.error(`[SubagentManager] Subagent ${taskId} error:`, err);
      const errorMsg = String(err instanceof Error ? err.message : err);
      if (instance.timeoutTimer) {
        clearTimeout(instance.timeoutTimer);
        instance.timeoutTimer = undefined;
      }
      if (instance.reported || instance.task.status === "aborted") {
        return;
      }
      if (instance.aborting) {
        queuePendingTerminal(instance, { type: "failed", error: errorMsg });
        return;
      }
      this.finalizeFailed(instance, errorMsg);
    });
  }

  /**
   * 终态处理 Helper：完成状态结算 (completed / conflict)
   */
  private async finalizeCompleted(instance: SubagentInstance) {
    if (instance.reported) return;
    instance.reported = true;
    instance.pendingTerminal = undefined;
    instance.aborting = false;

    if (instance.timeoutTimer) {
      clearTimeout(instance.timeoutTimer);
      instance.timeoutTimer = undefined;
    }

    const task = instance.task;
    task.completedAt = new Date().toISOString();
    task.durationMs = computeDurationMs(task);
    const rawMessages = instance.runtime?.session.messages ?? [];
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
      this.finalizeFailed(instance, task.error);
      return;
    }

    // 2. Runtime 验证
    const changedFiles = task.changedFiles ?? [];
    const contract = instance.taskContract ?? {
      taskId: task.taskId,
      parentSessionId: task.parentSessionId,
      role: task.role,
      goal: task.taskTitle,
    };
    const verification = runVerification(changedFiles, contract, rawMessages, task.logs ?? []);
    task.verification = verification;

    // 3. Worktree 自动合并至当前 Run 的 Integration 分支（不污染主分支）
    if (task.worktreePath && task.branchName && instance.repoRoot) {
      try {
        const integration = await this.getOrCreateIntegration(task.parentSessionId, instance.repoRoot);
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

    // 4. 尝试解析 Reviewer 结构化结果
    let reviewResult: ReviewResult | undefined;
    if (task.role === "reviewer") {
      reviewResult = tryParseReviewResult(lastAssistantText);
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
        this.reusableAgents.markCompleted(task.agentId, task);
      } catch (err) {
        console.warn(`[SubagentManager] Failed to update reusable knowledge for ${task.agentId}:`, err);
      }
    }

      // 6. 检查并自动唤醒下游已就绪任务 (DAG Unblock via Lineage)
    if (task.status === "completed") {
      const unblocked = this.taskGraph.getNewlyReadyTasks((depId) =>
        this.isTaskLineageSatisfied(depId, task.parentSessionId),
      );
      for (const unblockedId of unblocked) {
        await this.startBlockedTask(unblockedId);
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

    persistTask(task);
    instance.onUpdate?.(task);
    instance.onReport?.(task, report.parentReport);
  }

  /**
   * 终态处理 Helper：截断/未完成状态结算 (OUTPUT_TRUNCATED)
   */
  private finalizeIncomplete(instance: SubagentInstance, error: string) {
    if (instance.reported) return;
    instance.reported = true;
    instance.pendingTerminal = undefined;
    instance.aborting = false;

    if (instance.timeoutTimer) {
      clearTimeout(instance.timeoutTimer);
      instance.timeoutTimer = undefined;
    }

    const task = instance.task;
    task.status = "incomplete";
    task.error = error;
    task.completedAt = new Date().toISOString();
    task.durationMs = computeDurationMs(task);
    const rawMessages = instance.runtime?.session?.messages ?? [];
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
    instance.onUpdate?.(task);
    instance.onReport?.(task, report.parentReport);
  }

  /**
   * 终态处理 Helper：失败状态结算
   */
  private finalizeFailed(instance: SubagentInstance, error: string) {
    if (instance.reported) return;
    instance.reported = true;
    instance.pendingTerminal = undefined;
    instance.aborting = false;

    if (instance.timeoutTimer) {
      clearTimeout(instance.timeoutTimer);
      instance.timeoutTimer = undefined;
    }

    const task = instance.task;
    task.status = "failed";
    task.error = error;
    task.completedAt = new Date().toISOString();
    task.durationMs = computeDurationMs(task);
    const rawMessages = instance.runtime?.session.messages ?? [];
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
      this.reusableAgents.markFailed(task.agentId);
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
    instance.onUpdate?.(task);
    instance.onReport?.(task, report.parentReport);
  }

  /**
   * 子智能体运行结束后的处理：提取最终文本产出并向父会话汇报
   */
  public async handleSubagentCompletion(taskId: string) {
    const instance = subagentTasks.get(taskId);
    if (!instance) return;

    if (instance.timeoutTimer) {
      clearTimeout(instance.timeoutTimer);
      instance.timeoutTimer = undefined;
    }

    if (
      instance.reported ||
      instance.task.status === "aborted" ||
      instance.task.status === "failed" ||
      instance.task.status === "interrupted" ||
      instance.task.status === "completed" ||
      instance.task.status === "incomplete" ||
      instance.task.status === "conflict"
    ) {
      persistTask(instance.task);
      return;
    }

    if (instance.aborting) {
      queuePendingTerminal(instance, { type: "completed" });
      return;
    }

    // 检查最新一轮 Assistant 消息的 finishReason
    const rawMessages = instance.runtime?.session?.messages ?? [];
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
        this.finalizeIncomplete(
          instance,
          "Subagent session stopped after intermediate tool work without a final deliverable summary. agent_end does not mean the task succeeded.",
        );
        return;
      }
      await this.finalizeCompleted(instance);
      return;
    }

    if (finishReason === "max_tokens") {
      const currentContinuation = instance.autoContinuationCount ?? 0;
      if (currentContinuation < 1 && instance.runtime?.session) {
        instance.autoContinuationCount = currentContinuation + 1;
        const logLine = `[SubagentManager] Subagent ${taskId} output truncated by max_tokens. Auto-continuing (1/1)...`;
        instance.task.logs?.push(logLine);
        instance.task.messages = serializeMessages(instance.runtime.session.messages);
        persistTask(instance.task);
        instance.onUpdate?.(instance.task);

        const continuationPrompt =
          "上一轮因达到模型输出 Token 上限而被截断。\n\n不要重新进行完整分析。\n从未完成的位置继续。\n优先执行必要工具调用和实际任务。\n控制思考长度，尽快完成任务并给出最终结果。";

        instance.runtime.session.prompt(continuationPrompt).catch((err: unknown) => {
          console.error(`[SubagentManager] Subagent ${taskId} continuation error:`, err);
          this.finalizeIncomplete(
            instance,
            "Subagent output was truncated because the model reached its maximum output token limit. No valid final result was produced.",
          );
        });
        return;
      }

      this.finalizeIncomplete(
        instance,
        "Subagent output was truncated because the model reached its maximum output token limit. No valid final result was produced.",
      );
      return;
    }

    if (finishReason === "cancelled") {
      this.finalizeFailed(instance, "Subagent execution was cancelled or aborted.");
      return;
    }

    if (finishReason === "error") {
      const mutated = hasSuccessfulFileMutation(rawMessages, instance.task.logs);
      if (
        mutated &&
        assistantHasVisibleText(lastAssistantMsg) &&
        !assistantContentHasType(lastAssistantMsg, "toolCall")
      ) {
        await this.finalizeCompleted(instance);
        return;
      }
      this.finalizeFailed(instance, "Subagent encountered an error during execution.");
      return;
    }

    if (finishReason === "tool_call") {
      this.finalizeFailed(
        instance,
        "Subagent session ended unexpectedly while a tool call was still pending.",
      );
      return;
    }

    // Fail-closed for unknown or unmapped finish reasons
    this.finalizeIncomplete(
      instance,
      "Subagent termination reason could not be determined safely.",
    );
  }

  /**
   * 中断指定的 Subagent (标记为 aborted 并主动向 Coordinator 上报)
   */
  public async abort(taskId: string): Promise<boolean> {
    const instance = subagentTasks.get(taskId);
    if (!instance) return false;
    if (instance.timeoutTimer) {
      clearTimeout(instance.timeoutTimer);
      instance.timeoutTimer = undefined;
    }
    if (
      instance.reported ||
      instance.aborting ||
      instance.task.status === "aborted" ||
      instance.task.status === "completed" ||
      instance.task.status === "failed" ||
      instance.task.status === "interrupted"
    ) {
      return false;
    }
    instance.aborting = true;

    try {
      if (instance.runtime) {
        await instance.runtime.session.abort();
      }
      instance.task.status = "aborted";
      instance.task.completedAt = new Date().toISOString();
      instance.task.durationMs = computeDurationMs(instance.task);
      instance.task.summary = "任务已被用户或 Coordinator 主动终止 (aborted)";
      const finalTaskResult: TaskResult = {
        taskId: instance.task.taskId,
        role: instance.task.role,
        status: "aborted",
        summary: instance.task.summary,
        startedAt: instance.task.startedAt,
        completedAt: instance.task.completedAt,
        durationMs: instance.task.durationMs,
      };
      instance.task.taskResult = finalTaskResult;

      const roleConfig = getRoleConfig(instance.task.role);
      const report = buildBoundedCompletionReport({
        taskId: instance.task.taskId,
        taskTitle: instance.task.taskTitle,
        role: instance.task.role,
        roleName: roleConfig.name,
        branch: instance.task.branchName,
        status: "aborted",
        error: "任务已被用户或 Coordinator 主动终止 (aborted)",
        changedFiles: instance.task.changedFiles,
        startedAt: instance.task.startedAt,
        completedAt: instance.task.completedAt,
        durationMs: instance.task.durationMs,
        lastAssistantText: instance.task.summary,
        taskResult: finalTaskResult,
      });

      instance.reported = true;
      instance.aborting = false;
      instance.pendingTerminal = undefined;
      persistTask(instance.task);
      instance.onUpdate?.(instance.task);
      instance.onReport?.(instance.task, report.parentReport);
      return true;
    } catch {
      instance.aborting = false;
      const pending = instance.pendingTerminal;
      instance.pendingTerminal = undefined;

      if (pending) {
        if (pending.type === "failed") {
          this.finalizeFailed(instance, pending.error || "执行异常终止");
        } else if (pending.type === "completed") {
          await this.finalizeCompleted(instance);
        }
      }
      return false;
    }
  }

  /**
   * 删除指定的 Subagent 任务及其磁盘持久化文件，并清理附属 Task Memory (best-effort)
   */
  public async deleteTask(taskId: string): Promise<boolean> {
    const instance = subagentTasks.get(taskId);
    if (instance) {
      if (instance.timeoutTimer) {
        clearTimeout(instance.timeoutTimer);
      }
      if (instance.task.status === "running" && instance.runtime) {
        try {
          await instance.runtime.session.abort();
        } catch {
          /* ignore */
        }
      }
      subagentTasks.delete(taskId);
    }
    let taskDeleted = true;
    try {
      deleteTaskFile(taskId);
    } catch (err) {
      console.warn(`[SubagentManager] Failed to delete task file for ${taskId}:`, err);
      taskDeleted = false;
    }

    // Best-effort cleanup of external task memory directory (~/.pi/agent/task-memories/<taskId>/)
    try {
      removeTaskMemory(taskId);
    } catch (err) {
      console.warn(`[SubagentManager] Unexpected error during memory cleanup for ${taskId}:`, err);
    }

    return taskDeleted;
  }

  /**
   * 清空某主会话下的所有历史 Subagent 任务
   */
  public async clearTasksForParent(parentSessionId: string): Promise<number> {
    let count = 0;
    const taskIds: string[] = [];
    for (const [id, inst] of subagentTasks.entries()) {
      if (inst.task.parentSessionId === parentSessionId) {
        taskIds.push(id);
      }
    }
    for (const id of taskIds) {
      const ok = await this.deleteTask(id);
      if (ok) count++;
    }
    this.reusableAgents.clearForParent(parentSessionId);
    this.finalizedRuns.delete(parentSessionId);
    return count;
  }

  /**
   * 获取某主会话下的所有 Subagent 任务列表
   */
  public getTasksForParent(parentSessionId: string): UISubagentTask[] {
    const list: UISubagentTask[] = [];
    for (const inst of subagentTasks.values()) {
      if (inst.task.parentSessionId === parentSessionId) {
        list.push(inst.task);
      }
    }
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * 终结整轮 Run：将当前 session 的 Integration 结果安全写回用户工作区或正式 commit
   */
  public async finalizeRun(
    parentSessionId: string,
    options?: {
      mode?: FinalizeMode;
      commitMessage?: string;
      cleanup?: boolean;
      _injectSnapshotError?: boolean;
      _injectMutationError?: boolean;
      _injectMutationErrorAtStep?: number;
      _injectRollbackError?: boolean;
      _injectCleanupError?: boolean;
    },
  ): Promise<FinalizeResult> {
    const integration = this.integrations.get(parentSessionId);
    let repoRoot: string | undefined;

    // 门禁检查：所有属于当前 Run 的任务必须全部进入终态（completed, failed, aborted, interrupted, incomplete）
    const nonTerminalStates: TaskExecutionStatus[] = [
      "blocked",
      "ready",
      "running",
      "conflict",
    ];

    const activeTasks: { taskId: string; status: TaskExecutionStatus }[] = [];
    const taskInstances: { worktreePath?: string; branchName?: string }[] = [];
    const sessionTasks: UISubagentTask[] = [];
    for (const inst of subagentTasks.values()) {
      if (inst.task.parentSessionId === parentSessionId) {
        sessionTasks.push(inst.task);
        if (nonTerminalStates.includes(inst.task.status)) {
          activeTasks.push({ taskId: inst.task.taskId, status: inst.task.status });
        }
        if (!repoRoot && inst.repoRoot) {
          repoRoot = inst.repoRoot;
        }
        taskInstances.push({
          worktreePath: inst.task.worktreePath,
          branchName: inst.task.branchName,
        });
      }
    }

    if (activeTasks.length > 0) {
      return {
        success: false,
        status: "ERROR",
        mode: options?.mode || "working_tree",
        changedFiles: [],
        error: `Cannot finalize run: ${activeTasks.length} task(s) are still active or not in terminal state: ${activeTasks.map((t) => `${t.taskId} (${t.status})`).join(", ")}`,
      };
    }

    // 门禁检查 2：质量与返工闭环检查 (Quality & Lineage Gate)
    // 所有任务谱系必须得到满足：不存在未解决的 verification.fail / partially_verified / REQUEST_CHANGES
    const unsatisfiedTasks = sessionTasks.filter((t) => !this.isTaskLineageSatisfied(t.taskId, parentSessionId));
    if (unsatisfiedTasks.length > 0) {
      const details = unsatisfiedTasks
        .map((t) => {
          const ver = t.verification?.overall ?? t.taskResult?.verification?.overall;
          const rev = t.review?.verdict ?? t.taskResult?.review?.verdict;
          return `${t.taskId} (status=${t.status}, verification=${ver ?? "none"}, review=${rev ?? "none"})`;
        })
        .join(", ");
      return {
        success: false,
        status: "ERROR",
        mode: options?.mode || "working_tree",
        changedFiles: [],
        error: `Cannot finalize run: unsatisfied task lineage(s) exist: ${details}. Quality gate requires all tasks to be completed with passing verification/review or be resolved by a successful rework.`,
      };
    }

    if (!integration || !repoRoot) {
      if (this.finalizedRuns.has(parentSessionId)) {
        return this.finalizedRuns.get(parentSessionId)!;
      }
      return {
        success: false,
        status: "ERROR",
        mode: options?.mode || "working_tree",
        changedFiles: [],
        error: "No active integration workspace found for this session.",
      };
    }

    const result = await finalizeRun(repoRoot, integration, options, taskInstances);
    if (result.success) {
      this.finalizedRuns.set(parentSessionId, result);
      if (options?.cleanup !== false) {
        this.integrations.delete(parentSessionId);
      }
    }
    return result;
  }

  /**
   * 启动一个之前因依赖未满足而处于 blocked 状态的任务
   */
  public async startBlockedTask(taskId: string): Promise<boolean> {
    const instance = subagentTasks.get(taskId);
    if (!instance || instance.task.status !== "blocked") return false;

    if (instance.spawnOptions) {
      await this.startTaskExecution(instance);
      return true;
    }

    if (!instance.runtime) return false;

    if (!instance.task.startedAt) {
      instance.task.startedAt = new Date().toISOString();
    }
    instance.task.status = "running";
    persistTask(instance.task);
    instance.onUpdate?.(instance.task);

    const contract = instance.taskContract;
    const userPrompt = buildSubagentUserPrompt(instance.task.taskPrompt, contract, {
      workspaceContext: {
        cwd: instance.task.worktreePath || instance.repoRoot || process.cwd(),
        projectRoot: instance.repoRoot,
        workspaceType: instance.task.worktreePath ? "isolated_worktree" : "main_project",
        gitBranch: instance.task.branchName,
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
      this.finalizeFailed(instance, errorMsg);
    });

    return true;
  }
}

// ---------------------------------------------------------------------------
// Review result parsing helper
// ---------------------------------------------------------------------------

/**
 * Best-effort parse structured ReviewResult from reviewer's last assistant message.
 * Looks for JSON blocks containing verdict and findings.
 */
function tryParseReviewResult(text: string): ReviewResult | undefined {
  // Try to find a JSON block with review structure
  const jsonMatch = text.match(/```(?:json)?\s*\n(\{[\s\S]*?"verdict"[\s\S]*?\})\s*\n```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.verdict && (parsed.verdict === "APPROVE" || parsed.verdict === "REQUEST_CHANGES")) {
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
            }))
          : [];

        const onlyMinorFindings =
          findings.length === 0 ||
          findings.every((f) => f.severity === "minor" || f.severity === "nit");

        // Principle: minor / nit must not block tasks or cause endless rework loops
        const effectiveVerdict =
          onlyMinorFindings && parsed.verdict === "REQUEST_CHANGES"
            ? "APPROVE"
            : parsed.verdict;

        return {
          verdict: effectiveVerdict,
          findings,
          onlyMinorFindings,
        };
      }
    } catch {
      /* parse failure is expected for non-structured output */
    }
  }

  // Fallback: detect simple APPROVE/REQUEST_CHANGES keywords
  if (/\bAPPROVE\b/.test(text) && !/\bREQUEST_CHANGES\b/.test(text)) {
    return { verdict: "APPROVE", findings: [], onlyMinorFindings: true };
  }

  return undefined;
}

function validateSeverity(val: unknown): ReviewSeverity | undefined {
  const valid: ReviewSeverity[] = ["blocker", "major", "minor", "nit"];
  return typeof val === "string" && valid.includes(val as ReviewSeverity)
    ? (val as ReviewSeverity)
    : undefined;
}
