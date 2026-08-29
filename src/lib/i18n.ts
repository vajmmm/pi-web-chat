import { useSyncExternalStore } from "react";
import { type Messages, en } from "../i18n/en";
import { zh } from "../i18n/zh";

export type Locale = "zh" | "en";

export const LOCALES: { value: Locale; label: string; nativeLabel: string }[] = [
  { value: "zh", label: "Chinese", nativeLabel: "简体中文" },
  { value: "en", label: "English", nativeLabel: "English" },
];

const catalogs: Record<Locale, Messages> = { zh, en };
const listeners = new Set<() => void>();

export function isLocale(value: unknown): value is Locale {
  return value === "zh" || value === "en";
}

let current: Locale = "zh";

export function initLocale() {
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem("pi-locale") : null;
  if (isLocale(saved)) {
    current = saved;
  } else {
    current = typeof navigator !== "undefined" && navigator.language.startsWith("zh") ? "zh" : "en";
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = current === "zh" ? "zh-CN" : "en-US";
  }
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale) {
  if (!isLocale(locale)) return;
  current = locale;
  try {
    localStorage.setItem("pi-locale", locale);
  } catch {}
  if (typeof document !== "undefined") {
    document.documentElement.lang = current === "zh" ? "zh-CN" : "en-US";
  }
  for (const l of listeners) l();
}

export function getMessages(locale: Locale = current): Messages {
  return catalogs[locale] ?? catalogs.zh;
}

type Vars = Record<string, string | number>;

/** 模板渲染: "Hello {name}" + { name: "a" } → "Hello a" */
export function t(key: keyof Messages, vars?: Vars, locale: Locale = current): string {
  const catalog = catalogs[locale] ?? catalogs.zh;
  const template = catalog[key] ?? en[key] ?? String(key);
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`,
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, () => current, () => "zh");
}

/** 当前 locale 的翻译函数 */
export function useT() {
  const locale = useLocale();
  return (key: keyof Messages, vars?: Vars) => t(key, vars, locale);
}

/** 日期时间显示用 BCP 47 标签 */
export function localeTag(locale: Locale = current): string {
  return locale === "zh" ? "zh-CN" : "en-US";
}
