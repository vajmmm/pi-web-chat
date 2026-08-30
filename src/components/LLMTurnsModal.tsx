import { Dialog } from "@base-ui-components/react/dialog";
import { useEffect, useMemo, useState } from "react";
import type { UILLMTurnRecord } from "../../shared/protocol";
import { useLLMTurns } from "../lib/api";

type FormatMode = "unified" | "vendor";
type RoundFilterScope = "latest" | "all" | number;

interface DialogueRound {
  roundNumber: number;
  promptSnippet: string;
  turnIndices: number[];
  turnsCount: number;
  isLatest: boolean;
}

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
  const [selectedRound, setSelectedRound] = useState<RoundFilterScope>("latest");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [wrapLines, setWrapLines] = useState<boolean>(false);
  const [inspectingItem, setInspectingItem] = useState<{
    index: number;
    raw: string;
    parsed: any;
  } | null>(null);

  // 每次打开弹窗时默认重置为只看最新一轮对话
  useEffect(() => {
    if (open) {
      setSelectedRound("latest");
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

  // 将所有 API 调用按「用户对话轮次 (User Dialogue Round)」进行归类分组
  // 1 轮 = 用户发给模型一句话 ➔ 到 AI 对这句话的最终回复结束（期间可能包含多次工具调用与中间交互）
  const dialogueRounds = useMemo(() => {
    const roundMap = new Map<number, DialogueRound>();

    turns.forEach((turn, idx) => {
      const userMsgs = (turn.messages || []).filter((m: any) => m?.role === "user");
      const roundNumber = Math.max(1, userMsgs.length);
      const lastUserMsg: any = userMsgs[userMsgs.length - 1];

      let promptSnippet = "";
      if (lastUserMsg) {
        if (typeof lastUserMsg.content === "string") {
          promptSnippet = lastUserMsg.content;
        } else if (Array.isArray(lastUserMsg.content)) {
          promptSnippet = lastUserMsg.content
            .map((c: any) => (typeof c === "string" ? c : c?.text || ""))
            .join(" ");
        }
      }
      promptSnippet = promptSnippet.replace(/\s+/g, " ").trim();
      if (promptSnippet.length > 26) {
        promptSnippet = promptSnippet.slice(0, 26) + "...";
      }

      let existing = roundMap.get(roundNumber);
      if (!existing) {
        existing = {
          roundNumber,
          promptSnippet: promptSnippet || `第 ${roundNumber} 轮对话`,
          turnIndices: [],
          turnsCount: 0,
          isLatest: false,
        };
        roundMap.set(roundNumber, existing);
      }
      existing.turnIndices.push(idx);
      existing.turnsCount++;
    });

    const list = Array.from(roundMap.values()).sort((a, b) => a.roundNumber - b.roundNumber);
    if (list.length > 0) {
      list[list.length - 1].isLatest = true;
    }
    return list;
  }, [turns]);

  // 当前激活的对话轮次对象
  const activeRound = useMemo(() => {
    if (dialogueRounds.length === 0) return null;
    if (selectedRound === "latest") return dialogueRounds[dialogueRounds.length - 1];
    if (selectedRound === "all") return null;
    return dialogueRounds.find((r) => r.roundNumber === selectedRound) || dialogueRounds[dialogueRounds.length - 1];
  }, [dialogueRounds, selectedRound]);

  // 筛选属于当前所选对话轮次的 API 调用记录
  const displayedTurnLines = useMemo(() => {
    if (allTurnLines.length === 0) return [];

    let scopedList = allTurnLines;
    if (selectedRound === "latest") {
      const latest = dialogueRounds[dialogueRounds.length - 1];
      if (latest) {
        const allowed = new Set(latest.turnIndices);
        scopedList = allTurnLines.filter((t) => allowed.has(t.index));
      }
    } else if (typeof selectedRound === "number") {
      const target = dialogueRounds.find((r) => r.roundNumber === selectedRound);
      if (target) {
        const allowed = new Set(target.turnIndices);
        scopedList = allTurnLines.filter((t) => allowed.has(t.index));
      }
    }

    if (!searchQuery.trim()) return scopedList;
    const q = searchQuery.toLowerCase();
    return scopedList.filter((item) => item.raw.toLowerCase().includes(q));
  }, [allTurnLines, dialogueRounds, selectedRound, searchQuery]);

  const fullJsonlText = useMemo(
    () => allTurnLines.map((t) => t.raw).join("\n"),
    [allTurnLines],
  );

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
                <span>共 {turns.length} 次调用 / {dialogueRounds.length} 轮对话</span>
                {selectedRound === "latest" && activeRound && (
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold">
                    (默认仅展示最新第 {activeRound.roundNumber} 轮对话的 {activeRound.turnsCount} 次调用)
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

          {/* 格式切换与对话轮次选择栏 */}
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
                🌐 1. Pi 内部统一格式 ({displayedTurnLines.length})
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
                🏢 2. 实际发往厂商格式 ({displayedTurnLines.length})
              </button>
            </div>

            {/* 对话轮次选择器：默认显示最新一轮（用户发一句话到最终回复） */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={!activeRound || activeRound.roundNumber <= 1}
                  onClick={() => {
                    if (activeRound) {
                      setSelectedRound(activeRound.roundNumber - 1);
                    }
                  }}
                  className="border border-line bg-card px-1.5 py-0.5 text-[11px] text-muted hover:border-accent hover:text-ink disabled:opacity-30"
                  title="查看上一轮用户对话"
                >
                  ◀ 上一轮对话
                </button>

                <select
                  value={
                    selectedRound === "latest"
                      ? "latest"
                      : selectedRound === "all"
                        ? "all"
                        : String(selectedRound)
                  }
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "latest" || val === "all") {
                      setSelectedRound(val);
                    } else {
                      setSelectedRound(Number(val));
                    }
                  }}
                  className="border border-line bg-card px-2 py-0.5 text-[11px] text-ink outline-none focus:border-accent cursor-pointer max-w-[240px] sm:max-w-xs truncate"
                  title="切换对话轮次（1 轮 = 用户发一句话到 AI 最终回复，包含期间的所有工具调用）"
                >
                  {dialogueRounds.length > 0 && (
                    <option value="latest">
                      🌟 最新一轮对话 (第 {dialogueRounds[dialogueRounds.length - 1].roundNumber} 轮: &quot;{dialogueRounds[dialogueRounds.length - 1].promptSnippet}&quot; · {dialogueRounds[dialogueRounds.length - 1].turnsCount} 次调用)
                    </option>
                  )}
                  {dialogueRounds.length > 1 && (
                    <optgroup label="历史对话轮次">
                      {dialogueRounds.map((r) => (
                        <option key={r.roundNumber} value={r.roundNumber}>
                          第 {r.roundNumber} 轮对话: &quot;{r.promptSnippet}&quot; ({r.turnsCount} 次调用)
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <option value="all">
                    📑 显示全部所有对话 ({dialogueRounds.length} 轮 · {turns.length} 次调用)
                  </option>
                </select>

                <button
                  type="button"
                  disabled={!activeRound || activeRound.isLatest}
                  onClick={() => {
                    if (activeRound) {
                      const next = activeRound.roundNumber + 1;
                      const maxRound = dialogueRounds[dialogueRounds.length - 1]?.roundNumber;
                      if (next >= maxRound) {
                        setSelectedRound("latest");
                      } else {
                        setSelectedRound(next);
                      }
                    }
                  }}
                  className="border border-line bg-card px-1.5 py-0.5 text-[11px] text-muted hover:border-accent hover:text-ink disabled:opacity-30"
                  title="查看下一轮用户对话"
                >
                  下一轮对话 ▶
                </button>
              </div>

              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索内容关键词..."
                className="border border-line bg-card px-2 py-0.5 text-xs text-ink placeholder:text-faint outline-none focus:border-accent w-32 sm:w-40"
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
                <span className="text-xs font-bold">当前对话轮次没有匹配的内容</span>
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



