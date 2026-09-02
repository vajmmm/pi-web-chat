import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WebSocket } from "ws";
import {
  createAgentSessionRuntime,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import type { ClientCommand } from "../../shared/protocol.ts";
import { performSessionCompaction } from "../compact.ts";
import { registerKnownProjectPath } from "../projects.ts";
import { applyRoleToSession } from "../session/role-binding.ts";
import { sessionIdOf, type SessionEntry, type SessionRegistry } from "../session/session-registry.ts";
import type { SubagentManager } from "../subagent-manager.ts";
import { getCurrentGitBranch, resolveGitRepoRoot } from "../worktree.ts";
import { bindSessionEvents } from "./session-binding.ts";
import { broadcastSnapshot, publishEntry, sendTo } from "./websocket-server.ts";

export interface CommandHandlerContext {
  sessionRegistry: SessionRegistry;
  subagentManager: SubagentManager;
  getModelRuntime: () => ModelRuntime;
  get modelRuntime(): ModelRuntime;
  homeDir: string;
  agentCwd: string;
  createRuntime: CreateAgentSessionRuntimeFactory;
}

export async function handleCommand(
  cmd: ClientCommand,
  ws: WebSocket,
  ctx: CommandHandlerContext,
): Promise<void> {
  const { sessionRegistry, subagentManager, homeDir, agentCwd, createRuntime } = ctx;
  const modelRuntime = ctx.getModelRuntime();
  const entry = sessionRegistry.getByWs(ws);
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
      broadcastSnapshot(entry, subagentManager);
      break;
    case "set_model": {
      const model = modelRuntime.getModel(cmd.provider, cmd.id);
      if (!model) {
        sendTo(ws, { type: "error", message: `Model not found: ${cmd.provider}/${cmd.id}` });
        return;
      }
      await runtime.session.setModel(model);
      broadcastSnapshot(entry, subagentManager);
      break;
    }
    case "set_thinking_level":
      session.setThinkingLevel(cmd.level);
      broadcastSnapshot(entry, subagentManager);
      break;
    case "set_session_role": {
      applyRoleToSession(entry, cmd.role);
      broadcastSnapshot(entry, subagentManager);
      break;
    }
    case "set_session_cwd": {
      const targetCwd = cmd.cwd?.trim();
      if (!targetCwd) return;
      const rawPath = targetCwd.startsWith("~") ? join(homeDir, targetCwd.slice(1)) : targetCwd;
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

      const newRuntime = await createAgentSessionRuntime(createRuntime, {
        cwd: resolved,
        agentDir: getAgentDir(),
        sessionManager: SessionManager.create(resolved),
      });
      entry.runtime = newRuntime;
      entry.id = sessionIdOf(newRuntime.session.sessionFile);
      bindSessionEvents(entry, subagentManager);
      broadcastSnapshot(entry, subagentManager);
      break;
    }
    case "abort_subagent":
      await subagentManager.abort(cmd.taskId);
      broadcastSnapshot(entry, subagentManager);
      break;
    case "delete_subagent_task":
      await subagentManager.deleteTask(cmd.taskId);
      broadcastSnapshot(entry, subagentManager);
      break;
    case "clear_subagent_tasks":
      await subagentManager.clearTasksForParent(entry.id);
      broadcastSnapshot(entry, subagentManager);
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
        broadcastSnapshot(entry, subagentManager);
        sendTo(ws, { type: "compaction_start" });
        await performSessionCompaction(runtime.session, modelRuntime, cmd.customInstructions);
        entry.isCompacting = false;
        sendTo(ws, { type: "compaction_end" });
        broadcastSnapshot(entry, subagentManager);
      } catch (err) {
        entry.isCompacting = false;
        sendTo(ws, { type: "compaction_end" });
        broadcastSnapshot(entry, subagentManager);
        sendTo(ws, { type: "error", message: `压缩失败: ${String(err instanceof Error ? err.message : err)}` });
      }
      break;
    }
  }
}
