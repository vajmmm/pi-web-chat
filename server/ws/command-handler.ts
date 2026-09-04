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
import { isCanonicalRole } from "../contracts/index.ts";
import { applyRoleToSession } from "../session/role-binding.ts";
import { sessionIdOf, type SessionEntry, type SessionRegistry } from "../session/session-registry.ts";
import type { SubagentManager } from "../subagent-manager.ts";
import { getCurrentGitBranch, resolveGitRepoRoot } from "../worktree.ts";
import { bindSessionEvents } from "./session-binding.ts";
import { broadcastSnapshot, publishEntry, sendTo } from "./websocket-server.ts";

import { isPendingDeletion } from "../session/deletion-tombstone.ts";

export interface CommandHandlerContext {
  sessionRegistry: SessionRegistry;
  subagentManager: SubagentManager;
  getModelRuntime: () => ModelRuntime;
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

  // 0. Deletion Gate: 若当前会话处于正在删除或 pending deletion 状态，拒绝所有新命令
  if (isPendingDeletion(entry.id) || subagentManager.isDeleting(entry.id)) {
    sendTo(ws, { type: "error", message: `会话 ${entry.id} 正在删除中，禁止执行操作` });
    return;
  }

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

      if (session.isStreaming) {
        // Agent 正在流式/运行中：进入 followUp 消息队列排队等待当前轮次自然结束后执行
        const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        if (!entry.queuedMessages) entry.queuedMessages = [];
        entry.queuedMessages.push({
          id,
          text,
          mode: "followUp",
          createdAt: new Date().toISOString(),
        });
        await session.followUp(text, images.length > 0 ? images : undefined);
        broadcastSnapshot(entry, subagentManager);
        break;
      }

