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
import { bindCoordinatorSessionRuntime, bindSessionEvents, extractUserMessageTexts } from "./session-binding.ts";
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

type QueueDispatchSession = {
  steer: (text: string) => Promise<void>;
  followUp: (text: string) => Promise<void>;
};

/**
 * Re-dispatch a queued user message as steer/followUp without blocking the WS
 * command handler. The operation is intentionally fire-and-forget, but its
 * rejection (queue/session divergence, abort race) must be captured here so it
 * cannot surface as an unhandledRejection.
 */
function dispatchQueueItem(
  session: QueueDispatchSession,
  item: { mode?: string; text: string },
  sessionId: string,
): void {
  const op = item.mode === "steer" ? session.steer(item.text) : session.followUp(item.text);
  op.catch((err: unknown) => {
    console.error(
      `[CommandHandler] queued message re-dispatch failed (session=${sessionId}, mode=${item.mode ?? "followUp"}):`,
      err,
    );
  });
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
        const userMsgCount = extractUserMessageTexts(
          (session as { messages?: unknown[] }).messages,
        ).length;
        entry.queuedMessages.push({
          id,
          text,
          mode: "followUp",
          createdAt: new Date().toISOString(),
          // Ignore transcript user turns that already existed before this enqueue.
          deliverAfterUserMsgCount: userMsgCount,
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
        await runtime.session.setModel(model, { persist: true });
        // Rebind the Main Session against the live active model. This updates the
        // capability-gated tools and the next-turn prompt without touching subagents.
        applyRoleToSession(entry, entry.activeRole);
        broadcastSnapshot(entry, subagentManager);
      });
      break;
    }
    case "set_thinking_level":
      await sessionRegistry.trackInFlightOp(entry.id, async () => {
        session.setThinkingLevel(cmd.level, { persist: true });
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

        // The new runtime's session carries its own recovery scope / turn recorder /
        // shadow transcript subscriber; rebind them exactly like createEntry does
        // before wiring transport events (bindSessionEvents owns entry.unsubscribe).
        bindCoordinatorSessionRuntime(entry);
        bindSessionEvents(entry, subagentManager, ctx.getModelRuntime);
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
      // Text changed; previous expanded sessionText is stale until re-queued/expanded.
      delete target.sessionText;

      const itemsToRequeue = [...entry.queuedMessages];
      session.clearQueue();
      entry.queuedMessages = itemsToRequeue;
      for (const item of itemsToRequeue) {
        dispatchQueueItem(session, item, entry.id);
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
        dispatchQueueItem(session, item, entry.id);
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
        // 立即打断当前运行，等待其真正进入 idle（abort 完成后）再启动新一轮。
        // 这替代了旧的 steer 语义（steer 需等当前 assistant turn 执行完工具调用）。
        await session.abort();
      }
      // 其余排队消息在 abort 完成之后、prompt 之前逐个恢复排队；
      // 此时会话已非 streaming，按既有模式走 followUp 排队。
      for (const remaining of remainingItems) {
        dispatchQueueItem(session, remaining, entry.id);
      }
      void sessionRegistry.trackInFlightOp(entry.id, async () => {
        try {
          await session.prompt(item.text);
        } catch (err) {
          sendTo(ws, { type: "error", message: String(err instanceof Error ? err.message : err) });
        }
      });
      broadcastSnapshot(entry, subagentManager);
      break;
    }
  }
}
