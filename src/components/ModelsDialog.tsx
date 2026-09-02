import { Dialog } from "@base-ui-components/react/dialog";
import { useEffect, useState } from "react";
import type { UICustomApi, UICustomModel, UICustomProvider } from "../../shared/protocol";
import {
  addSubscriptionProvider,
  deleteSubscriptionProvider,
  fetchRemoteCustomModels,
  hideSubscriptionModel,
  saveCustomModels,
  unhideAllSubscriptionModels,
  unhideSubscriptionModel,
  useCustomModels,
  useInvalidateModels,
  useInvalidateSubscriptionModels,
  useSubscriptionModels,
} from "../lib/api";
import { useT } from "../lib/i18n";
import type { UISubscriptionModel, UISubscriptionProvider } from "../../shared/protocol";

const APIS: UICustomApi[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

const inputClass =
  "w-full border-2 border-line bg-canvas px-2.5 py-1.5 font-mono text-xs text-ink outline-none placeholder:text-faint focus:border-accent";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted">
        {label}
        {hint && <span className="ml-1 font-normal text-faint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function numberOrUndefined(v: string): number | undefined {
  const n = Number(v);
  return v.trim() === "" || !Number.isFinite(n) ? undefined : n;
}

function ModelRow({
  model,
  onChange,
  onRemove,
}: {
  model: UICustomModel;
  onChange: (next: UICustomModel) => void;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <div className="rounded-lg border border-line p-2.5">
      <div className="flex gap-2">
        <div className="flex-1">
          <Field label={t("modelId")}>
            <input
              className={inputClass}
              value={model.id}
              placeholder="llama3.1:8b"
              onChange={(e) => onChange({ ...model, id: e.target.value })}
            />
          </Field>
        </div>
        <div className="flex-1">
          <Field label={t("modelName")} hint={`(${t("optional")})`}>
            <input
              className={inputClass}
              value={model.name ?? ""}
              onChange={(e) => onChange({ ...model, name: e.target.value })}
            />
          </Field>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("removeModel")}
          title={t("removeModel")}
          className="mt-4 flex size-7 shrink-0 items-center justify-center self-start rounded-lg text-faint hover:bg-hover hover:text-ink"
        >
          <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2">
            <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="w-32">
          <Field label={t("contextWindow")} hint={`(${t("optional")})`}>
            <input
              className={inputClass}
              inputMode="numeric"
              value={model.contextWindow ?? ""}
              placeholder="128000"
              onChange={(e) => onChange({ ...model, contextWindow: numberOrUndefined(e.target.value) })}
            />
          </Field>
        </div>
        <div className="w-32">
          <Field label={t("maxTokens")} hint={`(${t("optional")})`}>
            <input
              className={inputClass}
              inputMode="numeric"
              value={model.maxTokens ?? ""}
              placeholder="131072"
              onChange={(e) => onChange({ ...model, maxTokens: numberOrUndefined(e.target.value) })}
            />
          </Field>
        </div>
        <label className="flex items-center gap-1.5 py-1.5 text-[12px] text-muted">
          <input
            type="checkbox"
            className="accent-[var(--c-accent)]"
            checked={model.reasoning ?? false}
            onChange={(e) => onChange({ ...model, reasoning: e.target.checked })}
          />
          {t("reasoning")}
        </label>
        <label className="flex items-center gap-1.5 py-1.5 text-[12px] text-muted">
          <input
            type="checkbox"
            className="accent-[var(--c-accent)]"
            checked={model.input?.includes("image") ?? false}
            onChange={(e) =>
              onChange({ ...model, input: e.target.checked ? ["text", "image"] : ["text"] })
            }
          />
          {t("imageInput")}
        </label>
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  onChange,
  onRemove,
}: {
  provider: UICustomProvider;
  onChange: (next: UICustomProvider) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const patch = (p: Partial<UICustomProvider>) => onChange({ ...provider, ...p });

  const [isProbing, setIsProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probeSuccess, setProbeSuccess] = useState<string | null>(null);

  const handleAutoFetch = async () => {
    if (!provider.baseUrl.trim()) {
      setProbeError("请先填写 Base URL");
      return;
    }
    setIsProbing(true);
    setProbeError(null);
    setProbeSuccess(null);
    try {
      const result = await fetchRemoteCustomModels({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        api: provider.api,
      });
      if (result.models.length === 0) {
        setProbeError("远程服务未返回任何可用模型");
        return;
      }

      const existingValid = provider.models.filter((m) => m.id.trim().length > 0);
      const existingIds = new Set(existingValid.map((m) => m.id.trim()));
      const newModels = result.models.filter((m) => !existingIds.has(m.id.trim()));

      const finalModels = [...existingValid, ...newModels];
      patch({ models: finalModels.length > 0 ? finalModels : result.models });
      setProbeSuccess(
        `成功获取 ${result.models.length} 个模型（新增 ${newModels.length} 个）`,
      );
      setTimeout(() => setProbeSuccess(null), 4000);
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsProbing(false);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-canvas/60 p-3">
      <div className="flex gap-2">
        <div className="flex-1">
          <Field label={t("providerKey")}>
            <input
              className={inputClass}
              value={provider.key}
              placeholder="ollama"
              onChange={(e) => patch({ key: e.target.value })}
            />
          </Field>
        </div>
        <div className="w-48">
          <Field label={t("apiType")}>
            <select
              className={inputClass}
              value={provider.api}
              onChange={(e) => patch({ api: e.target.value as UICustomApi })}
            >
              {APIS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("removeProvider")}
          title={t("removeProvider")}
          className="mt-4 flex size-7 shrink-0 items-center justify-center self-start rounded-lg text-faint hover:bg-hover hover:text-ink"
        >
          <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2">
            <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <Field label={t("baseUrl")}>
          <input
            className={inputClass}
            value={provider.baseUrl}
            placeholder="http://localhost:11434/v1"
            onChange={(e) => patch({ baseUrl: e.target.value })}
          />
        </Field>
        <Field label={t("apiKey")} hint={`(${t("optional")})`}>
          <input
            className={inputClass}
            value={provider.apiKey ?? ""}
            placeholder="$OPENAI_API_KEY"
            onChange={(e) => patch({ apiKey: e.target.value })}
          />
        </Field>
      </div>
      <p className="mt-1 text-[11px] text-faint">{t("apiKeyHint")}</p>

      <div className="mt-3 flex flex-col gap-2 border-t border-line/40 pt-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold text-muted">
            模型列表 ({provider.models.length})
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleAutoFetch}
              disabled={isProbing || !provider.baseUrl.trim()}
              className="flex items-center gap-1 rounded-lg border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/20 disabled:opacity-40 transition-colors"
              title="从该 Base URL 自动拉取 /models 接口的可用模型"
            >
              <span>⚡</span>
              <span>{isProbing ? "正在拉取模型…" : "自动拉取模型"}</span>
            </button>
          </div>
        </div>

        {probeError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2 font-mono text-[11px] text-red-500 whitespace-pre-wrap">
            {probeError}
          </div>
        )}

        {probeSuccess && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2 font-mono text-[11px] text-emerald-600 dark:text-emerald-400">
            ✓ {probeSuccess}
          </div>
        )}

        {provider.models.map((m, i) => (
          <ModelRow
            key={i}
            model={m}
            onChange={(next) =>
              patch({ models: provider.models.map((old, j) => (j === i ? next : old)) })
            }
            onRemove={() => patch({ models: provider.models.filter((_, j) => j !== i) })}
          />
        ))}
        <button
          type="button"
          onClick={() => patch({ models: [...provider.models, { id: "" }] })}
          className="self-start rounded-lg px-2 py-1 text-[12px] font-medium text-accent hover:bg-hover"
        >
          + {t("addModel")}
        </button>
      </div>
    </div>
  );
}

