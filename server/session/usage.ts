import type {
  AgentRole,
  UISubagentTask,
  UIThinkingLevel,
  UITokenUsageStats,
} from "../../shared/protocol.ts";

export const ALL_THINKING_LEVELS: UIThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function supportedThinkingLevels(model: unknown): UIThinkingLevel[] {
  const m = model as
    | { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }
    | null
    | undefined;
  if (!m?.reasoning) return ["off"];
  const map = m.thinkingLevelMap;
  return ALL_THINKING_LEVELS.filter((level) => {
    if (map && map[level] === null) return false;
    if ((level === "xhigh" || level === "max") && map?.[level] == null) return false;
    return true;
  });
}

const ESTIMATED_IMAGE_TOKENS = 1200;

export function estimateMessageTokens(m: unknown): number {
  if (!m || typeof m !== "object") return 0;
  const msg = m as any;
  if (
    typeof msg.summary === "string" &&
    (msg.role === "compactionSummary" || msg.role === "branchSummary")
  ) {
    return Math.ceil(msg.summary.length / 3.5);
  }
  if (msg.role === "bashExecution") {
    const cmd = typeof msg.command === "string" ? msg.command : "";
    const out = typeof msg.output === "string" ? msg.output : "";
    return Math.ceil((cmd.length + out.length) / 3.5);
  }

  const content = msg.content;
  if (typeof content === "string") {
    return Math.ceil(content.length / 3.5);
  }
  if (Array.isArray(content)) {
    let tokens = 0;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "image") {
        tokens += ESTIMATED_IMAGE_TOKENS;
      } else if (part.type === "text" && typeof part.text === "string") {
        tokens += Math.ceil(part.text.length / 3.5);
      } else if (part.type === "thinking" && typeof part.thinking === "string") {
        tokens += Math.ceil(part.thinking.length / 3.5);
      } else if (part.type === "toolCall" || part.type === "tool_call") {
        const name = typeof part.name === "string" ? part.name : "";
        const args = part.arguments ? JSON.stringify(part.arguments) : "";
        tokens += Math.ceil((name.length + args.length) / 3.5);
      } else {
        const clone = { ...part };
        if ("data" in clone && typeof clone.data === "string" && clone.data.length > 500) {
          clone.data = "[image/binary data]";
        }
        tokens += Math.ceil(JSON.stringify(clone).length / 3.5);
      }
    }
    return tokens;
  }
  return Math.ceil(JSON.stringify(content ?? "").length / 3.5);
}

export function accumulateUsageFromMessages(messages: unknown[]): {
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestTurnTokens: number;
  contextTokens: number;
} {
  let input = 0;
  let output = 0;
  let total = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let latestTurnTokens = 0;
  let contextTokens = 0;

  let estimatedContextTokens = 0;
  let latestCompactionTimestamp = 0;

  for (const m of messages as any[]) {
    if (!m || typeof m !== "object") continue;

    if (m.role === "compactionSummary") {
      estimatedContextTokens = 0;
      contextTokens = 0;
      latestTurnTokens = 0;
      const ts =
        typeof m.timestamp === "number"
          ? m.timestamp
          : m.timestamp
            ? new Date(m.timestamp).getTime()
            : 0;
      if (ts > latestCompactionTimestamp) {
        latestCompactionTimestamp = ts;
      }
    }

    estimatedContextTokens += estimateMessageTokens(m);

    const u = m.usage;
    if (!u || typeof u !== "object") continue;
    const i = typeof u.input === "number" ? u.input : 0;
    const o = typeof u.output === "number" ? u.output : 0;
    const cr = typeof u.cacheRead === "number" ? u.cacheRead : 0;
    const cw = typeof u.cacheWrite === "number" ? u.cacheWrite : 0;
    const t = typeof u.totalTokens === "number" ? u.totalTokens : i + o;
    const c = typeof u.cost?.total === "number" ? u.cost.total : 0;
    input += i;
    output += o;
    total += t;
    cacheRead += cr;
    cacheWrite += cw;
    cost += c;

    // Only assistant messages carry meaningful context window occupancy (input + cacheRead).
    // ToolResult messages have usage from tool execution where input/cacheRead are 0.
    // Error responses (stopReason === 'error') or zero-token responses must not wipe previously known valid context size.
    const isValidUsage = (i + cr) > 0 && m.stopReason !== "error" && m.stopReason !== "aborted";
    if (m.role === "assistant" && isValidUsage) {
      const msgTs =
        typeof m.timestamp === "number"
          ? m.timestamp
          : m.timestamp
            ? new Date(m.timestamp).getTime()
            : 0;
      // When compaction has occurred, kept pre-compaction assistant messages carry stale
      // pre-compaction usage and must not overwrite post-compaction context.
      const isPostCompaction =
        latestCompactionTimestamp === 0 || msgTs === 0 || msgTs > latestCompactionTimestamp;
      if (isPostCompaction) {
        contextTokens = i + cr;
        latestTurnTokens = i + cr + o;
      }
    }
  }

  if (contextTokens === 0 && estimatedContextTokens > 0) {
    contextTokens = estimatedContextTokens;
  }

  return { input, output, total, cacheRead, cacheWrite, cost, latestTurnTokens, contextTokens };
}

export function calculateTokenUsage(
  messages: unknown[],
  model: unknown,
  subagentTasks?: UISubagentTask[],
  parentRole?: AgentRole,
): UITokenUsageStats {
  const parent = accumulateUsageFromMessages(messages);

  const byRoleMap = new Map<
    string,
    { role: string; totalTokens: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }
  >();
  const addRole = (
    role: string,
    stats: { input: number; output: number; total: number; cacheRead: number },
  ) => {
    const cur = byRoleMap.get(role) ?? {
      role,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    };
    cur.totalTokens += stats.total;
    cur.inputTokens += stats.input;
    cur.outputTokens += stats.output;
    cur.cacheReadTokens += stats.cacheRead;
    byRoleMap.set(role, cur);
  };

  addRole(parentRole ?? "coordinator", parent);

  let subagentTokens = 0;
  for (const task of subagentTasks ?? []) {
    const s = accumulateUsageFromMessages(task.messages ?? []);
    subagentTokens += s.total;
    addRole(task.role, s);
  }

  const m = model as { contextWindow?: number } | null | undefined;
  const contextWindow =
    typeof m?.contextWindow === "number" && m.contextWindow > 0 ? m.contextWindow : undefined;
  const contextPercent =
    contextWindow && parent.contextTokens > 0
      ? Math.min(100, Math.round((parent.contextTokens / contextWindow) * 1000) / 10)
      : undefined;

  const byRole = [...byRoleMap.values()].filter((r) => r.totalTokens > 0);

  return {
    totalInputTokens: parent.input,
    totalOutputTokens: parent.output,
    totalTokens: parent.total,
    totalCost: parent.cost > 0 ? parent.cost : undefined,
    cacheReadTokens: parent.cacheRead,
    cacheWriteTokens: parent.cacheWrite,
    latestTurnTokens: parent.latestTurnTokens > 0 ? parent.latestTurnTokens : undefined,
    contextTokens: parent.contextTokens > 0 ? parent.contextTokens : undefined,
    contextWindow,
    contextPercent,
    subagentTokens: subagentTokens > 0 ? subagentTokens : undefined,
    runTokens: parent.total + subagentTokens,
    byRole: byRole.length > 0 ? byRole : undefined,
  };
}
