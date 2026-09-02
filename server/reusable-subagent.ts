import { randomUUID } from "node:crypto";
import type { AgentRole, UIMessage, UISubagentTask } from "../shared/protocol.ts";

export const MAX_SUBAGENT_REUSE = 3;
export const MAX_KNOWLEDGE_CHARS = 4000;
export const MAX_FACTS_PER_BUCKET = 8;

export type ReusableSubagentState = "running" | "idle_reusable" | "retired";

export interface SubagentKnowledge {
  repoFacts: string[];
  environmentFacts: string[];
  relevantFiles: string[];
  knownCommands: string[];
  failedApproaches: string[];
  topics: string[];
}

export interface ReusableSubagent {
  agentId: string;
  parentSessionId: string;
  role: AgentRole;
  model?: string;
  state: ReusableSubagentState;
  lastTaskId?: string;
  lastTaskTitle?: string;
  knowledge: SubagentKnowledge;
  reuseCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReusableAgentListItem {
  agentId: string;
  role: AgentRole;
  state: ReusableSubagentState;
  lastTaskId?: string;
  lastTaskTitle?: string;
  topics: string[];
  reuseCount: number;
  maxReuse: number;
  knowledgePreview: {
    environmentFacts: string[];
    relevantFiles: string[];
    knownCommands: string[];
    failedApproaches: string[];
  };
}

export function createEmptyKnowledge(): SubagentKnowledge {
  return {
    repoFacts: [],
    environmentFacts: [],
    relevantFiles: [],
    knownCommands: [],
    failedApproaches: [],
    topics: [],
  };
}

function uniqPush(list: string[], value: string, max = MAX_FACTS_PER_BUCKET): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (list.some((x) => x.toLowerCase() === trimmed.toLowerCase())) return;
  if (list.length >= max) return;
  list.push(trimmed);
}

function knowledgeCharCount(k: SubagentKnowledge): number {
  return JSON.stringify(k).length;
}

export function truncateKnowledge(k: SubagentKnowledge): SubagentKnowledge {
  const next: SubagentKnowledge = {
    repoFacts: [...k.repoFacts],
    environmentFacts: [...k.environmentFacts],
    relevantFiles: [...k.relevantFiles],
    knownCommands: [...k.knownCommands],
    failedApproaches: [...k.failedApproaches],
    topics: [...k.topics],
  };
  const buckets: Array<keyof SubagentKnowledge> = [
    "failedApproaches",
    "repoFacts",
    "relevantFiles",
    "knownCommands",
    "environmentFacts",
    "topics",
  ];
  while (knowledgeCharCount(next) > MAX_KNOWLEDGE_CHARS) {
    let shrunk = false;
    for (const key of buckets) {
      if (next[key].length > 0) {
        next[key].pop();
        shrunk = true;
        break;
      }
    }
    if (!shrunk) break;
  }
  return next;
}

export function mergeKnowledge(prev: SubagentKnowledge, incoming: SubagentKnowledge): SubagentKnowledge {
  const out = createEmptyKnowledge();
  for (const item of [...prev.repoFacts, ...incoming.repoFacts]) uniqPush(out.repoFacts, item);
  for (const item of [...prev.environmentFacts, ...incoming.environmentFacts]) {
    uniqPush(out.environmentFacts, item);
  }
  for (const item of [...prev.relevantFiles, ...incoming.relevantFiles]) {
    uniqPush(out.relevantFiles, item);
  }
  for (const item of [...prev.knownCommands, ...incoming.knownCommands]) {
    uniqPush(out.knownCommands, item);
  }
  for (const item of [...prev.failedApproaches, ...incoming.failedApproaches]) {
    uniqPush(out.failedApproaches, item);
  }
  for (const item of [...prev.topics, ...incoming.topics]) uniqPush(out.topics, item, 12);
  return truncateKnowledge(out);
}