const PRESET_SUBSCRIPTION_PROVIDERS = [
  { id: "opencode-go", label: "OpenCode Go (opencode-go)" },
  { id: "opencode", label: "OpenCode (opencode)" },
  { id: "openai-codex", label: "OpenAI Codex (openai-codex)" },
  { id: "xai", label: "xAI Grok (xai)" },
  { id: "github-copilot", label: "GitHub Copilot (github-copilot)" },
  { id: "anthropic", label: "Anthropic Claude (anthropic)" },
  { id: "google-gemini", label: "Google Gemini (google-gemini)" },
  { id: "deepseek", label: "DeepSeek (deepseek)" },
  { id: "minimax", label: "MiniMax (minimax)" },
  { id: "openrouter", label: "OpenRouter (openrouter)" },
  { id: "mistral", label: "Mistral AI (mistral)" },
  { id: "groq", label: "Groq (groq)" },
  { id: "cerebras", label: "Cerebras (cerebras)" },
  { id: "custom", label: "+ 自定义服务商 ID..." },
];

function SubscriptionModelsSection() {
  const { data, isLoading, isRefetching, refetch } = useSubscriptionModels();
  const invalidateSubscription = useInvalidateSubscriptionModels();
  const invalidateModels = useInvalidateModels();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // 添加服务商表单状态
  const [showAdd, setShowAdd] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState("opencode-go");
  const [customId, setCustomId] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // 删除服务商状态
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRefresh = async () => {
    invalidateSubscription();
    invalidateModels();
    await refetch();
  };

  const handleAddProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    const providerId = selectedPreset === "custom" ? customId.trim() : selectedPreset.trim();
    if (!providerId) {
      setAddError("请输入或选择服务商 ID");
      return;
    }
    if (!apiKeyInput.trim()) {
      setAddError("请输入 API 密钥");
      return;
    }

    setIsAdding(true);
    setAddError(null);
    try {
      await addSubscriptionProvider(providerId, apiKeyInput.trim());
      invalidateSubscription();
      invalidateModels();
      await refetch();
      setShowAdd(false);
      setApiKeyInput("");
      setCustomId("");
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsAdding(false);
    }
  };

  const handleDeleteProvider = async (providerId: string) => {
    if (!window.confirm(`确定要删除 ${providerId} 授权吗？其关联的缓存模型也将被清除。`)) {
      return;
    }
    setDeletingId(providerId);
    try {
      await deleteSubscriptionProvider(providerId);
      invalidateSubscription();
      invalidateModels();
      await refetch();
    } catch (err) {
      alert(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeletingId(null);
    }
  };

  const providers = data?.providers ?? [];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-muted">
          订阅制与已授权模型 ({providers.length})
        </h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setShowAdd((prev) => !prev);
              setAddError(null);
            }}
            className="rounded-lg border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/20 transition-colors"
          >
            {showAdd ? "取消添加" : "+ 添加服务商授权"}
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefetching}
            className="rounded-lg px-2 py-0.5 text-[11px] text-accent hover:bg-hover disabled:opacity-40"
          >
            {isRefetching ? "刷新中…" : "刷新状态"}
          </button>
        </div>
      </div>

      {showAdd && (
        <form
          onSubmit={handleAddProvider}
          className="rounded-xl border border-accent/30 bg-accent/5 p-3 space-y-2.5 animate-scale-in"
        >
          <div className="text-[12px] font-bold text-ink">添加/配置订阅制或 API Key 服务商</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted">服务商 (Provider)</span>
              <select
                className={inputClass}
                value={selectedPreset}
                onChange={(e) => setSelectedPreset(e.target.value)}
              >
                {PRESET_SUBSCRIPTION_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {selectedPreset === "custom" ? (
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted">自定义 Provider ID</span>
                <input
                  className={inputClass}
                  value={customId}
                  placeholder="例如: minimax, moonshot"
                  onChange={(e) => setCustomId(e.target.value)}
                />
              </label>
            ) : (
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted">Provider ID</span>
                <input className={`${inputClass} bg-canvas/40 text-faint`} value={selectedPreset} disabled />
              </label>
            )}
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted">API Key / Access Token</span>
            <input
              type="password"
              className={inputClass}
              value={apiKeyInput}
              placeholder="sk-..."
              onChange={(e) => setApiKeyInput(e.target.value)}
            />
          </label>
          {addError && <div className="text-[11px] text-red-500 font-mono">{addError}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowAdd(false)}
              className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-muted hover:bg-hover"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isAdding}
              className="rounded-lg bg-accent px-3 py-1 text-[11px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
            >
              {isAdding ? "正在验证保存…" : "确认添加授权"}
            </button>
          </div>
        </form>
      )}

      {isLoading && (
        <div className="py-3 text-center font-mono text-xs text-faint">加载中…</div>
      )}

      {!isLoading && providers.length === 0 && (
        <div className="py-3 text-center font-mono text-xs text-faint">
          暂无已配置的订阅制或认证服务商
        </div>
      )}

      {providers.map((provider) => (
        <SubscriptionProviderCard
          key={provider.id}
          provider={provider}
          expanded={expanded.has(provider.id)}
          isDeleting={deletingId === provider.id}
          onToggle={() => toggle(provider.id)}
          onDelete={() => handleDeleteProvider(provider.id)}
          onModelsChanged={async () => {
            invalidateSubscription();
            invalidateModels();
            await refetch();
          }}
        />
      ))}
    </div>
  );
}

