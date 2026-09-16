import { spawn } from "node:child_process";
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
let refreshInFlight: Promise<AgyModelInfo[]> | null = null;
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 3_000;

function parseModelsOutput(stdout: string): AgyModelInfo[] {
  const lines = stdout.trim().split("\n");
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
  return parsed.length > 0 ? parsed : DEFAULT_AGY_MODELS;
}

function fetchAgyCatalogModels(): Promise<AgyModelInfo[]> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (models: AgyModelInfo[]) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(models);
    };

    let child;
    try {
      child = spawn(resolveAgyBinary(), ["models"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish(DEFAULT_AGY_MODELS);
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", () => finish(DEFAULT_AGY_MODELS));
    child.once("close", (code) => {
      if (code !== 0 || !stdout) {
        finish(DEFAULT_AGY_MODELS);
        return;
      }
      finish(parseModelsOutput(stdout));
    });

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(DEFAULT_AGY_MODELS);
    }, FETCH_TIMEOUT_MS);
  });
}

/** Returns the last known AGY models without blocking the request path. */
export function getAgyCatalogModels(): AgyModelInfo[] {
  const now = Date.now();
  if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) return cachedModels;
  void refreshAgyCatalogModels();
  return cachedModels ?? DEFAULT_AGY_MODELS;
}

/** Refreshes the AGY catalog off the event loop and coalesces concurrent calls. */
export function refreshAgyCatalogModels(): Promise<AgyModelInfo[]> {
  const now = Date.now();
  if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) {
    return Promise.resolve(cachedModels);
  }
  if (refreshInFlight) return refreshInFlight;

  const pending = fetchAgyCatalogModels()
    .catch(() => cachedModels ?? DEFAULT_AGY_MODELS)
    .then((models) => {
      cachedModels = models;
      lastFetchTime = Date.now();
      return models;
    });
  let tracked: Promise<AgyModelInfo[]>;
  tracked = pending.finally(() => {
    if (refreshInFlight === tracked) refreshInFlight = null;
  });
  refreshInFlight = tracked;
  return tracked;
}

export function isAgyModel(provider?: string): boolean {
  return provider === "agy";
}
