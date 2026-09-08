export type UIContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      args: unknown;
      result?: { text: string; isError: boolean };
    }
  | { type: "image"; dataUrl?: string };

export interface UIMessageUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export interface UIMessage {
  role: "user" | "assistant" | "custom";
  content: UIContentBlock[];
  errorMessage?: string;
  usage?: UIMessageUsage;
}

export interface UIModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

export type UIThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type AgentRole =
  | "default"
  | "coordinator"
  | "developer"
  | "verifier"
  | "researcher";

export interface RoleDefinition {
  id: AgentRole;
  name: string;
  description: string;
  responsibilities: string[];
  strictProhibitions: string[];
  /** 角色专属工作方法、流程与判断原则 */
  instructions?: string;
  allowedSkills?: string[];
  requiresWorktree?: boolean;
  defaultModel?: {
    provider?: string;
    modelId: string;
    thinkingLevel?: UIThinkingLevel;
  };
  /** 角色定义规范版本号 */
  definitionVersion?: number;
}

export interface RoleConfig {
  id: AgentRole;
  name: string;
  description: string;
  systemPrompt: string;
  roleDefinitionVersion?: number;
  model?: {
    provider?: string;
    modelId: string;
    thinkingLevel?: UIThinkingLevel;
  };
  allowedTools?: string[];
  allowedSkills?: string[];
  requiresWorktree: boolean;
  /** V2 架构下的结构化角色定义 (若存在) */
  definition?: RoleDefinition;
}

export interface TaskScope {
  include?: string[];
  exclude?: string[];
}

