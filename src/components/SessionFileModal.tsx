import { Dialog } from "@base-ui-components/react/dialog";
import { useMemo, useState } from "react";
import type { UISessionFileLine } from "../../shared/protocol";
import { useSessionFile } from "../lib/api";

type ViewTab = "table" | "raw" | "cards";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function getTypeBadgeStyle(type: string, role?: string): { label: string; shortLabel: string; className: string } {
  if (type === "session") {
    return {
      label: "SESSION (会话头)",
      shortLabel: "SESSION",
      className: "border-purple-500 bg-purple-50 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300",
    };
  }
  if (type === "model_change") {
    return {
      label: "MODEL_CHANGE (模型变更)",
      shortLabel: "MODEL",
      className: "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
    };
  }
  if (type === "compaction") {
    return {
      label: "COMPACTION (上下文压缩)",
      shortLabel: "COMPACT",
      className: "border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
    };
  }
  if (type === "session_info") {
    return {
      label: "SESSION_INFO (元数据)",
      shortLabel: "INFO",
      className: "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300",
    };
  }
  if (type === "custom_message" || type === "custom") {
    return {
      label: "CUSTOM (扩展事件)",
      shortLabel: "CUSTOM",
      className: "border-teal-500 bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300",
    };
  }
  if (type === "message") {
    if (role === "user") {
      return {
        label: "MESSAGE (USER 用户)",
        shortLabel: "USER",
        className: "border-accent bg-bubble text-accent dark:bg-accent/20 font-bold",
      };
    }
    if (role === "assistant") {
      return {
        label: "MESSAGE (ASSISTANT 助手)",
        shortLabel: "ASSISTANT",
        className: "border-emerald-600 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 font-bold",
      };
    }
    if (role === "toolResult") {
      return {
        label: "MESSAGE (TOOL_RESULT 工具结果)",
        shortLabel: "TOOL_RES",
        className: "border-orange-500 bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300",
      };
    }
    return {
      label: `MESSAGE (${String(role || "OTHER").toUpperCase()})`,
      shortLabel: "MESSAGE",
      className: "border-line bg-canvas text-muted",
    };
  }
  return {
    label: type.toUpperCase(),
    shortLabel: type.toUpperCase().slice(0, 8),
    className: "border-line bg-canvas text-muted",
  };
}

/** 提取单行极简摘要，用于单行比对视图 */
function getSingleLineSummary(line: UISessionFileLine): string {
  const parsed = line.parsed as any;
  if (!parsed) return line.raw;

  if (line.type === "session") {
    return `[SESSION] cwd: ${parsed.cwd || ""} (v${parsed.version || 3})${parsed.parentSession ? ` ← parentSession: ${parsed.parentSession}` : ""}`;
  }

  if (line.type === "model_change") {
    return `[MODEL] 切换至 ${parsed.provider}/${parsed.modelId}${parsed.thinkingLevel ? ` (thinking: ${parsed.thinkingLevel})` : ""}`;
  }

  if (line.type === "compaction") {
    const summaryClean = (parsed.summary || "").replace(/\n+/g, " ").trim();
    return `[COMPACTION] firstKept: ${parsed.firstKeptEntryId} | tokensBefore: ${parsed.tokensBefore} | summary: "${summaryClean.slice(0, 100)}${summaryClean.length > 100 ? "..." : ""}"`;
  }

  if (line.type === "session_info") {
    return `[INFO] name: "${parsed.name || ""}"`;
  }

  if (line.type === "custom_message" || line.type === "custom") {
    return `[CUSTOM] type: ${parsed.customType || ""} | ${JSON.stringify(parsed.content || parsed.data || "")}`;
  }

  if (line.type === "message") {
    const msg = parsed.message;
    if (!msg) return line.raw;
    const role = msg.role;

    if (role === "user") {
      const text = typeof msg.content === "string" ? msg.content : (msg.content?.[0]?.text ?? JSON.stringify(msg.content));
      return `User: "${text.replace(/\n+/g, " ").trim()}"`;
    }

    if (role === "assistant") {
      if (typeof msg.content === "string") {
        return `Assistant: "${msg.content.replace(/\n+/g, " ").trim()}"`;
      }
      if (Array.isArray(msg.content)) {
        const parts: string[] = [];
        for (const b of msg.content) {
          if (b.type === "text" && b.text) {
            parts.push(b.text.replace(/\n+/g, " ").trim());
          } else if (b.type === "toolCall") {
            const argsStr = JSON.stringify(b.arguments || b.input || {});
            parts.push(`[ToolCall: ${b.name || b.toolName}(${argsStr.slice(0, 60)}${argsStr.length > 60 ? "..." : ""})]`);
          }
        }
        return `Assistant: ${parts.join(" ") || "(empty)"}`;
      }
    }

    if (role === "toolResult") {
      const raw = typeof msg.content === "string" ? msg.content : (msg.content?.[0]?.text ?? JSON.stringify(msg.content));
      const clean = raw.replace(/\n+/g, " ").trim();
      return `ToolResult[${msg.toolCallId || ""}]: "${clean.slice(0, 120)}${clean.length > 120 ? "..." : ""}"`;
    }
  }

  return line.raw.replace(/\n+/g, " ").trim();
}

