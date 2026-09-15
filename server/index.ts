import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { WebSocketServer } from "ws";
import type {
  ClientCommand,
  UICustomProvider,
} from "../shared/protocol.ts";
import { createCoordinatorExtension } from "./coordinator-tools.ts";
import { createCodexImagegenExtension } from "./codex-imagegen-extension.ts";
import { createProductDesignExtension } from "./product-design-extension.ts";
import { createWebSearchExtension } from "./web-search-extension.ts";
import { getCompactionInstructions } from "./compact.ts";
import {
  createRecoveryTools,
} from "./subagent/agent-runtime.ts";
import {
  createTaskContextExtension,
  restoreLatestRecoveryManifest,
  type TaskContextRuntimeState,
} from "./subagent/compaction-evidence-index.ts";
import { initializeTaskFactStore } from "./runtime-artifacts.ts";
import { readCustomModels } from "./models-config.ts";
import { sanitizeEmptyAvailableModelIds } from "./auth-config.ts";
import { startBackgroundCatalogRefresh } from "./model-catalog.ts";
import { SubagentManager } from "./subagent-manager.ts";
import { getCurrentGitBranch, recoverRuntimeResources, resolveGitRepoRoot } from "./worktree.ts";
import { registerKnownProjectPath } from "./projects.ts";
import {
  bindExistingSession,
  isPendingDeletion,
  sessionIdOf,
  SessionRegistry,
  type SessionEntry,
} from "./session/index.ts";
import {
  bindCoordinatorSessionRuntime,
  bindSessionEvents,
  broadcastSnapshot as broadcastEntrySnapshot,
  broadcastTo,
  handleCommand,
  publishEntry,
  sendTo,
} from "./ws/index.ts";
import { buildSnapshot } from "./session/snapshot.ts";
import { handleHttpRequest, type ServerContext } from "./http/index.ts";
import { isTrustedHost, isTrustedOrigin } from "./http/origin-guard.ts";
import { getMainSessionCapabilities } from "./session/capabilities.ts";
import { SubagentReportDispatcher } from "./subagent/report-dispatcher.ts";

const PORT = Number(process.env.PORT ?? 3141);
// Default to loopback — this server has no auth and can drive a coding agent.
// Override with HOST=0.0.0.0 only on trusted networks.
const HOST = process.env.HOST ?? "127.0.0.1";
const HOME = homedir();
const DEFAULT_AGENT_CWD = join(HOME, ".pi", "web-chat");
const AGENT_CWD = resolve(process.env.PI_WEB_CWD ?? DEFAULT_AGENT_CWD);
mkdirSync(AGENT_CWD, { recursive: true });

// Process-level safety net (S2): a single bad WebSocket frame, a missing
// 'error' listener, or a rejected promise deep in a handler must never take the
// whole coding-agent server down. Log and keep serving other connections
// instead of exiting. Registered before any async work at import time.
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException (kept alive):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection (kept alive):", reason);
});

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

// Empty availableModelIds (e.g. stale GitHub Copilot OAuth) hides all provider models from getAvailable().
sanitizeEmptyAvailableModelIds();
let modelRuntime = await ModelRuntime.create();
const subagentManager = new SubagentManager(modelRuntime);

// Startup recovery of persisted git runtime resources
try {
  const root = await resolveGitRepoRoot(AGENT_CWD);
  if (root) {
    await recoverRuntimeResources(root);
  }
} catch {
  /* best effort on startup */
}

const sessionRegistry = new SessionRegistry();
const entries = sessionRegistry.entries;
const wsEntry = sessionRegistry.wsEntry;
sessionRegistry.isDeleting = (id) => subagentManager.isDeleting(id) || isPendingDeletion(id);

