import { Dialog } from "@base-ui-components/react/dialog";
import { useEffect, useMemo, useState } from "react";
import type { UILLMTurnRecord } from "../../shared/protocol";
import { useLLMTurns } from "../lib/api";

type FormatMode = "unified" | "vendor";
type ViewTab = "detail" | "jsonl_list";

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
    liveMode ? 2000 : false,
  );

  const turns = data?.turns ?? [];
  const [selectedTurnIdx, setSelectedTurnIdx] = useState<number>(-1);
  const [userLockedTurn, setUserLockedTurn] = useState<boolean>(false);
  const [formatMode, setFormatMode] = useState<FormatMode>("unified");
  const [viewTab, setViewTab] = useState<ViewTab>("detail");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");

  // 当新轮次产生且用户未锁定特定历史轮次时，自动跟踪到最新一轮
  useEffect(() => {
    if (turns.length > 0) {
      if (!userLockedTurn || selectedTurnIdx < 0 || selectedTurnIdx >= turns.length) {
        setSelectedTurnIdx(turns.length - 1);
      }
    } else {
      setSelectedTurnIdx(-1);
    }
  }, [turns.length, userLockedTurn]);

  // 重置状态
  useEffect(() => {
    if (open) {
      setUserLockedTurn(false);
      if (turns.length > 0) {
        setSelectedTurnIdx(turns.length - 1);
      }
    }
  }, [open]);

  const activeTurn: UILLMTurnRecord | undefined =
    selectedTurnIdx >= 0 && selectedTurnIdx < turns.length
      ? turns[selectedTurnIdx]
      : turns[turns.length - 1];

  const effectiveIdx = activeTurn ? turns.indexOf(activeTurn) : -1;

  const copyText = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  // 获取单轮格式化后的对象
  const getTurnObject = (turn: UILLMTurnRecord) => {
    if (formatMode === "unified") {
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
      return {
        systemPrompt: sysPrompt,
        messages: turn.messages,
        tools: turn.tools,
        model: turn.model,
        thinkingLevel: turn.thinkingLevel,
      };
    }

    return turn.vendorPayload && typeof turn.vendorPayload === "object"
      ? turn.vendorPayload
      : {
          model: turn.model.id,
          system: turn.systemPrompt,
          messages: turn.messages,
          tools: turn.tools,
        };
  };

  // 当前选中轮次的纯 JSON 文本
  const currentFormattedJson = useMemo(() => {
    if (!activeTurn) return "";
    try {
      return JSON.stringify(getTurnObject(activeTurn), null, 2);
    } catch {
      return "{}";
    }
  }, [activeTurn, formatMode]);

  // 一键按需生成全量 JSONL 文本（仅在复制时按需序列化，避免每秒占用大量内存）
  const handleCopyFullJsonl = () => {
    if (turns.length === 0) return;
    const lines = turns.map((t) => JSON.stringify(getTurnObject(t)));
    copyText("full-jsonl", lines.join("\n"));
  };

  // 过滤后的紧凑列表项（每项不存放巨大字符串，只存放元数据和截断预览）
  const compactList = useMemo(() => {
    return turns.map((t, idx) => {
      const toolNames = (t.tools || []).map((tl: any) => tl.name || tl.type).filter(Boolean);
      const isLatest = idx === turns.length - 1;
      const totalTokens = t.tokenEstimate?.totalTokens ?? 0;
      return {
        idx,
        timeStr: t.timeStr,
        modelId: t.model?.id || "unknown",
        messageCount: t.messages?.length ?? 0,
        toolCount: t.tools?.length ?? 0,
        toolNamesPreview: toolNames.slice(0, 4).join(", ") + (toolNames.length > 4 ? "…" : ""),
        totalTokens,
        isLatest,
      };
    });
  }, [turns]);

  const filteredCompactList = useMemo(() => {
    if (!searchQuery.trim()) return compactList;
    const q = searchQuery.toLowerCase();
    return compactList.filter(
      (item) =>
        item.modelId.toLowerCase().includes(q) ||
        item.toolNamesPreview.toLowerCase().includes(q) ||
        item.timeStr.toLowerCase().includes(q) ||
        String(item.idx + 1).includes(q),
    );
  }, [compactList, searchQuery]);

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
                API 实际发送内容监视器
              </Dialog.Title>
              <span className="inline-flex items-center gap-1.5 border border-line bg-canvas px-2 py-0.5 text-[10px] text-faint">
                <span>共 {turns.length} 轮调用</span>
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {turns.length > 0 && (
                <button
                  type="button"
                  onClick={handleCopyFullJsonl}
                  className="border border-line bg-card px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-ink transition-colors"
                  title="一键复制全部轮次的完整 JSONL（每行一条）"
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
                title="开启后实时捕获最新产生的调用并自动更新"
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

          {/* 模式与视图控制栏 */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-canvas px-4 py-2 shrink-0 text-xs">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setViewTab("detail")}
                className={`border px-3 py-1 text-xs font-bold transition-all ${
                  viewTab === "detail"
                    ? "border-accent bg-bubble text-accent shadow-[var(--pixel-shadow-sm)]"
                    : "border-transparent text-muted hover:border-line"
                }`}
                title="单轮完整格式化详情（秒开无卡顿）"
              >
                🔍 单轮详情（默认最新）
              </button>
              <button
                type="button"
                onClick={() => setViewTab("jsonl_list")}
                className={`border px-3 py-1 text-xs font-bold transition-all ${
                  viewTab === "jsonl_list"
                    ? "border-accent bg-bubble text-accent shadow-[var(--pixel-shadow-sm)]"
                    : "border-transparent text-muted hover:border-line"
                }`}
                title="查看全部调用轮次流水线列表"
              >
                📑 轮次总览列表 ({turns.length})
              </button>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-faint text-[11px]">格式:</span>
              <button
                type="button"
                onClick={() => setFormatMode("unified")}
                className={`border px-2 py-0.5 text-[11px] transition-all ${
                  formatMode === "unified"
                    ? "border-accent bg-card text-accent font-bold"
                    : "border-line text-muted hover:text-ink"
                }`}
                title="Pi 内部统一格式（systemPrompt, messages, tools）"
              >
                🌐 Pi 统一格式
              </button>
              <button
                type="button"
                onClick={() => setFormatMode("vendor")}
                className={`border px-2 py-0.5 text-[11px] transition-all ${
                  formatMode === "vendor"
                    ? "border-accent bg-card text-accent font-bold"
                    : "border-line text-muted hover:text-ink"
                }`}
                title="发往厂商 API 的原生 HTTP 请求体"
              >
                🏢 厂商原生体
              </button>
            </div>
          </div>

          {/* 核心内容区 */}
          {turns.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center text-muted">
              <span className="text-4xl mb-2">📦</span>
              <span className="text-sm font-bold text-ink">暂未产生调用记录</span>
              <span className="mt-1.5 text-xs text-faint max-w-md">
                在对话中发送消息或触发 Agent 执行后，每次发出的请求体将以高保真形式记录在此。
              </span>
            </div>
          ) : viewTab === "detail" ? (
            /* 1. 默认：单轮详情（性能极佳，仅渲染单轮 JSON） */
            <div className="flex flex-col flex-1 min-h-0 bg-canvas">
              {/* 轮次导航步进器 */}
              <div className="flex flex-wrap items-center justify-between border-b border-line bg-card/80 px-4 py-2 gap-2 shrink-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-accent">
                    #第 {effectiveIdx + 1} 轮
                  </span>
                  {effectiveIdx === turns.length - 1 && (
                    <span className="rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 px-1.5 py-0.2 text-[10px] font-bold">
                      最新调用
                    </span>
                  )}
                  {activeTurn && (
                    <div className="hidden sm:flex items-center gap-1.5 text-[11px] text-faint">
                      <span>• {activeTurn.timeStr}</span>
                      <span>• 模型: <code className="text-ink">{activeTurn.model.id}</code></span>
                      <span>• {activeTurn.messages.length} 条消息</span>
                      <span>• {activeTurn.tools.length} 个工具</span>
                      {activeTurn.tokenEstimate && (
                        <span>• ~{activeTurn.tokenEstimate.totalTokens.toLocaleString()} tokens</span>
                      )}
                    </div>
                  )}
                </div>

                {/* 翻页步进控件 */}
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={effectiveIdx <= 0}
                    onClick={() => {
                      setUserLockedTurn(true);
                      setSelectedTurnIdx(0);
                    }}
                    className="border border-line bg-card px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-ink disabled:opacity-30"
                    title="跳转到第 1 轮"
                  >
                    ⏮ 首轮
                  </button>
                  <button
                    type="button"
                    disabled={effectiveIdx <= 0}
                    onClick={() => {
                      setUserLockedTurn(true);
                      setSelectedTurnIdx(Math.max(0, effectiveIdx - 1));
                    }}
                    className="border border-line bg-card px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-ink disabled:opacity-30"
                    title="查看上一轮"
                  >
                    ◀ 上一轮
                  </button>

                  <select
                    value={effectiveIdx}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setUserLockedTurn(val !== turns.length - 1);
                      setSelectedTurnIdx(val);
                    }}
                    className="border border-line bg-card px-2 py-0.5 text-[11px] text-ink outline-none focus:border-accent cursor-pointer"
                  >
                    {turns.map((t, idx) => (
                      <option key={t.turnIndex} value={idx}>
                        第 {idx + 1} 轮 {idx === turns.length - 1 ? "(最新)" : ""} ({t.timeStr})
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    disabled={effectiveIdx >= turns.length - 1}
                    onClick={() => {
                      const next = Math.min(turns.length - 1, effectiveIdx + 1);
                      setUserLockedTurn(next !== turns.length - 1);
                      setSelectedTurnIdx(next);
                    }}
                    className="border border-line bg-card px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-ink disabled:opacity-30"
                    title="查看下一轮"
                  >
                    下一轮 ▶
                  </button>
                  <button
                    type="button"
                    disabled={effectiveIdx >= turns.length - 1}
                    onClick={() => {
                      setUserLockedTurn(false);
                      setSelectedTurnIdx(turns.length - 1);
                    }}
                    className="border border-line bg-card px-2 py-0.5 text-[11px] font-bold text-accent hover:border-accent disabled:opacity-30"
                    title="跳转到最新一轮"
                  >
                    ⏭ 最新
                  </button>

                  <button
                    type="button"
                    onClick={() => copyText("current-turn", currentFormattedJson)}
                    className="border border-accent bg-bubble px-2.5 py-0.5 text-[11px] text-accent font-bold hover:bg-accent hover:text-white transition-colors ml-1"
                    title="复制当前轮次格式化 JSON"
                  >
                    {copiedKey === "current-turn" ? "✓ 已复制" : "📋 复制此轮"}
                  </button>
                </div>
              </div>

              {/* JSON 文本区 (单轮全量，秒级加载) */}
              <div className="thin-scroll flex-1 overflow-auto p-3 text-xs">
                <pre className="border border-line bg-card p-3 text-[11px] text-ink overflow-x-auto whitespace-pre-wrap select-text leading-relaxed font-mono">
                  {currentFormattedJson}
                </pre>
              </div>
            </div>
          ) : (
            /* 2. 轮次总览列表（轻量流水线，点击某一行快速进入该轮） */
            <div className="flex flex-col flex-1 min-h-0 bg-canvas">
              <div className="flex items-center justify-between border-b border-line bg-card/60 px-4 py-2 gap-2 shrink-0">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索模型 / 工具名 / 序号..."
                  className="border border-line bg-card px-2 py-1 text-xs text-ink placeholder:text-faint outline-none focus:border-accent w-64"
                />
                <span className="text-[11px] text-faint">
                  点击任意一行即可快速切换并查看该轮完整请求体
                </span>
              </div>

              <div className="thin-scroll flex-1 overflow-auto p-2">
                <div className="flex flex-col gap-1">
                  {filteredCompactList.map((item) => (
                    <div
                      key={item.idx}
                      onClick={() => {
                        setUserLockedTurn(item.idx !== turns.length - 1);
                        setSelectedTurnIdx(item.idx);
                        setViewTab("detail");
                      }}
                      className={`flex items-center justify-between p-2 rounded border transition-colors cursor-pointer text-xs ${
                        item.idx === effectiveIdx
                          ? "border-accent bg-bubble text-accent font-bold"
                          : "border-line bg-card hover:border-accent/60 text-ink"
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="w-8 text-right font-bold text-faint">
                          #{item.idx + 1}
                        </span>
                        {item.isLatest && (
                          <span className="rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 px-1 py-0.2 text-[9px] font-bold shrink-0">
                            最新
                          </span>
                        )}
                        <span className="font-mono text-[11px] text-ink truncate max-w-[140px] sm:max-w-[200px]">
                          {item.modelId}
                        </span>
                        <span className="text-faint text-[11px] hidden md:inline">
                          ({item.toolCount} 工具: {item.toolNamesPreview || "无"})
                        </span>
                      </div>

                      <div className="flex items-center gap-3 shrink-0 text-faint text-[11px]">
                        <span>{item.messageCount} 条消息</span>
                        {item.totalTokens > 0 && (
                          <span>~{item.totalTokens.toLocaleString()} tokens</span>
                        )}
                        <span>{item.timeStr}</span>
                        <span className="text-accent text-[11px]">查看 ➔</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

