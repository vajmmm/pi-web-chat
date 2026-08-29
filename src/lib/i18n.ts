import { useSyncExternalStore } from "react";
import type { Messages } from "../i18n/en";
import { zh } from "../i18n/zh";

export type Locale = "zh";

export const LOCALES: { value: Locale; label: string; nativeLabel: string }[] = [
  { value: "zh", label: "Chinese", nativeLabel: "简体中文" },
];

const catalogs: Record<Locale, Messages> = { zh };
const listeners = new Set<() => void>();

export function isLocale(value: unknown): value is Locale {
  return value === "zh";
}

let current: Locale = "zh";

export function initLocale() {
  current = "zh";
  document.documentElement.lang = "zh-CN";
}

export function getLocale(): Locale {
  return "zh";
}

export function setLocale(_locale: Locale) {
  current = "zh";
  document.documentElement.lang = "zh-CN";
  for (const l of listeners) l();
}

export function getMessages(_locale: Locale = current): Messages {
  return catalogs.zh;
}

type Vars = Record<string, string | number>;

/** 模板渲染: "Hello {name}" + { name: "a" } → "Hello a" */
export function t(key: keyof Messages, vars?: Vars, _locale: Locale = current): string {
  const template = zh[key] ?? String(key);
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
export function localeTag(_locale: Locale = current): string {
  return "zh-CN";
}
