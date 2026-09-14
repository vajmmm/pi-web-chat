import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  UICustomApi,
  UICustomModel,
  UICustomModelsResponse,
  UICustomProvider,
} from "../shared/protocol.ts";

const HOME = homedir();

const APIS: UICustomApi[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

export function modelsPath(): string {
  return join(getAgentDir(), "models.json");
}

function shorten(p: string): string {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

type Json = Record<string, unknown>;

function readRaw(): { json: Json; parseError?: string } {
  const file = modelsPath();
  if (!existsSync(file)) return { json: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { json: {}, parseError: "models.json is not a JSON object" };
    }
    return { json: parsed as Json };
  } catch (err) {
    return { json: {}, parseError: err instanceof Error ? err.message : String(err) };
  }
}

function toNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function readCustomModels(): UICustomModelsResponse {
  const { json, parseError } = readRaw();
  const providersRaw = (json.providers ?? {}) as Record<string, Json>;
  const providers: UICustomProvider[] = Object.entries(providersRaw).map(([key, p]) => {
    const models = Array.isArray(p?.models) ? (p.models as Json[]) : [];
    return {
      key,
      baseUrl: typeof p?.baseUrl === "string" ? p.baseUrl : "",
      api: (APIS.includes(p?.api as UICustomApi) ? p.api : "openai-completions") as UICustomApi,
      apiKey: typeof p?.apiKey === "string" ? p.apiKey : undefined,
      models: models
        .filter((m): m is Json => !!m && typeof m === "object")
        .map((m) => ({
          id: typeof m.id === "string" ? m.id : "",
          name: typeof m.name === "string" ? m.name : undefined,
          reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
          contextWindow: toNumber(m.contextWindow),
          maxTokens: toNumber(m.maxTokens),
          input: Array.isArray(m.input)
            ? (m.input.filter((i) => i === "text" || i === "image") as ("text" | "image")[])
            : undefined,
        })),
    };
  });
  return { path: shorten(modelsPath()), providers, parseError };
}

/**
 * Redact provider secrets for outbound HTTP responses. The raw config retains
 * `apiKey` for internal runtime/probe use; clients only need to know whether a
 * key is configured (to render an "已配置" hint), never the value itself.
 *
 * Each provider's `apiKey` is dropped and replaced with `hasApiKey: boolean`.
 */
export function sanitizeCustomModelsResponse(
  res: UICustomModelsResponse,
): UICustomModelsResponse {
  return {
    ...res,
    providers: res.providers.map((p) => {
      const { apiKey, ...rest } = p;
      return { ...rest, hasApiKey: Boolean(apiKey && apiKey.trim()) };
    }),
  };
}

export function validateProviders(providers: unknown): string | null {
  if (!Array.isArray(providers)) return "providers must be an array";
  const seen = new Set<string>();
  for (const p of providers as UICustomProvider[]) {
    if (!p || typeof p !== "object") return "invalid provider entry";
    const key = String(p.key ?? "").trim();
    if (!key) return "provider key is required";
    if (!/^[\w.-]+$/.test(key)) return `invalid provider key: ${key}`;
    if (seen.has(key)) return `duplicate provider key: ${key}`;
    seen.add(key);
    if (!APIS.includes(p.api)) return `invalid api for ${key}`;
    const baseUrl = String(p.baseUrl ?? "").trim();
    if (!baseUrl) return `baseUrl is required for ${key}`;
    if (!/^https?:\/\//.test(baseUrl)) return `baseUrl must start with http(s):// (${key})`;
    if (!Array.isArray(p.models) || p.models.length === 0) {
      return `at least one model is required for ${key}`;
    }
    const ids = new Set<string>();
    for (const m of p.models) {
      const id = String(m?.id ?? "").trim();
      if (!id) return `model id is required for ${key}`;
      if (ids.has(id)) return `duplicate model id in ${key}: ${id}`;
      ids.add(id);
      for (const field of ["contextWindow", "maxTokens"] as const) {
        const v = m[field];
        if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
          return `${field} must be a positive number (${key}/${id})`;
        }
      }
    }
  }
  return null;
}

function mergeModel(existing: Json | undefined, next: UICustomModel): Json {
  const out: Json = { ...(existing ?? {}) };
  out.id = next.id.trim();
  const put = (k: string, v: unknown) => {
    if (v === undefined || v === "" || v === null) delete out[k];
    else out[k] = v;
  };
  put("name", next.name?.trim());
  put("reasoning", next.reasoning);
  put("contextWindow", next.contextWindow);
  put("maxTokens", next.maxTokens);
  put("input", next.input && next.input.length > 0 ? next.input : undefined);
  return out;
}

export function writeCustomModels(providers: UICustomProvider[]): void {
  const { json } = readRaw();
  const prevProviders = (json.providers ?? {}) as Record<string, Json>;
  const nextProviders: Record<string, Json> = {};

  for (const p of providers) {
    const key = p.key.trim();
    const prev = prevProviders[key];
    const prevModels = Array.isArray(prev?.models) ? (prev.models as Json[]) : [];
    const entry: Json = { ...(prev ?? {}) };
    entry.baseUrl = p.baseUrl.trim();
    entry.api = p.api;
    // Preserve a previously configured key when the request omits one. GET now
    // redacts apiKey (sanitizeCustomModelsResponse), so the edit form submits an
    // empty value for untouched providers — clearing it here would silently drop
    // the stored secret. `entry` already carries prev.apiKey via the spread
    // above, so we only overwrite when a non-empty key is provided.
    if (p.apiKey?.trim()) entry.apiKey = p.apiKey.trim();
    entry.models = p.models.map((m) =>
      mergeModel(
        prevModels.find((pm) => typeof pm?.id === "string" && pm.id === m.id.trim()),
        m,
      ),
    );
    nextProviders[key] = entry;
  }

  const out: Json = { ...json };
  if (Object.keys(nextProviders).length > 0) out.providers = nextProviders;
  else delete out.providers;

  const file = modelsPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export async function probeCustomModels(
  baseUrl: string,
  apiKey?: string,
  _api?: string,
): Promise<{ models: UICustomModel[] }> {
  const urlTrimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!urlTrimmed) {
    throw new Error("Base URL is required");
  }

  let resolvedApiKey = "";
  if (apiKey?.trim()) {
    const raw = apiKey.trim();
    if (raw.startsWith("$")) {
      const envName = raw.slice(1).trim();
      resolvedApiKey = process.env[envName] || "";
    } else {
      resolvedApiKey = raw;
    }
  }

  const candidateUrls: string[] = [];

  // 1. Direct /models
  candidateUrls.push(`${urlTrimmed}/models`);

  // 2. Direct /v1/models
  if (!urlTrimmed.endsWith("/v1")) {
    candidateUrls.push(`${urlTrimmed}/v1/models`);
  }

  // 3. If baseUrl has /v1 at the end, also try stripping /v1 -> /models
  if (urlTrimmed.endsWith("/v1")) {
    candidateUrls.push(`${urlTrimmed.slice(0, -3)}/models`);
  }

  // 4. If baseUrl has /claude-code, try parent /models and /v1/models
  if (urlTrimmed.endsWith("/claude-code")) {
    const parent = urlTrimmed.slice(0, -12);
    candidateUrls.push(`${parent}/models`);
    candidateUrls.push(`${parent}/v1/models`);
  }

  // 5. Ollama /api/tags
  candidateUrls.push(`${urlTrimmed}/api/tags`);

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (resolvedApiKey) {
    headers["Authorization"] = `Bearer ${resolvedApiKey}`;
    headers["x-api-key"] = resolvedApiKey;
  }

  const errors: string[] = [];

  for (const targetUrl of candidateUrls) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);
      const res = await fetch(targetUrl, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        errors.push(`${targetUrl} (HTTP ${res.status} ${res.statusText})`);
        continue;
      }

      const json = (await res.json()) as unknown;
      const rawModels: Array<{ id?: string; name?: string; model?: string }> = [];

      if (Array.isArray(json)) {
        for (const item of json) {
          if (typeof item === "string") rawModels.push({ id: item });
          else if (item && typeof item === "object") rawModels.push(item as { id?: string; name?: string });
        }
      } else if (json && typeof json === "object") {
        const anyJson = json as Record<string, unknown>;
        const list = (anyJson.data || anyJson.models || anyJson.result || anyJson.items) as unknown[];
        if (Array.isArray(list)) {
          for (const item of list) {
            if (typeof item === "string") rawModels.push({ id: item });
            else if (item && typeof item === "object") {
              rawModels.push(item as { id?: string; name?: string; model?: string });
            }
          }
        }
      }

      if (rawModels.length > 0) {
        const seenIds = new Set<string>();
        const models: UICustomModel[] = [];

        for (const m of rawModels) {
          const id = String(m.id || m.model || m.name || "").trim();
          if (!id || seenIds.has(id)) continue;
          seenIds.add(id);

          const isReasoning =
            /thinking|reasoning|r1|claude-3-7|o1|o3|gemini-2\.0-flash-thinking|deepseek-r1/i.test(
              id,
            );
          models.push({
            id,
            name: m.name?.trim() || id,
            contextWindow: 128000,
            maxTokens: 131072,
            reasoning: isReasoning,
            input: ["text", "image"],
          });
        }

        if (models.length > 0) {
          return { models };
        }
      }
      errors.push(`${targetUrl} (未包含可识别的模型字段)`);
    } catch (err) {
      errors.push(`${targetUrl} (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  throw new Error(`无法从远程服务拉取模型列表。尝试记录:\n${errors.join("\n")}`);
}
