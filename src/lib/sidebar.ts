import { useSyncExternalStore } from "react";

const STORAGE_KEY = "pi-web-chat:sidebar-pinned";
const listeners = new Set<() => void>();

/**
 * Resolve the persisted sidebar-pinned flag.
 *
 * The sidebar is pinned (open) by default: only an explicit "0" collapses it.
 * A missing key (null) keeps the default pinned state so new users land in the
 * decompressed layout.
 */
export function resolvePinnedStoredValue(raw: string | null): boolean {
  return raw !== "0";
}

function readPinned(): boolean {
  try {
    return resolvePinnedStoredValue(localStorage.getItem(STORAGE_KEY));
  } catch {
    return true;
  }
}

let cache = typeof window !== "undefined" ? readPinned() : false;

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isSidebarPinned(): boolean {
  return cache;
}

export function setSidebarPinned(pinned: boolean) {
  cache = pinned;
  try {
    localStorage.setItem(STORAGE_KEY, pinned ? "1" : "0");
  } catch {
    // ignore quota / private mode
  }
  emit();
}

export function toggleSidebarPinned() {
  setSidebarPinned(!cache);
}

export function useSidebarPinned(): boolean {
  return useSyncExternalStore(subscribe, () => cache, () => false);
}
