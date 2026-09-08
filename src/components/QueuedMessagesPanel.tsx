import { useState, useEffect, useRef } from "react";
import type { UIQueuedMessage } from "../../shared/protocol";
import { chatClient, useChat } from "../lib/chat";

function QueuedMessageBar({
  item,
}: {
  item: UIQueuedMessage;
  index: number;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(item.text);
  }, [item.text]);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  // Click outside to close dropdown menu
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isMenuOpen]);

  const handleSave = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== item.text) {
      chatClient.editQueuedMessage(item.id, trimmed);
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    if (item.source === "subagent") {
      chatClient.cancelQueuedMessage(item.id);
    } else {
      chatClient.cancelQueuedMessage(item.id, item.text);
    }
  };

  const handleSendNow = () => {
    chatClient.sendQueuedMessageNow(item.id);
  };

  const isSubagent = item.source === "subagent";
  const subagentKindLabel = item.kind === "subagent_blocker" ? "⚡ 阻塞" : "📋 完结";

  return (
    <div className="flex items-center justify-between gap-2.5 rounded-lg border border-line-bright/70 bg-card px-3 py-1.5 shadow-[var(--pixel-shadow-sm)] transition-colors dark:border-line-bright/40 dark:bg-[#1e1a26]">
      {/* Left side: icon, subagent badge, and text */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* Curved turn arrow icon matching GPT style */}
        <svg
          viewBox="0 0 24 24"
          className="size-3.5 shrink-0 text-muted stroke-current fill-none stroke-2"
          aria-hidden
        >
          <path d="M9 10l-5 5 5 5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M20 4v7a4 4 0 0 1-4 4H4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>

        {isSubagent && (
          <div className="flex shrink-0 items-center gap-1">
            <span className="rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-bold text-purple-600 dark:text-purple-400">
              {subagentKindLabel}
            </span>
            {item.role && (
              <span className="rounded border border-line bg-canvas px-1 py-0.2 text-[9.5px] font-mono text-muted">
                @{item.role}
              </span>
            )}
          </div>
        )}

        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
              if (e.key === "Escape") {
                setDraft(item.text);
                setIsEditing(false);
              }
            }}
            className="w-full min-w-0 bg-transparent border-b border-accent px-1 py-0.5 font-mono text-xs text-ink outline-none"
            placeholder="编辑排队消息内容..."
          />
        ) : (
          <span
            className="truncate font-mono text-xs text-ink select-text cursor-default"
            title={item.text}
            onDoubleClick={() => setIsEditing(true)}
          >
            {item.text}
          </span>
        )}
      </div>

      {/* Right side actions */}
      {isEditing ? (
        <div className="flex shrink-0 items-center gap-1.5 font-mono text-xs">
          <button
            type="button"
            onClick={() => {
              setDraft(item.text);
              setIsEditing(false);
            }}
            className="rounded px-2 py-0.5 text-[11px] text-muted hover:bg-canvas hover:text-ink transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded bg-accent px-2.5 py-0.5 text-[11px] font-bold text-accent-ink transition-opacity hover:opacity-90 shadow-[var(--pixel-shadow-sm)]"
          >
            保存
          </button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-1 text-muted">
          {/* ↳ Steer action button */}
          <button
            type="button"
            onClick={handleSendNow}
            className="flex items-center gap-1 rounded px-2 py-1 font-mono text-xs text-muted hover:text-accent hover:bg-hover transition-colors"
            title="立即插话发送 (Steer now)"
          >
            <svg
              viewBox="0 0 24 24"
              className="size-3 stroke-current fill-none stroke-2"
              aria-hidden
            >
              <path d="M9 10l-5 5 5 5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M20 4v7a4 4 0 0 1-4 4H4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>Steer</span>
          </button>

          {/* Delete / Cancel button (Trash icon) */}
          <button
            type="button"
            onClick={handleCancel}
            className="flex size-7 items-center justify-center rounded text-muted hover:text-rose-500 hover:bg-rose-500/10 transition-colors"
            title={isSubagent ? "丢弃该上报" : "取消排队并退回输入框"}
          >
            <svg
              viewBox="0 0 24 24"
              className="size-3.5 stroke-current fill-none stroke-2"
              aria-hidden
            >
              <path
                d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <line x1="10" y1="11" x2="10" y2="17" strokeLinecap="round" />
              <line x1="14" y1="11" x2="14" y2="17" strokeLinecap="round" />
            </svg>
          </button>

          {/* More options menu (...) */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setIsMenuOpen((prev) => !prev)}
              className={`flex size-7 items-center justify-center rounded transition-colors ${
                isMenuOpen ? "bg-hover text-ink" : "text-muted hover:text-ink hover:bg-hover"
              }`}
              title="更多操作"
            >
              <svg viewBox="0 0 24 24" className="size-3.5 fill-current" aria-hidden>
                <circle cx="12" cy="12" r="1.5" />
                <circle cx="19" cy="12" r="1.5" />
                <circle cx="5" cy="12" r="1.5" />
              </svg>
            </button>

            {isMenuOpen && (
              <div className="absolute right-0 bottom-full mb-1.5 z-50 min-w-[130px] rounded border border-line bg-card py-1 shadow-lg font-mono text-xs text-ink animate-in fade-in zoom-in-95">
                <button
                  type="button"
                  onClick={() => {
                    setIsEditing(true);
                    setIsMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover transition-colors"
                >
                  <span>✏️</span>
                  <span>编辑内容</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(item.text);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                    setIsMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover transition-colors"
                >
                  <span>{copied ? "✓" : "📋"}</span>
                  <span>{copied ? "已复制" : "复制文本"}</span>
                </button>
                <div className="my-1 border-t border-line/60" />
                <button
                  type="button"
                  onClick={() => {
                    handleSendNow();
                    setIsMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-accent hover:bg-hover transition-colors"
                >
                  <span>⚡</span>
                  <span>立即发送 (Steer)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleCancel();
                    setIsMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-rose-500 hover:bg-rose-500/10 transition-colors"
                >
                  <span>🗑️</span>
                  <span>取消排队</span>
                </button>
              </div>
            )}
          </div>
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
    <div className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-1 font-mono">
      <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto pr-0.5">
        {queuedMessages.map((msg, idx) => (
          <QueuedMessageBar key={msg.id} item={msg} index={idx} />
        ))}
      </div>
    </div>
  );
}
