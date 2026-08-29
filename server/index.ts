import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  AgentRole,
  ClientCommand,
  ServerEvent,
  RoleConfig,
  UICwdValidateResponse,
  UICustomModelsResponse,
  UICustomProvider,
  UIExtensionInfo,
  UIFsItem,
  UIFsListResponse,
  UIPickDirectoryResponse,
  UIPromptInspection,
  UISessionInfo,
  UISessionFileResponse,
  UISnapshot,
  UIThinkingLevel,
  UITokenUsageStats,
  UIToolItem,
  UIToolSchema,
  UISubscriptionModelsResponse,
} from "../shared/protocol.ts";
import { createCoordinatorExtension } from "./coordinator-tools.ts";
import { performSessionCompaction } from "./compact.ts";
import { getSessionTurns, installTurnRecorderOnSession } from "./turn-recorder.ts";
import { readCustomModels, validateProviders, writeCustomModels } from "./models-config.ts";
import {
  buildUnifiedSystemPrompt,
  buildWorkspaceContextPrompt,
  getAllRoleConfigs,
  getRoleConfig,
  loadRolesConfig,
  saveRolesConfig,
} from "./roles.ts";
import {
  ConstraintResolver,
  PromptAssembler,
  RuntimeEnforcer,
} from "./contracts/index.ts";
import { serializeMessages } from "./serialize.ts";
import { adjustSkillsInBasePrompt, discoverAllSkills } from "./skills.ts";
import { SubagentManager } from "./subagent-manager.ts";
import { getCurrentGitBranch, resolveGitRepoRoot, resolveProjectRoot } from "./worktree.ts";
import {
  deleteFolderSessions,
  deleteProjectSessions,
  deleteSessionFile,
  formatRelativeTime,
  listAllProjects,
  registerKnownProjectPath,
  removeKnownProjectPath,
} from "./projects.ts";

const PORT = Number(process.env.PORT ?? 3141);
// Default to loopback — this server has no auth and can drive a coding agent.
// Override with HOST=0.0.0.0 only on trusted networks.
const HOST = process.env.HOST ?? "127.0.0.1";
const HOME = homedir();
const DEFAULT_AGENT_CWD = join(HOME, ".pi", "web-chat");
const AGENT_CWD = resolve(process.env.PI_WEB_CWD ?? DEFAULT_AGENT_CWD);
mkdirSync(AGENT_CWD, { recursive: true });

// Resolve static assets for both layouts:
//   production package: <pkg>/dist/index.js  + <pkg>/dist/public/
//   dev (tsx server/):  <pkg>/server/index.ts + <pkg>/dist/  (vite default) or dist/public
const HERE = dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  for (const candidate of [join(HERE, "..", "package.json"), join(HERE, "package.json")]) {
    try {
      if (!existsSync(candidate)) continue;
      const v = (JSON.parse(readFileSync(candidate, "utf8")) as { version?: string }).version;
      if (v) return v;
    } catch {
      /* ignore */
    }
  }
  return "unknown";
}
const PACKAGE_VERSION = readPackageVersion();
const DIST_DIR = (() => {
  const candidates = [
    join(HERE, "public"), // dist/index.js → dist/public
    join(HERE, "dist", "public"), // monorepo-style
    join(HERE, "..", "dist", "public"), // server/index.ts → dist/public
    join(HERE, "..", "dist"), // server/index.ts → dist (legacy vite outDir)
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return candidates[0]!;
})();

let modelRuntime = await ModelRuntime.create();
const subagentManager = new SubagentManager(modelRuntime);

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({
    cwd,
    resourceLoaderOptions: {
      appendSystemPromptOverride: () => [],
      extensionFactories: [
        createCoordinatorExtension(subagentManager, () => {
          const currentEntry = Array.from(entries.values()).find(
            (e) => e.runtime.session.sessionManager === sessionManager,
          );
          const model = currentEntry?.runtime.session.model;
          return {
            parentSessionId: currentEntry?.id ?? "",
            parentCwd: cwd,
            parentModel: model ? { provider: model.provider, id: model.id } : null,
            activeRole: currentEntry?.activeRole ?? "coordinator",
            onUpdate: (task) => {
              if (currentEntry) {
                broadcastTo(currentEntry, { type: "subagent_updated", task });
                broadcastSnapshot(currentEntry);
              }
            },
            onReport: (task, reportText) => {
              if (currentEntry) {
                broadcastTo(currentEntry, { type: "subagent_reported", task, reportText });
                if (currentEntry.runtime.session.isStreaming) {
                  currentEntry.pendingReports.push(reportText);
                } else {
                  currentEntry.runtime.session.prompt(reportText).catch(console.error);
                }
                broadcastSnapshot(currentEntry);
              }
            },
          };
        }),
      ],
    },
  });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};

function applyRoleToSession(entry: SessionEntry, role: AgentRole) {
  entry.activeRole = role;
  const session = entry.runtime.session;

  const effectiveContext = ConstraintResolver.resolve({
    role,
    cwd: entry.cwd,
    branchName: entry.gitBranch,
    isGitRepo: entry.isGitRepo,
  });

  // 1. 设置运行时硬权限 (RuntimeEnforcer)
  RuntimeEnforcer.applyPermissionsToSession(session, effectiveContext.permission);

  // 2. 根据角色分层更新系统提示词 (System Prompt)
  if (role === "default") {
    // 标准模式：使用 pi 原生默认提示词，但按 roleConfig.allowedSkills 精准过滤（默认不注入任何 skill）
    (session as any)._systemPromptOverride = undefined;
    const basePrompt = (session as any)._baseSystemPrompt || "";
    session.agent.state.systemPrompt = adjustSkillsInBasePrompt(
      basePrompt,
      effectiveContext.role.allowedSkills ?? [],
      entry.cwd,
    );
  } else {
    // 定制角色：注入分层组装的结构化提示词
    const assembled = PromptAssembler.assemble(effectiveContext);
    (session as any)._systemPromptOverride = assembled.systemPrompt;
    session.agent.state.systemPrompt = assembled.systemPrompt;
  }
}