function SubscriptionProviderCard({
  provider,
  expanded,
  isDeleting,
  onToggle,
  onDelete,
  onModelsChanged,
}: {
  provider: UISubscriptionProvider;
  expanded: boolean;
  isDeleting: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onModelsChanged: () => Promise<void>;
}) {
  const [pendingModelId, setPendingModelId] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const hiddenModels = provider.hiddenModels ?? [];
  const totalCatalog = provider.models.length + hiddenModels.length;

  const runModelAction = async (fn: () => Promise<unknown>) => {
    setModelError(null);
    try {
      await fn();
      await onModelsChanged();
    } catch (err) {
      setModelError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingModelId(null);
    }
  };

  const handleHide = (model: UISubscriptionModel) => {
    setPendingModelId(model.id);
    void runModelAction(() => hideSubscriptionModel(provider.id, model.id));
  };

  const handleUnhide = (model: UISubscriptionModel) => {
    setPendingModelId(model.id);
    void runModelAction(() => unhideSubscriptionModel(provider.id, model.id));
  };

  const handleUnhideAll = () => {
    setPendingModelId("__all__");
    void runModelAction(() => unhideAllSubscriptionModels(provider.id));
  };

  return (
    <div className="rounded-xl border border-line bg-canvas/40 p-3">
      <div className="flex items-center gap-2">
        <div className="flex flex-col">
          <span className="text-[13px] font-semibold text-ink">{provider.name}</span>
          <span className="text-[10px] font-mono text-faint">ID: {provider.id}</span>
        </div>
        <span
          className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
            provider.configured
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
              : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
          }`}
        >
          {provider.configured ? (provider.authType === "oauth" ? "OAuth 已授权" : "API Key 已授权") : "未配置"}
        </span>
        {provider.authSource && (
          <span className="text-[9px] text-faint font-mono hidden sm:inline">({provider.authSource})</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {provider.envKey && (
            <span className="hidden md:inline font-mono text-[10px] text-faint">{provider.envKey}</span>
          )}
          <button
            type="button"
            onClick={onDelete}
            disabled={isDeleting}
            aria-label={`删除 ${provider.name} 授权`}
            title={`删除 ${provider.name} 授权与缓存`}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-red-500 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
          >
            <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-2">
              <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{isDeleting ? "删除中…" : "删除"}</span>
          </button>
        </div>
      </div>

      {totalCatalog > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={onToggle}
            className="flex items-center gap-1 text-[11px] text-muted hover:text-ink"
          >
            <svg
              viewBox="0 0 24 24"
              className={`size-3.5 fill-none stroke-current stroke-2 transition-transform ${
                expanded ? "rotate-90" : ""
              }`}
            >
              <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            可用模型 ({provider.models.length}
            {hiddenModels.length > 0 ? ` / 已隐藏 ${hiddenModels.length}` : ""})
          </button>
          {expanded && (
            <div className="mt-1.5 space-y-2">
              <p className="text-[10px] text-faint">
                点击模型右侧 × 可从选择器中移除；已隐藏的模型可随时恢复。
              </p>
              {provider.models.length === 0 ? (
                <div className="text-[11px] text-faint">当前没有可见模型（均已隐藏）</div>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {provider.models.map((model) => (
                    <li
                      key={model.id}
                      className="group flex items-center gap-1 rounded-md border border-line bg-card pl-2 pr-1 py-0.5 font-mono text-[11px] text-ink shadow-[var(--pixel-shadow-sm)]"
                      title={model.id}
                    >
                      <span className="truncate max-w-[14rem]">{model.name ?? model.id}</span>
                      {model.reasoning && (
                        <span className="text-[9px] text-faint shrink-0">推理</span>
                      )}
                      <button
                        type="button"
                        onClick={() => handleHide(model)}
                        disabled={pendingModelId !== null}
                        aria-label={`隐藏模型 ${model.name ?? model.id}`}
                        title="从选择器中移除"
                        className="ml-0.5 rounded p-0.5 text-faint opacity-70 transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-40 group-hover:opacity-100"
                      >
                        {pendingModelId === model.id ? (
                          <span className="text-[9px] px-0.5">…</span>
                        ) : (
                          <svg viewBox="0 0 24 24" className="size-3 fill-none stroke-current stroke-2">
                            <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
                          </svg>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {hiddenModels.length > 0 && (
                <div className="rounded-lg border border-dashed border-line/80 bg-canvas/30 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setShowHidden((v) => !v)}
                      className="text-[11px] text-muted hover:text-ink"
                    >
                      {showHidden ? "▾" : "▸"} 已隐藏模型 ({hiddenModels.length})
                    </button>
                    <button
                      type="button"
                      onClick={handleUnhideAll}
                      disabled={pendingModelId !== null}
                      className="rounded px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/10 disabled:opacity-40"
                    >
                      {pendingModelId === "__all__" ? "恢复中…" : "全部恢复"}
                    </button>
                  </div>
                  {showHidden && (
                    <ul className="mt-1.5 flex flex-wrap gap-1.5">
                      {hiddenModels.map((model) => (
                        <li
                          key={model.id}
                          className="flex items-center gap-1 rounded-md border border-line/70 bg-card/60 pl-2 pr-1 py-0.5 font-mono text-[11px] text-muted"
                          title={model.id}
                        >
                          <span className="truncate max-w-[14rem] line-through opacity-80">
                            {model.name ?? model.id}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleUnhide(model)}
                            disabled={pendingModelId !== null}
                            className="rounded px-1 py-0.5 text-[10px] text-accent hover:bg-accent/10 disabled:opacity-40"
                          >
                            {pendingModelId === model.id ? "…" : "恢复"}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {modelError && (
                <div className="text-[11px] text-red-500 font-mono">{modelError}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ModelsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { data, refetch } = useCustomModels(open);
  const invalidateModels = useInvalidateModels();
  const [draft, setDraft] = useState<UICustomProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    if (open && data && draft === null) setDraft(structuredClone(data.providers));
  }, [open, data, draft]);

  const close = () => {
    onOpenChange(false);
    setDraft(null);
    setError(null);
    setStatus("idle");
  };

  const save = async () => {
    if (!draft) return;
    setStatus("saving");
    setError(null);
    try {
      const result = await saveCustomModels(draft);
      setDraft(structuredClone(result.providers));
      setStatus("saved");
      setError(result.warning ?? null);
      await invalidateModels();
      await refetch();
      if (!result.warning) window.setTimeout(close, 400);
    } catch (err) {
      setStatus("idle");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/50 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 flex max-h-[82vh] w-[94vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col border-2 border-line-bright bg-card font-mono shadow-[var(--pixel-shadow)] outline-none">
          <div className="border-b-2 border-line px-4 py-3">
            <Dialog.Title className="text-sm font-bold text-ink">{t("manageModels")}</Dialog.Title>
            <Dialog.Description className="mt-0.5 font-mono text-xs text-faint">
              {t("customModelsDescription", { path: data?.path ?? "models.json" })}
            </Dialog.Description>
          </div>

          <div className="thin-scroll flex flex-1 flex-col gap-3 overflow-y-auto p-4">
            {data?.parseError && (
              <div className="border-2 border-red-300 bg-red-50 px-3 py-2 font-mono text-xs text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
                models.json parse error: {data.parseError}
              </div>
            )}
            {(draft ?? []).map((p, i) => (
              <ProviderCard
                key={i}
                provider={p}
                onChange={(next) =>
                  setDraft((prev) => (prev ?? []).map((old, j) => (j === i ? next : old)))
                }
                onRemove={() => setDraft((prev) => (prev ?? []).filter((_, j) => j !== i))}
              />
            ))}
            {draft && draft.length === 0 && (
              <div className="py-6 text-center font-mono text-xs text-faint">{t("noCustomProviders")}</div>
            )}
            <button
              type="button"
              onClick={() =>
                setDraft((prev) => [
                  ...(prev ?? []),
                  {
                    key: "",
                    baseUrl: "",
                    api: "openai-completions",
                    apiKey: "",
                    models: [{ id: "" }],
                  },
                ])
              }
              className="self-start border-2 border-line-bright bg-card px-3 py-1.5 font-mono text-xs font-bold text-accent shadow-[var(--pixel-shadow-sm)] hover:translate-x-[1px] hover:translate-y-[1px] hover:border-accent hover:bg-hover"
            >
              + {t("addProvider")}
            </button>

            <div className="border-t-2 border-line pt-3">
              <SubscriptionModelsSection />
            </div>
          </div>

          <div className="flex items-center gap-2 border-t-2 border-line px-4 py-3">
            <div className="min-w-0 flex-1 truncate text-xs">
              {error ? (
                <span className="text-red-500 dark:text-red-400">{error}</span>
              ) : status === "saved" ? (
                <span className="text-emerald-600 dark:text-emerald-400">{t("saved")}</span>
              ) : null}
            </div>
            <button
              type="button"
              onClick={close}
              className="border-2 border-transparent px-3 py-1.5 font-mono text-xs text-muted hover:border-line hover:bg-hover hover:text-ink"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={status === "saving" || draft === null}
              className="border-2 border-accent bg-accent px-3.5 py-1.5 font-mono text-xs font-bold text-accent-ink shadow-[2px_2px_0_rgba(119,68,180,0.3)] transition-all hover:translate-x-[1px] hover:translate-y-[1px] disabled:opacity-40 disabled:hover:translate-x-0 disabled:hover:translate-y-0"
            >
              {status === "saving" ? t("saving") : t("save")}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