const PATH_RE = /(?:^|[\s`"'(=])((?:\/[\w.-]+)+(?:\/[\w.-]+)*|(?:docs|src|test|tests|server|shared)\/[\w./-]+)/g;
const ENV_LINE_RE =
  /(?:python|pytest|node|npm|pnpm|yarn|bun|pip|conda)[^\n]{0,120}/gi;
const VERSION_RE =
  /(?:Python\s+\d+\.\d+(?:\.\d+)?|pytest\s+\d+\.\d+(?:\.\d+)?|v?\d+\.\d+\.\d+)/gi;

interface CommandAttempt {
  command: string;
  output: string;
}

function collectTextFromMessages(messages: UIMessage[] | undefined): {
  successAttempts: CommandAttempt[];
  failedAttempts: CommandAttempt[];
  assistantText: string[];
} {
  const successAttempts: CommandAttempt[] = [];
  const failedAttempts: CommandAttempt[] = [];
  const assistantText: string[] = [];

  for (const msg of messages ?? []) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "text" && block.text) {
        assistantText.push(block.text);
      } else if (block.type === "toolCall") {
        const args = block.args as { command?: string; path?: string; file_path?: string } | undefined;
        const command =
          typeof args?.command === "string"
            ? args.command
            : typeof args?.path === "string"
              ? `read ${args.path}`
              : typeof args?.file_path === "string"
                ? `read ${args.file_path}`
                : "";
        if (!command) continue;
        const output = (block.result?.text ?? "").slice(0, 240);
        const attempt = { command, output };
        if (block.result?.isError === true) {
          failedAttempts.push(attempt);
        } else {
          successAttempts.push(attempt);
        }
      }
    }
  }

  return { successAttempts, failedAttempts, assistantText };
}

/** Only stable environment/path unavailability — not ordinary test or transient run failures. */
function isStableEnvOrPathFailure(command: string, output: string): boolean {
  const text = `${command}\n${output}`.toLowerCase();
  if (
    /\b(assertionerror|test suite failed|failed tests\/|failures=\d+|error during test|traceback \(most recent call last\))\b/.test(
      text,
    )
  ) {
    return false;
  }
  return (
    /no such file|does not exist|enoent|command not found|not found|no such path|cannot find|is not recognized/.test(
      text,
    ) && output.trim().length > 0
  );
}

function inferTopics(knowledge: SubagentKnowledge, taskTitle?: string): string[] {
  const topics: string[] = [];
  const corpus = [
    taskTitle ?? "",
    ...knowledge.knownCommands,
    ...knowledge.environmentFacts,
    ...knowledge.relevantFiles,
    ...knowledge.failedApproaches,
  ]
    .join(" ")
    .toLowerCase();

  const candidates: Array<[string, RegExp]> = [
    ["pytest", /\bpytest\b/],
    ["python", /\bpython\b|\bpy3\d\b/],
    ["node", /\bnode\b|\bnpm\b|\bpnpm\b/],
    ["shell", /\bbash\b|\bshell\b|\bprocess\b/],
    ["evidence", /evidence|docs\//],
    ["login", /login|auth|endpoint/],
    ["soak", /soak|fault/],
  ];
  for (const [topic, re] of candidates) {
    if (re.test(corpus)) uniqPush(topics, topic, 8);
  }
  return topics;
}

/**
 * Rule-based knowledge extraction from a completed task.
 * Never copies transcript messages — only short facts/commands/paths.
 */
export function extractKnowledgeFromTask(task: UISubagentTask): SubagentKnowledge {
  const knowledge = createEmptyKnowledge();
  const collected = collectTextFromMessages(task.messages);

  for (const attempt of collected.successAttempts) {
    const compact = attempt.command.replace(/\s+/g, " ").trim();
    if (
      /\b(python|pytest|node|npm|pnpm|yarn|bun|pip|conda|which|pwd|--version|-v)\b/i.test(compact) ||
      compact.length <= 120
    ) {
      uniqPush(knowledge.knownCommands, compact.slice(0, 160));
    }
  }

  for (const attempt of collected.successAttempts) {
    const out = attempt.output;
    for (const m of out.match(ENV_LINE_RE) ?? []) {
      uniqPush(knowledge.environmentFacts, m.replace(/\s+/g, " ").slice(0, 160));
    }
    for (const m of out.match(VERSION_RE) ?? []) {
      uniqPush(knowledge.environmentFacts, m.replace(/\s+/g, " ").slice(0, 80));
    }
    for (const m of out.matchAll(PATH_RE)) {
      const p = m[1];
      if (p && (p.includes("python") || p.includes("conda") || p.includes("node") || p.includes("/bin/"))) {
        uniqPush(knowledge.environmentFacts, p.slice(0, 200));
      } else if (p) {
        uniqPush(knowledge.relevantFiles, p.slice(0, 200));
      }
    }
  }

  for (const attempt of collected.failedAttempts) {
    const cmd = attempt.command.replace(/\s+/g, " ").trim().slice(0, 120);
    const out = attempt.output.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!isStableEnvOrPathFailure(cmd, out)) continue;
    uniqPush(knowledge.failedApproaches, `${cmd} -> ${out}`);
  }

  for (const file of task.changedFiles ?? []) {
    uniqPush(knowledge.relevantFiles, file);
  }

  for (const text of collected.assistantText) {
    for (const m of text.matchAll(PATH_RE)) {
      const p = m[1];
      if (!p) continue;
      if (p.includes("python") || p.includes("conda") || p.includes("/bin/")) {
        uniqPush(knowledge.environmentFacts, p.slice(0, 200));
      } else {
        uniqPush(knowledge.relevantFiles, p.slice(0, 200));
      }
    }
    if (/\b(monorepo|worktree|read-only|soak)\b/i.test(text)) {
      const hit = text.match(/\b(monorepo|worktree|read-only|soak)[^.!\n]{0,80}/i);
      if (hit) uniqPush(knowledge.repoFacts, hit[0].replace(/\s+/g, " ").slice(0, 120));
    }
  }

  knowledge.topics = inferTopics(knowledge, task.taskTitle);
  return truncateKnowledge(knowledge);
}

export function formatKnowledgeForPrompt(knowledge: SubagentKnowledge): string {
  const lines: string[] = ["## Reusable Knowledge", "Allow using prior project/environment facts below."];

  if (knowledge.environmentFacts.length) {
    lines.push("", "Known environment:");
    for (const f of knowledge.environmentFacts) lines.push(`- ${f}`);
  }
  if (knowledge.relevantFiles.length) {
    lines.push("", "Relevant paths:");
    for (const f of knowledge.relevantFiles) lines.push(`- ${f}`);
  }
  if (knowledge.knownCommands.length) {
    lines.push("", "Known commands:");
    for (const f of knowledge.knownCommands) lines.push(`- ${f}`);
  }
  if (knowledge.repoFacts.length) {
    lines.push("", "Known facts:");
    for (const f of knowledge.repoFacts) lines.push(`- ${f}`);
  }
  if (knowledge.failedApproaches.length) {
    lines.push("", "Failed approaches to avoid:");
    for (const f of knowledge.failedApproaches) lines.push(`- ${f}`);
  }

  return lines.join("\n");
}

export function buildContinueBoundaryPrompt(input: {
  taskId: string;
  goal: string;
  scopeInclude?: string[];
  acceptanceCriteria?: string[];
  knowledge: SubagentKnowledge;
}): string {
  const scope = (input.scopeInclude ?? ["*"]).join(", ");
  const criteria = (input.acceptanceCriteria ?? []).map((c) => `- ${c}`).join("\n") || "- (none provided)";

  return [
    "===== NEW TASK =====",
    "",
    `TaskId: ${input.taskId}`,
    `Goal: ${input.goal}`,
    `Scope: ${scope}`,
    "Acceptance Criteria:",
    criteria,
    "",
    "上一任务已经结束。",
    "",
    "允许继续使用之前获得的项目和环境知识。",
    "",
    "但不得继承上一任务的：",
    "- Scope",
    "- Acceptance Criteria",
    "- 权限",
    "- Task 状态",
    "- 未完成假设",
    "",
    "本任务以新的 TaskContract 为唯一约束。",
    "",
    formatKnowledgeForPrompt(input.knowledge),
  ].join("\n");
}

export function toReusableAgentListItem(agent: ReusableSubagent): ReusableAgentListItem {
  return {
    agentId: agent.agentId,
    role: agent.role,
    state: agent.state,
    lastTaskId: agent.lastTaskId,
    lastTaskTitle: agent.lastTaskTitle,
    topics: agent.knowledge.topics.slice(0, 8),
    reuseCount: agent.reuseCount,
    maxReuse: MAX_SUBAGENT_REUSE,
    knowledgePreview: {
      environmentFacts: agent.knowledge.environmentFacts.slice(0, 5),
      relevantFiles: agent.knowledge.relevantFiles.slice(0, 8),
      knownCommands: agent.knowledge.knownCommands.slice(0, 5),
      failedApproaches: agent.knowledge.failedApproaches.slice(0, 5),
    },
  };
}

export class ReusableSubagentRegistry {
  private agents = new Map<string, ReusableSubagent>();

  create(input: {
    parentSessionId: string;
    role: AgentRole;
    taskId: string;
    taskTitle?: string;
    model?: string;
    agentId?: string;
  }): ReusableSubagent {
    const now = new Date().toISOString();
    const agent: ReusableSubagent = {
      agentId: input.agentId ?? `agent-${randomUUID()}`,
      parentSessionId: input.parentSessionId,
      role: input.role,
      model: input.model,
      state: "running",
      lastTaskId: input.taskId,
      lastTaskTitle: input.taskTitle,
      knowledge: createEmptyKnowledge(),
      reuseCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.agents.set(agent.agentId, agent);
    return agent;
  }

  get(agentId: string): ReusableSubagent | undefined {
    return this.agents.get(agentId);
  }

  listForParent(parentSessionId: string): ReusableSubagent[] {
    return [...this.agents.values()]
      .filter((a) => a.parentSessionId === parentSessionId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  markCompleted(agentId: string, task: UISubagentTask): ReusableSubagent {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Reusable agent not found: ${agentId}`);
    }
    if (agent.state === "retired") return agent;

    const extracted = extractKnowledgeFromTask(task);
    agent.knowledge = mergeKnowledge(agent.knowledge, extracted);
    agent.lastTaskId = task.taskId;
    agent.lastTaskTitle = task.taskTitle;
    agent.updatedAt = new Date().toISOString();

    if (agent.reuseCount >= MAX_SUBAGENT_REUSE) {
      agent.state = "retired";
    } else {
      agent.state = "idle_reusable";
    }
    return agent;
  }

  markFailed(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent || agent.state === "retired") return;
    // Do not update knowledge. Keep agent retired on failure.
    agent.state = "retired";
    agent.updatedAt = new Date().toISOString();
  }

  beginContinue(
    agentId: string,
    taskId: string,
    taskTitle: string,
  ): { ok: true; agent: ReusableSubagent } | { ok: false; error: string } {
    const agent = this.agents.get(agentId);
    if (!agent) return { ok: false, error: `Reusable agent not found: ${agentId}` };
    if (agent.state !== "idle_reusable") {
      return { ok: false, error: `Agent ${agentId} is not idle_reusable (state=${agent.state})` };
    }
    if (agent.reuseCount >= MAX_SUBAGENT_REUSE) {
      agent.state = "retired";
      agent.updatedAt = new Date().toISOString();
      return {
        ok: false,
        error: `Agent ${agentId} reached max reuse limit (${MAX_SUBAGENT_REUSE})`,
      };
    }

    agent.reuseCount += 1;
    agent.state = "running";
    agent.lastTaskId = taskId;
    agent.lastTaskTitle = taskTitle;
    agent.updatedAt = new Date().toISOString();

    if (agent.reuseCount > MAX_SUBAGENT_REUSE) {
      agent.state = "retired";
      return { ok: false, error: `Agent ${agentId} exceeded max reuse limit` };
    }

    return { ok: true, agent };
  }

  /**
   * Undo beginContinue when spawn/start fails so the agent does not stay stuck in running.
   */
  rollbackContinue(
    agentId: string,
    previous: {
      reuseCount: number;
      lastTaskId?: string;
      lastTaskTitle?: string;
    },
  ): void {
    const agent = this.agents.get(agentId);
    if (!agent || agent.state === "retired") return;
    agent.reuseCount = previous.reuseCount;
    agent.lastTaskId = previous.lastTaskId;
    agent.lastTaskTitle = previous.lastTaskTitle;
    agent.state = "idle_reusable";
    agent.updatedAt = new Date().toISOString();
  }

  retire(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.state = "retired";
    agent.updatedAt = new Date().toISOString();
  }

  clearForParent(parentSessionId: string): number {
    let count = 0;
    for (const [id, agent] of this.agents) {
      if (agent.parentSessionId === parentSessionId) {
        this.agents.delete(id);
        count++;
      }
    }
    return count;
  }
}