export interface TaskContract {
  taskId: string;
  parentSessionId: string;
  role: AgentRole;
  goal: string;
  scope?: TaskScope;
  contextFiles?: string[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  expectedEffects?: ExpectedEffect[];
  /** 可选返工关系：指向被本次任务修复的先前任务 ID */
  reworkOfTaskId?: string;
}

export type ExpectedEffect =
  | "code_change"
  | "test_execution"
  | "analysis"
  | "deployment"
  | "artifact";

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

export type AssistantFinishReason =
  | "stop"
  | "tool_call"
  | "max_tokens"
  | "cancelled"
  | "error"
  | "unknown";

export type VerificationStatus =
  | "pass"
  | "fail"
  | "not_run"
  | "blocked_by_environment"
  | "partially_verified";

export interface VerificationCheck {
  name: string;
  status: VerificationStatus;
  detail?: string;
}

export type CommandPurpose =
  | "exploration"
  | "verification"
  | "build"
  | "test"
  | "deployment";

export interface CommandRecord {
  command: string;
  exitCode: number | null;
  exitCodeSource: "runtime" | "unknown";
  passed: boolean;
  purpose: CommandPurpose;
  stdoutSummary?: string;
  stderrSummary?: string;
}

export interface TaskAudit {
  forceAccepted?: boolean;
  reason?: string;
  forcedAt?: string;
}

export interface VerificationResult {
  diff: VerificationCheck;
  scope: VerificationCheck;
  testExecution?: VerificationCheck;
  commands: CommandRecord[];
  overall: VerificationStatus;
  scopeViolations?: string[];
  changedFiles?: string[];
}

export type FinalizeMode = "working_tree" | "squash_commit" | "keep_commits";

export interface FinalizeResult {
  success: boolean;
  status: "FINALIZED" | "FINALIZE_CONFLICT" | "NO_CHANGES" | "ERROR";
  mode: FinalizeMode;
  changedFiles: string[];
  conflictFiles?: string[];
  commitSha?: string;
  error?: string;
}

export type ReviewSeverity = "blocker" | "major" | "minor" | "nit";

export interface ReviewFinding {
  id: string;
  severity: ReviewSeverity;
  criterionId?: string;
  invariantId?: string;
  file?: string;
  line?: number;
  problem: string;
  evidence: string;
  expected?: string;
  actual?: string;
  suggestedFix?: string;
}

export interface ReviewResult {
  verdict: "APPROVE" | "REQUEST_CHANGES";
  findings: ReviewFinding[];
  onlyMinorFindings: boolean;
}

export interface TaskResult {
  taskId: string;
  role: AgentRole;
  status: TaskExecutionStatus;
  summary: string;
  changedFiles?: string[];
  commit?: string;
  startedAt?: string;
  completedAt: string;
  durationMs?: number;
  meta?: Record<string, unknown>;
  verification?: VerificationResult;
  review?: ReviewResult;
  audit?: TaskAudit;
}

export interface UISkillItem {
  name: string;
  description: string;
  path: string;
  scope: "project" | "user";
}

export interface UISkillsResponse {
  skills: UISkillItem[];
}

export interface UIRolesResponse {
  roles: RoleConfig[];
  path: string;
}

export interface UIToolItem {
  name: string;
  label?: string;
  description: string;
  category?: "core" | "subagents" | "custom";
}

export interface UISubagentTask {
  taskId: string;
  parentSessionId: string;
  role: AgentRole;
  /** Logical reusable agent identity (survives across continued tasks). */
  agentId?: string;
  taskTitle: string;
  taskPrompt: string;
  branchName?: string;
  worktreePath?: string;
  targetCwd?: string;
  status: TaskExecutionStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  /** Immutable task-worktree baseline used by the terminal Episode Card. */
  baseCommit?: string;
  /** Number of successful Pi-native compactions observed for this task. */
  compactionCount?: number;
  stallTelemetry?: {
    commandLoopSignals: number;
    verificationStagnationSignals: number;
    codeOscillationSignals: number;
    contextPressure: number;
    warningCount: number;
  };
  summary?: string;
  changedFiles?: string[];
  logs?: string[];
  error?: string;
  /** Subagent 的完整对话会话与工具调用流 */
  messages?: UIMessage[];
  /** Subagent 实际使用的模型 */
  model?: { provider: string; id: string; name?: string };
  /** 结构化任务契约 */
  taskContract?: TaskContract;
  /** 可选返工关系：指向被本次任务修复的先前任务 ID */
  reworkOfTaskId?: string;
  /** 交付结果记录 */
  taskResult?: TaskResult;
  /** Runtime 验证结果 */
  verification?: VerificationResult;
  /** 结构化 Review 结果 */
  review?: ReviewResult;
  /** 强制接受审计记录 */
  audit?: TaskAudit;
}

export interface UITokenUsageByRole {
  role: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface UITokenUsageStats {
  /** Cumulative input tokens for this parent session (all turns). */
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Cumulative parent-session tokens (input+output, excluding cache read unless counted in total). */
  totalTokens: number;
  totalCost?: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latestTurnTokens?: number;
  /** Current context window occupancy (last turn input + cache read). */
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
  /** Sum of all subagent run tokens for this parent session. */
  subagentTokens?: number;
  /** Parent + subagent cumulative tokens. */
  runTokens?: number;
  byRole?: UITokenUsageByRole[];
}

export interface UIQueuedMessage {
  id: string;
  text: string;
  mode: "followUp" | "steer";
  createdAt?: string;
  source?: "user" | "subagent";
  taskId?: string;
  taskTitle?: string;
  role?: AgentRole;
  taskStatus?: TaskExecutionStatus;
  kind?: "subagent_terminal" | "subagent_blocker";
}

export interface UISnapshot {
  messages: UIMessage[];
  isStreaming: boolean;
  isCompacting?: boolean;
  model: UIModel | null;
  thinkingLevel: UIThinkingLevel;
  thinkingLevels: UIThinkingLevel[];
  sessionFile?: string;
  sessionId?: string;
  /** 当前工作目录 */
  cwd?: string;
  /** 当前工作目录简短名称 (如项目文件夹名) */
  cwdName?: string;
  /** 当前工作目录是否在 Git 仓库内 */
  isGitRepo?: boolean;
  /** 当前 Git 分支 (如果在仓库内) */
  gitBranch?: string;
  activeRole?: AgentRole;
  /** 当前主会话派发的子智能体列表 */
  subagents?: UISubagentTask[];
  /** 会话 Token 用量与上下文窗口统计 */
  tokenUsage?: UITokenUsageStats;
  /** 当前正在排队等待执行的消息列表 */
  queuedMessages?: UIQueuedMessage[];
}

export interface UISessionInfo {
  id: string;
  path: string;
  name?: string;
  firstMessage: string;
  modified: string;
  relativeTime?: string;
  messageCount: number;
  cwd?: string;
}

export interface UIProjectFolder {
  path: string;
  name: string;
  displayPath: string;
  branch?: string;
  isMain?: boolean;
  sessions: UISessionInfo[];
}

export interface UIProjectItem {
  id: string;
  name: string;
  cwd: string;
  projectRoot: string;
  displayPath: string;
  isGitRepo?: boolean;
  gitBranch?: string;
  lastModified: string;
  folders: UIProjectFolder[];
  sessions: UISessionInfo[];
}

export interface UIForkPoint {
  entryId: string;
  text: string;
}

export interface UIExtensionInfo {
  name: string;
  packageName?: string;
  path: string;
  scope: "user" | "project" | "temporary";
  tools: string[];
  commands: string[];
  flags: string[];
  events: string[];
}

export interface UIExtensionsResponse {
  extensions: UIExtensionInfo[];
  errors: { path: string; error: string }[];
}

export interface UICustomModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
}

export type UICustomApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export interface UICustomProvider {
  key: string;
  baseUrl: string;
  api: UICustomApi;
  apiKey?: string;
  models: UICustomModel[];
}

export interface UICustomModelsResponse {
  path: string;
  providers: UICustomProvider[];
  parseError?: string;
  warning?: string;
}

export interface UIImageAttachment {
  data: string;
  mimeType: string;
}

export interface UICwdValidateResponse {
  ok: boolean;
  path: string;
  displayPath: string;
  name: string;
  isGitRepo: boolean;
  gitBranch?: string;
  error?: string;
}

export interface UIPickDirectoryResponse {
  ok: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
  fallback?: boolean;
}

export interface UIFsItem {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo?: boolean;
}

export interface UIFsListResponse {
  ok: boolean;
  currentPath: string;
  parentPath: string | null;
  homePath: string;
  items: UIFsItem[];
  error?: string;
}

export interface UIToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  promptGuidelines?: string[];
}

