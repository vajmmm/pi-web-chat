import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentRole, UISubagentTask } from "../shared/protocol.ts";
import {
  CANONICAL_ROLES,
  ConstraintResolver,
  formatWorkspaceContext,
  getAllRoleDefinitions,
  isCanonicalRole,
  isPathContained,
  resolveWorkspaceMode,
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
import { runGit } from "./git/git.ts";
import { getRoleConfig } from "./roles.ts";
import { resolveExpectedEffects, runVerification } from "./runtime-verifier.ts";
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
import { findRepoRootForWorktree } from "./git/runtime-resources.ts";
import {
  cleanupRunResources,
  commitWorktreeChanges,
  createWorktree,
  finalizeRun,
  getOrCreateIntegrationWorkspace,
  getWorktreeDiff,
  loadPersistedRuntimeResources,
  mergeTaskToIntegration,
  mergeWorktreeBranch,
  removeWorktree,
  resolveGitRepoRoot,
  resolveProjectRoot,
  tryMergeWorktree,
  unregisterRuntimeResource,
  type CleanupResult,
  type FinalizeMode,
  type FinalizeResult,
  type IntegrationWorkspace,
  type QuiescenceResult,
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
import { isPendingDeletion } from "./session/deletion-tombstone.ts";
import { deleteSessionTurns } from "./turn-recorder.ts";
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

type AbortSource = "coordinator" | "user" | "timeout" | "system";

export {
  buildSubagentUserPrompt,
  subagentTasks,
  type ContinueSubagentOptions,
  type SpawnSubagentOptions,
  type WorkspaceContextDetails,
};

export interface FileBaselineEntry {
  path: string;
  status: string;
  hash?: string;
  exists: boolean;
}

export interface WorkspaceBaseline {
  ok: boolean;
  cwd: string;
  files: Map<string, FileBaselineEntry>;
  error?: string;
}

export interface WorkspaceMutationResult {
  ok: boolean;
  mutatedFiles: string[];
  error?: string;
}

export interface FileHashResult {
  ok: boolean;
  exists: boolean;
  hash?: string;
  error?: string;
}

export function computeFileContentHash(absPath: string): FileHashResult {
  try {
    if (!existsSync(absPath)) {
      return { ok: true, exists: false };
    }
    const buf = readFileSync(absPath);
    const hash = createHash("sha256").update(buf).digest("hex");
    return { ok: true, exists: true, hash };
  } catch (err) {
    return {
      ok: false,
      exists: true,
      error: `Failed to read file for hash computation: ${String(err instanceof Error ? err.message : err)}`,
    };
  }
}

export function parsePorcelainLine(rawLine: string): { status: string; filePath: string } | null {
  const line = rawLine.trimEnd();
  if (!line) return null;
  let status: string;
  let filePath: string;
  if (line.length >= 3 && line[2] === " ") {
    status = line.slice(0, 2);
    filePath = line.slice(3).trim();
  } else if (line.length >= 2 && line[1] === " ") {
    // 兼容首行被 stdout.trim() 剥离前导空格的情况（例如 " M path" 变为 "M path"）
    status = " " + line[0];
    filePath = line.slice(2).trim();
  } else {
    return null;
  }
  return { status, filePath };
}

export async function captureWorkspaceBaseline(cwd: string): Promise<WorkspaceBaseline> {
  try {
    const statusOut = await runGit(cwd, ["status", "--porcelain=v1", "-uall"]);
    const files = new Map<string, FileBaselineEntry>();
    if (statusOut) {
      for (const rawLine of statusOut.split("\n")) {
        const parsed = parsePorcelainLine(rawLine);
        if (!parsed) continue;
        const { status, filePath } = parsed;
        const absPath = join(cwd, filePath);
        const hashRes = computeFileContentHash(absPath);
        if (!hashRes.ok) {
          return {
            ok: false,
            cwd,
            files: new Map(),
            error: `Failed to compute hash for ${filePath}: ${hashRes.error}`,
          };
        }
        files.set(filePath, {
          path: filePath,
          status,
          hash: hashRes.hash,
          exists: hashRes.exists,
        });
      }
    }
    return { ok: true, cwd, files };
  } catch (err) {
    return {
      ok: false,
      cwd,
      files: new Map(),
      error: `Failed to capture workspace baseline: ${String(err instanceof Error ? err.message : err)}`,
    };
  }
}

export async function detectWorkspaceMutations(
  cwd: string,
  baseline: WorkspaceBaseline,
): Promise<WorkspaceMutationResult> {
  // Fail-closed: 若 baseline 采集失败，严禁 fail-open
  if (!baseline.ok) {
    return {
      ok: false,
      mutatedFiles: [],
      error: baseline.error || "Baseline capture failed or was unavailable",
    };
  }

  try {
    const currentStatusOut = await runGit(cwd, ["status", "--porcelain=v1", "-uall"]);
    const currentFiles = new Map<string, FileBaselineEntry>();
    if (currentStatusOut) {
      for (const rawLine of currentStatusOut.split("\n")) {
        const parsed = parsePorcelainLine(rawLine);
        if (!parsed) continue;
        const { status, filePath } = parsed;
        const absPath = join(cwd, filePath);
        const hashRes = computeFileContentHash(absPath);
        if (!hashRes.ok) {
          return {
            ok: false,
            mutatedFiles: [],
            error: `Failed to compute hash for ${filePath}: ${hashRes.error}`,
          };
        }
        currentFiles.set(filePath, {
          path: filePath,
          status,
          hash: hashRes.hash,
          exists: hashRes.exists,
        });
      }
    }

    const mutatedFiles: string[] = [];

    // 1. 对比当前 status 中新增或状态变更的文件
    for (const [file, currentEntry] of currentFiles.entries()) {
      const baseEntry = baseline.files.get(file);
      if (!baseEntry) {
        // 新增的未跟踪或已修改文件
        mutatedFiles.push(file);
      } else if (baseEntry.status !== currentEntry.status) {
        // 状态码发生变更 (例如未暂存变为已暂存，或未跟踪变为已跟踪)
        mutatedFiles.push(file);
      } else {
        // 状态码完全一致 (例如都为 " M" 或都为 "??" )：基于内容 SHA-256 判断内容是否被进一步修改
        if (baseEntry.hash !== currentEntry.hash) {
          mutatedFiles.push(file);
        }
      }
    }

    // 2. 对比 baseline 中原本修改但在当前 status 中消失的文件 (例如被恢复、删除或提交)
    for (const [file] of baseline.files.entries()) {
      if (!currentFiles.has(file)) {
        mutatedFiles.push(file);
      }
    }

    return {
      ok: true,
      mutatedFiles: Array.from(new Set(mutatedFiles)),
    };
  } catch (err) {
    // Fail-closed: git 异常绝不返回空数组 []
    return {
      ok: false,
      mutatedFiles: [],
      error: `Failed to detect workspace mutations: ${String(err instanceof Error ? err.message : err)}`,
    };
  }
}

import { CoordinatorStateTracker } from "./coordinator/coordinator-state.ts";

export class SubagentManager {
  private modelRuntime: ModelRuntime;
  public readonly taskGraph = new TaskGraph();
  public readonly reusableAgents = new ReusableSubagentRegistry();
  private readonly coordinatorState = new CoordinatorStateTracker();
  private integrations = new Map<string, IntegrationWorkspace>();
  private finalizedRuns = new Map<string, FinalizeResult>();
  private finalizingRuns = new Set<string>();
  private finalizingRunPromises = new Map<string, Promise<FinalizeResult | null>>();
  private deletingRuns = new Set<string>();
  private inFlightTaskStarts = new Map<string, Set<Promise<void>>>();
  private inFlightCompletions = new Map<string, Set<Promise<void>>>();
  public autoFinalize: boolean = true;

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

  /**
   * 自动检查当前会话的所有子任务生命周期与质量 Gate。
   * 调度触发点为会话 agent_end（Coordinator 空闲且消息队列全空时触发）。
   * 本方法作为底层防御性 Gate，严格校验：
   * 1. Coordinator 非执行态 (isCoordinatorActive === false)；
   * 2. 无正在执行中的 finalize (finalizingRuns in-flight lock)；
   * 3. 对应 Session 的 Integration 工作区已初始化；
   * 4. 该会话所有任务 Lineage 叶子节点均满足通过标准且无运行中/返工中任务。
   * 当且仅当所有 Gate 校验全部通过时，自动将 Integration 工作区改动写回用户工作区。
   */
  public async tryAutoFinalizeRun(parentSessionId: string): Promise<FinalizeResult | null> {
    if (this.deletingRuns.has(parentSessionId)) {
      return null;
    }
    if (this.isCoordinatorActive(parentSessionId)) {
      return null;
    }

    if (this.finalizingRuns.has(parentSessionId)) {
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

    this.finalizingRuns.add(parentSessionId);
    const finalizePromise = this.finalizeRun(parentSessionId, { mode: "working_tree" });
    this.finalizingRunPromises.set(parentSessionId, finalizePromise);
    try {
      return await finalizePromise;
    } catch (err) {
      console.warn(`[SubagentManager] Auto finalizeRun failed for session ${parentSessionId}:`, err);
      return null;
    } finally {
      this.finalizingRuns.delete(parentSessionId);
      this.finalizingRunPromises.delete(parentSessionId);
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
   * 获取当前 Session/Run 已激活的 Integration 工作区（若已创建）
   */
  public getIntegration(parentSessionId: string): IntegrationWorkspace | undefined {
    return this.integrations.get(parentSessionId);
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
    if (this.deletingRuns.has(options.parentSessionId)) {
      throw new Error(
        `[SubagentManager] Cannot continue subagent for session ${options.parentSessionId}: session is being deleted (lifecycle gate locked).`,
      );
    }

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
    return this.trackInFlightStart(options.parentSessionId, async () => {
      // 0. Deletion gate check (Fail-closed)
      if (this.deletingRuns.has(options.parentSessionId)) {
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
    });
  }

  /**
   * 真正启动子任务执行（创建 Worktree、初始化 Runtime/Session 并发送提示词）
   */
  private async startTaskExecution(instance: SubagentInstance): Promise<void> {
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
      if (this.deletingRuns.has(options.parentSessionId) || instance.task.status === "aborted") {
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
          options.onUpdate?.(instance.task);
          return true;
        }

        instance.initializationCleanupError = undefined;
        instance.task.status = "aborted";
        instance.task.summary = "Parent session was deleted during task initialization";
        persistTask(instance.task);
        options.onUpdate?.(instance.task);
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
        const integration = await this.getOrCreateIntegration(options.parentSessionId, repoRoot);
        const wt = await createWorktree(repoRoot, taskId, options.preferredBranch, integration.branch, options.parentSessionId);
        worktreePath = wt.worktreePath;
        branchName = wt.branch;
        baseCommit = wt.baseCommit;
        instance.task.worktreePath = worktreePath;
        instance.task.branchName = branchName;
        instance.baseCommit = baseCommit;
        baseDir = worktreePath;
      } catch (err) {
        throw new Error(
          `[SubagentManager] Role "${options.role}" requires worktree isolation, but worktree creation failed for ${taskId}: ${String(err instanceof Error ? err.message : err)}. Fail-closed: refusing fallback to parent cwd.`,
        );
      }
    } else if (wsMode === "integration") {
      // Verifier: 直接复用当前 Session 的 Integration 工作区，不创建独立 branch/worktree，不参与 commit/merge
      if (repoRoot) {
        const integration = await this.getOrCreateIntegration(options.parentSessionId, repoRoot);
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

    const subagentSession = await createSubagentSessionRuntime({
      taskId,
      role: options.role,
      effectiveCwd,
      effectiveContext,
      modelRuntime: this.modelRuntime,
      parentModel: options.parentModel,
      customSession: options.customSession,
      onReportBlocker: (message, severity, context) => {
        if (options.onReport && !this.deletingRuns.has(options.parentSessionId)) {
          const severityTag = severity ? `[${severity.toUpperCase()}] ` : "";
          options.onReport(
            instance.task,
            `[Subagent 报告阻塞] 角色 ${options.role} 上报: ${severityTag}${message}${context ? `\n上下文: ${context}` : ""}`,
            { kind: "blocker" },
          );
        }
      },
    });

    runtime = subagentSession.runtime;
    const { session, resolvedModelDetails } = subagentSession;

    if (await abortAndCleanupIfDeleted()) return;

    instance.runtime = runtime as any;
    instance.task.model = resolvedModelDetails;
    instance.task.status = "running";

    if (options.executionOptions?.timeoutMs && options.executionOptions.timeoutMs > 0) {
      instance.timeoutTimer = setTimeout(() => {
        console.warn(`[SubagentManager] Task ${taskId} timed out after ${options.executionOptions!.timeoutMs}ms`);
        void this.abort(taskId, { source: "timeout" });
      }, options.executionOptions.timeoutMs);
      instance.timeoutTimer.unref?.();
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

    if (await abortAndCleanupIfDeleted()) return;

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
      void this.finalizeFailed(instance, errorMsg);
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
      await this.finalizeFailed(instance, task.error);
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
        this.reusableAgents.markCompleted(task.agentId, task);
      } catch (err) {
        console.warn(`[SubagentManager] Failed to update reusable knowledge for ${task.agentId}:`, err);
      }
    }

    // 6. 检查并自动唤醒下游已就绪任务 (DAG Unblock via Lineage)
    if (task.status === "completed" && !this.deletingRuns.has(task.parentSessionId)) {
      const unblocked = this.taskGraph.getNewlyReadyTasks((depId) =>
        this.isTaskLineageSatisfied(depId, task.parentSessionId),
      );
      for (const unblockedId of unblocked) {
        if (!this.deletingRuns.has(task.parentSessionId)) {
          await this.startBlockedTask(unblockedId);
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

    persistTask(task);
    instance.onUpdate?.(task);
    if (!this.deletingRuns.has(task.parentSessionId)) {
      await Promise.resolve(instance.onReport?.(task, report.parentReport, { kind: "terminal" }));
    }
  }

  /**
   * 终态处理 Helper：截断/未完成状态结算 (OUTPUT_TRUNCATED)
   */
  private async finalizeIncomplete(instance: SubagentInstance, error: string) {
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
    if (!this.deletingRuns.has(task.parentSessionId)) {
      await Promise.resolve(instance.onReport?.(task, report.parentReport, { kind: "terminal" }));
    }
  }

  /**
   * 终态处理 Helper：失败状态结算
   */
  private async finalizeFailed(instance: SubagentInstance, error: string) {
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
    if (!this.deletingRuns.has(task.parentSessionId)) {
      await Promise.resolve(instance.onReport?.(task, report.parentReport, { kind: "terminal" }));
    }
  }

  /**
   * 子智能体运行结束后的处理：提取最终文本产出并向父会话汇报
   */
  public async handleSubagentCompletion(taskId: string): Promise<void> {
    const instance = subagentTasks.get(taskId);
    if (!instance) return;

    const parentSessionId = instance.task.parentSessionId;
    if (this.deletingRuns.has(parentSessionId) || isPendingDeletion(parentSessionId)) {
      await this.finalizeIncomplete(instance, "Subagent execution cancelled due to parent session deletion.");
      return;
    }

    let completions = this.inFlightCompletions.get(parentSessionId);
    if (!completions) {
      completions = new Set();
      this.inFlightCompletions.set(parentSessionId, completions);
    }

    const p = this.executeSubagentCompletion(instance).finally(() => {
      completions?.delete(p);
      if (completions?.size === 0) {
        this.inFlightCompletions.delete(parentSessionId);
      }
    });
    completions.add(p);
    return p;
  }

  private async executeSubagentCompletion(instance: SubagentInstance): Promise<void> {
    const taskId = instance.task.taskId;
    const parentSessionId = instance.task.parentSessionId;

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
        await this.finalizeIncomplete(
          instance,
          "Subagent session stopped after intermediate tool work without a final deliverable summary. agent_end does not mean the task succeeded.",
        );
        return;
      }
      await this.finalizeCompleted(instance);
      return;
    }

    if (finishReason === "max_tokens") {
      if (this.deletingRuns.has(parentSessionId) || isPendingDeletion(parentSessionId)) {
        await this.finalizeIncomplete(
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
        instance.task.messages = serializeMessages(instance.runtime.session.messages);
        persistTask(instance.task);
        instance.onUpdate?.(instance.task);

        const continuationPrompt =
          "上一轮因达到模型输出 Token 上限而被截断。\n\n不要重新进行完整分析。\n从未完成的位置继续。\n优先执行必要工具调用和实际任务。\n控制思考长度，尽快完成任务并给出最终结果。";

        instance.runtime.session.prompt(continuationPrompt).catch((err: unknown) => {
          console.error(`[SubagentManager] Subagent ${taskId} continuation error:`, err);
          void this.finalizeIncomplete(
            instance,
            "Subagent output was truncated because the model reached its maximum output token limit. No valid final result was produced.",
          );
        });
        return;
      }

      await this.finalizeIncomplete(
        instance,
        "Subagent output was truncated because the model reached its maximum output token limit. No valid final result was produced.",
      );
      return;
    }

    if (finishReason === "cancelled") {
      await this.finalizeFailed(instance, "Subagent execution was cancelled or aborted.");
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
      await this.finalizeFailed(instance, "Subagent encountered an error during execution.");
      return;
    }

    if (finishReason === "tool_call") {
      await this.finalizeFailed(
        instance,
        "Subagent session ended unexpectedly while a tool call was still pending.",
      );
      return;
    }

    // Fail-closed for unknown or unmapped finish reasons
    await this.finalizeIncomplete(
      instance,
      "Subagent termination reason could not be determined safely.",
    );
  }

  /**
   * 中断指定的 Subagent (标记为 aborted，若非主动放弃则向 Coordinator 上报)
   */
  public async abort(taskId: string, options?: { source?: AbortSource }): Promise<boolean> {
    const instance = subagentTasks.get(taskId);
    if (!instance) return false;

    // 若存在初始化清理错误，abort 调用自动重试清理
    if (instance.initializationCleanupError) {
      return await this.retryInitializationCleanup(instance);
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
    const source = options?.source ?? "system";
    const isSilent = source === "coordinator" || source === "user";
    let abortReason = "任务已被用户或 Coordinator 主动终止 (aborted)";
    if (source === "timeout") {
      abortReason = "子任务执行超时并被终止";
    } else if (source === "system") {
      abortReason = "子任务因系统原因被终止";
    }

    try {
      if (instance.runtime) {
        await instance.runtime.session.abort();
      }
      if (instance.timeoutTimer) {
        clearTimeout(instance.timeoutTimer);
        instance.timeoutTimer = undefined;
      }
      instance.task.status = "aborted";
      instance.task.completedAt = new Date().toISOString();
      instance.task.durationMs = computeDurationMs(instance.task);
      instance.task.summary = abortReason;
      const finalTaskResult: TaskResult = {
        taskId: instance.task.taskId,
        role: instance.task.role,
        status: "aborted",
        summary: abortReason,
        startedAt: instance.task.startedAt,
        completedAt: instance.task.completedAt,
        durationMs: instance.task.durationMs,
        meta: { error: abortReason },
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
        error: abortReason,
        changedFiles: instance.task.changedFiles,
        startedAt: instance.task.startedAt,
        completedAt: instance.task.completedAt,
        durationMs: instance.task.durationMs,
        lastAssistantText: abortReason,
        taskResult: finalTaskResult,
      });

      instance.reported = true;
      instance.aborting = false;
      instance.pendingTerminal = undefined;
      persistTask(instance.task);
      instance.onUpdate?.(instance.task);
      if (!isSilent && !this.deletingRuns.has(instance.task.parentSessionId)) {
        await Promise.resolve(
          instance.onReport?.(instance.task, report.parentReport, { kind: "terminal" }),
        );
      }
      return true;
    } catch {
      instance.aborting = false;
      const pending = instance.pendingTerminal;
      instance.pendingTerminal = undefined;

      if (pending) {
        if (pending.type === "failed") {
          await this.finalizeFailed(instance, pending.error || "执行异常终止");
        } else if (pending.type === "completed") {
          await this.finalizeCompleted(instance);
        }
      }
      return false;
    }
  }

  /**
   * 重试清理在初始化阶段因异常残留的运行时与 Git 资源 (Idempotent & Fail-Closed)
   * 仅当所有残留资源（Runtime、Worktree、Branch）全部确认清理成功后，
   * 才清除 initializationCleanupError 并将 task.status 标为 "aborted"。
   */
  public async retryInitializationCleanup(instance: SubagentInstance): Promise<boolean> {
    const parentSessionId = instance.task.parentSessionId;
    const taskId = instance.task.taskId;
    const repoRoot =
      instance.repoRoot ||
      (await resolveGitRepoRoot(instance.spawnOptions?.parentCwd || process.cwd()));
    const remainingErrors: string[] = [];

    // 1. 若 runtime 存在，先尝试 abort (若处于 streaming)，再 dispose
    if (instance.runtime) {
      if (instance.runtime.session?.isStreaming) {
        try {
          await instance.runtime.session.abort();
        } catch {
          /* best effort */
        }
      }
      try {
        await instance.runtime.dispose();
        instance.runtime = undefined;
      } catch (err) {
        const msg = `Failed to dispose subagent session runtime during retry cleanup for ${taskId}: ${String(err instanceof Error ? err.message : err)}`;
        console.warn(`[SubagentManager] ${msg}`);
        remainingErrors.push(msg);
      }
    }

    // 2. 若 task.worktreePath 存在，尝试 removeWorktree
    if (instance.task.worktreePath && repoRoot) {
      try {
        await removeWorktree(repoRoot, instance.task.worktreePath);
        unregisterRuntimeResource(parentSessionId, "task_worktree", instance.task.worktreePath, repoRoot);
        instance.task.worktreePath = undefined;
      } catch (err) {
        const msg = `Failed to remove worktree ${instance.task.worktreePath} during retry cleanup for ${taskId}: ${String(err instanceof Error ? err.message : err)}`;
        console.warn(`[SubagentManager] ${msg}`);
        remainingErrors.push(msg);
      }
    }

    // 3. 若 task.branchName 存在，尝试 git branch -D
    if (instance.task.branchName && repoRoot) {
      try {
        await runGit(repoRoot, ["branch", "-D", instance.task.branchName]);
        unregisterRuntimeResource(parentSessionId, "task_branch", instance.task.branchName, repoRoot);
        instance.task.branchName = undefined;
      } catch (err) {
        const msg = `Failed to delete branch ${instance.task.branchName} during retry cleanup for ${taskId}: ${String(err instanceof Error ? err.message : err)}`;
        console.warn(`[SubagentManager] ${msg}`);
        remainingErrors.push(msg);
      }
    }

    if (remainingErrors.length > 0) {
      instance.initializationCleanupError = remainingErrors.join("; ");
      persistTask(instance.task);
      return false;
    }

    // 全部清理成功：清除错误，确认任务安全进入 aborted 终态
    instance.initializationCleanupError = undefined;
    instance.task.status = "aborted";
    instance.task.summary = "Task initialization rollback completed on retry";
    persistTask(instance.task);
    return true;
  }

  /**
   * 删除指定的 Subagent 任务及其磁盘持久化文件，并清理附属 Task Memory (Fail-closed)
   * 必须确保：
   * 1. 存在 initializationCleanupError 时，重试清理残留 side effects 且必须成功；
   * 2. 若任务处于 streaming，尝试 abort 并确认已停止；
   * 3. 若任务未处于 terminal state，尝试 abort 并确认终态；
   * 4. 如果 instance.runtime 存在，必须确认 runtime.dispose() 成功，否则严禁从 subagentTasks 移除；
   * 5. 全部确认安全释放后，清除 timeoutTimer，删除内存映射，删除磁盘持久化及 Task Memory。
   */
  public async deleteTask(taskId: string): Promise<boolean> {
    const instance = subagentTasks.get(taskId);
    if (instance) {
      // 1. 如果存在初始化回滚错误，先重试清理残留资源，重试失败严禁当成普通终态任务删除
      if (instance.initializationCleanupError) {
        const retryOk = await this.retryInitializationCleanup(instance);
        if (!retryOk) {
          console.warn(
            `[SubagentManager] Cannot delete task ${taskId}: initialization cleanup retry failed: ${instance.initializationCleanupError}`,
          );
          return false;
        }
      }

      const terminalStates: TaskExecutionStatus[] = [
        "completed",
        "failed",
        "aborted",
        "interrupted",
        "incomplete",
      ];

      // 2. 检查 streaming 并确保退出
      let isStreaming = Boolean(instance.runtime?.session?.isStreaming);
      if (isStreaming) {
        try {
          await instance.runtime?.session?.abort();
        } catch {
          /* best effort */
        }
        isStreaming = Boolean(instance.runtime?.session?.isStreaming);
        if (isStreaming) {
          console.warn(`[SubagentManager] Cannot delete task ${taskId}: session is still streaming after abort`);
          return false;
        }
      }

      // 3. 确保进入安全终态
      let isSafelyTerminal = terminalStates.includes(instance.task.status);
      if (!isSafelyTerminal) {
        let aborted = false;
        try {
          aborted = await this.abort(taskId, { source: "user" });
        } catch (err) {
          console.warn(`[SubagentManager] Failed to abort task ${taskId} prior to deletion:`, err);
          aborted = false;
        }

        const confirmedTerminal = terminalStates.includes(instance.task.status);
        if (!aborted && !confirmedTerminal) {
          console.warn(
            `[SubagentManager] Cannot delete task ${taskId}: task is running and failed to abort (fail-closed)`,
          );
          return false;
        }
      }

      // 4. 统一 Invariant：从 subagentTasks 永久移除之前，若 instance.runtime 存在，必须确认 runtime.dispose() 成功
      if (instance.runtime) {
        try {
          await instance.runtime.dispose();
          instance.runtime = undefined;
        } catch (err) {
          console.warn(
            `[SubagentManager] Cannot delete task ${taskId}: runtime.dispose() failed: ${String(err instanceof Error ? err.message : err)}. Fail-closed: retaining instance handle.`,
          );
          return false;
        }
      }

      if (instance.timeoutTimer) {
        clearTimeout(instance.timeoutTimer);
        instance.timeoutTimer = undefined;
      }
    }

    try {
      const memOk = removeTaskMemory(taskId);
      if (!memOk) {
        console.warn(
          `[SubagentManager] Cannot delete task ${taskId}: task memory cleanup failed. Preserving persistent task file as retry anchor.`,
        );
        return false;
      }
    } catch (err) {
      console.warn(`[SubagentManager] Unexpected error during memory cleanup for ${taskId}:`, err);
      return false;
    }

    try {
      const turnsOk = deleteSessionTurns(taskId);
      if (!turnsOk) {
        console.warn(
          `[SubagentManager] Cannot delete task ${taskId}: turns cleanup failed. Preserving persistent task file as retry anchor.`,
        );
        return false;
      }
    } catch (err) {
      console.warn(`[SubagentManager] Unexpected error during turns cleanup for ${taskId}:`, err);
      return false;
    }

    try {
      const fileOk = deleteTaskFile(taskId);
      if (!fileOk) {
        console.warn(
          `[SubagentManager] Cannot delete task ${taskId}: task file unlink failed. Preserving in-memory instance and file as retry anchor.`,
        );
        return false;
      }
    } catch (err) {
      console.warn(`[SubagentManager] Failed to delete task file for ${taskId}:`, err);
      return false;
    }

    subagentTasks.delete(taskId);
    this.taskGraph.removeTask(taskId);
    return true;
  }

  /**
   * Phase A: 销毁指定 Parent Session 下属所有 Subagent 的 Session Runtime
   * 仅销毁 runtime，完整保留 Task metadata、worktreePath、branchName、所有权与持久化文件
   */
  public async disposeSubagentRuntimesForParent(parentSessionId: string): Promise<boolean> {
    let allSucceeded = true;
    for (const [taskId, inst] of subagentTasks.entries()) {
      if (inst.task.parentSessionId === parentSessionId) {
        if (inst.runtime) {
          try {
            await inst.runtime.dispose();
            inst.runtime = undefined;
          } catch (err) {
            console.warn(`[SubagentManager] Failed to dispose runtime for task ${taskId}:`, err);
            allSucceeded = false;
          }
        }
      }
    }
    return allSucceeded;
  }

  /**
   * Phase C: 在 Git 清理成功后，彻底销毁指定 Parent Session 下属的 Subagent 元数据、文件、Memory、TurnRecorder、DAG 与复用智能体
   */
  public async purgeSubagentMetadataForParent(parentSessionId: string): Promise<boolean> {
    try {
      await this.clearTasksForParent(parentSessionId);
      return true;
    } catch (err) {
      console.warn(`[SubagentManager] Failed to purge subagent metadata for ${parentSessionId}:`, err);
      return false;
    }
  }

  /**
   * 准备删除 Run（Quiescence 阶段）：
   * 1. 标记该 Run 为 deleting，拦截后续 Auto Finalize；
   * 2. 若当前已有 in-flight Auto Finalize，等待其执行完毕，避免并发冲突；
   * 3. 静默停止当前 Parent Session 下仍然处于 active/running 状态的子任务，确保 Runtime 完全 Quiescent；
   * 4. 显式检查 abort() 的真实返回结果，若无法确认进入安全终态则报告 Quiescence Failure；
   * 5. 不删除 Task metadata（保留 metadata 供随后的 Git cleanup 使用）。
   */
  public async prepareRunForDeletion(parentSessionId: string, timeoutMs = 5000): Promise<QuiescenceResult> {
    // 1. 标记 deletion gate (互斥门禁)
    this.deletingRuns.add(parentSessionId);

    // 2. 等待当前已在进行的 finalize 完成 (serialized)
    const inFlightFinalize = this.finalizingRunPromises.get(parentSessionId);
    if (inFlightFinalize) {
      try {
        await inFlightFinalize;
      } catch {
        /* ignore settle error */
      }
    }

    // 2.5 等待已进入 in-flight 的 start/spawn 初始化流程安全退出或取消 (with timeout)
    const inFlightStarts = this.inFlightTaskStarts.get(parentSessionId);
    if (inFlightStarts && inFlightStarts.size > 0) {
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([
        Promise.allSettled([...inFlightStarts]),
        timeoutPromise,
      ]).finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      });
    }

    // 2.6 等待已进入 in-flight 的 subagent completion 流程执行完毕
    const inFlightComps = this.inFlightCompletions.get(parentSessionId);
    if (inFlightComps && inFlightComps.size > 0) {
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([
        Promise.allSettled([...inFlightComps]),
        timeoutPromise,
      ]).finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      });
    }

    // 3. 静默停止所有运行中/活跃中的子任务，等待 Runtime 真正退出并显式检查 abort() 真实结果
    const failedTaskIds: string[] = [];
    const terminalStates: TaskExecutionStatus[] = [
      "completed",
      "failed",
      "aborted",
      "interrupted",
      "incomplete",
    ];

    for (const [taskId, inst] of subagentTasks.entries()) {
      if (inst.task.parentSessionId === parentSessionId) {
        // FAIL-CLOSED: 若任务在初始化 rollback 期间曾失败，在本次删除准备阶段自动重试清理
        if (inst.initializationCleanupError) {
          const retryOk = await this.retryInitializationCleanup(inst);
          if (!retryOk) {
            console.warn(
              `[SubagentManager] Quiescence failure: task ${taskId} had initialization rollback failure and retry failed: ${inst.initializationCleanupError}`,
            );
            failedTaskIds.push(taskId);
            continue;
          }
        }

        const isStreaming = Boolean(inst.runtime?.session?.isStreaming);
        if (terminalStates.includes(inst.task.status) && !isStreaming) {
          continue;
        }

        let aborted = false;
        try {
          aborted = await this.abort(taskId, { source: "user" });
        } catch (err) {
          console.warn(`[SubagentManager] Failed to abort task ${taskId} during run deletion:`, err);
          aborted = false;
        }

        const safelyTerminal =
          terminalStates.includes(inst.task.status) && !Boolean(inst.runtime?.session?.isStreaming);
        if (!aborted && !safelyTerminal) {
          console.warn(
            `[SubagentManager] Quiescence failure: task ${taskId} (status=${inst.task.status}) failed to abort and is not confirmed quiescent`,
          );
          failedTaskIds.push(taskId);
        }
      }
    }

    // 4. 再次确认没有任何 in-flight task starts / completions 残留
    const remainingStarts = this.inFlightTaskStarts.get(parentSessionId);
    if (remainingStarts && remainingStarts.size > 0) {
      console.warn(
        `[SubagentManager] Quiescence failure: in-flight task starts still active for session ${parentSessionId}`,
      );
      failedTaskIds.push(`in-flight-start-${parentSessionId}`);
    }

    const remainingComps = this.inFlightCompletions.get(parentSessionId);
    if (remainingComps && remainingComps.size > 0) {
      console.warn(
        `[SubagentManager] Quiescence failure: in-flight task completions still active for session ${parentSessionId}`,
      );
      failedTaskIds.push(`in-flight-completion-${parentSessionId}`);
    }

    if (failedTaskIds.length > 0) {
      return { success: false, failedTaskIds };
    }
    return { success: true };
  }

  /**
   * 删除完成后解除 Run 的 deleting 状态
   */
  public finishRunDeletion(parentSessionId: string): void {
    this.deletingRuns.delete(parentSessionId);
  }

  /**
   * 当 Parent Session 被永久删除时，安全清理该 Session 拥有的所有 Git Runtime Resources
   * 包含 Task worktrees/branches 与 Integration worktree/branch，具备严格所有权保护
   * 支持 active 会话及服务器重启后的 inactive 历史会话
   */
  public async cleanupRunResourcesForParent(
    parentSessionId: string,
    repoRootHint?: string,
  ): Promise<CleanupResult | undefined> {
    let repoRoot: string | undefined;

    const activeInt = this.integrations.get(parentSessionId);
    if (activeInt?.worktreePath) {
      repoRoot = findRepoRootForWorktree(activeInt.worktreePath);
    }

    if (!repoRoot) {
      for (const inst of subagentTasks.values()) {
        if (inst.task.parentSessionId === parentSessionId && inst.task.worktreePath) {
          const candidate = findRepoRootForWorktree(inst.task.worktreePath);
          if (candidate) {
            repoRoot = candidate;
            break;
          }
        }
      }
    }

    if (!repoRoot && repoRootHint) {
      try {
        const info = await resolveProjectRoot(repoRootHint);
        if (existsSync(join(info.projectRoot, ".git"))) {
          repoRoot = info.projectRoot;
        }
      } catch {
        /* ignore */
      }
    }

    if (!repoRoot) {
      const hasGitExpectation =
        this.integrations.has(parentSessionId) ||
        Array.from(subagentTasks.values()).some(
          (inst) =>
            inst.task.parentSessionId === parentSessionId &&
            Boolean(inst.task.worktreePath || inst.task.branchName),
        );
      if (hasGitExpectation) {
        return {
          success: false,
          removed: [],
          skipped: [],
          leftovers: [],
          errors: [`Cannot resolve git repository root for session ${parentSessionId} while git runtime resources exist`],
        };
      }
      this.integrations.delete(parentSessionId);
      return { success: true, removed: [], skipped: [], leftovers: [] };
    }

    const taskInstances: { worktreePath?: string; branchName?: string }[] = [];
    for (const inst of subagentTasks.values()) {
      if (inst.task.parentSessionId === parentSessionId) {
        if (inst.task.worktreePath || inst.task.branchName) {
          taskInstances.push({
            worktreePath: inst.task.worktreePath,
            branchName: inst.task.branchName,
          });
        }
      }
    }

    const persisted = loadPersistedRuntimeResources(repoRoot);
    for (const r of persisted) {
      if (r.runId === parentSessionId) {
        if (r.type === "task_worktree") {
          if (!taskInstances.some((t) => t.worktreePath === r.nameOrPath)) {
            taskInstances.push({ worktreePath: r.nameOrPath });
          }
        } else if (r.type === "task_branch") {
          if (!taskInstances.some((t) => t.branchName === r.nameOrPath)) {
            taskInstances.push({ branchName: r.nameOrPath });
          }
        }
      }
    }

    let integration: IntegrationWorkspace;
    if (activeInt) {
      integration = activeInt;
    } else {
      const persistedIntWt = persisted.find(
        (r) => r.runId === parentSessionId && r.type === "integration_worktree",
      )?.nameOrPath;
      const persistedIntBranch = persisted.find(
        (r) => r.runId === parentSessionId && r.type === "integration_branch",
      )?.nameOrPath;
      const safeId = parentSessionId.replace(/[^a-zA-Z0-9._-]/g, "-");
      integration = {
        runId: parentSessionId,
        worktreePath: persistedIntWt || resolve(repoRoot, ".worktrees", `integration-${safeId}`),
        branch: persistedIntBranch || `runtime/run-${safeId}`,
        baseCommit: "",
        originalBranch: "",
      };
    }

    const result = await cleanupRunResources(repoRoot, integration, taskInstances);
    // 仅当清理完全成功时才注销 integration 内存记录；若失败保留记录以供 retry
    if (result.success) {
      this.integrations.delete(parentSessionId);
    }
    return result;
  }

  /**
   * 清空某主会话下的所有历史 Subagent 任务 (Fail-closed)
   * 若存在无法安全停止或删除的任务，不得假装清理成功，必须抛出错误并保留未安全停止的实例。
   */
  public async clearTasksForParent(parentSessionId: string): Promise<number> {
    let count = 0;
    const taskIds: string[] = [];
    for (const [id, inst] of subagentTasks.entries()) {
      if (inst.task.parentSessionId === parentSessionId) {
        taskIds.push(id);
      }
    }
    const failedTaskIds: string[] = [];
    for (const id of taskIds) {
      const ok = await this.deleteTask(id);
      if (ok) {
        count++;
      } else {
        failedTaskIds.push(id);
      }
    }
    if (failedTaskIds.length > 0) {
      throw new Error(
        `Failed to safely clear tasks for parent session ${parentSessionId}: tasks [${failedTaskIds.join(", ")}] could not be quiesced or deleted`,
      );
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
    if (this.deletingRuns.has(parentSessionId)) {
      return {
        success: false,
        status: "ERROR",
        mode: options?.mode || "working_tree",
        changedFiles: [],
        error: `Cannot finalize run for session ${parentSessionId}: session is being deleted`,
      };
    }

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
    const parentSessionId = instance.task.parentSessionId;
    if (this.deletingRuns.has(parentSessionId)) {
      console.warn(
        `[SubagentManager] Cannot start blocked task ${taskId}: parent session ${parentSessionId} is being deleted (lifecycle gate locked).`,
      );
      return false;
    }

    return this.trackInFlightStart(parentSessionId, async () => {
      const currentStatus = instance.task.status as TaskExecutionStatus;
      if (this.deletingRuns.has(parentSessionId) || currentStatus === "aborted") {
        return false;
      }

      if (instance.spawnOptions) {
        await this.startTaskExecution(instance);
        return (instance.task.status as TaskExecutionStatus) !== "aborted";
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
        void this.finalizeFailed(instance, errorMsg);
      });

      return true;
    });
  }
}

// ---------------------------------------------------------------------------
// Review result parsing helper
// ---------------------------------------------------------------------------

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
