import { useEffect, useRef, type TouchEvent, type WheelEvent } from "react";

const BOTTOM_TOLERANCE = 8;
import type { UIContentBlock, UIMessage } from "../../shared/protocol";
import type { ActiveTool } from "../lib/chat";
import { useT } from "../lib/i18n";
import { Markdown } from "./Markdown";

export function ToolCallCard({ block }: { block: Extract<UIContentBlock, { type: "toolCall" }> }) {
  const args = block.args ? JSON.stringify(block.args, null, 2) : "";
  const isSubagentTool = block.name === "spawn_subagent" || block.name === "abort_subagent" || block.name === "merge_subagent_branch";

  return (
    <details className={`my-2 border-2 bg-card shadow-[var(--pixel-shadow-sm)] ${
      isSubagentTool ? "border-accent/80" : "border-line"
    }`}>
      <summary className="flex cursor-pointer items-center gap-2 border-b border-line/60 px-3 py-2 font-mono text-xs select-none hover:bg-hover">
        <span
          className={`size-2 shrink-0 ${
            block.result
              ? block.result.isError
                ? "bg-red-500"
                : "bg-emerald-500/80"
              : "bg-amber-400 animate-pulse"
          }`}
        />
        <span className={`font-bold ${isSubagentTool ? "text-accent" : "text-ink"}`}>
          {block.name === "spawn_subagent" ? "⚡ spawn_subagent (派发子任务)" : block.name}
        </span>
        <span className="truncate text-faint">{args.slice(0, 80)}</span>
      </summary>
      <div className="p-2.5">
        {args && (
          <pre className="max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted">
            {args}
          </pre>
        )}
        {block.result && (
          <pre
            className={`mt-2 max-h-64 overflow-auto border-t border-line pt-2 font-mono text-xs whitespace-pre-wrap ${
              block.result.isError ? "text-red-500 dark:text-red-400" : "text-ink"
            }`}
          >
            {block.result.text.slice(0, 4000) || "(no output)"}
          </pre>
        )}
      </div>
    </details>
  );
}

export function Thinking({ text }: { text: string }) {
  return (
    <details className="my-2 text-xs">
      <summary className="cursor-pointer font-mono text-faint italic select-none hover:text-accent">
        ▸ thinking…
      </summary>
      <div className="mt-1.5 border-l-2 border-line-bright bg-card/60 px-3 py-2 font-mono text-muted italic whitespace-pre-wrap">
        {text}
      </div>
    </details>
  );
}

export function Blocks({ blocks, markdown }: { blocks: UIContentBlock[]; markdown: boolean }) {
  const t = useT();
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.type) {
          case "text":
            return markdown ? (
              <Markdown key={i} text={b.text} />
            ) : (
              <div key={i} className="whitespace-pre-wrap leading-relaxed">
                {b.text}
              </div>
            );
          case "thinking":
            return <Thinking key={i} text={b.text} />;
          case "toolCall":
            return <ToolCallCard key={i} block={b} />;
          case "image":
            return b.dataUrl ? (
              <img
                key={i}
                src={b.dataUrl}
                alt={t("attachedImage")}
                className="my-1 max-h-64 max-w-full border-2 border-line object-cover"
              />
            ) : (
              <div key={i} className="font-mono text-xs opacity-60">
                {t("imagePlaceholder")}
              </div>
            );
        }
      })}
    </>
  );
}

export function Message({ message }: { message: UIMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] border-2 border-[#c2a9df] bg-bubble px-4 py-2.5 font-mono text-[13.5px] leading-relaxed text-ink shadow-[3px_3px_0_rgba(119,68,180,0.12)] sm:max-w-[75%] dark:border-[#674b88]">
          <Blocks blocks={message.content} markdown={false} />
        </div>
      </div>
    );
  }
  return (
    <div className="text-[14px] leading-relaxed">
      <Blocks blocks={message.content} markdown />
      {message.errorMessage && (
        <div className="mt-2 border-2 border-red-300 bg-red-50 p-3 font-mono text-xs text-red-600 dark:border-red-800 dark:bg-red-950/50 dark:text-red-400">
          {message.errorMessage}
        </div>
      )}
      {message.usage && (
        <div className="mt-1 flex items-center gap-2 font-mono text-[10.5px] text-faint select-none">
          <span>⚡ {(message.usage.totalTokens ?? ((message.usage.input ?? 0) + (message.usage.output ?? 0))).toLocaleString()} tokens</span>
          {message.usage.input != null && message.usage.output != null && (
            <span>(in: {message.usage.input.toLocaleString()}, out: {message.usage.output.toLocaleString()}{message.usage.cacheRead ? `, cache: ${message.usage.cacheRead.toLocaleString()}` : ""})</span>
          )}
        </div>
      )}
    </div>
  );
}

export function MessageList({
  messages,
  streamText,
  streamThinking,
  activeTools,
  isStreaming,
}: {
  messages: UIMessage[];
  streamText: string;
  streamThinking: string;
  activeTools: ActiveTool[];
  isStreaming: boolean;
}) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prevScrollHeight = useRef(0);
  const touchStartY = useRef<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const wasAtBottom =
      el.scrollTop + el.clientHeight >= prevScrollHeight.current - BOTTOM_TOLERANCE;
    prevScrollHeight.current = el.scrollHeight;
    if (stickToBottom.current && wasAtBottom) {
      el.scrollTop = el.scrollHeight;
    }
  });

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_TOLERANCE;
  };

  const handleWheel = (e: WheelEvent) => {
    if (!e.ctrlKey && e.deltaY < 0) stickToBottom.current = false;
  };

  const handleTouchStart = (e: TouchEvent) => {
    touchStartY.current = e.touches[0]?.clientY ?? null;
  };

  const handleTouchMove = (e: TouchEvent) => {
    if (touchStartY.current === null) return;
    const y = e.touches[0]?.clientY;
    if (y != null && y > touchStartY.current) {
      stickToBottom.current = false;
    }
  };

  const last = messages[messages.length - 1];
  const waitingForAssistant =
    !last ||
    last.role === "user" ||
    (last.role === "assistant" && last.content.some((b) => b.type === "toolCall" && b.result));
  const showTyping =
    isStreaming && !streamText && !streamThinking && activeTools.length === 0 && waitingForAssistant;

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      className="thin-scroll min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
        {messages.length === 0 && !streamText && (
          <div className="mt-20 text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center border-2 border-accent bg-purple-dark text-2xl font-black text-accent shadow-[var(--pixel-shadow)]">
              π
            </div>
            <div className="font-mono text-base font-black tracking-widest text-ink">
              PI // CHAT
            </div>
            <div className="mt-2 font-mono text-xs text-faint">{t("emptyPrompt")}</div>
          </div>
        )}
        {messages.map((m, i) => (
          <Message key={i} message={m} />
        ))}
        {streamThinking && <Thinking text={streamThinking} />}
        {streamText && (
          <div className="text-[15px]">
            <Markdown text={streamText} />
          </div>
        )}
        {activeTools.map((tool) => (
          <div key={tool.toolCallId} className="flex items-center gap-2 text-sm text-muted">
            <span className="size-2 animate-pulse rounded-full bg-amber-400" />
            {t("toolRunning", { name: tool.toolName })}
          </div>
        ))}
        {showTyping && (
          <div className="flex items-center gap-1.5 text-faint">
            <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
            <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
            <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
          </div>
        )}
      </div>
    </div>
  );
}
