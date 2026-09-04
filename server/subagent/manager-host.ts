import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { UISubagentTask } from "../../shared/protocol.ts";
import type { TaskGraph } from "../task-graph.ts";
import type { ReusableSubagentRegistry } from "../reusable-subagent.ts";
import type {
  FinalizeMode,
  FinalizeResult,
  IntegrationWorkspace,
} from "../worktree.ts";
import type { ContinueSubagentOptions, SpawnSubagentOptions, SubagentInstance } from "./types.ts";

export type AbortSource = "coordinator" | "user" | "timeout" | "system";

/**
 * Narrow host surface for subagent collaborators.
 * SubagentManager owns all Maps/Sets and implements this interface.
 * Cross-module calls go through these methods to avoid ESM cycles.
 */
export interface SubagentManagerHost {
  modelRuntime: ModelRuntime;
  autoFinalize: boolean;
  readonly taskGraph: TaskGraph;
  readonly reusableAgents: ReusableSubagentRegistry;
  deletingRuns: Set<string>;
  inFlightTaskStarts: Map<string, Set<Promise<void>>>;
  inFlightCompletions: Map<string, Set<Promise<void>>>;
  integrations: Map<string, IntegrationWorkspace>;
  finalizedRuns: Map<string, FinalizeResult>;
  finalizingRuns: Set<string>;
  finalizingRunPromises: Map<string, Promise<FinalizeResult | null>>;

  notifyUpdate(instance: SubagentInstance): void;
  getSerializableMessages(instance: SubagentInstance, interruptionReason?: string): any[];
  isTerminalLocked(instance: SubagentInstance): boolean;
  registerActiveTool(
    instance: SubagentInstance,
    event: { toolCallId?: string; toolName?: string; args?: unknown },
  ): void;
  clearActiveTool(instance: SubagentInstance, toolCallId?: string): void;
  listActiveToolNames(instance: SubagentInstance): string[];
  abortSessionAndQuiesceTools(instance: SubagentInstance, reason: string): Promise<void>;
  disposeRuntime(instance: SubagentInstance, reason: string): Promise<void>;
  trackInFlightStart<T>(parentSessionId: string, action: () => Promise<T>): Promise<T>;
  isTaskLineageSatisfied(taskId: string, parentSessionId?: string): boolean;
  isSessionLineageSatisfied(parentSessionId: string): boolean;
  isCoordinatorActive(parentSessionId: string): boolean;
  getTasksForParent(parentSessionId: string): UISubagentTask[];
  getOrCreateIntegration(parentSessionId: string, repoRoot: string): Promise<IntegrationWorkspace>;
  clearTasksForParent(parentSessionId: string): Promise<number>;

  spawn(options: SpawnSubagentOptions): Promise<UISubagentTask>;
  continueAgent(options: ContinueSubagentOptions): Promise<UISubagentTask>;
  startTaskExecution(instance: SubagentInstance): Promise<void>;
  startBlockedTask(taskId: string): Promise<boolean>;
  abort(taskId: string, options?: { source?: AbortSource }): Promise<boolean>;
  finalizeCompleted(instance: SubagentInstance): Promise<void>;
  finalizeIncomplete(instance: SubagentInstance, error: string): Promise<void>;
  finalizeFailed(instance: SubagentInstance, error: string): Promise<void>;
  handleSubagentCompletion(taskId: string): Promise<void>;
  executeSubagentCompletion(instance: SubagentInstance): Promise<void>;
  retryInitializationCleanup(instance: SubagentInstance): Promise<boolean>;
  deleteTask(taskId: string): Promise<boolean>;
  finalizeRun(
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
  ): Promise<FinalizeResult>;
}
