import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function authPath(): string {
  return join(getAgentDir(), "auth.json");
}

export function modelsStorePath(): string {
  return join(getAgentDir(), "models-store.json");
}

export interface StoredCredential {
  type: "api_key" | "oauth" | string;
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  [key: string]: unknown;
}

export function readAuthCredentials(): Record<string, StoredCredential> {
  const file = authPath();
  if (!existsSync(file)) return {};
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, StoredCredential>;
  } catch (err) {
    console.warn(`[auth-config] Failed to read ${file}:`, err);
    return {};
  }
}

function writeAuthCredentials(credentials: Record<string, StoredCredential>): void {
  const file = authPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(credentials, null, 2), "utf8");
  renameSync(tmp, file);
}

/**
 * GitHub Copilot (and similar OAuth providers) store `availableModelIds` after login/refresh.
 * An empty array is treated by pi-ai `filterModels` as "no models allowed", which hides the
 * entire provider from `getAvailable()` / model pickers — even though auth is valid and the
 * static catalog still has models. Treat empty lists as "unknown" by removing the field so
 * the catalog models surface again until a successful refresh repopulates entitlements.
 */
export function sanitizeEmptyAvailableModelIds(): boolean {
  const credentials = readAuthCredentials();
  let changed = false;

  for (const cred of Object.values(credentials)) {
    if (!cred || typeof cred !== "object") continue;
    const ids = cred.availableModelIds;
    if (Array.isArray(ids) && ids.length === 0) {
      delete cred.availableModelIds;
      changed = true;
    }
  }

  if (changed) {
    writeAuthCredentials(credentials);
  }
  return changed;
}

export function writeAuthApiKey(providerId: string, apiKey: string): void {
  const credentials = readAuthCredentials();
  credentials[providerId] = {
    type: "api_key",
    key: apiKey.trim(),
  };
  writeAuthCredentials(credentials);
}

export function deleteAuthCredential(providerId: string): void {
  const credentials = readAuthCredentials();
  if (providerId in credentials) {
    delete credentials[providerId];
    writeAuthCredentials(credentials);
  }

  // 级联清理 models-store.json 中的该提供商缓存
  const storeFile = modelsStorePath();
  if (existsSync(storeFile)) {
    try {
      const raw = readFileSync(storeFile, "utf8");
      const store = JSON.parse(raw);
      if (store && typeof store === "object" && !Array.isArray(store)) {
        if (providerId in store) {
          delete store[providerId];
          const storeTmp = `${storeFile}.${Date.now()}.tmp`;
          writeFileSync(storeTmp, JSON.stringify(store, null, 2), "utf8");
          renameSync(storeTmp, storeFile);
        }
      }
    } catch (err) {
      console.warn(`[auth-config] Failed to clean models-store for ${providerId}:`, err);
    }
  }
}
