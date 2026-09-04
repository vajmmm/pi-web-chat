import { useState, useEffect } from "react";
import type { UIQueuedMessage } from "../../shared/protocol";
import { chatClient, useChat } from "../lib/chat";

function QueuedMessageCard({
  item,
  index,
}: {
  item: UIQueuedMessage;
  index: number;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);

  useEffect(() => {
    setDraft(item.text);
  }, [item.text]);

  const handleSave = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== item.text) {
      chatClient.editQueuedMessage(item.id, trimmed);
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    // 用户消息取消排队时退回输入框；子任务上报取消排队直接废弃
    if (item.source === "subagent") {
      chatClient.cancelQueuedMessage(item.id);
    } else {
      chatClient.cancelQueuedMessage(item.id, item.text);
    }
  };

  const handleSendNow = () => {
    chatClient.sendQueuedMessageNow(item.id);
  };

  const timeStr = item.createdAt
    ? new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "";

  const isSubagent = item.source === "subagent";
  const subagentKindLabel = item.kind === "subagent_blocker" ? "⚡ 阻塞上报" : "📋 完结报告";

  return (
    <div className="flex flex-col gap-2 rounded border-2 border-line-bright bg-card p-3 shadow-[var(--pixel-shadow-sm)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-dashed border-line pb-1.5 font-mono text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-bold text-ink">#{index + 1}</span>
          {isSubagent ? (
            <>
              <span className="rounded bg-purple-500/10 px-2 py-0.5 text-[11px] font-bold text-purple-600 dark:text-purple-400">
                {subagentKindLabel}
              </span>
              <span className="font-bold text-ink">{item.taskTitle || item.taskId}</span>
              {item.role && (
                <span className="rounded border border-line bg-canvas px-1.5 py-0.2 text-[10px] text-muted font-mono">
                  @{item.role}
                </span>
              )}
            </>
          ) : (
            <span className="rounded bg-blue-500/10 px-2 py-0.5 text-[11px] font-bold text-blue-600 dark:text-blue-400">
              {item.mode === "steer" ? "⚡ 插话引导 (Steer)" : "⏳ 排队追问 (Follow-up)"}
            </span>
          )}
          {timeStr && <span className="text-[10.5px] text-faint">{timeStr}</span>}
        </div>
        <span className="text-[11px] text-muted">当前轮次完成后将自动执行</span>
      </div>

      <div className="flex flex-col gap-1.5">
        {isEditing ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(6, Math.max(2, draft.split("\n").length))}
              className="w-full resize-y rounded border border-line bg-canvas px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-muted focus:border-accent focus:outline-none"
              placeholder="编辑排队消息内容..."
            />
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setDraft(item.text);
                  setIsEditing(false);
                }}
                className="rounded border border-line px-2.5 py-0.5 font-mono text-xs text-muted hover:bg-canvas hover:text-ink"
              >
                放弃修改
              </button>
              <button
                type="button"
                onClick={handleSave}
                className="rounded border border-accent bg-accent px-2.5 py-0.5 font-mono text-xs font-bold text-accent-ink"
              >
                保存
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded border border-line/60 bg-canvas/60 px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink break-words [overflow-wrap:anywhere] whitespace-pre-wrap select-text">
            {item.text}
          </div>
        )}
      </div>

      {!isEditing && (
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            className="flex items-center gap-1 rounded border border-line px-2.5 py-1 font-mono text-xs font-semibold text-muted hover:border-accent hover:bg-canvas hover:text-ink transition-colors"
            title="修改排队消息内容"
          >
            <span>✏️</span>
            <span>修改</span>
          </button>
          <button
            type="button"
            onClick={handleCancel}
            className="flex items-center gap-1 rounded border border-line px-2.5 py-1 font-mono text-xs font-semibold text-rose-600 hover:border-rose-400 hover:bg-rose-500/10 transition-colors dark:text-rose-400"
            title={isSubagent ? "取消并丢弃该上报" : "取消排队并退回至输入框"}
          >
            <span>❌</span>
            <span>取消排队</span>
          </button>
          <button
            type="button"
            onClick={handleSendNow}
            className="flex items-center gap-1 rounded border border-accent bg-accent/15 px-3 py-1 font-mono text-xs font-bold text-accent hover:bg-accent hover:text-accent-ink transition-all shadow-[var(--pixel-shadow-sm)]"
            title="立即打断/插话至当前运行流并优先执行"
          >
            <span>⚡</span>
            <span>立即发送</span>
          </button>
        </div>
      )}
    </div>
  );
}

export function QueuedMessagesPanel() {
  const { snapshot } = useChat();
  const queuedMessages = snapshot?.queuedMessages ?? [];

  if (queuedMessages.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-4 py-2">
      <div className="flex flex-col gap-2 rounded border-2 border-blue-400/80 bg-blue-50/20 p-3 shadow-[var(--pixel-shadow)] dark:border-blue-600/80 dark:bg-blue-950/20">
        <div className="flex items-center justify-between gap-2 border-b border-dashed border-blue-300 pb-1.5 text-xs font-mono dark:border-blue-700">
          <div className="flex items-center gap-2">
            <span className="inline-block size-2 rounded-full bg-blue-500 animate-pulse" />
            <span className="font-bold text-ink">
              消息队列 (Message Queue) · {queuedMessages.length} 条等待执行
            </span>
          </div>
          <span className="text-[11px] text-muted">支持在当前轮次结束前调整或立即插话</span>
        </div>

        <div className="flex flex-col gap-2.5 pt-1">
          {queuedMessages.map((msg, idx) => (
            <QueuedMessageCard key={msg.id} item={msg} index={idx} />
          ))}
        </div>
      </div>
    </div>
  );
}
