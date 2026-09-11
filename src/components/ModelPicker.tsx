import { Menu } from "@base-ui-components/react/menu";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { UIModel, UIThinkingLevel } from "../../shared/protocol";
import {
  MODELS_QUERY_KEY,
  refreshModelsApi,
  ROLE_MODELS_QUERY_KEY,
  useCustomModels,
  useModels,
  useSubscriptionModels,
} from "../lib/api";
import { chatClient } from "../lib/chat";
import { useT } from "../lib/i18n";

const KNOWN_PROVIDER_NAMES: Record<string, string> = {
  "opencode-go": "OpenCode Go",
  "opencode": "OpenCode",
  "openai-codex": "OpenAI Codex",
  "xai": "xAI Grok",
  "github-copilot": "GitHub Copilot",
  "anthropic": "Anthropic Claude",
  "google-gemini": "Google Gemini",
  "google-vertex": "Google Vertex AI",
  "deepseek": "DeepSeek",
  "minimax": "MiniMax",
  "openrouter": "OpenRouter",
  "mistral": "Mistral AI",
  "groq": "Groq",
  "cerebras": "Cerebras",
  "cohere": "Cohere",
  "agy": "Google Antigravity (AGY)",
};

const THINKING_LABELS: Record<UIThinkingLevel, string> = {
  off: "关",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
};

