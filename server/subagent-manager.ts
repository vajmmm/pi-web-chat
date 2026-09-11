import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { UISubagentTask } from "../shared/protocol.ts";
import {
  type TaskExecutionStatus,
  type WorkspaceContextDetails,
} from "./contracts/index.ts";
import { CoordinatorStateTracker } from "./coordinator/coordinator-state.ts";
import { isPendingDeletion } from "./session/deletion-tombstone.ts";
import {
  isTaskExecutionSatisfied,
  isTaskLineageSatisfied,
  TaskGraph,
} from "./task-graph.ts";
import {
  getOrCreateIntegrationWorkspace,
  type CleanupResult,
  type FinalizeMode,
  type FinalizeResult,
  type IntegrationWorkspace,
  type QuiescenceResult,
} from "./worktree.ts";
import {
  ReusableSubagentRegistry,
  toReusableAgentListItem,
  type ReusableAgentListItem,
  type ReusableSubagent,
} from "./reusable-subagent.ts";
import {
  buildSubagentUserPrompt,
  loadPersistedTasks,
  subagentTasks,
  type ContinueSubagentOptions,
  type SpawnSubagentOptions,
  type SubagentInstance,
} from "./subagent/index.ts";
import type { AbortSource, SubagentManagerHost } from "./subagent/manager-host.ts";
import {
  abortSessionAndQuiesceTools,
  clearActiveTool,
  disposeRuntime,
  getSerializableMessages,
  isTerminalLocked,
  listActiveToolNames,
  notifyUpdate,
  registerActiveTool,
} from "./subagent/runtime-control.ts";
import {
  continueAgent as continueAgentLifecycle,
  spawn as spawnLifecycle,
  startBlockedTask as startBlockedTaskLifecycle,
  startTaskExecution as startTaskExecutionLifecycle,
} from "./subagent/task-lifecycle.ts";
import {
  executeSubagentCompletion as executeSubagentCompletionLifecycle,
  finalizeCompleted as finalizeCompletedLifecycle,
  finalizeFailed as finalizeFailedLifecycle,
  finalizeIncomplete as finalizeIncompleteLifecycle,
  handleSubagentCompletion as handleSubagentCompletionLifecycle,
} from "./subagent/task-terminal.ts";
import {
  abort as abortLifecycle,
  cleanupRunResourcesForParent as cleanupRunResourcesForParentLifecycle,
  clearTasksForParent as clearTasksForParentLifecycle,
  deleteTask as deleteTaskLifecycle,
  disposeSubagentRuntimesForParent as disposeSubagentRuntimesForParentLifecycle,
  finalizeRun as finalizeRunLifecycle,
  finishRunDeletion as finishRunDeletionLifecycle,
  prepareRunForDeletion as prepareRunForDeletionLifecycle,
  purgeSubagentMetadataForParent as purgeSubagentMetadataForParentLifecycle,
  retryInitializationCleanup as retryInitializationCleanupLifecycle,
  tryAutoFinalizeRun as tryAutoFinalizeRunLifecycle,
} from "./subagent/run-lifecycle.ts";

export {
  buildSubagentUserPrompt,
  subagentTasks,
  type ContinueSubagentOptions,
  type SpawnSubagentOptions,
  type WorkspaceContextDetails,
};

export {
  captureWorkspaceBaseline,
  computeFileContentHash,
  detectWorkspaceMutations,
  parsePorcelainLine,
  type FileBaselineEntry,
  type FileHashResult,
  type WorkspaceBaseline,
  type WorkspaceMutationResult,
} from "./subagent/workspace-baseline.ts";

export { tryParseReviewResult } from "./subagent/review-result.ts";

export class SubagentManager implements SubagentManagerHost {
  modelRuntime: ModelRuntime;
  readonly taskGraph = new TaskGraph();
  readonly reusableAgents = new ReusableSubagentRegistry();
  private readonly coordinatorState = new CoordinatorStateTracker();
  integrations = new Map<string, IntegrationWorkspace>();
  finalizedRuns = new Map<string, FinalizeResult>();
  finalizingRuns = new Set<string>();
  finalizingRunPromises = new Map<string, Promise<FinalizeResult | null>>();
  deletingRuns = new Set<string>();
  inFlightTaskStarts = new Map<string, Set<Promise<void>>>();
  inFlightCompletions = new Map<string, Set<Promise<void>>>();
  autoFinalize: boolean = true;

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