sessionRegistry.startIdlePruning(
  (sessionId) => {
    if (isPendingDeletion(sessionId) || subagentManager.isDeleting(sessionId)) return false;
    if (subagentManager.hasActiveTasksForParent(sessionId)) return false;
    if (subagentManager.isCoordinatorActive(sessionId)) return false;
    const entry = sessionRegistry.get(sessionId);
    if (entry?.queuedMessages && entry.queuedMessages.length > 0) return false;
    return true;
  },
  undefined,
  undefined,
  // 兜底 GC:空闲 session 被 prune 后,回收其残留的 worktree/分支。
  // cleanupRunResourcesForParent 自带 ownership+namespace 双重校验与 fail-closed,不会误删无关资源。
  async (sessionId, cwdHint) => {
    try {
      await subagentManager.cleanupRunResourcesForParent(sessionId, cwdHint);
    } catch (err) {
      console.warn(`[IdleSweep] worktree reclaim failed for pruned session ${sessionId}:`, err);
    }
  },
);

function broadcastSnapshot(entry: SessionEntry) {
  broadcastEntrySnapshot(entry, subagentManager);
}

const subagentReportDispatcher = new SubagentReportDispatcher({
  sessionRegistry,
  subagentManager,
  isPendingDeletion,
  broadcastSnapshot,
});

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  // The canonical session ID is only known once the runtime binds the session
  // file (see sessionIdOf(runtime.session.sessionFile)). Never invent a
  // temporary artifact scope: event handlers resolve this bound scope only.
  let recoveryScope: { runId: string; taskId: string } | undefined;
  const taskContextState: TaskContextRuntimeState = { compactionCount: 0 };
  const bindRecoveryScope = (scope: { runId: string; taskId: string }) => {
    recoveryScope = scope;
    initializeTaskFactStore(scope.runId, scope.taskId);
    restoreLatestRecoveryManifest(taskContextState, scope.runId, scope.taskId);
  };
  const services = await createAgentSessionServices({
    cwd,
    resourceLoaderOptions: {
      appendSystemPromptOverride: () => [],
      extensionFactories: [
        createTaskContextExtension({
          getScope: () => recoveryScope,
          role: "coordinator",
          state: taskContextState,
          getSettingsManager: () => services.settingsManager,
          getModel: () => {
            const currentEntry = Array.from(entries.values()).find(
              (e) => e.runtime.session.sessionManager === sessionManager,
            );
            return currentEntry?.runtime.session.model;
          },
        }),
        createCodexImagegenExtension(),
        createProductDesignExtension(),
        createWebSearchExtension(),
        createCoordinatorExtension(subagentManager, () => {
          const currentEntry = Array.from(entries.values()).find(
            (e) => e.runtime.session.sessionManager === sessionManager,
          );
          const model = currentEntry?.runtime.session.model;
          return {
            parentSessionId: currentEntry?.id ?? "",
            parentCwd: cwd,
            parentModel: model ? { provider: model.provider, id: model.id } : null,
            getMainSessionCapabilities: () =>
              getMainSessionCapabilities(currentEntry?.runtime.session.model),
            activeRole: currentEntry?.activeRole ?? "coordinator",
            onUpdate: (task) => {
              if (currentEntry) {
                broadcastTo(currentEntry, { type: "subagent_updated", task });
              }
            },
            onReport: async (
              task: any,
              reportText: string,
              metadata?: { kind?: "terminal" | "blocker" },
            ) => {
              if (!currentEntry) return;
              await subagentReportDispatcher.handleReport(currentEntry, task, reportText, metadata);
            },
          };
        }),
      ],
    },
  });
  services.settingsManager.applyOverrides({
    compaction: {
      triggerRatio: 0.8,
      customInstructions: getCompactionInstructions(),
    },
  });
  const result = await createAgentSessionFromServices({
    services,
    sessionManager,
    sessionStartEvent,
    customTools: createRecoveryTools(() => {
      if (!recoveryScope) throw new Error("Coordinator recovery scope is not bound");
      return recoveryScope;
    }),
  });
  (result.session as any).__bindRecoveryScope = bindRecoveryScope;
  return {
    ...result,
    services,
    diagnostics: services.diagnostics,
  };
};

