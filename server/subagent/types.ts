import type { createAgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentRole, UISubagentTask } from "../../shared/protocol.ts";
import type {
  SubagentExecutionOptions,
  TaskContract,
  WorkspaceContextDetails,
} from "../contracts/index.ts";

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
  onReport?: (task: UISubagentTask, reportText: string) => void;
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
  onReport?: (task: UISubagentTask, reportText: string) => void;
}

export interface SubagentInstance {
  task: UISubagentTask;
  runtime?: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
  repoRoot?: string | null;
  baseCommit?: string;
  taskContract?: TaskContract;
  spawnOptions?: SpawnSubagentOptions;
  timeoutTimer?: NodeJS.Timeout;
  autoContinuationCount?: number;
  reported?: boolean;
  aborting?: boolean;
  pendingTerminal?: {
    type: "completed" | "failed";
    error?: string;
  };
  onUpdate?: (task: UISubagentTask) => void;
  onReport?: (task: UISubagentTask, reportText: string) => void;
}

export type { WorkspaceContextDetails };