  notifyUpdate(instance: SubagentInstance): void {
    notifyUpdate(instance);
  }

  getSerializableMessages(instance: SubagentInstance, interruptionReason?: string): any[] {
    return getSerializableMessages(instance, interruptionReason);
  }

  isTerminalLocked(instance: SubagentInstance): boolean {
    return isTerminalLocked(instance);
  }

  registerActiveTool(
    instance: SubagentInstance,
    event: { toolCallId?: string; toolName?: string; args?: unknown },
  ): void {
    registerActiveTool(instance, event);
  }

  clearActiveTool(instance: SubagentInstance, toolCallId?: string): void {
    clearActiveTool(instance, toolCallId);
  }

  listActiveToolNames(instance: SubagentInstance): string[] {
    return listActiveToolNames(instance);
  }

  async abortSessionAndQuiesceTools(instance: SubagentInstance, reason: string): Promise<void> {
    return abortSessionAndQuiesceTools(instance, reason);
  }

  async disposeRuntime(instance: SubagentInstance, reason: string): Promise<void> {
    return disposeRuntime(instance, reason);
  }

  public markRunDeleting(parentSessionId: string): void {
    this.deletingRuns.add(parentSessionId);
  }

  public isRunDeleting(parentSessionId: string): boolean {
    return this.deletingRuns.has(parentSessionId) || isPendingDeletion(parentSessionId);
  }

  public isDeleting(parentSessionId: string): boolean {
    return this.isRunDeleting(parentSessionId);
  }

