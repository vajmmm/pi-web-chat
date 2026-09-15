import { useEffect, useRef, type TouchEvent, type WheelEvent } from "react";

const BOTTOM_TOLERANCE = 8;
import type { UIContentBlock, UIMessage } from "../../shared/protocol";
import {
  looksLikeHtmlErrorPage,
  sanitizeProviderErrorMessage,
} from "../../shared/provider-error";
import type { ActiveTool } from "../lib/chat";
import { useT } from "../lib/i18n";
import { LazyMarkdown } from "./LazyMarkdown";

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
            if (looksLikeHtmlErrorPage(b.text)) {
              return (
                <div
                  key={i}
                  className="mt-2 border-2 border-red-300 bg-red-50 p-3 font-mono text-xs text-red-600 dark:border-red-800 dark:bg-red-950/50 dark:text-red-400 break-words [overflow-wrap:anywhere]"
                >
                  {sanitizeProviderErrorMessage(b.text)}
                </div>
              );
            }
            return markdown ? (
              <LazyMarkdown key={i} text={b.text} />
            ) : (
              <div key={i} className="whitespace-pre-wrap leading-relaxed break-words [overflow-wrap:anywhere]">
                {b.text}
              </div>
            );
          case "thinking":
            return <Thinking key={i} text={b.text} />;
          case "toolCall":
            return <ToolCallCard key={i} block={b} />;
          case "image":
            return b.dataUrl ? (
              <div key={i} className="my-1">
                <a href={b.dataUrl} download="generated-image" className="inline-block">
                  <img
                    src={b.dataUrl}
                    alt={t("attachedImage")}
                    className="max-h-64 max-w-full border-2 border-line object-cover"
                  />
                </a>
                <a
                  href={b.dataUrl}
                  download="generated-image"
                  className="mt-1 block font-mono text-xs text-accent underline underline-offset-2"
                >
                  下载图片
                </a>
              </div>
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

/**
 * UIMessage has no stable id in the shared protocol (out of scope to add one), so
 * the top-level list key is a composite: bound session + position + role +
 * first-block shape. The session prefix is the important part — it stops keys
 * from being reused across a session switch, which previously let uncontrolled
 * DOM state (<details> expand, <img> load) bleed into the next session's messages
 * at the same array position. toolCall ids are stable when present; text/thinking
 * contribute only their type so a first block that grows during streaming never
 * forces a mid-stream remount of an otherwise unchanged message.
 */
function firstBlockKey(m: UIMessage): string {
  const first = m.content[0];
  if (!first) return "empty";
  switch (first.type) {
    case "toolCall":
      return `toolCall:${first.id}`;
    case "text":
      return "text";
    case "thinking":
      return "thinking";
    case "image":
      return "image";
  }
}

function messageKey(m: UIMessage, index: number, sessionId: string | null | undefined): string {
  return `${sessionId ?? "-"}::${index}::${m.role}::${firstBlockKey(m)}`;
}

export function Message({ message }: { message: UIMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end min-w-0">
        <div className="max-w-[85%] border-2 border-[#c2a9df] bg-bubble px-4 py-2.5 font-mono text-[13.5px] leading-relaxed text-ink shadow-[3px_3px_0_rgba(119,68,180,0.12)] sm:max-w-[75%] dark:border-[#674b88] break-words [overflow-wrap:anywhere] min-w-0">
          <Blocks blocks={message.content} markdown={false} />
        </div>
      </div>
    );
  }
  return (
    <div className="text-[14px] leading-relaxed break-words [overflow-wrap:anywhere] min-w-0">
      <Blocks blocks={message.content} markdown />
      {message.errorMessage && (
        <div className="mt-2 border-2 border-red-300 bg-red-50 p-3 font-mono text-xs text-red-600 dark:border-red-800 dark:bg-red-950/50 dark:text-red-400 break-words [overflow-wrap:anywhere]">
          {sanitizeProviderErrorMessage(message.errorMessage)}
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
  sessionId,
}: {
  messages: UIMessage[];
  streamText: string;
  streamThinking: string;
  activeTools: ActiveTool[];
  isStreaming: boolean;
  /** When defined (including null), a change resets stick-to-bottom for the new session. */
  sessionId?: string | null;
}) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  /**
   * 底部跟随 스크롤 (스트리밍 중 "덜덜덜" 흔들림 방지):
   *
   * 1. 위로 올리려는 의도는 wheel/touch에서 동기로 해제한다.
   *    - wheel: deltaY < 0 (ctrl+휠 핀치 줌 제외)
   *    - touch: 손가락이 시작점보다 아래로 움직인 즉시 (임계값 없음).
   * 2. 재고정은 진짜 바닥(여유 8px)에서만 한다.
   * 3. snap 전에 "직전 렌더 시점에 바닥이었는지"를 확인한다. 렌더 이후엔
   *    DOM이 이미 자랐으므로 직전 scrollHeight와 비교해야 한다.
   * 4. 재고정을 다시 허용하는 신호는 두 가지뿐이다.
   *    (a) 아래로 내리려는 동기 입력(wheel down / touch up). scroll 이벤트가
   *        프레임 단위로 늦게 도착하는 동안에도 먼저 도착한다.
   *    (b) 진짜 바닥(≤8px)에 닿은 scroll.
   *    scrollTop이 증가했다는 이유로 재허용하면 안 된다: 직전 snap이 만든
   *    지연된 scroll 이벤트(scrollTop 증가)가 사용자의 wheel-up 해제 직후
   *    도착해 다시 고정시켜 버린다(위로 올렸는데 매 프레임 바닥으로 끌림).
   *    이 경합이 없으면 다음 영구 고착이 생긴다: 사용자가 바닥으로
   *    되돌아오는 도중 실제 scroll 이벤트는 늦게 도착하는데 그 사이
   *    스트리밍 렌더가 내용을 먼저 키워버린다. 그러면 onScroll은 (자라난)
   *    scrollHeight 기준으로 거리 > 8px를 보고 stick을 계속 false로 두고,
   *    이후 렌더에서도 직전 scrollHeight가 이미 갱신되어 "바닥이었음"을
   *    복구할 수 없어 바닥에 영영 붙지 못한다. 따라서 재고정 신호는
   *    (a)의 동기 입력에서도 받아야 한다.
   * 5. "바닥이었는지" 판정의 기준 높이는 직전 렌더 몇 프레임의 최소값을 쓴다.
   *    스크롤은 브라우저 스레드에서 처리되므로, 바닥으로 가는 제스처가
   *    메인 스레드가 이미 키워 둔 최신 레이아웃이 아니라 한두 프레임 전
   *    레이아웃의 최대치로 clamp될 수 있다. 그 경우 scrollTop은 그 예전
   *    최대치에 머무는데 직전 scrollHeight와 비교하면 거리가 커 보여 다시
   *    붙지 못한다. 짧은 히스토리의 최소값과 비교하면 그 lag를 흡수한다.
   */
  const stickToBottom = useRef(true);
  /** 최근 몇 렌더의 scrollHeight (스레드 스크롤 clamp lag 대응) */
  const recentScrollHeights = useRef<number[]>([]);
  const lastScrollTop = useRef(0);
  const touchStartY = useRef<number | null>(null);

  // The list no longer remounts per session (ChatPage dropped the per-session key).
  // Reset the scroll-follow state explicitly once the bound session changes.
  useEffect(() => {
    if (sessionId === undefined) return;
    stickToBottom.current = true;
    recentScrollHeights.current = [];
    lastScrollTop.current = 0;
  }, [sessionId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const scrollHeight = el.scrollHeight;
    const history = recentScrollHeights.current;
    const anchor = history.length > 0 ? Math.min(...history) : 0;
    history.push(scrollHeight);
    if (history.length > 3) history.shift();
    const wasAtBottom =
      el.scrollTop + el.clientHeight >= anchor - BOTTOM_TOLERANCE;
    if (stickToBottom.current && wasAtBottom) {
      el.scrollTop = scrollHeight;
    }
  });

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_TOLERANCE;
    if (atBottom) {
      stickToBottom.current = true;
    } else if (el.scrollTop < lastScrollTop.current) {
      // 위로 이동 = 과거 내용 보기 → 해제
      stickToBottom.current = false;
    }
    lastScrollTop.current = el.scrollTop;
  };

  const handleWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.deltaY === 0) return;
    // 위로 = 해제, 아래로 = 바닥으로 복귀 의도. 실제 snap은 여전히
    // wasAtBottom(진짜 바닥)일 때만 일어나므로 과도한 고정은 없다.
    stickToBottom.current = e.deltaY > 0;
  };

  const handleTouchStart = (e: TouchEvent) => {
    touchStartY.current = e.touches[0]?.clientY ?? null;
  };

  const handleTouchMove = (e: TouchEvent) => {
    if (touchStartY.current === null) return;
    const y = e.touches[0]?.clientY;
    if (y == null) return;
    // 손가락 아래로 = 내용 위로 = 과거 내용 보기. 첫 픽셀부터 해제.
    // 손가락 위로 = 내용 아래로 = 바닥으로 복귀 의도.
    if (y > touchStartY.current) {
      stickToBottom.current = false;
    } else if (y < touchStartY.current) {
      stickToBottom.current = true;
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
          <Message key={messageKey(m, i, sessionId)} message={m} />
        ))}
        {streamThinking && <Thinking text={streamThinking} />}
        {streamText && looksLikeHtmlErrorPage(streamText) && (
          <div className="border-2 border-red-300 bg-red-50 p-3 font-mono text-xs text-red-600 dark:border-red-800 dark:bg-red-950/50 dark:text-red-400 break-words [overflow-wrap:anywhere]">
            {sanitizeProviderErrorMessage(streamText)}
          </div>
        )}
        {streamText && !looksLikeHtmlErrorPage(streamText) && (
          <div className="text-[15px] whitespace-pre-wrap leading-relaxed break-words [overflow-wrap:anywhere]">
            {streamText}
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