async function createEntry(id: string | null, customCwd?: string): Promise<SessionEntry> {
  let effectiveCwd: string;
  let path: string | undefined;
  if (id) {
    const bound = await bindExistingSession(id, customCwd, AGENT_CWD);
    path = bound.path;
    effectiveCwd = bound.cwd;
  } else {
    effectiveCwd = customCwd && existsSync(customCwd) ? resolve(customCwd) : AGENT_CWD;
  }
  registerKnownProjectPath(effectiveCwd);
  const repoRoot = await resolveGitRepoRoot(effectiveCwd);
  const gitBranch = repoRoot ? (await getCurrentGitBranch(effectiveCwd)) ?? undefined : undefined;

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: effectiveCwd,
    agentDir: getAgentDir(),
    sessionManager: path
      ? SessionManager.open(path, undefined, effectiveCwd)
      : SessionManager.create(effectiveCwd),
    ...(path
      ? { sessionStartEvent: { type: "session_start" as const, reason: "resume" as const } }
      : {}),
  });
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
    queuedMessages: [],
  };
  bindCoordinatorSessionRuntime(entry);

  sessionRegistry.set(entry.id, entry);
  bindSessionEvents(entry, subagentManager, () => modelRuntime);
  return entry;
}

async function acquireEntry(id: string | null, customCwd?: string): Promise<SessionEntry> {
  return sessionRegistry.acquire(id, () => createEntry(id, customCwd));
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
      if (isPendingDeletion(entry.id) || subagentManager.isDeleting(entry.id)) continue;
      await sessionRegistry.trackInFlightOp(entry.id, async () => {
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
              maxTokens: m.maxTokens ?? 131_072,
            })),
          });
        }
      });
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
const serverContext: ServerContext = {
  sessionRegistry,
  subagentManager,
  getModelRuntime: () => modelRuntime,
  homeDir: HOME,
  agentCwd: AGENT_CWD,
  distDir: DIST_DIR,
  packageVersion: PACKAGE_VERSION,
  createRuntime,
  reloadModelProviders,
  updateModelRuntime: (newRuntime) => {
    modelRuntime = newRuntime;
  },
};

const httpServer = createServer(async (req, res) => {
  await handleHttpRequest(req, res, serverContext);
});

const wss = new WebSocketServer({
  server: httpServer,
  path: "/ws",
  // CSWSH + DNS-rebinding guard at the handshake (S1): reject cross-site
  // Origins and untrusted Host headers before the socket is established.
  // Non-browser clients send no Origin and are allowed (isTrustedOrigin).
  verifyClient: (info: { req: IncomingMessage }) =>
    isTrustedOrigin(info.req) && isTrustedHost(info.req),
});

// Server-level error sink (S2): errors emitted on the WebSocketServer itself
// (e.g. during upgrade) must not become an uncaughtException.
wss.on("error", (err) => {
  console.error("[server] WebSocketServer error:", err);
});

wss.on("connection", (ws, req) => {
  // Per-socket error sink (S2): `ws` is an EventEmitter; an unhandled 'error'
  // event would propagate as an uncaughtException and crash the process. Log
  // and let the 'close' handler clean up.
  ws.on("error", (err) => {
    console.error("[server] WebSocket connection error:", err);
  });

  const urlObj = new URL(req.url ?? "/ws", "http://localhost");
  const requested = urlObj.searchParams.get("session");
  const requestedCwd = urlObj.searchParams.get("cwd") || undefined;
  const queue: ClientCommand[] = [];
  let ready = false;

  const commandHandlerCtx = {
    sessionRegistry,
    subagentManager,
    getModelRuntime: () => modelRuntime,
    homeDir: HOME,
    agentCwd: AGENT_CWD,
    createRuntime,
  };

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
    handleCommand(cmd, ws, commandHandlerCtx).catch((err) => {
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
      sendTo(ws, { type: "snapshot", snapshot: buildSnapshot(entry, subagentManager) });
      ready = true;
      for (const cmd of queue.splice(0)) {
        handleCommand(cmd, ws, commandHandlerCtx).catch((err) => {
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

// Standalone catalog freshness (non-blocking): the web app must not depend on a
// prior `pi` CLI run having populated the local models-store cache. Refresh the
// official catalog over the network while the server is already listening;
// bounded and fail-open, so startup never waits on the network.
void startBackgroundCatalogRefresh(modelRuntime);
