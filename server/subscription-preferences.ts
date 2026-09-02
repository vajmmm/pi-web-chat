import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type HiddenModelsMap = Record<string, string[]>;

interface SubscriptionPreferencesFile {
  /** providerId -> hidden model ids */
  hiddenModels?: HiddenModelsMap;
}

export function subscriptionPreferencesPath(): string {
  return join(getAgentDir(), "subscription-preferences.json");
}

function readRaw(): SubscriptionPreferencesFile {
  const file = subscriptionPreferencesPath();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as SubscriptionPreferencesFile;
  } catch (err) {
    console.warn(`[subscription-preferences] Failed to read ${file}:`, err);
    return {};
  }
}

function writeRaw(data: SubscriptionPreferencesFile): void {
  const file = subscriptionPreferencesPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

function normalizeIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** providerId -> Set(modelId) */
export function readHiddenModelsMap(): Map<string, Set<string>> {
  const raw = readRaw().hiddenModels ?? {};
  const map = new Map<string, Set<string>>();
  for (const [providerId, ids] of Object.entries(raw)) {
    if (!providerId.trim()) continue;
    const normalized = normalizeIds(ids);
    if (normalized.length > 0) map.set(providerId, new Set(normalized));
  }
  return map;
}

export function isModelHidden(
  hidden: Map<string, Set<string>>,
  providerId: string,
  modelId: string,
): boolean {
  return hidden.get(providerId)?.has(modelId) ?? false;
}

export function getHiddenModelIds(providerId: string): string[] {
  return [...(readHiddenModelsMap().get(providerId) ?? [])];
}

function persistHiddenMap(map: Map<string, Set<string>>): void {
  const hiddenModels: HiddenModelsMap = {};
  for (const [providerId, ids] of map) {
    if (ids.size === 0) continue;
    hiddenModels[providerId] = [...ids].sort();
  }
  const data = readRaw();
  if (Object.keys(hiddenModels).length > 0) data.hiddenModels = hiddenModels;
  else delete data.hiddenModels;
  writeRaw(data);
}

export function hideSubscriptionModel(providerId: string, modelId: string): string[] {
  const provider = providerId.trim();
  const model = modelId.trim();
  if (!provider || !model) throw new Error("provider and modelId are required");

  const map = readHiddenModelsMap();
  const set = map.get(provider) ?? new Set<string>();
  set.add(model);
  map.set(provider, set);
  persistHiddenMap(map);
  return [...set].sort();
}

export function unhideSubscriptionModel(providerId: string, modelId: string): string[] {
  const provider = providerId.trim();
  const model = modelId.trim();
  if (!provider || !model) throw new Error("provider and modelId are required");

  const map = readHiddenModelsMap();
  const set = map.get(provider);
  if (set) {
    set.delete(model);
    if (set.size === 0) map.delete(provider);
    else map.set(provider, set);
    persistHiddenMap(map);
  }
  return [...(map.get(provider) ?? [])].sort();
}

export function unhideAllSubscriptionModels(providerId: string): string[] {
  const provider = providerId.trim();
  if (!provider) throw new Error("provider is required");

  const map = readHiddenModelsMap();
  if (map.has(provider)) {
    map.delete(provider);
    persistHiddenMap(map);
  }
  return [];
}

/** Clear preferences when a provider auth is removed. */
export function clearProviderHiddenModels(providerId: string): void {
  unhideAllSubscriptionModels(providerId);
}
