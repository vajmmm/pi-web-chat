import { spawnSync } from "node:child_process";
import { resolveAgyBinary } from "./agy-runner.ts";

export interface AgyModelInfo {
  provider: "agy";
  id: string;
  name: string;
  reasoning: boolean;
}

const DEFAULT_AGY_MODELS: AgyModelInfo[] = [
  { provider: "agy", id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", reasoning: true },
  { provider: "agy", id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", reasoning: true },
  { provider: "agy", id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", reasoning: false },
  { provider: "agy", id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", reasoning: true },
  { provider: "agy", id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)", reasoning: true },
  { provider: "agy", id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)", reasoning: false },
  { provider: "agy", id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)", reasoning: true },
  { provider: "agy", id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)", reasoning: true },
  { provider: "agy", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)", reasoning: true },
  { provider: "agy", id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", reasoning: true },
  { provider: "agy", id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", reasoning: false },
];

let cachedModels: AgyModelInfo[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60_000;

/**
 * Returns available AGY models. Queries `agy models` with caching and fallback.
 */
export function getAgyCatalogModels(): AgyModelInfo[] {
  const now = Date.now();
  if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedModels;
  }

  try {
    const binary = resolveAgyBinary();
    const res = spawnSync(binary, ["models"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (res.error || res.status !== 0 || !res.stdout) {
      cachedModels = DEFAULT_AGY_MODELS;
      lastFetchTime = now;
      return cachedModels;
    }

    const lines = res.stdout.trim().split("\n");
    const parsed: AgyModelInfo[] = [];
    for (const line of lines) {
      const parts = line.trim().split(/\t+/);
      if (parts.length >= 2 && !parts[0].includes("Fetching")) {
        const id = parts[0].trim();
        const name = parts[1].trim();
        parsed.push({
          provider: "agy",
          id,
          name,
          reasoning: id.includes("high") || id.includes("thinking"),
        });
      }
    }

    if (parsed.length > 0) {
      cachedModels = parsed;
    } else {
      cachedModels = DEFAULT_AGY_MODELS;
    }
  } catch {
    cachedModels = DEFAULT_AGY_MODELS;
  }

  lastFetchTime = now;
  return cachedModels;
}

export function isAgyModel(provider?: string): boolean {
  return provider === "agy";
}
