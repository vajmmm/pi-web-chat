import { Menu } from "@base-ui-components/react/menu";
import { useEffect, useMemo, useRef, useState } from "react";
import type { UIModel } from "../../shared/protocol";
import { useModels } from "../lib/api";
import { chatClient } from "../lib/chat";
import { useT } from "../lib/i18n";

function matchesQuery(model: UIModel, q: string) {
  if (!q) return true;
  const hay = `${model.name ?? ""} ${model.id} ${model.provider}`.toLowerCase();
  return hay.includes(q);
}

export function ModelMenu({ current }: { current: UIModel | null }) {
  const t = useT();
  const { data: models } = useModels();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (models ?? []).filter((m) => matchesQuery(m, q));
  }, [models, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const focus = () => inputRef.current?.focus();
    const t1 = window.setTimeout(focus, 0);
    const t2 = window.setTimeout(focus, 50);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [open]);

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger className="flex max-w-[40vw] items-center gap-1.5 truncate border-2 border-line-bright bg-card px-2.5 py-1 font-mono text-xs font-bold text-ink shadow-[var(--pixel-shadow-sm)] transition-all hover:translate-x-[1px] hover:translate-y-[1px] hover:border-accent hover:bg-hover sm:max-w-xs">
        <span className="truncate">{current ? (current.name ?? current.id) : t("selectModel")}</span>
        <span className="text-[10px] text-accent">▾</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end">
          <Menu.Popup className="flex w-72 flex-col overflow-hidden border-2 border-accent bg-card font-mono shadow-[var(--pixel-shadow)] outline-none">
            <div className="border-b-2 border-line p-2">
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
            </div>

            <div className="max-h-[min(50vh,22rem)] overflow-y-auto py-1">
              {filtered.map((m) => {
                const active = current && m.provider === current.provider && m.id === current.id;
                return (
                  <Menu.Item
                    key={`${m.provider}/${m.id}`}
                    onClick={() =>
                      chatClient.send({ type: "set_model", provider: m.provider, id: m.id })
                    }
                    className={`flex cursor-pointer flex-col px-3 py-2 text-xs outline-none data-[highlighted]:bg-hover ${
                      active ? "bg-hover font-bold text-accent" : "text-ink"
                    }`}
                  >
                    <span className="truncate">{m.name ?? m.id}</span>
                    <span className="text-[10px] text-faint">{m.provider}</span>
                  </Menu.Item>
                );
              })}
              {filtered.length === 0 && (
                <div className="px-3 py-6 text-center text-xs text-faint">
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