function formatProviderTitle(providerId: string): string {
  if (KNOWN_PROVIDER_NAMES[providerId]) {
    return KNOWN_PROVIDER_NAMES[providerId];
  }
  return providerId
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function matchesQuery(model: UIModel, q: string) {
  if (!q) return true;
  const hay = `${model.name ?? ""} ${model.id} ${model.provider} ${formatProviderTitle(model.provider)}`.toLowerCase();
  return hay.includes(q);
}

function thinkingLabel(level: UIThinkingLevel): string {
  return THINKING_LABELS[level] ?? level;
}

type ModelCategoryTab = "all" | "custom" | "subscription" | "builtin";
type PickerView = "compact" | "catalog";

interface GroupedProvider {
  providerId: string;
  providerTitle: string;
  models: UIModel[];
}

interface GroupedCategory {
  key: "custom" | "subscription" | "builtin";
  title: string;
  badge: string;
  icon: string;
  providers: GroupedProvider[];
  totalCount: number;
}

function ThinkingSlider({
  levels,
  value,
  onChange,
}: {
  levels: UIThinkingLevel[];
  value: UIThinkingLevel;
  onChange: (level: UIThinkingLevel) => void;
}) {
  const max = Math.max(levels.length - 1, 0);
  const index = Math.max(0, levels.indexOf(value));
  const pct = max > 0 ? (index / max) * 100 : 0;

  return (
    <div
      className="relative mt-3 h-6 select-none px-2"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-x-2 top-1/2 h-[5px] -translate-y-1/2 rounded-full bg-line" />
      <div
        className="absolute top-1/2 h-[5px] -translate-y-1/2 rounded-full bg-accent"
        style={{ left: 8, width: `calc((100% - 16px) * ${pct} / 100)` }}
      />
      {levels.map((level, i) => (
        <span
          key={level}
          className={`absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${
            i <= index ? "bg-accent-ink" : "bg-faint"
          }`}
          style={{ left: `calc(8px + (100% - 16px) * ${max > 0 ? i / max : 0})` }}
        />
      ))}
      <div
        className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-line bg-card shadow-[var(--pixel-shadow-sm)]"
        style={{ left: `calc(8px + (100% - 16px) * ${pct} / 100)` }}
      />
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={index}
        aria-label="思考程度"
        aria-valuetext={thinkingLabel(value)}
        className="absolute inset-0 w-full cursor-pointer opacity-0"
        onChange={(e) => {
          const next = levels[Number(e.target.value)];
          if (next) onChange(next);
        }}
      />
    </div>
  );
}

/**
 * Codex-style picker: compact first-screen (thinking slider + current model),
 * with the full catalog behind a drill-in.
 */
export function ModelPicker({
  current,
  thinking,
  levels,
}: {
  current: UIModel | null;
  thinking: UIThinkingLevel;
  levels: UIThinkingLevel[];
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: models, refetch } = useModels();
  const { data: customData } = useCustomModels();
  const { data: subscriptionData } = useSubscriptionModels();

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PickerView>("compact");
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<ModelCategoryTab>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const showThinking = levels.length > 1;
  const modelName = current ? (current.name ?? current.id) : t("selectModel");

  const customSet = useMemo(() => {
    return new Set(customData?.providers.map((p) => p.key) ?? []);
  }, [customData]);

  const subscriptionSet = useMemo(() => {
    return new Set(subscriptionData?.providers.map((p) => p.id) ?? []);
  }, [subscriptionData]);

  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (models ?? []).filter((m) => matchesQuery(m, q));
  }, [models, query]);

  const groupedCategories = useMemo((): GroupedCategory[] => {
    const customMap = new Map<string, UIModel[]>();
    const subscriptionMap = new Map<string, UIModel[]>();
    const builtinMap = new Map<string, UIModel[]>();

    for (const m of filteredModels) {
      const isCustom = customSet.has(m.provider) || m.provider.endsWith("-custom");
      const isSubscription =
        !isCustom &&
        (subscriptionSet.has(m.provider) ||
          Boolean(KNOWN_PROVIDER_NAMES[m.provider]));

      if (isCustom) {
        const list = customMap.get(m.provider) ?? [];
        list.push(m);
        customMap.set(m.provider, list);
      } else if (isSubscription) {
        const list = subscriptionMap.get(m.provider) ?? [];
        list.push(m);
        subscriptionMap.set(m.provider, list);
      } else {
        const list = builtinMap.get(m.provider) ?? [];
        list.push(m);
        builtinMap.set(m.provider, list);
      }
    }

    const toProviders = (map: Map<string, UIModel[]>): GroupedProvider[] => {
      return Array.from(map.entries()).map(([providerId, pModels]) => ({
        providerId,
        providerTitle: formatProviderTitle(providerId),
        models: pModels,
      }));
    };

    const categories: GroupedCategory[] = [];

    const customProviders = toProviders(customMap);
    if (customProviders.length > 0) {
      categories.push({
        key: "custom",
        title: "自定义配置模型",
        badge: "models.json",
        icon: "🛠️",
        providers: customProviders,
        totalCount: customProviders.reduce((acc, p) => acc + p.models.length, 0),
      });
    }

    const subscriptionProviders = toProviders(subscriptionMap);
    if (subscriptionProviders.length > 0) {
      categories.push({
        key: "subscription",
        title: "订阅与平台授权",
        badge: "auth.json",
        icon: "🔑",
        providers: subscriptionProviders,
        totalCount: subscriptionProviders.reduce((acc, p) => acc + p.models.length, 0),
      });
    }

    const builtinProviders = toProviders(builtinMap);
    if (builtinProviders.length > 0) {
      categories.push({
        key: "builtin",
        title: "官方与环境变量模型",
        badge: "env",
        icon: "🌐",
        providers: builtinProviders,
        totalCount: builtinProviders.reduce((acc, p) => acc + p.models.length, 0),
      });
    }

    return categories;
  }, [filteredModels, customSet, subscriptionSet]);

  const displayedCategories = useMemo(() => {
    if (activeTab === "all") return groupedCategories;
    return groupedCategories.filter((c) => c.key === activeTab);
  }, [groupedCategories, activeTab]);

  const totalFilteredCount = filteredModels.length;

  useEffect(() => {
    if (!open) {
      setView("compact");
      setQuery("");
      setActiveTab("all");
      setRefreshError(null);
      return;
    }
    if (view !== "catalog") return;
    void refetch();
    const focus = () => inputRef.current?.focus();
    const t1 = window.setTimeout(focus, 0);
    return () => window.clearTimeout(t1);
  }, [open, view, refetch]);

  const handleForceRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const fresh = await refreshModelsApi();
      queryClient.setQueryData(MODELS_QUERY_KEY, fresh);
      await queryClient.invalidateQueries({ queryKey: ROLE_MODELS_QUERY_KEY });
    } catch {
      setRefreshError(t("refreshModelsFailed"));
    } finally {
      setRefreshing(false);
    }
  };

  const setThinking = (level: UIThinkingLevel) => {
    chatClient.send({ type: "set_thinking_level", level });
  };

  return (
    <Menu.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setView("compact");
      }}
    >
      <Menu.Trigger
        className="flex h-7.5 min-w-0 items-center gap-1 border-2 border-line bg-canvas px-2 font-mono text-xs font-bold text-ink shadow-[var(--pixel-shadow-sm)] transition-all hover:translate-x-[1px] hover:translate-y-[1px] hover:border-accent"
        title={current ? `${modelName} · ${thinkingLabel(thinking)}` : t("selectModel")}
      >
        <span className="min-w-0 max-w-[110px] truncate sm:max-w-[160px]">{modelName}</span>
        {showThinking && (
          <span className="shrink-0 text-[10px] font-normal text-muted">{thinkingLabel(thinking)}</span>
        )}
        <span className="shrink-0 text-[10px] text-accent">▾</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end">
          <Menu.Popup
            className={`flex flex-col overflow-hidden border-2 border-accent bg-card font-mono shadow-[var(--pixel-shadow)] outline-none animate-scale-in ${
              view === "catalog" ? "w-72" : "w-64"
            }`}
          >
            {view === "compact" ? (
              <div className="px-3 pb-3 pt-2.5">
                <div className="flex items-start gap-1">
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center text-faint" aria-hidden>
                    <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-[1.8]">
                      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <button
                    type="button"
                    onClick={() => setView("catalog")}
                    className="min-w-0 flex-1 py-0.5 text-center outline-none hover:text-accent"
                    title="选择模型"
                  >
                    {showThinking && (
                      <div className="flex items-center justify-center gap-1 text-[15px] font-black leading-none text-ink">
                        <span>{thinkingLabel(thinking)}</span>
                        <span className="text-[11px] font-bold text-faint">›</span>
                      </div>
                    )}
                    <div className={`truncate text-[11px] text-muted ${showThinking ? "mt-1" : "text-sm font-bold text-ink"}`}>
                      {modelName}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleForceRefresh()}
                    disabled={refreshing}
                    aria-label={t("refreshModels")}
                    className="mt-0.5 flex size-7 shrink-0 items-center justify-center text-faint hover:text-ink disabled:opacity-60"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className={`size-3.5 fill-none stroke-current stroke-2 ${refreshing ? "animate-spin" : ""}`}
                      aria-hidden
                    >
                      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
                {showThinking && (
                  <ThinkingSlider levels={levels} value={thinking} onChange={setThinking} />
                )}
                {refreshError && (
                  <div className="mt-1.5 text-center text-[10px] text-red-500" role="alert">
                    {refreshError}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="flex items-center gap-1 border-b-2 border-line bg-canvas/40 px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => setView("compact")}
                    className="flex size-7 shrink-0 items-center justify-center text-faint hover:text-ink"
                    aria-label="返回"
                  >
                    ‹
                  </button>
                  <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-ink">选择模型</span>
                  <button
                    type="button"
                    onClick={() => void handleForceRefresh()}
                    disabled={refreshing}
                    aria-label={t("refreshModels")}
                    className="flex size-7 shrink-0 items-center justify-center text-muted hover:text-ink disabled:opacity-60"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className={`size-3.5 fill-none stroke-current stroke-2 ${refreshing ? "animate-spin" : ""}`}
                      aria-hidden
                    >
                      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
                <div className="border-b-2 border-line p-2 space-y-2 bg-canvas/40">
                  <div className="flex items-center gap-2 border-2 border-line bg-canvas px-2.5">
                    <svg
                      viewBox="0 0 24 24"
                      className="size-4 shrink-0 fill-none stroke-current stroke-2 text-faint"
                      aria-hidden
                    >
                      <circle cx="11" cy="11" r="7" />
                      <path d="m20 20-3-3" strokeLinecap="round" />
                    </svg>
                    <input
                      ref={inputRef}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={t("searchModels")}
                      aria-label={t("searchModels")}
                      className="w-full bg-transparent py-1.5 font-mono text-xs text-ink outline-none placeholder:text-faint"
                      onKeyDown={(e) => {
                        if (e.key === "Escape") return;
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          e.currentTarget.blur();
                          return;
                        }
                        e.stopPropagation();
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                  <div className="flex items-center gap-1 overflow-x-auto pb-0.5 text-[10px]">
                    <button
                      type="button"
                      onClick={() => setActiveTab("all")}
                      className={`rounded px-2 py-0.5 transition-colors shrink-0 ${
                        activeTab === "all"
                          ? "bg-accent text-accent-ink font-bold"
                          : "bg-canvas text-muted hover:bg-hover hover:text-ink"
                      }`}
                    >
                      全部 ({totalFilteredCount})
                    </button>
                    {groupedCategories.map((c) => (
                      <button
                        key={c.key}
                        type="button"
                        onClick={() => setActiveTab(c.key)}
                        className={`flex items-center gap-1 rounded px-2 py-0.5 transition-colors shrink-0 ${
                          activeTab === c.key
                            ? "bg-accent text-accent-ink font-bold"
                            : "bg-canvas text-muted hover:bg-hover hover:text-ink"
                        }`}
                      >
                        <span>{c.icon}</span>
                        <span>{c.title.slice(0, 5)}</span>
                        <span className="opacity-80">({c.totalCount})</span>
                      </button>
                    ))}
                  </div>
                  {refreshError && (
                    <div className="text-[10px] text-red-500" role="alert">
                      {refreshError}
                    </div>
                  )}
                </div>
                <div className="max-h-64 overflow-y-auto divide-y divide-line/40">
                  {displayedCategories.map((cat) => (
                    <div key={cat.key} className="bg-canvas/10">
                      <div className="sticky top-0 z-10 flex items-center justify-between border-y border-line bg-canvas/95 px-3 py-1 backdrop-blur-sm">
                        <span className="flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-ink">
                          <span>{cat.icon}</span>
                          <span>{cat.title}</span>
                        </span>
                        <span className="text-[9px] font-mono text-faint">{cat.totalCount}</span>
                      </div>
                      {cat.providers.map((p) => (
                        <div key={p.providerId} className="py-0.5">
                          <div className="px-3 py-1 text-[10px] font-mono text-muted">
                            {p.providerTitle}
                          </div>
                          {p.models.map((m) => {
                            const active =
                              current && m.provider === current.provider && m.id === current.id;
                            return (
                              <Menu.Item
                                key={`${m.provider}/${m.id}`}
                                onClick={() =>
                                  chatClient.send({
                                    type: "set_model",
                                    provider: m.provider,
                                    id: m.id,
                                  })
                                }
                                className={`flex cursor-pointer items-center justify-between px-3 py-1.5 text-xs outline-none transition-colors data-[highlighted]:bg-hover ${
                                  active
                                    ? "bg-accent/15 font-bold text-accent"
                                    : "text-ink hover:bg-hover"
                                }`}
                              >
                                <span className="truncate">{m.name ?? m.id}</span>
                                {active && <span className="shrink-0 pl-2 text-accent">✓</span>}
                              </Menu.Item>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  ))}
                  {displayedCategories.length === 0 && (
                    <div className="px-3 py-8 text-center text-xs text-faint">
                      {models && models.length === 0 ? t("noModelsAvailable") : t("noSearchResults")}
                    </div>
                  )}
                </div>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
