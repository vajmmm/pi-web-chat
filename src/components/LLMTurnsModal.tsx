import { Dialog } from "@base-ui-components/react/dialog";
import { useEffect, useMemo, useState } from "react";
import type { UILLMTurnRecord } from "../../shared/protocol";
import { useLLMTurns } from "../lib/api";

type FormatMode = "unified" | "vendor";
type TurnFilterScope = "latest" | "all" | number;

export function LLMTurnsModal({
  open,
  onOpenChange,
  sessionId,
  taskId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId?: string | null;
  taskId?: string | null;
}) {
  const [liveMode, setLiveMode] = useState<boolean>(true);
  const { data, isLoading, refetch } = useLLMTurns(
    sessionId,
    taskId,
    open,
    liveMode ? 1500 : false,
  );

  const turns = data?.turns ?? [];
  const [formatMode, setFormatMode] = useState<FormatMode>("unified");
  const [turnFilter, setTurnFilter] = useState<TurnFilterScope>("latest");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [wrapLines, setWrapLines] = useState<boolean>(false);
  const [inspectingItem, setInspectingItem] = useState<{
    index: number;
    raw: string;
    parsed: any;
  } | null>(null);

  // 打开弹窗时默认重置为展示最新一轮
  useEffect(() => {
    if (open) {
      setTurnFilter("latest");
    }
  }, [open]);

  const copyText = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  // 生成每次请求对应 1 行纯粹 JSON 的列表（不注入任何 turn / meta 额外标记，单行完整不截断）
  const allTurnLines = useMemo(() => {
    return turns.map((turn, index) => {
      let obj: any;
      if (formatMode === "unified") {
        // Pi 内部统一请求对象（纯粹的 systemPrompt, messages, tools, model）
        let sysPrompt = turn.systemPrompt;
        if (typeof sysPrompt === "string") {
          const trimmed = sysPrompt.trim();
          if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed && typeof parsed === "object") {
                sysPrompt = parsed;
              }
            } catch {}
          }
        }
        obj = {
          systemPrompt: sysPrompt,
          messages: turn.messages,
          tools: turn.tools,
          model: turn.model,
          thinkingLevel: turn.thinkingLevel,
        };
      } else {
        // 实际发送给厂商 API 的完整原生 HTTP 请求体
        obj =
          turn.vendorPayload && typeof turn.vendorPayload === "object"
            ? turn.vendorPayload
            : {
                model: turn.model.id,
                system: turn.systemPrompt,
                messages: turn.messages,
                tools: turn.tools,
              };
      }

      const raw = JSON.stringify(obj);
      return {
        index,
        raw,
        parsed: obj,
      };
    });
  }, [turns, formatMode]);

  // 根据当前选择的范围（默认最新一轮、全部轮次或指定第几轮）筛选显示的行
  const displayedTurnLines = useMemo(() => {
    if (allTurnLines.length === 0) return [];

    let scopedList = allTurnLines;
    if (turnFilter === "latest") {
      scopedList = [allTurnLines[allTurnLines.length - 1]];
    } else if (typeof turnFilter === "number") {
      const target = allTurnLines.find((t) => t.index === turnFilter);
      scopedList = target ? [target] : [allTurnLines[allTurnLines.length - 1]];
    }

    if (!searchQuery.trim()) return scopedList;
    const q = searchQuery.toLowerCase();
    return scopedList.filter((item) => item.raw.toLowerCase().includes(q));
  }, [allTurnLines, turnFilter, searchQuery]);

  const fullJsonlText = useMemo(
    () => allTurnLines.map((t) => t.raw).join("\n"),
    [allTurnLines],
  );

  // 计算当前聚焦的轮次序号（0-based）
  const currentIdx =
    turnFilter === "latest"
      ? turns.length - 1
      : typeof turnFilter === "number"
        ? turnFilter
        : turns.length - 1;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/50 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 z-40" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 flex max-h-[92vh] w-[96vw] max-w-6xl -translate-x-1/2 -translate-y-1/2 flex-col border-2 border-accent bg-card font-mono shadow-[var(--pixel-shadow)] outline-none z-50">
          {/* 顶栏 */}
          <div className="flex flex-wrap items-center justify-between border-b-2 border-line px-4 py-2.5 gap-2 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex size-6 shrink-0 items-center justify-center border border-accent bg-bubble text-xs font-bold text-accent">
                🧠
              </span>
              <Dialog.Title className="text-sm font-bold text-ink truncate">
                API 实际发送内容监视器 (1行1条完整 JSON)
              </Dialog.Title>
              <span className="hidden sm:inline-flex items-center gap-1.5 border border-line bg-canvas px-2 py-0.5 text-[10px] text-faint">
                <span>共 {turns.length} 条调用记录</span>
                {turnFilter === "latest" && (
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold">
                    (默认仅显示最新第 {turns.length} 轮)
                  </span>
                )}
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {allTurnLines.length > 0 && (
                <button
                  type="button"
                  onClick={() => copyText("full-jsonl", fullJsonlText)}
                  className="border border-line bg-card px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-ink transition-colors"
                  title="一键复制全部 JSONL 文本（每行一条完整 JSON）"
                >
                  {copiedKey === "full-jsonl" ? "✓ 全部 JSONL 已复制" : "📋 复制全部 JSONL"}
                </button>
              )}

              <button
                type="button"
                onClick={() => setLiveMode(!liveMode)}
                className={`border px-2 py-1 text-[11px] font-bold transition-all ${
                  liveMode
                    ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                    : "border-line bg-card text-muted hover:text-ink"
                }`}
                title="开启后实时同步捕获新产生的调用"
              >
                {liveMode ? "🟢 实时监听中" : "⏸️ 静态查看"}
              </button>

              <button
                type="button"
                onClick={() => void refetch()}
                disabled={isLoading}
                className="border border-line bg-card px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-ink transition-colors disabled:opacity-50"
                title="手动刷新"
              >
                {isLoading ? "⏳" : "🔄 刷新"}
              </button>

              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="border-2 border-line px-2 py-0.5 text-xs text-muted hover:border-accent hover:text-ink"
              >
                ✕ 关闭
              </button>
            </div>
          </div>

          {/* 格式切换与控制栏 */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-canvas px-4 py-2 shrink-0 text-xs">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setFormatMode("unified")}
                className={`border px-3 py-1 text-xs font-bold transition-all ${
                  formatMode === "unified"
                    ? "border-accent bg-bubble text-accent shadow-[var(--pixel-shadow-sm)]"
                    : "border-transparent text-muted hover:border-line"
                }`}
                title="Pi 内部统一中间格式"
              >
                🌐 1. Pi 内部统一格式 ({turns.length})
              </button>
              <button
                type="button"
                onClick={() => setFormatMode("vendor")}
                className={`border px-3 py-1 text-xs font-bold transition-all ${
                  formatMode === "vendor"
                    ? "border-accent bg-bubble text-accent shadow-[var(--pixel-shadow-sm)]"
                    : "border-transparent text-muted hover:border-line"
                }`}
                title="实际通过网络发送给大模型厂商 API 的完整原生 HTTP 请求体"
              >
                🏢 2. 实际发往厂商格式 ({turns.length})
              </button>
            </div>

            {/* 轮次选择与显示范围控制 */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={currentIdx <= 0}
                  onClick={() => setTurnFilter(Math.max(0, currentIdx - 1))}
                  className="border border-line bg-card px-1.5 py-0.5 text-[11px] text-muted hover:border-accent hover:text-ink disabled:opacity-30"
                  title="查看上一轮"
                >
                  ◀ 上一轮
                </button>

                <select
                  value={
                    turnFilter === "latest"
                      ? "latest"
                      : turnFilter === "all"
                        ? "all"
                        : String(turnFilter)
                  }
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "latest" || val === "all") {
                      setTurnFilter(val);
                    } else {
                      setTurnFilter(Number(val));
                    }
                  }}
                  className="border border-line bg-card px-2 py-0.5 text-[11px] text-ink outline-none focus:border-accent cursor-pointer"
                  title="切换显示范围：默认仅显示最新一轮，可选择指定历史轮次或显示全部"
                >
                  <option value="latest">🌟 仅显示最新轮次 (第 {turns.length} 轮)</option>
                  <option value="all">📑 显示全部轮次 ({turns.length} 条)</option>
                  <optgroup label="指定历史轮次">
                    {turns.map((t, idx) => (
                      <option key={t.turnIndex} value={idx}>
                        第 {idx + 1} 轮 {idx === turns.length - 1 ? "(最新)" : ""} ({t.timeStr})
                      </option>
                    ))}
                  </optgroup>
                </select>

                <button
                  type="button"
                  disabled={currentIdx >= turns.length - 1}
                  onClick={() => {
                    const next = currentIdx + 1;
                    if (next >= turns.length - 1) {
                      setTurnFilter("latest");
                    } else {
                      setTurnFilter(next);
                    }
                  }}
                  className="border border-line bg-card px-1.5 py-0.5 text-[11px] text-muted hover:border-accent hover:text-ink disabled:opacity-30"
                  title="查看下一轮"
                >
                  下一轮 ▶
                </button>
              </div>

              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索内容关键词..."
                className="border border-line bg-card px-2 py-0.5 text-xs text-ink placeholder:text-faint outline-none focus:border-accent w-36 sm:w-44"
              />

              <label className="flex items-center gap-1 text-[11px] text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={wrapLines}
                  onChange={(e) => setWrapLines(e.target.checked)}
                  className="accent-accent"
                />
                <span>折行显示</span>
              </label>
            </div>
          </div>

          {/* 核心内容区：标准纯净的 1 行 1 条完整 JSON（单行完整不截断） */}
          <div className="thin-scroll flex-1 overflow-auto bg-canvas font-mono text-xs text-ink select-text">
            {turns.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center text-muted">
                <span className="text-4xl mb-2">📦</span>
                <span className="text-sm font-bold text-ink">暂未产生调用记录</span>
                <span className="mt-1.5 text-xs text-faint max-w-md">
                  在对话框中发送任意一条消息后，系统将把每次发出的<strong>完整请求以每行一条 JSON 的形式</strong>自动记录在此。
                </span>
              </div>
            ) : displayedTurnLines.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center text-muted">
                <span className="text-xl mb-1">🔍</span>
                <span className="text-xs font-bold">没有匹配的内容</span>
              </div>
            ) : (
              <div className="min-w-full w-max">
                <div
                  className={`leading-relaxed ${
                    wrapLines ? "whitespace-pre-wrap break-all" : "whitespace-pre"
                  }`}
                >
                  {displayedTurnLines.map((item) => (
                    <div
                      key={item.index}
                      className="flex hover:bg-card/90 py-1.5 px-3 group transition-colors cursor-pointer border-b border-line/40 last:border-b-0 min-w-full w-max"
                      onClick={() => setInspectingItem(item)}
                      title="点击在底部展开格式化查看此行完整 JSON"
                    >
                      <span className="sticky left-0 select-none text-faint w-10 shrink-0 text-right pr-3 opacity-80 border-r border-line mr-3 bg-canvas group-hover:bg-card/90">
                        {item.index + 1}
                      </span>
                      {/* 单行 100% 完整 JSON，无任何字符截断 */}
                      <span className="flex-1 select-text text-ink group-hover:text-accent font-mono">
                        {item.raw}
                      </span>
                      <div className="hidden group-hover:flex items-center gap-1.5 shrink-0 ml-3">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            copyText(`line-${item.index}`, item.raw);
                          }}
                          className="border border-line bg-card px-1.5 py-0.5 text-[10px] text-muted hover:border-accent hover:text-ink shadow-sm"
                          title="复制此行完整 JSON"
                        >
                          {copiedKey === `line-${item.index}` ? "✓" : "📋 复制完整行"}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setInspectingItem(item);
                          }}
                          className="border border-accent bg-bubble px-1.5 py-0.5 text-[10px] text-accent font-bold hover:bg-accent hover:text-white shadow-sm"
                          title="在底部格式化展开"
                        >
                          🔍 展开详情
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 单行格式化展开检查抽屉 (Inline Inspector) */}
          {inspectingItem && (
            <div className="border-t-2 border-accent bg-card p-3 font-mono text-xs shrink-0 max-h-80 overflow-y-auto">
              <div className="flex items-center justify-between border-b border-line pb-1.5 mb-2">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-accent">
                    #第 {inspectingItem.index + 1} 行完整 JSON 格式化详情
                  </span>
                  <span className="border border-line bg-canvas px-1.5 text-[10px] text-faint">
                    {formatMode === "unified" ? "Pi 内部统一格式" : "厂商原生请求体"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      copyText(
                        "inspect-formatted",
                        JSON.stringify(inspectingItem.parsed, null, 2),
                      )
                    }
                    className="border border-line px-2 py-0.5 text-[10px] text-muted hover:border-accent hover:text-ink"
                  >
                    {copiedKey === "inspect-formatted"
                      ? "✓ 已复制格式化 JSON"
                      : "📋 复制格式化 JSON"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setInspectingItem(null)}
                    className="border border-line px-1.5 py-0.5 text-[10px] text-muted hover:text-ink"
                  >
                    ✕ 关闭面板
                  </button>
                </div>
              </div>
              <pre className="border border-line bg-canvas p-2 text-[11px] text-ink overflow-x-auto whitespace-pre-wrap select-text leading-relaxed font-mono">
                {JSON.stringify(inspectingItem.parsed, null, 2)}
              </pre>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}