interface SessionEntry {
  id: string;
  runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
  clients: Set<WebSocket>;
  unsubscribe?: () => void;
  lastActive: number;
  published: boolean;
  activeRole: AgentRole;
  cwd: string;
  isGitRepo: boolean;
  gitBranch?: string;
  isCompacting?: boolean;
  pendingReports: string[];
}

const entries = new Map<string, SessionEntry>();
const pending = new Map<string, Promise<SessionEntry>>();
const wsEntry = new Map<WebSocket, SessionEntry>();
const IDLE_TTL_MS = 15 * 60_000;

function sessionIdOf(file?: string): string {
  if (!file) return "";
  const base = basename(file).replace(/\.jsonl$/, "");
  const i = base.lastIndexOf("_");
  return i >= 0 ? base.slice(i + 1) : base;
}

async function resolveSessionPath(id: string, cwd = AGENT_CWD): Promise<string | undefined> {
  const sessions = await SessionManager.list(cwd);
  const found = sessions.find((s) => sessionIdOf(s.path) === id);
  if (found) return found.path;
  if (cwd !== AGENT_CWD) {
    const fallback = await SessionManager.list(AGENT_CWD);
    return fallback.find((s) => sessionIdOf(s.path) === id)?.path;
  }
  return undefined;
}

function broadcastTo(entry: SessionEntry, event: ServerEvent) {
  const data = JSON.stringify(event);
  for (const ws of entry.clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function publishEntry(entry: SessionEntry, ws?: WebSocket) {
  entry.published = true;
  const event: ServerEvent = { type: "session_bound", sessionId: entry.id };
  if (ws) sendTo(ws, event);
  else broadcastTo(entry, event);
}

function rekeyEntry(entry: SessionEntry) {
  const next = sessionIdOf(entry.runtime.session.sessionFile);
  if (!next || next === entry.id) return;
  entries.delete(entry.id);
  entry.id = next;
  entries.set(next, entry);
  entry.published = true;
  broadcastTo(entry, { type: "session_bound", sessionId: next });
}

async function createEntry(id: string | null, customCwd?: string): Promise<SessionEntry> {
  const effectiveCwd = customCwd && existsSync(customCwd) ? resolve(customCwd) : AGENT_CWD;
  registerKnownProjectPath(effectiveCwd);
  const path = id ? await resolveSessionPath(id, effectiveCwd) : undefined;
  const repoRoot = await resolveGitRepoRoot(effectiveCwd);
  const gitBranch = repoRoot ? (await getCurrentGitBranch(effectiveCwd)) ?? undefined : undefined;

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: effectiveCwd,
    agentDir: getAgentDir(),
    sessionManager: SessionManager.create(effectiveCwd),
  });
  if (path) await runtime.switchSession(path);
  const entry: SessionEntry = {
    id: sessionIdOf(runtime.session.sessionFile),
    runtime,
    clients: new Set(),
    lastActive: Date.now(),
    published: id !== null,
    activeRole: "coordinator",
    cwd: effectiveCwd,
    isGitRepo: !!repoRoot,
    gitBranch,
    pendingReports: [],
  };
  applyRoleToSession(entry, entry.activeRole);
  installTurnRecorderOnSession(runtime.session, () => entry.id);

  entries.set(entry.id, entry);
  bindSession(entry);
  return entry;
}

async function acquireEntry(id: string | null, customCwd?: string): Promise<SessionEntry> {
  if (!id) return createEntry(null, customCwd);
  const hit = entries.get(id);
  if (hit) return hit;
  const inflight = pending.get(id);
  if (inflight) return inflight;
  const p = createEntry(id, customCwd).finally(() => pending.delete(id));
  pending.set(id, p);
  return p;
}

setInterval(() => {
  const now = Date.now();
  for (const entry of [...entries.values()]) {
    if (entry.clients.size > 0 || entry.runtime.session.isStreaming) continue;
    if (now - entry.lastActive < IDLE_TTL_MS) continue;
    entries.delete(entry.id);
    entry.unsubscribe?.();
    void entry.runtime.dispose().catch(() => {});
  }
}, 60_000).unref();

