import { Menu } from "@base-ui-components/react/menu";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { UIModel } from "../../shared/protocol";
import { MODELS_QUERY_KEY, refreshModelsApi, useCustomModels, useModels, useSubscriptionModels } from "../lib/api";
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

type ModelCategoryTab = "all" | "custom" | "subscription" | "builtin";

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

export function ModelMenu({ current }: { current: UIModel | null }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: models, refetch } = useModels();
  const { data: customData } = useCustomModels();
  const { data: subscriptionData } = useSubscriptionModels();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<ModelCategoryTab>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
    if (!open) return;
    setQuery("");
    setActiveTab("all");
    setRefreshError(null);
    // Re-fetch on every open: the server performs a freshness-throttled catalog
    // refresh while serving GET /api/models, so newly published models appear.
    void refetch();
    const focus = () => inputRef.current?.focus();
    const t1 = window.setTimeout(focus, 0);
    const t2 = window.setTimeout(focus, 50);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [open, refetch]);

  const handleForceRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const fresh = await refreshModelsApi();
      queryClient.setQueryData(MODELS_QUERY_KEY, fresh);
    } catch {
      setRefreshError(t("refreshModelsFailed"));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger className="flex max-w-[40vw] items-center gap-1.5 truncate border-2 border-line-bright bg-card px-2.5 py-1 font-mono text-xs font-bold text-ink shadow-[var(--pixel-shadow-sm)] transition-all hover:translate-x-[1px] hover:translate-y-[1px] hover:border-accent hover:bg-hover sm:max-w-xs">
        <span className="truncate">{current ? (current.name ?? current.id) : t("selectModel")}</span>
        <span className="text-[10px] text-accent">▾</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end">
          <Menu.Popup className="flex w-80 sm:w-96 flex-col overflow-hidden border-2 border-accent bg-card font-mono shadow-[var(--pixel-shadow)] outline-none animate-scale-in">
            {/* Search Header */}
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
                  autoFocus
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
                {query && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      inputRef.current?.focus();
                    }}
                    className="shrink-0 text-faint hover:text-ink"
                    aria-label={t("clearSearch")}
                  >
                    <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-2">
                      <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Category Filter Chips */}
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
                <button
                  type="button"
                  onClick={handleForceRefresh}
                  disabled={refreshing}
                  aria-label={t("refreshModels")}
                  className="ml-auto flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-muted transition-colors hover:bg-hover hover:text-ink disabled:cursor-wait disabled:opacity-60"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className={`size-3 fill-none stroke-current stroke-2 ${refreshing ? "animate-spin" : ""}`}
                    aria-hidden
                  >
                    <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>{refreshing ? t("refreshingModels") : t("refreshModels")}</span>
                </button>
              </div>

              {refreshError && (
                <div className="text-[10px] text-red-500" role="alert">
                  {refreshError}
                </div>
              )}
            </div>

            {/* Grouped Model List */}
            <div className="max-h-[min(65vh,28rem)] overflow-y-auto divide-y divide-line/40">
              {displayedCategories.map((cat) => (
                <div key={cat.key} className="bg-canvas/10">
                  {/* Sticky Category Section Header */}
                  <div className="sticky top-0 z-10 flex items-center justify-between border-y border-line bg-canvas/95 px-3 py-1.5 backdrop-blur-sm shadow-sm">
                    <span className="text-[11px] font-bold tracking-wide text-ink flex items-center gap-1.5">
                      <span>{cat.icon}</span>
                      <span>{cat.title}</span>
                    </span>
                    <span className="rounded border border-line bg-card px-1.5 py-0.2 text-[9px] font-mono text-faint">
                      {cat.totalCount} 个模型
                    </span>
                  </div>

                  {/* Providers within Category */}
                  <div className="divide-y divide-line/20">
                    {cat.providers.map((p) => (
                      <div key={p.providerId} className="py-1">
                        <div className="flex items-center justify-between px-3 py-1 text-[10px] font-mono text-muted bg-card/40">
                          <span className="font-semibold text-ink/80 flex items-center gap-1">
                            <span>{p.providerTitle}</span>
                            <span className="text-faint font-normal">({p.providerId})</span>
                          </span>
                          <span className="text-faint">{p.models.length}</span>
                        </div>

                        <div className="py-0.5">
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
                                className={`flex cursor-pointer items-center justify-between px-3 py-2 text-xs outline-none transition-colors data-[highlighted]:bg-hover ${
                                  active
                                    ? "bg-accent/15 font-bold text-accent"
                                    : "text-ink hover:bg-hover"
                                }`}
                              >
                                <div className="flex flex-col min-w-0 pr-2">
                                  <div className="flex items-center gap-1.5 truncate">
                                    <span className="truncate">{m.name ?? m.id}</span>
                                    {m.reasoning && (
                                      <span className="rounded bg-accent/20 px-1 py-0.2 text-[9px] font-mono text-accent shrink-0">
                                        推理
                                      </span>
                                    )}
                                  </div>
                                  {m.name && m.name !== m.id && (
                                    <span className="text-[10px] text-faint truncate font-mono">
                                      {m.id}
                                    </span>
                                  )}
                                </div>
                                {active && (
                                  <span className="text-accent font-bold text-xs shrink-0 pl-2">
                                    ✓
                                  </span>
                                )}
                              </Menu.Item>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {displayedCategories.length === 0 && (
                <div className="px-3 py-8 text-center text-xs text-faint">
                  {models && models.length === 0 ? t("noModelsAvailable") : t("noSearchResults")}
                </div>
              )}
            </div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
