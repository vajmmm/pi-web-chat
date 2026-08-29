import { Dialog } from "@base-ui-components/react/dialog";
import { useEffect, useState } from "react";
import type { UICustomApi, UICustomModel, UICustomProvider } from "../../shared/protocol";
import {
  saveCustomModels,
  useCustomModels,
  useInvalidateModels,
  useInvalidateSubscriptionModels,
  useSubscriptionModels,
} from "../lib/api";
import { useT } from "../lib/i18n";
import type { UISubscriptionProvider } from "../../shared/protocol";

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
              placeholder="8192"
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

      <div className="mt-3 flex flex-col gap-2">
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

function SubscriptionModelsSection() {
  const { data, isLoading, isRefetching, refetch } = useSubscriptionModels();
  const invalidate = useInvalidateSubscriptionModels();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRefresh = () => {
    invalidate();
    void refetch();
  };

  const providers = data?.providers ?? [];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-muted">
          订阅制模型
        </h3>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={isRefetching}
          className="rounded-lg px-2 py-0.5 text-[11px] text-accent hover:bg-hover disabled:opacity-40"
        >
          {isRefetching ? "刷新中…" : "刷新状态"}
        </button>
      </div>

      {isLoading && (
        <div className="py-3 text-center font-mono text-xs text-faint">加载中…</div>
      )}

      {!isLoading && providers.length === 0 && (
        <div className="py-3 text-center font-mono text-xs text-faint">
          暂无订阅制模型提供方
        </div>
      )}

      {providers.map((provider) => (
        <SubscriptionProviderCard
          key={provider.id}
          provider={provider}
          expanded={expanded.has(provider.id)}
          onToggle={() => toggle(provider.id)}
        />
      ))}
    </div>
  );
}

function SubscriptionProviderCard({
  provider,
  expanded,
  onToggle,
}: {
  provider: UISubscriptionProvider;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-xl border border-line bg-canvas/40 p-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold text-ink">{provider.name}</span>
        <span
          className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
            provider.configured
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
              : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
          }`}
        >
          {provider.configured ? "已配置" : "未配置"}
        </span>
        <span className="ml-auto font-mono text-[10px] text-faint">{provider.envKey}</span>
      </div>

      {provider.models.length > 0 && (
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
            可用模型 ({provider.models.length})
          </button>
          {expanded && (
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {provider.models.map((model) => (
                <li
                  key={model.id}
                  className="rounded-md border border-line bg-card px-2 py-0.5 font-mono text-[11px] text-ink shadow-[var(--pixel-shadow-sm)]"
                  title={model.name ?? model.id}
                >
                  {model.name ?? model.id}
                  {model.reasoning && (
                    <span className="ml-1 text-[9px] text-faint">推理</span>
                  )}
                </li>
              ))}
            </ul>
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