const ALL_THINKING_LEVELS: UIThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function supportedThinkingLevels(model: unknown): UIThinkingLevel[] {
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

function accumulateUsageFromMessages(messages: unknown[]): {
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

function calculateTokenUsage(
  messages: unknown[],
  model: unknown,
  subagentTasks?: import("../shared/protocol.ts").UISubagentTask[],
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

function buildSnapshot(entry: SessionEntry): UISnapshot {
  const session = entry.runtime.session;
  const model = session.model;
  return {
    messages: serializeMessages(session.messages),
    isStreaming: session.isStreaming,
    isCompacting: !!entry.isCompacting,
    model: model
      ? {
          provider: model.provider,
          id: model.id,
          name: (model as { name?: string }).name,
          reasoning: (model as { reasoning?: boolean }).reasoning,
        }
      : null,
    thinkingLevel: session.thinkingLevel as UIThinkingLevel,
    thinkingLevels: supportedThinkingLevels(model),
    sessionFile: session.sessionFile,
    sessionId: entry.id,
    cwd: entry.cwd,
    cwdName: basename(entry.cwd),
    isGitRepo: entry.isGitRepo,
    gitBranch: entry.gitBranch,
    activeRole: entry.activeRole,
    subagents: subagentManager.getTasksForParent(entry.id),
    tokenUsage: calculateTokenUsage(
      session.messages,
      model,
      subagentManager.getTasksForParent(entry.id),
      entry.activeRole,
    ),
  };
}

function broadcastSnapshot(entry: SessionEntry) {
  broadcastTo(entry, { type: "snapshot", snapshot: buildSnapshot(entry) });
}

function bindSession(entry: SessionEntry) {
  entry.unsubscribe?.();
  entry.unsubscribe = entry.runtime.session.subscribe((event) => {
    entry.lastActive = Date.now();
    const broadcast = (e: ServerEvent) => broadcastTo(entry, e);
    switch (event.type) {
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta") {
          broadcast({ type: "delta", kind: "text", delta: e.delta });
        } else if (e.type === "thinking_delta") {
          broadcast({ type: "delta", kind: "thinking", delta: e.delta });
        }
        break;
      }
      case "message_end":
        broadcastSnapshot(entry);
        break;
      case "tool_execution_start":
        broadcast({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName });
        break;
      case "tool_execution_end":
        broadcast({
          type: "tool_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
        });
        broadcastSnapshot(entry);
        break;
      case "agent_start":
        broadcast({ type: "agent_start" });
        break;
      case "agent_end": {
        broadcast({ type: "agent_end" });
        const snap = buildSnapshot(entry);
        snap.isStreaming = false;
        broadcast({ type: "snapshot", snapshot: snap });

        // 检查并消费子任务主动上报队列
        if (entry.pendingReports.length > 0) {
          const nextReport = entry.pendingReports.shift();
          if (nextReport) {
            setTimeout(() => {
              entry.runtime.session
                .prompt(nextReport, {
                  ...(entry.runtime.session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
                })
                .catch(console.error);
            }, 200);
          }
        }
        break;
      }
    }
  });
}

async function handleCommand(cmd: ClientCommand, ws: WebSocket) {
  const entry = wsEntry.get(ws);
  if (!entry) return;
  entry.lastActive = Date.now();
  const runtime = entry.runtime;
  const session = runtime.session;
  switch (cmd.type) {
    case "prompt": {
      const text = cmd.text.trim();
      const images = (cmd.images ?? []).map((img) => ({
        type: "image" as const,
        data: img.data,
        mimeType: img.mimeType,
      }));
      if (!text && images.length === 0) return;
      if (!entry.published) publishEntry(entry, ws);

      session
        .prompt(text, {
          images: images.length > 0 ? images : undefined,
          ...(session.isStreaming ? { streamingBehavior: "steer" as const } : {}),
        })
        .catch((err) => {
          sendTo(ws, { type: "error", message: String(err instanceof Error ? err.message : err) });
        });
      break;
    }
    case "abort":
      await session.abort();
      broadcastSnapshot(entry);
      break;
    case "set_model": {
      const model = modelRuntime.getModel(cmd.provider, cmd.id);
      if (!model) {
        sendTo(ws, { type: "error", message: `Model not found: ${cmd.provider}/${cmd.id}` });
        return;
      }
      await runtime.session.setModel(model);
      broadcastSnapshot(entry);
      break;
    }
    case "set_thinking_level":
      session.setThinkingLevel(cmd.level);
      broadcastSnapshot(entry);
      break;
    case "set_session_role": {
      applyRoleToSession(entry, cmd.role);
      broadcastSnapshot(entry);
      break;
    }
    case "set_session_cwd": {
      const targetCwd = cmd.cwd?.trim();
      if (!targetCwd) return;
      const rawPath = targetCwd.startsWith("~") ? join(HOME, targetCwd.slice(1)) : targetCwd;
      const resolved = resolve(rawPath);
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        sendTo(ws, { type: "error", message: `工作目录不存在或不是文件夹: ${targetCwd}` });
        return;
      }
      if (entry.cwd === resolved) return;

      entry.cwd = resolved;
      registerKnownProjectPath(resolved);
      const repoRoot = await resolveGitRepoRoot(resolved);
      entry.isGitRepo = !!repoRoot;
      entry.gitBranch = repoRoot ? (await getCurrentGitBranch(resolved)) ?? undefined : undefined;

      entry.unsubscribe?.();
      await entry.runtime.dispose().catch(() => {});

      const runtime = await createAgentSessionRuntime(createRuntime, {
        cwd: resolved,
        agentDir: getAgentDir(),
        sessionManager: SessionManager.create(resolved),
      });
      entry.runtime = runtime;
      entry.id = sessionIdOf(runtime.session.sessionFile);
      bindSession(entry);
      broadcastSnapshot(entry);
      break;
    }
    case "abort_subagent":
      await subagentManager.abort(cmd.taskId);
      broadcastSnapshot(entry);
      break;
    case "delete_subagent_task":
      await subagentManager.deleteTask(cmd.taskId);
      broadcastSnapshot(entry);
      break;
    case "clear_subagent_tasks":
      await subagentManager.clearTasksForParent(entry.id);
      broadcastSnapshot(entry);
      break;
    case "fork": {
      const result = await runtime.fork(cmd.entryId);
      if (result.cancelled) return;
      sendTo(ws, { type: "forked", selectedText: result.selectedText });
      break;
    }
    case "compact": {
      if (entry.isCompacting || entry.runtime.session.isStreaming) {
        sendTo(ws, { type: "error", message: "当前正在执行任务或压缩中，请稍候" });
        break;
      }
      try {
        entry.isCompacting = true;
        broadcastSnapshot(entry);
        sendTo(ws, { type: "compaction_start" });
        await performSessionCompaction(runtime.session, modelRuntime, cmd.customInstructions);
        entry.isCompacting = false;
        sendTo(ws, { type: "compaction_end" });
        broadcastSnapshot(entry);
      } catch (err) {
        entry.isCompacting = false;
        sendTo(ws, { type: "compaction_end" });
        broadcastSnapshot(entry);
        sendTo(ws, { type: "error", message: `压缩失败: ${String(err instanceof Error ? err.message : err)}` });
      }
      break;
    }
  }
}

function sendTo(ws: WebSocket, event: ServerEvent) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function reloadModelProviders(providers: UICustomProvider[]): Promise<string | undefined> {
  const previousKeys = new Set(knownCustomProviderKeys);
  knownCustomProviderKeys = new Set(providers.map((p) => p.key));

  try {
    modelRuntime = await ModelRuntime.create();
    subagentManager.updateModelRuntime(modelRuntime);
  } catch (err) {
    return `models.json saved, but reloading failed: ${String(err)}`;
  }

  try {
    for (const entry of entries.values()) {
      const sessionModels = entry.runtime.services.modelRuntime;
      for (const key of previousKeys) {
        if (!knownCustomProviderKeys.has(key)) sessionModels.unregisterProvider(key);
      }
      for (const p of providers) {
        sessionModels.registerProvider(p.key, {
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          api: p.api,
          models: p.models.map((m) => ({
            id: m.id,
            name: m.name ?? m.id,
            reasoning: m.reasoning ?? false,
            input: m.input && m.input.length > 0 ? m.input : ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: m.contextWindow ?? 128_000,
            maxTokens: m.maxTokens ?? 8_192,
          })),
        });
      }
    }
  } catch (err) {
    return `models.json saved, but live reload failed (restart pi --web to apply): ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
  return undefined;
}

let knownCustomProviderKeys = new Set(readCustomModels().providers.map((p) => p.key));

// ---------------------------------------------------------------------------
function shorten(p: string): string {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

const execFileAsync = promisify(execFile);

async function pickDirectoryNative(startPath?: string): Promise<UIPickDirectoryResponse> {
  const platform = process.platform;
  const initial =
    startPath && existsSync(startPath) && statSync(startPath).isDirectory() ? resolve(startPath) : HOME;

  if (platform === "darwin") {
    const escaped = initial.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `set chosenFolder to choose folder with prompt "选择工作区目录:" default location (POSIX file "${escaped}")\nPOSIX path of chosenFolder`;
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", script]);
      const picked = stdout.trim().replace(/\/+$/, "");
      if (picked && existsSync(picked)) {
        return { ok: true, path: picked };
      }
      return { ok: false, error: "未选择有效目录" };
    } catch (err: unknown) {
      const errorMsg = String(err);
      if (errorMsg.includes("User canceled") || errorMsg.includes("-128")) {
        return { ok: false, canceled: true };
      }
      return { ok: false, error: errorMsg, fallback: true };
    }
  }

  if (platform === "win32") {
    const escaped = initial.replace(/'/g, "''");
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "选择工作区目录"
$dialog.ShowNewFolderButton = $true
if (Test-Path '${escaped}') { $dialog.SelectedPath = '${escaped}' }
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
} else {
  exit 2
}
`;
    try {
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        psScript,
      ]);
      const picked = stdout.trim();
      if (picked && existsSync(picked)) {
        return { ok: true, path: picked };
      }
      return { ok: false, error: "未选择有效目录" };
    } catch (err: unknown) {
      const errObj = err as { code?: number; message?: string };
      if (errObj.code === 2) {
        return { ok: false, canceled: true };
      }
      return { ok: false, error: String(err), fallback: true };
    }
  }

  if (platform === "linux") {
    try {
      const { stdout } = await execFileAsync("zenity", [
        "--file-selection",
        "--directory",
        `--filename=${initial}/`,
        "--title=选择工作区目录",
      ]);
      const picked = stdout.trim().replace(/\/+$/, "");
      if (picked && existsSync(picked)) {
        return { ok: true, path: picked };
      }
      return { ok: false, error: "未选择有效目录" };
    } catch (err: unknown) {
      const errorMsg = String(err);
      if (errorMsg.includes("1") || errorMsg.includes("cancelled")) {
        return { ok: false, canceled: true };
      }
      try {
        const { stdout } = await execFileAsync("kdialog", ["--getexistingdirectory", initial]);
        const picked = stdout.trim().replace(/\/+$/, "");
        if (picked && existsSync(picked)) {
          return { ok: true, path: picked };
        }
        return { ok: false, error: "未选择有效目录" };
      } catch {
        return { ok: false, error: "系统原生选择器不可用", fallback: true };
      }
    }
  }

  return { ok: false, error: "当前系统不支持原生目录选择器", fallback: true };
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  try {
    // Lightweight readiness probe (used by `pi --web` before opening the browser).
    if (url.pathname === "/api/health") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, version: PACKAGE_VERSION }));
      return;
    }

    if (url.pathname === "/api/home") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ home: HOME }));
      return;
    }

    // 唤起原生目录选择器 (/api/fs/pick-dir)
    if (url.pathname === "/api/fs/pick-dir" && req.method === "POST") {
      const body = await readBody(req);
      let startPath: string | undefined;
      try {
        const parsed = JSON.parse(body) as { currentPath?: string };
        if (parsed.currentPath?.trim()) {
          const raw = parsed.currentPath.trim();
          startPath = raw.startsWith("~") ? join(HOME, raw.slice(1)) : raw;
        }
      } catch {
        /* ignore */
      }
      const result = await pickDirectoryNative(startPath);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // 目录列表浏览 (/api/fs/list)
    if (url.pathname === "/api/fs/list") {
      const targetQuery = url.searchParams.get("path")?.trim() || HOME;
      const targetPath = targetQuery.startsWith("~") ? join(HOME, targetQuery.slice(1)) : targetQuery;
      const resolved = resolve(targetPath);

      if (!existsSync(resolved)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            currentPath: resolved,
            parentPath: dirname(resolved) !== resolved ? dirname(resolved) : null,
            homePath: HOME,
            items: [],
            error: "目录不存在",
          } satisfies UIFsListResponse),
        );
        return;
      }

      try {
        const isDir = statSync(resolved).isDirectory();
        if (!isDir) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              currentPath: resolved,
              parentPath: dirname(resolved) !== resolved ? dirname(resolved) : null,
              homePath: HOME,
              items: [],
              error: "指定路径不是目录",
            } satisfies UIFsListResponse),
          );
          return;
        }

        const entries = readdirSync(resolved, { withFileTypes: true });
        const items: UIFsItem[] = [];

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith(".") && entry.name !== ".pi") continue;
          const full = join(resolved, entry.name);
          const isGit = existsSync(join(full, ".git"));
          items.push({
            name: entry.name,
            path: full,
            isDirectory: true,
            isGitRepo: isGit,
          });
        }

        items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

        const resp: UIFsListResponse = {
          ok: true,
          currentPath: resolved,
          parentPath: dirname(resolved) !== resolved ? dirname(resolved) : null,
          homePath: HOME,
          items,
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(resp));
        return;
      } catch (err: unknown) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            currentPath: resolved,
            parentPath: dirname(resolved) !== resolved ? dirname(resolved) : null,
            homePath: HOME,
            items: [],
            error: `无法读取目录: ${String(err)}`,
          } satisfies UIFsListResponse),
        );
        return;
      }
    }

    // 工作目录有效性校验 (/api/cwd/validate)
    if (url.pathname === "/api/cwd/validate") {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method not allowed" }));
        return;
      }
      const body = await readBody(req);
      try {
        const { cwd } = JSON.parse(body) as { cwd: string };
        const rawPath = cwd?.trim() || "";
        const targetPath = rawPath.startsWith("~") ? join(HOME, rawPath.slice(1)) : rawPath;
        const resolved = resolve(targetPath);

        if (!existsSync(resolved)) {
          const resp: UICwdValidateResponse = {
            ok: false,
            path: resolved,
            displayPath: shorten(resolved),
            name: basename(resolved),
            isGitRepo: false,
            error: "目录不存在",
          };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(resp));
          return;
        }

        const isDir = statSync(resolved).isDirectory();
        if (!isDir) {
          const resp: UICwdValidateResponse = {
            ok: false,
            path: resolved,
            displayPath: shorten(resolved),
            name: basename(resolved),
            isGitRepo: false,
            error: "指定路径不是目录",
          };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(resp));
          return;
        }

        const repoRoot = await resolveGitRepoRoot(resolved);
        const gitBranch = repoRoot ? (await getCurrentGitBranch(resolved)) ?? undefined : undefined;

        const resp: UICwdValidateResponse = {
          ok: true,
          path: resolved,
          displayPath: shorten(resolved),
          name: basename(resolved),
          isGitRepo: !!repoRoot,
          gitBranch,
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(resp));
        return;
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
        return;
      }
    }

    // 获取或管理全部项目及其下属会话列表 (/api/projects)
    if (url.pathname === "/api/projects") {
      if (req.method === "DELETE") {
        const targetFolder = url.searchParams.get("folder");
        const targetCwd = url.searchParams.get("cwd");

        if (targetFolder) {
          const resDel = await deleteFolderSessions(targetFolder);
          for (const [id, entry] of entries.entries()) {
            if (entry.cwd === resolve(targetFolder)) {
              entries.delete(id);
              await entry.runtime.dispose().catch(() => {});
            }
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(resDel));
          return;
        }

        if (!targetCwd) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "missing cwd or folder parameter" }));
          return;
        }
        const resDel = await deleteProjectSessions(targetCwd);
        const resolvedTarget = resolve(targetCwd);
        for (const [id, entry] of entries.entries()) {
          const entryRoot = (await resolveProjectRoot(entry.cwd)).projectRoot;
          if (entry.cwd === resolvedTarget || entryRoot === resolvedTarget) {
            entries.delete(id);
            await entry.runtime.dispose().catch(() => {});
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(resDel));
        return;
      }

      if (req.method === "POST") {
        const body = await readBody(req);
        try {
          const { cwd } = JSON.parse(body) as { cwd: string };
          const rawPath = cwd?.trim() || "";
          const targetPath = rawPath.startsWith("~") ? join(HOME, rawPath.slice(1)) : rawPath;
          const resolved = resolve(targetPath);
          if (existsSync(resolved) && statSync(resolved).isDirectory()) {
            registerKnownProjectPath(resolved);
          }
          const activeCwds = Array.from(entries.values()).map((e) => e.cwd);
          const projects = await listAllProjects(activeCwds);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(projects));
          return;
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
          return;
        }
      }

      const activeCwds = Array.from(entries.values()).map((e) => e.cwd);
      const projects = await listAllProjects(activeCwds);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(projects));
      return;
    }

    // 删除单个会话 (/api/sessions/:id)
    if (url.pathname.startsWith("/api/sessions/") && req.method === "DELETE") {
      const sessionId = url.pathname.slice("/api/sessions/".length);
      const targetCwd = url.searchParams.get("cwd") || undefined;
      const resDel = await deleteSessionFile(sessionId, targetCwd);
      const activeEntry = entries.get(sessionId);
      if (activeEntry) {
        entries.delete(sessionId);
        await activeEntry.runtime.dispose().catch(() => {});
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(resDel));
      return;
    }

    if (url.pathname === "/api/sessions") {
      const targetCwd = url.searchParams.get("cwd") || AGENT_CWD;
      const effectiveCwd = existsSync(targetCwd) ? resolve(targetCwd) : AGENT_CWD;
      const sessions = await SessionManager.list(effectiveCwd);
      const list: UISessionInfo[] = sessions
        .sort((a, b) => b.modified.getTime() - a.modified.getTime())
        .slice(0, 100)
        .map((s) => ({
          id: sessionIdOf(s.path),
          path: s.path,
          name: s.name,
          firstMessage: s.firstMessage.slice(0, 200),
          modified: s.modified.toISOString(),
          relativeTime: formatRelativeTime(s.modified),
          messageCount: s.messageCount,
          cwd: effectiveCwd,
        }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    if (url.pathname === "/api/models") {
      const models = await modelRuntime.getAvailable();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          models.map((m) => ({
            provider: m.provider,
            id: m.id,
            name: (m as { name?: string }).name,
            reasoning: (m as { reasoning?: boolean }).reasoning,
          })),
        ),
      );
      return;
    }

    if (url.pathname === "/api/subscription-models") {
      const SUBSCRIPTION_PROVIDERS = [
        { id: "openai-codex", name: "OpenAI Codex", envKey: "OPENAI_API_KEY" },
        { id: "xai", name: "xAI Grok", envKey: "XAI_API_KEY" },
        { id: "opencode", name: "OpenCode", envKey: "OPENCODE_API_KEY" },
        { id: "opencode-go", name: "OpenCode Go", envKey: "OPENCODE_API_KEY" },
      ];

      const providers = SUBSCRIPTION_PROVIDERS
        .map((p) => {
          const authStatus = modelRuntime.getProviderAuthStatus(p.id);
          const provider = modelRuntime.getProvider(p.id);
          const models = provider?.getModels() ?? [];
          return {
            id: p.id,
            name: p.name,
            envKey: p.envKey,
            configured: authStatus.configured,
            authSource: authStatus.source,
            models: models.map((m) => ({
              id: m.id,
              name: m.name,
              reasoning: m.reasoning,
            })),
          };
        })
        .filter((p) => p.configured);

      const response: UISubscriptionModelsResponse = { providers };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
      return;
    }

    if (url.pathname === "/api/custom-models") {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(readCustomModels()));
        return;
      }
      if (req.method === "PUT") {
        const body = await readBody(req);
        let providers: UICustomProvider[];
        try {
          providers = (JSON.parse(body) as { providers: UICustomProvider[] }).providers;
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `invalid JSON: ${String(err)}` }));
          return;
        }
        const invalid = validateProviders(providers);
        if (invalid) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: invalid }));
          return;
        }
        writeCustomModels(providers);
        const warning = await reloadModelProviders(providers);
        const result: UICustomModelsResponse = { ...readCustomModels(), warning };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    // 角色配置与看板数据 (~/.pi/agent/roles.json)
    if (url.pathname === "/api/roles") {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(loadRolesConfig()));
        return;
      }
      if (req.method === "PUT") {
        const body = await readBody(req);
        try {
          const { roles } = JSON.parse(body) as { roles: RoleConfig[] };
          if (Array.isArray(roles)) {
            saveRolesConfig(roles);
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(loadRolesConfig()));
          return;
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `invalid JSON: ${String(err)}` }));
          return;
        }
      }
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    if (url.pathname === "/api/fork-points") {
      const entry = entries.get(url.searchParams.get("session") ?? "");
      if (!entry) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
        return;
      }
      const points = entry.runtime.session.getUserMessagesForForking();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(points.map((p) => ({ entryId: p.entryId, text: p.text.slice(0, 200) }))),
      );
      return;
    }

    // 查询指定会话的全部真实历史 LLM Turn 完整请求 Payload
    if (url.pathname === "/api/llm-turns") {
      const sessionId = url.searchParams.get("session") ?? "";
      const taskId = url.searchParams.get("task") ?? "";
      const targetId = taskId || sessionId;

      let targetEntry = sessionId ? entries.get(sessionId) : undefined;
      if (!targetEntry && !taskId && entries.size > 0) {
        targetEntry = entries.values().next().value;
      }
      const effectiveId = taskId || (targetEntry ? targetEntry.id : sessionId);

      const turns = getSessionTurns(effectiveId);
      const response = {
        sessionId: effectiveId,
        sessionFile: targetEntry?.runtime.session.sessionFile,
        totalTurns: turns.length,
        turns,
      };

      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(response));
      return;
    }

    // 实时读取当前会话对应的 session .jsonl 物理文件内容
    if (url.pathname === "/api/session-file") {
      const sessionId = url.searchParams.get("session") ?? "";
      let sessionFilePath: string | undefined;
      let targetEntry = entries.get(sessionId);
      if (!targetEntry && entries.size > 0) {
        targetEntry = entries.values().next().value;
      }
      if (targetEntry) {
        sessionFilePath = targetEntry.runtime.session.sessionFile;
      } else if (sessionId) {
        const customCwd = url.searchParams.get("cwd") || undefined;
        sessionFilePath = await resolveSessionPath(sessionId, customCwd);
      }

      if (!sessionFilePath || !existsSync(sessionFilePath)) {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(
          JSON.stringify({
            sessionId,
            sessionFile: sessionFilePath ?? "",
            exists: false,
            size: 0,
            modified: "",
            lineCount: 0,
            lines: [],
            rawContent: "",
          }),
        );
        return;
      }

      try {
        const stats = statSync(sessionFilePath);
        const rawContent = readFileSync(sessionFilePath, "utf8");
        const rawLines = rawContent.split("\n").filter((l) => l.trim().length > 0);
        const parsedLines = rawLines.map((raw, idx) => {
          let parsed: Record<string, unknown> | undefined;
          let type = "unknown";
          try {
            parsed = JSON.parse(raw);
            if (parsed && typeof parsed.type === "string") {
              type = parsed.type;
            }
          } catch {
            /* ignore JSON parse error for malformed lines */
          }
          return {
            lineNumber: idx + 1,
            type,
            raw,
            parsed,
          };
        });

        const response: UISessionFileResponse = {
          sessionId,
          sessionFile: sessionFilePath,
          exists: true,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          relativeTime: formatRelativeTime(stats.mtime),
          lineCount: parsedLines.length,
          lines: parsedLines,
          rawContent,
        };

        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(response));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `读取会话文件失败: ${String(err)}` }));
      }
      return;
    }

    if (url.pathname === "/api/extensions") {
      const anyEntry = entries.values().next().value as SessionEntry | undefined;
      if (!anyEntry) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ extensions: [], errors: [] }));
        return;
      }
      const { extensions, errors } = anyEntry.runtime.session.resourceLoader.getExtensions();
      const shorten = (p: string) => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);
      const list: UIExtensionInfo[] = extensions.map((ext) => {
        const { sourceInfo } = ext;
        let name: string;
        let packageName: string | undefined;
        if (sourceInfo.origin === "package") {
          packageName = sourceInfo.source.replace(/^npm:/, "");
          const rel = relative(sourceInfo.baseDir ?? dirname(ext.path), ext.path)
            .replace(/\.(ts|js|mjs|cjs)$/, "")
            .replace(/\/index$/, "")
            .replace(/^index$/, "")
            .replace(/^(src\/)?(extensions\/)?/, "");
          name = rel && rel !== "src" ? rel : packageName;
        } else {
          name = basename(ext.path).replace(/\.(ts|js|mjs|cjs)$/, "");
        }
        return {
          name,
          packageName,
          path: shorten(ext.path),
          scope: sourceInfo.scope,
          tools: [...ext.tools.keys()],
          commands: [...ext.commands.keys()],
          flags: [...ext.flags.keys()],
          events: [...ext.handlers.keys()],
        };
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          extensions: list,
          errors: errors.map((e) => ({ path: shorten(e.path), error: e.error })),
        }),
      );
      return;
    }

    if (url.pathname === "/api/tools") {
      const anyEntry = entries.values().next().value as SessionEntry | undefined;
      const toolsMap = new Map<string, UIToolItem>();

      // 核心基础工具 (Pi 官方内置)
      toolsMap.set("read", { name: "read", label: "读取文件 (read)", description: "读取指定文件的文本或代码内容", category: "core" });
      toolsMap.set("bash", { name: "bash", label: "终端命令 (bash)", description: "执行系统终端 bash 命令 (支持编译、测试、Git 及任意命令)", category: "core" });
      toolsMap.set("edit", { name: "edit", label: "精准编辑 (edit)", description: "按文本匹配对文件进行局部精准替换", category: "core" });
      toolsMap.set("write", { name: "write", label: "新建/覆写 (write)", description: "创建新文件或完全重写已有文件", category: "core" });
      toolsMap.set("grep", { name: "grep", label: "内容正则检索 (grep)", description: "Pi 原生结构化代码正则搜索（免启动 Shell，安全防爆）", category: "core" });
      toolsMap.set("find", { name: "find", label: "文件路径查找 (find)", description: "Pi 原生按 Glob 模式快速查找文件名与路径", category: "core" });
      toolsMap.set("ls", { name: "ls", label: "目录清单查看 (ls)", description: "Pi 原生快速列出目录结构与文件大小", category: "core" });

      // 统筹者工具
      toolsMap.set("list_available_roles", { name: "list_available_roles", label: "查询可用角色 (list_roles)", description: "查询当前支持的所有子智能体角色列表与能力", category: "subagents" });
      toolsMap.set("spawn_subagent", { name: "spawn_subagent", label: "派发子任务 (spawn_subagent)", description: "派发一个独立的异步子智能体任务并在独立工作区运行", category: "subagents" });
      toolsMap.set("abort_subagent", { name: "abort_subagent", label: "中断子任务 (abort_subagent)", description: "取消或中断正在后台运行的子任务", category: "subagents" });
      toolsMap.set("list_subagents", { name: "list_subagents", label: "列出子任务 (list_subagents)", description: "列出当前会话派发的所有子任务及其运行状态", category: "subagents" });

      // 测试与发布专属工具
      toolsMap.set("apit_send_api_event", {
        name: "apit_send_api_event",
        label: "API测试事件 (apit_event)",
        description: "发送或预览接口测试事件到 Kafka (来自 apiautotest 扩展)",
        category: "custom",
      });
      toolsMap.set("apit_send_performance_events", {
        name: "apit_send_performance_events",
        label: "性能压测 (apit_perf)",
        description: "执行自动化性能/负载测试场景 (来自 apiautotest 扩展)",
        category: "custom",
      });
      toolsMap.set("release_apiv3_monitor", {
        name: "release_apiv3_monitor",
        label: "发布流水线 (release_apiv3)",
        description: "执行 monitor-refactor 项目的发布流水线步骤 (来自 release-apiv3 扩展)",
        category: "custom",
      });

      // 如果有运行中的 session，收集所有动态注册的扩展工具
      if (anyEntry) {
        for (const t of anyEntry.runtime.session.getAllTools()) {
          if (!toolsMap.has(t.name)) {
            toolsMap.set(t.name, {
              name: t.name,
              label: (t as { label?: string }).label || t.name,
              description: t.description || "",
              category: "custom",
            });
          }
        }
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.from(toolsMap.values())));
      return;
    }

    if (url.pathname === "/api/skills") {
      const anyEntry = entries.values().next().value as SessionEntry | undefined;
      const cwd = url.searchParams.get("cwd") || anyEntry?.cwd;
      const skills = discoverAllSkills(cwd);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ skills }));
      return;
    }

    if (url.pathname === "/api/prompt-inspector") {
      const sessionId = url.searchParams.get("session");
      let entry = sessionId ? entries.get(sessionId) : undefined;
      if (!entry && entries.size > 0) {
        entry = entries.values().next().value;
      }
      if (!entry) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no active session" }));
        return;
      }

      const session = entry.runtime.session;
      const role = entry.activeRole;
      const roleConfig = getRoleConfig(role);
      const workspacePrompt = buildWorkspaceContextPrompt({
        cwd: entry.cwd,
        isCoordinator: role === "coordinator",
        branchName: entry.gitBranch,
      });

      const activeToolNames = new Set(session.getActiveToolNames());
      const allTools = session.getAllTools();
      const tools: UIToolSchema[] = allTools
        .filter((t) => activeToolNames.has(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description,
          parameters: (t.parameters ?? {}) as Record<string, unknown>,
          promptGuidelines: t.promptGuidelines,
        }));

      const systemPrompt = session.systemPrompt;
      const messages = serializeMessages(session.messages);

      const sysChars = systemPrompt.length;
      const msgChars = JSON.stringify(messages).length;
      const toolsChars = JSON.stringify(tools).length;
      const estimatedTokens = {
        systemPrompt: Math.round(sysChars / 3.5),
        messages: Math.round(msgChars / 3.5),
        tools: Math.round(toolsChars / 3.5),
        total: Math.round((sysChars + msgChars + toolsChars) / 3.5),
      };

      const roles = getAllRoleConfigs();

      const resp: UIPromptInspection = {
        systemPrompt,
        rolePrompt: roleConfig.systemPrompt,
        workspacePrompt,
        activeRole: role,
        cwd: entry.cwd,
        cwdName: basename(entry.cwd),
        gitBranch: entry.gitBranch,
        model: session.model
          ? {
              provider: session.model.provider,
              id: session.model.id,
              name: (session.model as { name?: string }).name,
              reasoning: (session.model as { reasoning?: boolean }).reasoning,
            }
          : null,
        thinkingLevel: session.thinkingLevel as UIThinkingLevel,
        messages,
        rawMessagesCount: session.messages.length,
        tools,
        estimatedTokens,
        subagentRoles: roles.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          systemPrompt: r.systemPrompt,
          model: r.model,
        })),
      };

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(resp));
      return;
    }

    if (url.pathname === "/api/state") {
      const requested = url.searchParams.get("session");
      const entry = requested ? entries.get(requested) : undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          entry
            ? buildSnapshot(entry)
            : {
                activeSessions: [...entries.values()].map((e) => ({
                  id: e.id,
                  clients: e.clients.size,
                  isStreaming: e.runtime.session.isStreaming,
                })),
              },
        ),
      );
      return;
    }

    if (existsSync(DIST_DIR)) {
      let filePath = join(DIST_DIR, url.pathname === "/" ? "index.html" : url.pathname);
      if (!filePath.startsWith(DIST_DIR) || !existsSync(filePath)) {
        filePath = join(DIST_DIR, "index.html"); // SPA fallback
      }
      const ext = extname(filePath);
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
      res.end(readFileSync(filePath));
      return;
    }

    res.writeHead(404);
    res.end("Not found. Run `npm run build` first, or use `npm run dev`.");
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
  }
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws, req) => {
  const urlObj = new URL(req.url ?? "/ws", "http://localhost");
  const requested = urlObj.searchParams.get("session");
  const requestedCwd = urlObj.searchParams.get("cwd") || undefined;
  const queue: ClientCommand[] = [];
  let ready = false;

  ws.on("message", (raw) => {
    let cmd: ClientCommand;
    try {
      cmd = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!ready) {
      queue.push(cmd);
      return;
    }
    handleCommand(cmd, ws).catch((err) => {
      sendTo(ws, { type: "error", message: String(err instanceof Error ? err.message : err) });
    });
  });

  acquireEntry(requested, requestedCwd)
    .then((entry) => {
      if (ws.readyState !== ws.OPEN) return;
      entry.clients.add(ws);
      entry.lastActive = Date.now();
      wsEntry.set(ws, entry);
      if (entry.published || requested) {
        publishEntry(entry, ws);
      }
      sendTo(ws, { type: "snapshot", snapshot: buildSnapshot(entry) });
      ready = true;
      for (const cmd of queue.splice(0)) {
        handleCommand(cmd, ws).catch((err) => {
          sendTo(ws, { type: "error", message: String(err instanceof Error ? err.message : err) });
        });
      }
    })
    .catch((err) => {
      sendTo(ws, { type: "error", message: String(err instanceof Error ? err.message : err) });
      ws.close();
    });

  ws.on("close", () => {
    const entry = wsEntry.get(ws);
    if (entry) {
      entry.clients.delete(ws);
      entry.lastActive = Date.now();
      wsEntry.delete(ws);
    }
  });
});

httpServer.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  console.log(
    `pi-web-chat server: http://${displayHost}:${PORT}  (bind ${HOST}, chat cwd: ${AGENT_CWD})`,
  );
});
