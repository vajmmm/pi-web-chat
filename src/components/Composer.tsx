import { useEffect, useRef, useState } from "react";
import type { UIImageAttachment } from "../../shared/protocol";
import { chatClient, useChat } from "../lib/chat";
import { useT } from "../lib/i18n";

interface PendingImage extends UIImageAttachment {
  previewUrl: string;
}

async function fileToImage(file: File): Promise<PendingImage | null> {
  if (!file.type.startsWith("image/")) return null;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { data: base64, mimeType: file.type, previewUrl: dataUrl };
}

export function Composer({ isStreaming }: { isStreaming: boolean }) {
  const t = useT();
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { injectText, focusToken, snapshot } = useChat();

  useEffect(() => {
    if (injectText !== null) {
      setText(injectText);
      chatClient.consumeInjectText();
      textareaRef.current?.focus();
    }
  }, [injectText]);

  useEffect(() => {
    if (focusToken > 0) textareaRef.current?.focus();
  }, [focusToken]);

  const addFiles = async (files: Iterable<File>) => {
    const loaded = await Promise.all([...files].map(fileToImage));
    setImages((prev) => [...prev, ...loaded.filter((i): i is PendingImage => i !== null)]);
  };

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    chatClient.send({
      type: "prompt",
      text: trimmed,
      images: images.length > 0 ? images.map(({ data, mimeType }) => ({ data, mimeType })) : undefined,
    });
    setText("");
    setImages([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const isCoordinator = (snapshot?.activeRole ?? "coordinator") === "coordinator";
  const isCompacting = snapshot?.isCompacting ?? false;
  const stats = snapshot?.tokenUsage;
  const totalIn = (stats?.totalInputTokens ?? 0) + (stats?.cacheReadTokens ?? 0);
  const cacheHitRate =
    totalIn > 0 ? Math.round(((stats?.cacheReadTokens ?? 0) / totalIn) * 100) : 0;

  const formatCompact = (num?: number) => {
    if (!num || num === 0) return "0";
    if (num < 1000) return num.toString();
    if (num < 1_000_000) {
      const k = num / 1000;
      return (k < 10 ? k.toFixed(1) : Math.round(k).toString()) + "k";
    }
    const m = num / 1_000_000;
    return (m < 10 ? m.toFixed(2) : m.toFixed(1)) + "M";
  };

  return (
    <div className="composer-bar shrink-0 bg-canvas">
      <div className={`mx-auto max-w-3xl border-2 bg-card p-2 shadow-[var(--pixel-shadow)] transition-colors focus-within:border-accent ${
        isCoordinator ? "border-accent/80" : "border-line-bright"
      }`}>
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1.5 px-2.5 py-0.5 border-b border-dashed border-line text-[10px] font-mono">
          <span className={`font-bold flex items-center gap-1 ${isCoordinator ? "text-accent" : "text-muted"}`}>
            <span className={`size-1.5 ${isCoordinator ? "bg-accent" : "bg-muted"}`} />
            {isCoordinator ? "统筹者模式 (COORDINATOR)" : "标准模式 (STANDARD)"}
          </span>
          <div className="flex items-center gap-2 text-faint text-[9.5px] select-none font-mono">
            <span>
              累计: <strong className="text-ink font-bold">{formatCompact(stats?.runTokens ?? stats?.totalTokens)}</strong>
            </span>
            <span>•</span>
            <span>
              缓存命中:{" "}
              <strong className="text-ink font-bold">
                {stats?.cacheReadTokens ? `${formatCompact(stats.cacheReadTokens)} (${cacheHitRate}%)` : "0%"}
              </strong>
            </span>
            <span>•</span>
            <span>
              上下文:{" "}
              <strong className="text-ink font-bold">
                {stats?.contextWindow
                  ? `${formatCompact(stats.contextTokens ?? 0)}/${formatCompact(stats.contextWindow)} (${stats.contextPercent ?? 0}%)`
                  : `${formatCompact(stats?.contextTokens ?? 0)}`}
              </strong>
            </span>
            <span>•</span>
            <button
              type="button"
              onClick={() => chatClient.send({ type: "compact" })}
              disabled={isStreaming || isCompacting}
              title="将前面的历史对话总结提炼为简短摘要，释放 90%+ 上下文"
              className={`px-1.5 py-0.5 border text-[9px] font-bold transition-all ${
                isCompacting
                  ? "border-accent bg-accent/15 text-accent animate-pulse cursor-wait"
                  : "border-line bg-card hover:bg-canvas text-accent hover:border-accent disabled:opacity-40"
              }`}
            >
              {isCompacting ? (
                <span className="flex items-center gap-1">
                  <span className="inline-block animate-spin">⏳</span>
                  <span>正在压缩提炼中...</span>
                </span>
              ) : (
                "🗜️ 压缩上下文"
              )}
            </button>
          </div>
        </div>
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 px-1">
            {images.map((img, i) => (
              <div key={i} className="relative">
                <img
                  src={img.previewUrl}
                  alt=""
                  className="size-16 border-2 border-line object-cover"
                />
                <button
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center border border-line bg-ink text-xs text-canvas"
                  aria-label={t("removeImage")}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-col">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <textarea
            ref={textareaRef}
            value={text}
            rows={1}
            placeholder={
              isStreaming
                ? t("streamingPlaceholder")
                : isCoordinator
                  ? "请输入任务需求与规划指令，统筹者将自动拆解并派发 Subagents…"
                  : t("sendMessage")
            }
            className="composer-textarea max-h-40 w-full resize-none bg-transparent px-2.5 pt-1.5 pb-1 font-mono text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-faint"
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.items]
                .filter((item) => item.kind === "file")
                .map((item) => item.getAsFile())
                .filter((f): f is File => f !== null);
              if (files.length > 0) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                const isTouch = window.matchMedia("(pointer: coarse)").matches;
                if (!isTouch) {
                  e.preventDefault();
                  send();
                }
              }
            }}
          />
          {/* Bottom control row */}
          <div className="mt-1 flex items-center gap-1 px-1">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex size-7.5 shrink-0 items-center justify-center border-2 border-line bg-canvas text-muted shadow-[var(--pixel-shadow-sm)] transition-all hover:translate-x-[1px] hover:translate-y-[1px] hover:border-accent hover:text-ink"
              aria-label={t("attachImage")}
            >
              <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-[2]">
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>
            </button>
            <div className="flex-1" />
            {isStreaming ? (
              <button
                onClick={() => chatClient.send({ type: "abort" })}
                className="flex items-center gap-1.5 border-2 border-red-400 bg-red-500 px-3 py-1 font-mono text-xs font-bold text-white shadow-[2px_2px_0_rgba(195,78,109,0.3)] transition-all hover:translate-x-[1px] hover:translate-y-[1px]"
                aria-label={t("abort")}
              >
                <span className="size-2 bg-white" />
                <span>{t("abort")}</span>
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!text.trim() && images.length === 0}
                className="flex items-center gap-1.5 border-2 border-accent bg-accent px-3 py-1 font-mono text-xs font-bold text-accent-ink shadow-[2px_2px_0_rgba(119,68,180,0.3)] transition-all hover:translate-x-[1px] hover:translate-y-[1px] disabled:opacity-35 disabled:hover:translate-x-0 disabled:hover:translate-y-0"
                aria-label={t("send")}
              >
                <span>{t("send")}</span>
                <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-2">
                  <path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
