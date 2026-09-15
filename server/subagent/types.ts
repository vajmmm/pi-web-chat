import type { createAgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentRole, UISubagentTask } from "../../shared/protocol.ts";
import type {
  SubagentExecutionOptions,
  TaskContract,
  WorkspaceContextDetails,
} from "../contracts/index.ts";
import type { StallTelemetryState } from "./stall-arbiter.ts";

export type SubagentReportKind = "terminal" | "blocker";

export interface SpawnSubagentOptions {
  parentSessionId: string;
  role: AgentRole;
  taskTitle: string;
  taskPrompt: string;
  requiresWorktree?: boolean;
  preferredBranch?: string;
  targetCwd?: string;
  parentCwd: string;
  parentModel?: { provider: string; id: string } | null;
  taskContract?: TaskContract;
  executionOptions?: SubagentExecutionOptions;
  customSession?: any;
  /** Continue an existing reusable agent (injects knowledge; increments reuseCount). */
  reuseAgentId?: string;
  /** 可选返工关联：指向被本次任务修复的先前任务 ID */
  reworkOfTaskId?: string;
  onUpdate?: (task: UISubagentTask) => void;
  onReport?: (
    task: UISubagentTask,
    reportText: string,
    metadata?: { kind: SubagentReportKind },
  ) => void | Promise<void>;
}

export interface ContinueSubagentOptions {
  agentId: string;
  parentSessionId: string;
  taskTitle: string;
  taskPrompt: string;
  preferredBranch?: string;
  targetCwd?: string;
  parentCwd: string;
  parentModel?: { provider: string; id: string } | null;
  taskContract?: TaskContract;
  executionOptions?: SubagentExecutionOptions;
  customSession?: any;
  /** 可选返工关联：指向被本次任务修复的先前任务 ID */
  reworkOfTaskId?: string;
  onUpdate?: (task: UISubagentTask) => void;
  onReport?: (
    task: UISubagentTask,
    reportText: string,
    metadata?: { kind: SubagentReportKind },
  ) => void | Promise<void>;
}

export interface SubagentInstance {
  task: UISubagentTask;
  runtime?: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
  repoRoot?: string | null;
  baseCommit?: string;
  taskContract?: TaskContract;
  spawnOptions?: SpawnSubagentOptions;
  workspaceBaseline?: any;
  timeoutTimer?: NodeJS.Timeout;
  /**
   * Inactivity watchdog. Reset on every session event; fires when the subagent
   * emits nothing for {@link SUBAGENT_STALL_TIMEOUT_MS} — the failure mode where
   * a provider stream hangs silently (e.g. a retried "Stream ended without
   * finish_reason") so no settling `agent_end` ever arrives and the task would
   * otherwise sit in `running` forever. Self-guards on fire, so a stray late
   * fire after a terminal transition is a harmless no-op.
   */
  stallTimer?: NodeJS.Timeout;
  /**
   * Wall-clock budget (ms) for a single task execution. Persisted on the
   * instance so the max_tokens auto-continuation can re-arm the same watchdog.
   */
  timeoutMs?: number;
  autoContinuationCount?: number;
  reported?: boolean;
  aborting?: boolean;
  /** True while a terminal finalize path is settling runtime/tools. */
  terminalizing?: boolean;
  initializationCleanupError?: string;
  /**
   * In-flight tool executions (tool_execution_start → tool_execution_end).
   * Used as a finalize gate so harness status cannot race ahead of tools.
   */
  activeTools?: Map<
    string,
    {
      toolCallId: string;
      toolName: string;
      startedAt: number;
      args?: unknown;
    }
  >;
  /**
   * tool_execution_end is emitted before Agent Core appends the corresponding
   * toolResult message. Keep the finalized result here so an interruption in
   * that small window can still produce a structurally complete transcript.
   */
  pendingToolResults?: Map<
    string,
    {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: unknown[];
      details?: unknown;
      usage?: unknown;
      isError?: boolean;
      timestamp: number;
    }
  >;
  pendingTerminal?: {
    type: "completed" | "failed";
    error?: string;
  };
  stallTelemetry?: StallTelemetryState;
  onUpdate?: (task: UISubagentTask) => void;
  onReport?: (
    task: UISubagentTask,
    reportText: string,
    metadata?: { kind: SubagentReportKind },
  ) => void | Promise<void>;
}

export type { WorkspaceContextDetails };