  /**
   * 将任务的异步创建 / 初始化过程纳入 Run 的生命周期追踪，保证 Run Quiescence 能等待所有 in-flight start
   */
  public async trackInFlightStart<T>(parentSessionId: string, action: () => Promise<T>): Promise<T> {
    if (this.deletingRuns.has(parentSessionId)) {
      throw new Error(
        `[SubagentManager] Cannot start task for session ${parentSessionId}: session is being deleted (lifecycle gate locked).`,
      );
    }
    let set = this.inFlightTaskStarts.get(parentSessionId);
    if (!set) {
      set = new Set();
      this.inFlightTaskStarts.set(parentSessionId, set);
    }
    let resolveTrack!: () => void;
    const trackPromise = new Promise<void>((resolve) => {
      resolveTrack = resolve;
    });
    set.add(trackPromise);
    try {
      return await action();
    } finally {
      resolveTrack();
      set.delete(trackPromise);
      if (set.size === 0) {
        this.inFlightTaskStarts.delete(parentSessionId);
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

  public hasActiveTasksForParent(parentSessionId: string): boolean {
    const activeStates: TaskExecutionStatus[] = ["ready", "running", "blocked"];
    for (const inst of subagentTasks.values()) {
      if (inst.task.parentSessionId === parentSessionId) {
        if (activeStates.includes(inst.task.status) || Boolean(inst.runtime?.session?.isStreaming)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * All parent session ids that currently own active work of any kind:
   * non-terminal subagent tasks, streaming subagent runtimes, or an in-flight
   * coordinator turn. Used by the session list to render a "busy" indicator.
   */
  public getActiveParentSessionIds(): string[] {
    const activeStates: TaskExecutionStatus[] = ["ready", "running", "blocked"];
    const ids = new Set<string>();
    for (const inst of subagentTasks.values()) {
      if (
        activeStates.includes(inst.task.status) ||
        Boolean(inst.runtime?.session?.isStreaming)
      ) {
        ids.add(inst.task.parentSessionId);
      }
    }
    for (const sessionId of this.coordinatorState.activeSessionIds()) {
      ids.add(sessionId);
    }
    return Array.from(ids);
  }

  public isRunFinalized(parentSessionId: string): boolean {
    return this.finalizedRuns.has(parentSessionId);
  }

  public getFinalizeResult(parentSessionId: string): FinalizeResult | undefined {
    return this.finalizedRuns.get(parentSessionId);
  }

  public getCoordinatorState(parentSessionId: string): { isExecuting: boolean } {
    return this.coordinatorState.getState(parentSessionId);
  }

  public isCoordinatorActive(parentSessionId: string): boolean {
    return this.coordinatorState.isActive(parentSessionId);
  }

  public notifyCoordinatorTurnStart(parentSessionId: string): void {
    this.coordinatorState.turnStarted(parentSessionId);
  }

  public notifyCoordinatorTurnEnd(parentSessionId: string): void {
    this.coordinatorState.turnEnded(parentSessionId);
  }

  public clearCoordinatorState(parentSessionId: string): void {
    this.coordinatorState.clear(parentSessionId);
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

  public async tryAutoFinalizeRun(parentSessionId: string): Promise<FinalizeResult | null> {
    return tryAutoFinalizeRunLifecycle(this, parentSessionId);
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
   * 获取当前 Session/Run 已激活的 Integration 工作区（若已创建）
   */
  public getIntegration(parentSessionId: string): IntegrationWorkspace | undefined {
    return this.integrations.get(parentSessionId);
  }

  public async continueAgent(options: ContinueSubagentOptions): Promise<UISubagentTask> {
    return continueAgentLifecycle(this, options);
  }

  public async spawn(options: SpawnSubagentOptions): Promise<UISubagentTask> {
    return spawnLifecycle(this, options);
  }

  async startTaskExecution(instance: SubagentInstance): Promise<void> {
    return startTaskExecutionLifecycle(this, instance);
  }

  async finalizeCompleted(instance: SubagentInstance): Promise<void> {
    return finalizeCompletedLifecycle(this, instance);
  }

  async finalizeIncomplete(instance: SubagentInstance, error: string): Promise<void> {
    return finalizeIncompleteLifecycle(this, instance, error);
  }

  async finalizeFailed(instance: SubagentInstance, error: string): Promise<void> {
    return finalizeFailedLifecycle(this, instance, error);
  }

  public async handleSubagentCompletion(taskId: string): Promise<void> {
    return handleSubagentCompletionLifecycle(this, taskId);
  }

  async executeSubagentCompletion(instance: SubagentInstance): Promise<void> {
    return executeSubagentCompletionLifecycle(this, instance);
  }

  public async abort(taskId: string, options?: { source?: AbortSource }): Promise<boolean> {
    return abortLifecycle(this, taskId, options);
  }

  public async retryInitializationCleanup(instance: SubagentInstance): Promise<boolean> {
    return retryInitializationCleanupLifecycle(this, instance);
  }

  public async deleteTask(taskId: string): Promise<boolean> {
    return deleteTaskLifecycle(this, taskId);
  }

  public async disposeSubagentRuntimesForParent(parentSessionId: string): Promise<boolean> {
    return disposeSubagentRuntimesForParentLifecycle(this, parentSessionId);
  }

  public async purgeSubagentMetadataForParent(parentSessionId: string): Promise<boolean> {
    return purgeSubagentMetadataForParentLifecycle(this, parentSessionId);
  }

  public async prepareRunForDeletion(parentSessionId: string, timeoutMs = 5000): Promise<QuiescenceResult> {
    return prepareRunForDeletionLifecycle(this, parentSessionId, timeoutMs);
  }

  public finishRunDeletion(parentSessionId: string): void {
    finishRunDeletionLifecycle(this, parentSessionId);
  }

  public async cleanupRunResourcesForParent(
    parentSessionId: string,
    repoRootHint?: string,
  ): Promise<CleanupResult | undefined> {
    return cleanupRunResourcesForParentLifecycle(this, parentSessionId, repoRootHint);
  }

  public async clearTasksForParent(parentSessionId: string): Promise<number> {
    return clearTasksForParentLifecycle(this, parentSessionId);
  }

  public getTasksForParent(parentSessionId: string): UISubagentTask[] {
    const list: UISubagentTask[] = [];
    for (const inst of subagentTasks.values()) {
      if (inst.task.parentSessionId === parentSessionId) {
        list.push(inst.task);
      }
    }
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

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
    return finalizeRunLifecycle(this, parentSessionId, options);
  }

  public async startBlockedTask(taskId: string): Promise<boolean> {
    return startBlockedTaskLifecycle(this, taskId);
  }
}