      sessionRegistry.trackInFlightOp(entry.id, async () => {
        try {
          await session.prompt(text, {
            images: images.length > 0 ? images : undefined,
          });
        } catch (err) {
          sendTo(ws, { type: "error", message: String(err instanceof Error ? err.message : err) });
        }
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
      await sessionRegistry.trackInFlightOp(entry.id, async () => {
        await runtime.session.setModel(model);
        broadcastSnapshot(entry, subagentManager);
      });
      break;
    }
    case "set_thinking_level":
      await sessionRegistry.trackInFlightOp(entry.id, async () => {
        session.setThinkingLevel(cmd.level);
        broadcastSnapshot(entry, subagentManager);
      });
      break;
    case "set_session_role": {
      if (!isCanonicalRole(cmd.role)) {
        sendTo(ws, {
          type: "error",
          message: `[WebSocket] 未知或非法的角色: ${String(cmd.role)}。仅支持 canonical roles。`,
        });
        return;
      }
      try {
        await sessionRegistry.trackInFlightOp(entry.id, async () => {
          applyRoleToSession(entry, cmd.role);
          broadcastSnapshot(entry, subagentManager);
        });
      } catch (err: any) {
        sendTo(ws, {
          type: "error",
          message: err.message || `设置角色失败: ${String(cmd.role)}`,
        });
      }
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

      await sessionRegistry.trackInFlightOp(entry.id, async () => {
        const repoRoot = await resolveGitRepoRoot(resolved);
        const gitBranch = repoRoot ? (await getCurrentGitBranch(resolved)) ?? undefined : undefined;

        const newRuntime = await createAgentSessionRuntime(createRuntime, {
          cwd: resolved,
          agentDir: getAgentDir(),
          sessionManager: SessionManager.create(resolved),
        });

        try {
          await entry.runtime.dispose();
        } catch (err) {
          try {
            await newRuntime.dispose();
          } catch (rollbackErr) {
            entry.pendingReplacementRuntime = newRuntime;
            throw new AggregateError(
              [err, rollbackErr],
              `Failed to dispose old runtime and failed to rollback new runtime for session ${entry.id}`,
            );
          }
          throw err;
        }

        entry.unsubscribe?.();
        entry.unsubscribe = undefined;
        entry.runtime = newRuntime;
        entry.cwd = resolved;
        registerKnownProjectPath(resolved);
        entry.isGitRepo = !!repoRoot;
        entry.gitBranch = gitBranch;
        sessionRegistry.rekey(entry);

        bindSessionEvents(entry, subagentManager);
        broadcastSnapshot(entry, subagentManager);
      });
      break;
    }
    case "abort_subagent": {
      const task = subagentManager.getTask(cmd.taskId);
      if (!task || task.parentSessionId !== entry.id) {
        sendTo(ws, { type: "error", message: `无权中止不属于当前会话的子任务 ${cmd.taskId}` });
        return;
      }
      await subagentManager.abort(cmd.taskId, { source: "user" });
      broadcastSnapshot(entry, subagentManager);
      break;
    }
    case "delete_subagent_task": {
      const task = subagentManager.getTask(cmd.taskId);
      if (!task || task.parentSessionId !== entry.id) {
        sendTo(ws, { type: "error", message: `无权删除不属于当前会话的子任务 ${cmd.taskId}` });
        return;
      }
      const ok = await subagentManager.deleteTask(cmd.taskId);
      if (!ok) {
        sendTo(ws, {
          type: "error",
          message: `删除子任务 ${cmd.taskId} 失败：任务仍在运行或未能确认安全停止 (Fail-closed)`,
        });
      }
      broadcastSnapshot(entry, subagentManager);
      break;
    }
    case "clear_subagent_tasks": {
      try {
        await subagentManager.clearTasksForParent(entry.id);
      } catch (err) {
        sendTo(ws, {
          type: "error",
          message: `清理子任务失败：${String(err instanceof Error ? err.message : err)} (Fail-closed)`,
        });
      }
      broadcastSnapshot(entry, subagentManager);
      break;
    }
    case "fork": {
      await sessionRegistry.trackInFlightOp(entry.id, async () => {
        const result = await runtime.fork(cmd.entryId);
        if (result.cancelled) return;
        sendTo(ws, { type: "forked", selectedText: result.selectedText });
      });
      break;
    }
    case "compact": {
      if (entry.isCompacting || entry.runtime.session.isStreaming) {
        sendTo(ws, { type: "error", message: "当前正在执行任务或压缩中，请稍候" });
        break;
      }
      await sessionRegistry.trackInFlightOp(entry.id, async () => {
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
      });
      break;
    }
    case "edit_queued_message": {
      if (!entry.queuedMessages) break;
      const target = entry.queuedMessages.find((m) => m.id === cmd.id);
      if (!target) break;
      target.text = cmd.text.trim();

      const itemsToRequeue = [...entry.queuedMessages];
      session.clearQueue();
      entry.queuedMessages = itemsToRequeue;
      for (const item of itemsToRequeue) {
        if (item.mode === "steer") {
          void session.steer(item.text);
        } else {
          void session.followUp(item.text);
        }
      }
      broadcastSnapshot(entry, subagentManager);
      break;
    }
    case "cancel_queued_message": {
      if (!entry.queuedMessages) break;
      const idx = entry.queuedMessages.findIndex((m) => m.id === cmd.id);
      if (idx === -1) break;
      entry.queuedMessages.splice(idx, 1);
      const itemsToRequeue = [...entry.queuedMessages];

      session.clearQueue();
      entry.queuedMessages = itemsToRequeue;
      for (const item of itemsToRequeue) {
        if (item.mode === "steer") {
          void session.steer(item.text);
        } else {
          void session.followUp(item.text);
        }
      }
      broadcastSnapshot(entry, subagentManager);
      break;
    }
    case "send_queued_message_now": {
      if (!entry.queuedMessages) break;
      const idx = entry.queuedMessages.findIndex((m) => m.id === cmd.id);
      if (idx === -1) break;
      const [item] = entry.queuedMessages.splice(idx, 1);
      const remainingItems = [...entry.queuedMessages];

      session.clearQueue();
      entry.queuedMessages = remainingItems;
      if (session.isStreaming) {
        // 作为 steer 立即插话并介入当前运行流
        void session.steer(item.text);
        for (const remaining of remainingItems) {
          if (remaining.mode === "steer") {
            void session.steer(remaining.text);
          } else {
            void session.followUp(remaining.text);
          }
        }
      } else {
        for (const remaining of remainingItems) {
          if (remaining.mode === "steer") {
            void session.steer(remaining.text);
          } else {
            void session.followUp(remaining.text);
          }
        }
        void sessionRegistry.trackInFlightOp(entry.id, async () => {
          try {
            await session.prompt(item.text);
          } catch (err) {
            sendTo(ws, { type: "error", message: String(err instanceof Error ? err.message : err) });
          }
        });
      }
      broadcastSnapshot(entry, subagentManager);
      break;
    }
  }
}
