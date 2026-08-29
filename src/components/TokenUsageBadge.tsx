import { Popover } from "@base-ui-components/react/popover";
import type { UITokenUsageStats } from "../../shared/protocol";

function formatCompactNumber(num: number): string {
  if (num < 1000) return num.toString();
  if (num < 1_000_000) {
    const k = num / 1000;
    return (k < 10 ? k.toFixed(1) : Math.round(k).toString()) + "k";
  }
  const m = num / 1_000_000;
  return (m < 10 ? m.toFixed(2) : m.toFixed(1)) + "M";
}

function formatNumber(num: number): string {
  return num.toLocaleString();
}

function formatCost(cost?: number): string {
  if (cost == null || cost === 0) return "$0.00";
  if (cost < 0.0001) return "< $0.0001";
  if (cost < 0.01) return "$" + cost.toFixed(4);
  return "$" + cost.toFixed(2);
}

export function TokenUsageBadge({ stats }: { stats?: UITokenUsageStats }) {
  if (!stats || stats.totalTokens === 0) {
    return (
      <div
        className="hidden sm:flex h-7.5 items-center gap-1.5 border-2 border-line bg-card/60 px-2 font-mono text-xs font-bold text-faint select-none"
        title="等待会话生成 Token 消耗数据"
      >
        <span>📊</span>
        <span>0 tokens</span>
      </div>
    );
  }

  const {
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    totalCost,
    cacheReadTokens,
    cacheWriteTokens,
    contextTokens,
    contextWindow,
    contextPercent,
    latestTurnTokens,
    subagentTokens,
    runTokens,
    byRole,
  } = stats;

  const cacheHitRate =
    totalInputTokens + cacheReadTokens > 0
      ? Math.round((cacheReadTokens / (totalInputTokens + cacheReadTokens)) * 100)
      : 0;

  // Context bar color
  const percent = contextPercent ?? 0;
  const barColor =
    percent > 80 ? "bg-red-500" : percent > 50 ? "bg-amber-400" : "bg-accent";

  return (
    <Popover.Root>
      <Popover.Trigger
        className="flex h-7.5 items-center gap-1.5 border-2 border-line-bright bg-card px-2 font-mono text-xs font-bold text-ink transition-all shadow-[var(--pixel-shadow-sm)] hover:translate-x-[1px] hover:translate-y-[1px] hover:border-accent"
        title="查看 Token 用量统计与上下文占用"
      >
        <span className="text-accent">📊</span>
        <span className="text-xs">{formatCompactNumber(runTokens ?? totalTokens)}</span>
        {contextPercent != null && (
          <span className="hidden md:inline-block border border-accent/40 bg-bubble px-1 py-0.2 text-[9px] font-bold text-accent">
            {contextPercent}%
          </span>
        )}
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end">
          <Popover.Popup className="w-96 border-2 border-accent bg-card p-3.5 font-mono shadow-[var(--pixel-shadow)] outline-none z-50 text-xs">
            <div className="flex items-center justify-between border-b border-line pb-2 mb-2.5">
              <span className="text-[11px] font-black tracking-wider text-accent uppercase">
                TOKEN // USAGE METRICS
              </span>
              {totalCost != null && totalCost > 0 && (
                <span className="border border-mint bg-mint/10 px-1.5 py-0.5 text-[10px] font-bold text-mint">
                  {formatCost(totalCost)}
                </span>
              )}
            </div>

            {/* 上下文窗口进度 — 这是当前窗口占用，不是整个任务累计消耗 */}
            {contextWindow != null && contextWindow > 0 && (
              <div className="mb-3 border border-line bg-canvas p-2">
                <div className="flex items-center justify-between text-[11px] font-bold text-ink mb-1">
                  <span>🧠 当前上下文 (Current Context)</span>
                  <span className="text-accent">{contextPercent ?? 0}%</span>
                </div>
                <div className="h-2 w-full bg-sidebar border border-line overflow-hidden mb-1">
                  <div
                    className={`h-full ${barColor} transition-all duration-300`}
                    style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-faint">
                  <span>当前: {formatNumber(contextTokens ?? 0)}</span>
                  <span>上限: {formatNumber(contextWindow)}</span>
                </div>
              </div>
            )}

            {/* Token 分类明细 */}
            <div className="space-y-1.5 text-[11px]">
              <div className="flex items-center justify-between py-0.5 border-b border-line/40">
                <span className="text-muted">📥 累计输入 (Cumulative Input):</span>
                <span className="font-bold text-ink">{formatNumber(totalInputTokens)}</span>
              </div>
              <div className="flex items-center justify-between py-0.5 border-b border-line/40">
                <span className="text-muted">📤 累计输出 (Output):</span>
                <span className="font-bold text-ink">{formatNumber(totalOutputTokens)}</span>
              </div>

              {(cacheReadTokens > 0 || cacheWriteTokens > 0) && (
                <>
                  <div className="flex items-center justify-between py-0.5 border-b border-line/40">
                    <span className="text-muted">⚡ 缓存读取 (Cache Read):</span>
                    <div className="flex items-center gap-1.5">
                      {cacheHitRate > 0 && (
                        <span className="text-[10px] text-mint">({cacheHitRate}% 命中)</span>
                      )}
                      <span className="font-bold text-ink">{formatNumber(cacheReadTokens)}</span>
                    </div>
                  </div>
                  {cacheWriteTokens > 0 && (
                    <div className="flex items-center justify-between py-0.5 border-b border-line/40">
                      <span className="text-muted">💾 缓存写入 (Cache Write):</span>
                      <span className="font-bold text-ink">{formatNumber(cacheWriteTokens)}</span>
                    </div>
                  )}
                </>
              )}

              {latestTurnTokens != null && latestTurnTokens > 0 && (
                <div className="flex items-center justify-between py-0.5 border-b border-line/40">
                  <span className="text-muted">🔄 最近单轮 (Latest Turn):</span>
                  <span className="font-bold text-ink">{formatNumber(latestTurnTokens)}</span>
                </div>
              )}

              {subagentTokens != null && subagentTokens > 0 && (
                <div className="flex items-center justify-between py-0.5 border-b border-line/40">
                  <span className="text-muted">⚡ Subagent Tokens:</span>
                  <span className="font-bold text-ink">{formatNumber(subagentTokens)}</span>
                </div>
              )}

              <div className="flex items-center justify-between pt-1 font-bold text-ink">
                <span>📊 父会话累计 (Parent):</span>
                <span>{formatNumber(totalTokens)}</span>
              </div>
              <div className="flex items-center justify-between pt-0.5 font-bold text-accent">
                <span>Σ 整次 Run (Parent + Subagents):</span>
                <span>{formatNumber(runTokens ?? totalTokens)}</span>
              </div>
            </div>

            {byRole && byRole.length > 0 && (
              <div className="mt-3 border-t border-line pt-2">
                <div className="text-[10px] font-black tracking-wider text-accent uppercase mb-1.5">
                  By Role
                </div>
                <div className="space-y-1 text-[11px]">
                  {byRole
                    .slice()
                    .sort((a, b) => b.totalTokens - a.totalTokens)
                    .map((row) => (
                      <div key={row.role} className="flex items-center justify-between py-0.5">
                        <span className="text-muted">{row.role}</span>
                        <span className="font-bold text-ink">{formatNumber(row.totalTokens)}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            <div className="mt-3 border-t border-line pt-2 text-[10px] text-faint">
              当前上下文是最后一轮窗口占用；累计 Input/Output 是本会话所有轮次之和，不等于当前上下文。
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
