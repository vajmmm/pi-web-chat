import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
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

/**
 * SSRF guard for user-supplied provider base URLs.
 *
 * `probeCustomModels` fetches a URL entered by the user. Without a check a
 * crafted baseUrl could make the server request loopback / private / link-local
 * addresses (cloud metadata, internal dashboards, other local services) and
 * exfiltrate the response via the model list. We therefore reject such targets
 * BEFORE issuing any fetch.
 *
 * Only literal addresses are judged directly; hostnames are resolved first and
 * every resolved address is checked, so `http://internal.corp/` that resolves
 * to 10.0.0.5 is refused too.
 */

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed ⇒ treat as unsafe
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // "this network" 0.0.0.0/8
  if (a === 10) return true; // private 10.0.0.0/8
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
  if (a === 192 && b === 168) return true; // private 192.168.0.0/16
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51) return true; // documentation 198.51.100.0/24
  if (a === 203 && b === 0) return true; // documentation 203.0.113.0/24
  if (a >= 224) return true; // multicast 224.0.0.0/4 + reserved 240.0.0.0/4
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const h = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) — judge the embedded IPv4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (mapped) return isPrivateIPv4(mapped[1] as string);
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local fc00::/7
  if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) {
    return true; // link-local fe80::/10
  }
  return false;
}

/** True when an IP literal points at loopback/private/reserved space. */
export function isPrivateOrReservedAddress(ip: string): boolean {
  const stripped = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const version = isIP(stripped);
  if (version === 4) return isPrivateIPv4(stripped);
  if (version === 6) return isPrivateIPv6(stripped);
  return true; // not a recognisable literal ⇒ unsafe
}

function formatPrivateAddressError(hostname: string, detail: string): Error {
  return new Error(
    `拒绝探测 ${hostname}：目标地址属于回环/私有/保留网段（SSRF 防护${detail ? `，${detail}` : ""}）。`,
  );
}

/**
 * Reject a probe target that is (or resolves to) a loopback/private/reserved
 * address. Must run before any `fetch`.
 */
export async function assertProbeTargetAllowed(baseUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`无效的 Base URL：${baseUrl}`);
  }

  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;

  if (!hostname) throw formatPrivateAddressError(baseUrl, "无法解析主机名");

  if (isIP(hostname) !== 0) {
    if (isPrivateOrReservedAddress(hostname)) {
      throw formatPrivateAddressError(hostname, "字面 IP 位于受限网段");
    }
    return;
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw formatPrivateAddressError(hostname, "回环主机名");
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (err) {
    throw formatPrivateAddressError(
      hostname,
      `DNS 解析失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (addresses.length === 0) {
    throw formatPrivateAddressError(hostname, "DNS 未返回地址");
  }
  for (const { address } of addresses) {
    if (isPrivateOrReservedAddress(address)) {
      throw formatPrivateAddressError(hostname, `解析到受限地址 ${address}`);
    }
  }
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

  // SSRF guard: reject loopback/private targets before any network request.
  await assertProbeTargetAllowed(urlTrimmed);

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