export interface UIPromptInspection {
  systemPrompt: string;
  rolePrompt?: string;
  workspacePrompt?: string;
  activeRole: AgentRole;
  cwd: string;
  cwdName: string;
  gitBranch?: string;
  model: UIModel | null;
  thinkingLevel: UIThinkingLevel;
  messages: UIMessage[];
  rawMessagesCount: number;
  tools: UIToolSchema[];
  estimatedTokens?: {
    systemPrompt: number;
    messages: number;
    tools: number;
    total: number;
  };
  subagentRoles?: Array<{
    id: AgentRole;
    name: string;
    description: string;
    systemPrompt: string;
    model?: {
      provider?: string;
      modelId: string;
      thinkingLevel?: UIThinkingLevel;
    };
  }>;
}

export interface UISessionFileLine {
  lineNumber: number;
  type: string;
  raw: string;
  parsed?: Record<string, unknown>;
}

export interface UISessionFileResponse {
  sessionId: string;
  sessionFile: string;
  exists: boolean;
  size: number;
  modified: string;
  relativeTime?: string;
  lineCount: number;
  lines: UISessionFileLine[];
  rawContent: string;
}

export interface UILLMToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UILLMTurnRecord {
  turnIndex: number;
  timestamp: number;
  timeStr: string;
  model: {
    provider: string;
    id: string;
    name?: string;
  };
  thinkingLevel?: string;
  systemPrompt: string | Record<string, unknown>;
  messages: unknown[];
  tools: UILLMToolDefinition[];
  vendorPayload?: Record<string, unknown>;
  /** Hash of the stable provider-level prefix extracted from the real wire payload. */
  requestPrefixHash?: string;
  tokenEstimate?: {
    systemPromptTokens: number;
    messagesTokens: number;
    toolsTokens: number;
    totalTokens: number;
  };
}

export interface UILLMTurnsResponse {
  sessionId: string;
  sessionFile?: string;
  totalTurns: number;
  turns: UILLMTurnRecord[];
}

export interface UISubscriptionModel {
  id: string;
  name?: string;
  reasoning?: boolean;
}

export interface UISubscriptionProvider {
  id: string;
  name: string;
  envKey: string;
  configured: boolean;
  authSource?: string;
  authType?: "api_key" | "oauth" | string;
  /** Models still shown in the picker / settings. */
  models: UISubscriptionModel[];
  /** User-hidden models (can be restored). */
  hiddenModels?: UISubscriptionModel[];
}

export interface UISubscriptionModelsResponse {
  providers: UISubscriptionProvider[];
  path?: string;
  preferencesPath?: string;
}

export type UISubscriptionModelAction =
  | { action: "hide_model"; provider: string; modelId: string }
  | { action: "unhide_model"; provider: string; modelId: string }
  | { action: "unhide_all"; provider: string };

export type ServerEvent =
  | { type: "snapshot"; snapshot: UISnapshot }
  | { type: "session_bound"; sessionId: string }
  | { type: "delta"; kind: "text" | "thinking"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean }
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  | { type: "forked"; selectedText?: string }
  | { type: "subagent_spawned"; task: UISubagentTask }
  | { type: "subagent_updated"; task: UISubagentTask }
  | { type: "subagent_reported"; task: UISubagentTask; reportText: string }
  | { type: "error"; message: string };

export type ClientCommand =
  | { type: "prompt"; text: string; images?: UIImageAttachment[] }
  | { type: "abort" }
  | { type: "set_model"; provider: string; id: string }
  | { type: "set_thinking_level"; level: UIThinkingLevel }
  | { type: "set_session_role"; role: AgentRole }
  | { type: "set_session_cwd"; cwd: string }
  | { type: "abort_subagent"; taskId: string }
  | { type: "fork"; entryId: string }
  | { type: "compact"; customInstructions?: string }
  | { type: "delete_subagent_task"; taskId: string }
  | { type: "clear_subagent_tasks" }
  | { type: "edit_queued_message"; id: string; text: string }
  | { type: "cancel_queued_message"; id: string }
  | { type: "send_queued_message_now"; id: string };
