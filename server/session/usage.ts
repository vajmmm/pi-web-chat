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
  for (const m of messages as any[]) {
    if (!m || typeof m !== "object") continue;
    // compactionSummary stores content in 'summary', not 'content'
    const str =
      typeof m.summary === "string" && m.role === "compactionSummary"
        ? m.summary
        : typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content ?? "");
    estimatedContextTokens += Math.ceil(str.length / 3.5);

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
    latestTurnTokens = i + cr + o;
    // Only assistant messages carry meaningful context window occupancy (input + cacheRead).
    // toolResult messages have usage from tool execution where input/cacheRead are 0,
    // which would incorrectly overwrite the real context size.
    if (m.role === "assistant") {
      contextTokens = i + cr;
    }
  }

  const hasCompaction = (messages as any[]).some((m) => m?.role === "compactionSummary");
  if (hasCompaction && (contextTokens === 0 || estimatedContextTokens < contextTokens)) {
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