export function SessionFileModal({
  open,
  onOpenChange,
  sessionId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId?: string | null;
}) {
  const [liveMode, setLiveMode] = useState<boolean>(true);
  const { data, isLoading, refetch } = useSessionFile(
    sessionId,
    open,
    liveMode ? 1500 : false,
  );

  const [activeTab, setActiveTab] = useState<ViewTab>("table");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [wrapRawLines, setWrapRawLines] = useState<boolean>(false);
  const [expandedLines, setExpandedLines] = useState<Set<number>>(new Set());
  const [inspectingLine, setInspectingLine] = useState<UISessionFileLine | null>(null);

  const copyText = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const toggleLineExpanded = (lineNum: number) => {
    setExpandedLines((prev) => {
      const next = new Set(prev);
      if (next.has(lineNum)) next.delete(lineNum);
      else next.add(lineNum);
      return next;
    });
  };

  const expandAll = () => {
    if (!data?.lines) return;
    setExpandedLines(new Set(data.lines.map((l) => l.lineNumber)));
  };

  const collapseAll = () => {
    setExpandedLines(new Set());
  };

  // 过滤后的条目列表
  const filteredLines = useMemo(() => {
    if (!data?.lines) return [];
    let list = data.lines;

    if (filterType !== "all") {
      if (filterType === "message_user") {
        list = list.filter(
          (l) => l.type === "message" && (l.parsed as any)?.message?.role === "user",
        );
      } else if (filterType === "message_assistant") {
        list = list.filter(
          (l) => l.type === "message" && (l.parsed as any)?.message?.role === "assistant",
        );
      } else if (filterType === "message_tool") {
        list = list.filter(
          (l) => l.type === "message" && (l.parsed as any)?.message?.role === "toolResult",
        );
      } else if (filterType === "compaction") {
        list = list.filter((l) => l.type === "compaction");
      } else if (filterType === "model_change") {
        list = list.filter((l) => l.type === "model_change");
      } else if (filterType === "session") {
        list = list.filter((l) => l.type === "session" || l.type === "session_info");
      }
    }

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((l) => l.raw.toLowerCase().includes(q));
    }

    return list;
  }, [data?.lines, filterType, searchQuery]);

  // 统计各类型条目数量
  const counts = useMemo(() => {
    const lines = data?.lines ?? [];
    let user = 0;
    let assistant = 0;
    let tool = 0;
    let compaction = 0;
    let model = 0;
    let session = 0;

    for (const l of lines) {
      if (l.type === "session" || l.type === "session_info") session++;
      else if (l.type === "model_change") model++;
      else if (l.type === "compaction") compaction++;
      else if (l.type === "message") {
        const role = (l.parsed as any)?.message?.role;
        if (role === "user") user++;
        else if (role === "assistant") assistant++;
        else if (role === "toolResult") tool++;
      }
    }

    return { total: lines.length, user, assistant, tool, compaction, model, session };
  }, [data?.lines]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/50 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 z-40" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 flex max-h-[90vh] w-[96vw] max-w-6xl -translate-x-1/2 -translate-y-1/2 flex-col border-2 border-accent bg-card font-mono shadow-[var(--pixel-shadow)] outline-none z-50">
          {/* 顶栏 */}
          <div className="flex flex-wrap items-center justify-between border-b-2 border-line px-4 py-2.5 gap-2 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex size-6 shrink-0 items-center justify-center border border-accent bg-bubble text-xs font-bold text-accent">
                📄
              </span>
              <Dialog.Title className="text-sm font-bold text-ink truncate">
                会话文件逐行监视器 (JSONL Line-by-Line Viewer)
              </Dialog.Title>
              {data?.exists ? (
                <span className="hidden sm:inline-flex items-center gap-1.5 border border-line bg-canvas px-2 py-0.5 text-[10px] text-faint">
                  <span>{formatBytes(data.size)}</span>
                  <span>•</span>
                  <span>{data.lineCount} 行 (1行/1条)</span>
                  {data.relativeTime && (
                    <>
                      <span>•</span>
                      <span>{data.relativeTime}</span>
                    </>
                  )}
                </span>
              ) : (
                <span className="border border-amber-500 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                  草稿状态 (尚未落盘)
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {data?.exists && (
                <>
                  <button
                    type="button"
                    onClick={() => copyText("path", data.sessionFile)}
                    className="border border-line bg-card px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-ink transition-colors"
                    title="复制会话文件的绝对路径"
                  >
                    {copiedKey === "path" ? "✓ 路径已复制" : "📋 复制路径"}
                  </button>

                  <button
                    type="button"
                    onClick={() => copyText("raw", data.rawContent)}
                    className="border border-line bg-card px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-ink transition-colors"
                    title="复制完整的 JSONL 文件文本"
                  >
                    {copiedKey === "raw" ? "✓ JSONL 已复制" : "📋 复制完整内容"}
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={() => setLiveMode(!liveMode)}
                className={`border px-2 py-1 text-[11px] font-bold transition-all ${
                  liveMode
                    ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                    : "border-line bg-card text-muted hover:text-ink"
                }`}
                title="开启后每隔 1.5 秒自动拉取文件最新变更"
              >
                {liveMode ? "🟢 实时监听中" : "⏸️ 静态查看"}
              </button>

              <button
                type="button"
                onClick={() => void refetch()}
                disabled={isLoading}
                className="border border-line bg-card px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-ink transition-colors disabled:opacity-50"
                title="手动刷新文件"
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

          {/* 文件路径提示条 */}
          {data?.sessionFile && (
            <div className="flex items-center justify-between border-b border-line bg-canvas/60 px-4 py-1.5 text-[11px] text-faint shrink-0 gap-2 overflow-hidden">
              <div className="flex items-center gap-1.5 truncate">
                <span className="font-bold text-ink">物理路径:</span>
                <code className="text-accent truncate select-all">{data.sessionFile}</code>
              </div>
              <div className="text-[10px] text-faint">
                严格遵循 JSONL 规范：1 行对应 1 条独立记录
              </div>
            </div>
          )}

          {/* 模式选择与搜索控制栏 */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-canvas px-4 py-2 shrink-0 text-xs">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setActiveTab("table")}
                className={`border px-2.5 py-1 text-xs font-bold transition-all ${
                  activeTab === "table"
                    ? "border-accent bg-bubble text-accent"
                    : "border-transparent text-muted hover:border-line"
                }`}
                title="严格单行对比清单，快速查看每行 ID/ParentID 及内容差异"
              >
                📋 单行比对表 (1 Line/Row)
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("raw")}
                className={`border px-2.5 py-1 text-xs font-bold transition-all ${
                  activeTab === "raw"
                    ? "border-accent bg-bubble text-accent"
                    : "border-transparent text-muted hover:border-line"
                }`}
                title="原始 JSONL 单行文本（无换行折行，便于文本 Diff）"
              >
                📄 原始 JSONL (Raw)
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("cards")}
                className={`border px-2.5 py-1 text-xs font-bold transition-all ${
                  activeTab === "cards"
                    ? "border-accent bg-bubble text-accent"
                    : "border-transparent text-muted hover:border-line"
                }`}
                title="详细卡片视图"
              >
                📑 详细卡片
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索 ID / Parent / 文本..."
                className="border border-line bg-card px-2 py-0.5 text-xs text-ink placeholder:text-faint outline-none focus:border-accent w-44 sm:w-56"
              />

              {activeTab === "raw" && (
                <label className="flex items-center gap-1 text-[11px] text-muted cursor-pointer ml-1">
                  <input
                    type="checkbox"
                    checked={wrapRawLines}
                    onChange={(e) => setWrapRawLines(e.target.checked)}
                    className="accent-accent"
                  />
                  <span>折行显示</span>
                </label>
              )}

              {activeTab === "cards" && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={expandAll}
                    className="border border-line bg-card px-1.5 py-0.5 text-[10px] text-muted hover:text-ink"
                  >
                    展开全部
                  </button>
                  <button
                    type="button"
                    onClick={collapseAll}
                    className="border border-line bg-card px-1.5 py-0.5 text-[10px] text-muted hover:text-ink"
                  >
                    折叠全部
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* 筛选标签条 */}
          {activeTab !== "raw" && data?.exists && (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-canvas/30 px-4 py-1.5 text-[11px] shrink-0 overflow-x-auto">
              <span className="text-faint mr-1 shrink-0">分类:</span>
              <button
                type="button"
                onClick={() => setFilterType("all")}
                className={`border px-2 py-0.2 text-[10px] shrink-0 ${
                  filterType === "all"
                    ? "border-accent bg-accent text-white font-bold"
                    : "border-line bg-card text-muted hover:border-accent"
                }`}
              >
                全部 ({counts.total})
              </button>
              <button
                type="button"
                onClick={() => setFilterType("message_user")}
                className={`border px-2 py-0.2 text-[10px] shrink-0 ${
                  filterType === "message_user"
                    ? "border-accent bg-accent text-white font-bold"
                    : "border-line bg-card text-muted hover:border-accent"
                }`}
              >
                👤 用户提问 ({counts.user})
              </button>
              <button
                type="button"
                onClick={() => setFilterType("message_assistant")}
                className={`border px-2 py-0.2 text-[10px] shrink-0 ${
                  filterType === "message_assistant"
                    ? "border-emerald-600 bg-emerald-600 text-white font-bold"
                    : "border-line bg-card text-muted hover:border-emerald-500"
                }`}
              >
                🤖 助手回复 ({counts.assistant})
              </button>
              <button
                type="button"
                onClick={() => setFilterType("message_tool")}
                className={`border px-2 py-0.2 text-[10px] shrink-0 ${
                  filterType === "message_tool"
                    ? "border-orange-600 bg-orange-600 text-white font-bold"
                    : "border-line bg-card text-muted hover:border-orange-500"
                }`}
              >
                ⚙️ 工具结果 ({counts.tool})
              </button>
              <button
                type="button"
                onClick={() => setFilterType("compaction")}
                className={`border px-2 py-0.2 text-[10px] shrink-0 ${
                  filterType === "compaction"
                    ? "border-amber-600 bg-amber-600 text-white font-bold"
                    : "border-line bg-card text-muted hover:border-amber-500"
                }`}
              >
                🗜️ 压缩记录 ({counts.compaction})
              </button>
              <button
                type="button"
                onClick={() => setFilterType("model_change")}
                className={`border px-2 py-0.2 text-[10px] shrink-0 ${
                  filterType === "model_change"
                    ? "border-blue-600 bg-blue-600 text-white font-bold"
                    : "border-line bg-card text-muted hover:border-blue-500"
                }`}
              >
                🎯 模型变更 ({counts.model})
              </button>
              <button
                type="button"
                onClick={() => setFilterType("session")}
                className={`border px-2 py-0.2 text-[10px] shrink-0 ${
                  filterType === "session"
                    ? "border-purple-600 bg-purple-600 text-white font-bold"
                    : "border-line bg-card text-muted hover:border-purple-500"
                }`}
              >
                📁 系统/会话头 ({counts.session})
              </button>
            </div>
          )}

          {/* 主展示区 */}
          <div className="thin-scroll flex-1 overflow-auto p-3">
            {!data?.exists ? (
              <div className="flex flex-col items-center justify-center py-16 text-center text-muted">
                <span className="text-3xl mb-2">📦</span>
                <span className="text-sm font-bold text-ink">当前会话处于草稿状态</span>
                <span className="mt-1.5 text-xs text-faint max-w-md">
                  尚未在磁盘创建 <code>.jsonl</code> 文件。当您发送第一条指令后，系统将自动生成文件并在此实时显示。
                </span>
              </div>
            ) : activeTab === "table" ? (
              /* 单行比对表格模式：1 行严格对应 1 个 JSONL entry */
              filteredLines.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center text-muted">
                  <span className="text-xl mb-1">🔍</span>
                  <span className="text-xs font-bold">没有匹配的行记录</span>
                </div>
              ) : (
                <div className="min-w-full border-2 border-line bg-card font-mono text-xs shadow-[var(--pixel-shadow-sm)]">
                  {/* 表头 */}
                  <div className="flex items-center border-b-2 border-line bg-canvas/80 px-2 py-1.5 font-bold text-faint text-[11px] select-none sticky top-0 z-10">
                    <div className="w-12 shrink-0 text-center">行号</div>
                    <div className="w-24 shrink-0 text-center">记录类型</div>
                    <div className="w-24 shrink-0 px-2">ID (当前)</div>
                    <div className="w-24 shrink-0 px-2">Parent ID (父级)</div>
                    <div className="flex-1 min-w-[280px] px-2 truncate">单行内容摘要 (点击展开详情)</div>
                    <div className="w-20 shrink-0 text-right pr-2">时间</div>
                    <div className="w-16 shrink-0 text-center">操作</div>
                  </div>

                  {/* 逐行条目 */}
                  <div className="divide-y divide-line">
                    {filteredLines.map((line) => {
                      const parsed = line.parsed as any;
                      const role = parsed?.message?.role;
                      const badge = getTypeBadgeStyle(line.type, role);
                      const id = parsed?.id || (line.type === "session" ? parsed?.id?.slice(0, 8) + "..." : "-");
                      const parentId = parsed?.parentId || (line.type === "session" ? "root" : "-");
                      const summary = getSingleLineSummary(line);
                      const timeStr = parsed?.timestamp ? new Date(parsed.timestamp).toLocaleTimeString() : "";

                      return (
                        <div
                          key={line.lineNumber}
                          className="flex items-center px-2 py-1.5 hover:bg-bubble/40 transition-colors text-xs group cursor-pointer"
                          onClick={() => setInspectingLine(line)}
                          title="点击查看此行完整 JSON 结构"
                        >
                          <div className="w-12 shrink-0 text-center text-[10px] font-bold text-faint select-none">
                            #{line.lineNumber}
                          </div>
                          <div className="w-24 shrink-0 flex justify-center">
                            <span className={`border px-1.5 py-0.2 text-[9.5px] truncate max-w-full ${badge.className}`}>
                              {badge.shortLabel}
                            </span>
                          </div>
                          <div className="w-24 shrink-0 px-2 font-bold text-ink truncate select-all text-[11px]">
                            {id}
                          </div>
                          <div className="w-24 shrink-0 px-2 text-faint truncate select-all text-[11px]">
                            {parentId}
                          </div>
                          <div className="flex-1 min-w-[280px] px-2 truncate text-ink group-hover:text-accent select-text">
                            {summary}
                          </div>
                          <div className="w-20 shrink-0 text-right pr-2 text-[10px] text-faint select-none">
                            {timeStr}
                          </div>
                          <div className="w-16 shrink-0 flex justify-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={() => copyText(`row-${line.lineNumber}`, line.raw)}
                              className="border border-line bg-card px-1.5 py-0.5 text-[9.5px] text-muted hover:border-accent hover:text-ink transition-colors"
                              title="复制此行原始 JSON"
                            >
                              {copiedKey === `row-${line.lineNumber}` ? "✓" : "📋"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setInspectingLine(line)}
                              className="border border-line bg-card px-1.5 py-0.5 text-[9.5px] text-accent hover:border-accent font-bold transition-colors"
                              title="查看完整详情"
                            >
                              🔍
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )
            ) : activeTab === "raw" ? (
              /* 原始 JSONL 单行文本模式：严格 1 行 1 条，无折行 */
              <div className="border-2 border-line bg-canvas p-2 font-mono text-xs text-ink overflow-x-auto select-text">
                <pre className={`leading-relaxed ${wrapRawLines ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>
                  {data.lines.map((l) => (
                    <div key={l.lineNumber} className="flex hover:bg-card py-0.5 px-1 group">
                      <span className="select-none text-faint w-12 shrink-0 text-right pr-3 opacity-60 border-r border-line mr-2">
                        {l.lineNumber}
                      </span>
                      <span className="flex-1 select-text">{l.raw}</span>
                    </div>
                  ))}
                </pre>
              </div>
            ) : (
              /* 详细卡片模式 */
              <div className="space-y-3">
                {filteredLines.map((line) => (
                  <SessionLineCard
                    key={line.lineNumber}
                    line={line}
                    isExpanded={expandedLines.has(line.lineNumber)}
                    onToggle={() => toggleLineExpanded(line.lineNumber)}
                    onCopy={() => copyText(`line-${line.lineNumber}`, line.raw)}
                    isCopied={copiedKey === `line-${line.lineNumber}`}
                  />
                ))}
              </div>
            )}
          </div>

          {/* 单行选中详情弹层 (Inline Inspector) */}
          {inspectingLine && (
            <div className="border-t-2 border-accent bg-card p-3 font-mono text-xs shrink-0 max-h-60 overflow-y-auto">
              <div className="flex items-center justify-between border-b border-line pb-1.5 mb-2">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-accent">#第 {inspectingLine.lineNumber} 行数据详情</span>
                  <span className="border border-line bg-canvas px-1.5 text-[10px] text-faint">
                    {inspectingLine.type}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => copyText("inspect-raw", JSON.stringify(inspectingLine.parsed, null, 2))}
                    className="border border-line px-2 py-0.5 text-[10px] text-muted hover:border-accent hover:text-ink"
                  >
                    {copiedKey === "inspect-raw" ? "✓ 已复制格式化 JSON" : "📋 复制 JSON"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setInspectingLine(null)}
                    className="border border-line px-1.5 py-0.5 text-[10px] text-muted hover:text-ink"
                  >
                    ✕ 关闭面板
                  </button>
                </div>
              </div>
              <pre className="border border-line bg-canvas p-2 text-[11px] text-ink overflow-x-auto whitespace-pre-wrap select-text">
                {JSON.stringify(inspectingLine.parsed, null, 2)}
              </pre>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** 详细卡片视图项 */
function SessionLineCard({
  line,
  isExpanded,
  onToggle,
  onCopy,
  isCopied,
}: {
  line: UISessionFileLine;
  isExpanded: boolean;
  onToggle: () => void;
  onCopy: () => void;
  isCopied: boolean;
}) {
  const parsed = line.parsed as any;
  const role = parsed?.message?.role;
  const badge = getTypeBadgeStyle(line.type, role);

  const entryId = parsed?.id;
  const parentId = parsed?.parentId;
  const timestamp = parsed?.timestamp;

  return (
    <div className="border-2 border-line bg-card p-3 shadow-[var(--pixel-shadow-sm)] hover:border-accent/80 transition-colors">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="border border-line bg-canvas px-1.5 py-0.2 text-[10px] font-bold text-faint">
            #{line.lineNumber}
          </span>
          <span className={`border px-2 py-0.5 text-[10px] font-bold ${badge.className}`}>
            {badge.label}
          </span>
          {entryId && (
            <span className="text-[11px] text-faint">
              ID: <strong className="text-ink font-bold">{entryId}</strong>
            </span>
          )}
          {parentId && (
            <span className="text-[11px] text-faint">
              Parent: <strong className="text-ink">{parentId}</strong>
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs">
          {timestamp && (
            <span className="text-[10px] text-faint">
              {new Date(timestamp).toLocaleTimeString()}
            </span>
          )}
          <button
            type="button"
            onClick={onCopy}
            className="border border-line bg-canvas px-1.5 py-0.5 text-[10px] text-muted hover:border-accent hover:text-ink transition-colors"
            title="复制该行原始 JSON 字符串"
          >
            {isCopied ? "✓ 已复制" : "📋 复制"}
          </button>
          <button
            type="button"
            onClick={onToggle}
            className="border border-line bg-canvas px-1.5 py-0.5 text-[10px] text-accent hover:border-accent font-bold transition-colors"
          >
            {isExpanded ? "收起 ▲" : "详情 ▼"}
          </button>
        </div>
      </div>

      <div className="mt-2.5 text-xs font-mono">
        {line.type === "session" && (
          <div className="space-y-1 text-faint">
            <div>
              <span className="font-bold text-ink">会话 UUID:</span> {parsed?.id}
            </div>
            <div>
              <span className="font-bold text-ink">工作目录:</span> {parsed?.cwd}
            </div>
            <div>
              <span className="font-bold text-ink">版本:</span> v{parsed?.version}
            </div>
            {parsed?.parentSession && (
              <div>
                <span className="font-bold text-ink">父会话路径:</span> {parsed.parentSession}
              </div>
            )}
          </div>
        )}

        {line.type === "model_change" && (
          <div className="flex flex-wrap items-center gap-2 text-ink">
            <span>切换至模型:</span>
            <span className="border border-line bg-bubble px-1.5 py-0.5 font-bold text-accent">
              🤖 {parsed?.provider}/{parsed?.modelId}
            </span>
            {parsed?.thinkingLevel && (
              <span className="border border-line bg-canvas px-1.5 py-0.5 text-faint">
                思考级别: {parsed.thinkingLevel}
              </span>
            )}
          </div>
        )}

        {line.type === "compaction" && (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 text-amber-600 dark:text-amber-400 font-bold">
              <span>🗜️ 压缩保留入口: {parsed?.firstKeptEntryId}</span>
              <span>•</span>
              <span>压缩前 Token: {parsed?.tokensBefore}</span>
            </div>
            {parsed?.summary && (
              <div className="border border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 p-2 text-xs text-ink whitespace-pre-wrap max-h-40 overflow-y-auto">
                {parsed.summary}
              </div>
            )}
          </div>
        )}

        {line.type === "message" && (
          <MessageEntryBody message={parsed?.message} isExpanded={isExpanded} />
        )}

        {isExpanded && (
          <div className="mt-3 border-t border-dashed border-line pt-2.5">
            <span className="text-[10px] font-bold text-faint uppercase">原始 JSON 数据:</span>
            <pre className="mt-1 border border-line bg-canvas p-2 text-[11px] text-ink overflow-x-auto whitespace-pre-wrap break-all select-text max-h-60 overflow-y-auto">
              {JSON.stringify(parsed, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function MessageEntryBody({ message, isExpanded }: { message: any; isExpanded: boolean }) {
  if (!message) return null;
  const role = message.role;
  const content = message.content;

  if (role === "user") {
    const text = typeof content === "string" ? content : (content?.[0]?.text ?? JSON.stringify(content));
    return (
      <div className="border border-accent/40 bg-bubble/40 p-2 text-ink">
        <span className="font-bold text-accent mr-1">💬 用户指令:</span>
        <span className="whitespace-pre-wrap">{text}</span>
      </div>
    );
  }

  if (role === "assistant") {
    if (typeof content === "string") {
      return (
        <div className="border border-emerald-500/30 bg-emerald-50/30 dark:bg-emerald-950/20 p-2 text-ink whitespace-pre-wrap">
          {content}
        </div>
      );
    }

    if (Array.isArray(content)) {
      const textBlocks = content.filter((b) => b.type === "text" && b.text);
      const toolCalls = content.filter((b) => b.type === "toolCall");
      const thinkingBlocks = content.filter((b) => b.type === "thinking" && b.thinking);

      return (
        <div className="space-y-2">
          {thinkingBlocks.length > 0 && !isExpanded && (
            <div className="border border-line bg-canvas px-2 py-1 text-[11px] text-faint italic">
              🧠 思考过程: {thinkingBlocks.map((t) => t.thinking).join(" ").slice(0, 120)}...
            </div>
          )}

          {textBlocks.map((b, i) => (
            <div
              key={i}
              className="border border-emerald-500/30 bg-emerald-50/30 dark:bg-emerald-950/20 p-2 text-ink whitespace-pre-wrap"
            >
              {b.text}
            </div>
          ))}

          {toolCalls.map((tc, i) => (
            <div
              key={i}
              className="border border-purple-400/50 bg-purple-50/30 dark:bg-purple-950/20 p-2 text-xs text-ink"
            >
              <div className="flex items-center gap-1.5 font-bold text-purple-700 dark:text-purple-300">
                <span>⚡ 工具调用:</span>
                <code className="border border-purple-400 bg-canvas px-1 py-0.2">{tc.name}</code>
                <span className="text-[10px] text-faint">ID: {tc.id}</span>
              </div>
              <pre className="mt-1 text-[11px] text-faint overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(tc.arguments || tc.input || {}, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      );
    }
  }

  if (role === "toolResult") {
    const raw = typeof content === "string" ? content : (content?.[0]?.text ?? JSON.stringify(content));
    const isErr = message.isError;
    const preview = raw.length > 300 ? `${raw.slice(0, 300)}...` : raw;

    return (
      <div
        className={`border p-2 text-xs ${
          isErr
            ? "border-red-400 bg-red-50/40 dark:bg-red-950/30 text-red-600 dark:text-red-300"
            : "border-orange-400/40 bg-orange-50/30 dark:bg-orange-950/20 text-ink"
        }`}
      >
        <div className="flex items-center gap-1.5 font-bold text-faint mb-1">
          <span>{isErr ? "❌ 工具执行报错" : "⚙️ 工具返回结果"}</span>
          <span className="text-[10px]">CallID: {message.toolCallId}</span>
        </div>
        <pre className="text-[11px] whitespace-pre-wrap break-all max-h-36 overflow-y-auto">
          {preview}
        </pre>
      </div>
    );
  }

  return (
    <pre className="text-[11px] text-faint whitespace-pre-wrap">{JSON.stringify(message, null, 2)}</pre>
  );
}
