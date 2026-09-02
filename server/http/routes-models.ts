import type { IncomingMessage, ServerResponse } from "node:http";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  UICustomModelsResponse,
  UICustomProvider,
  UISubscriptionModelsResponse,
} from "../../shared/protocol.ts";
import {
  authPath,
  deleteAuthCredential,
  readAuthCredentials,
  sanitizeEmptyAvailableModelIds,
  writeAuthApiKey,
} from "../auth-config.ts";
import {
  probeCustomModels,
  readCustomModels,
  validateProviders,
  writeCustomModels,
} from "../models-config.ts";
import {
  clearProviderHiddenModels,
  hideSubscriptionModel,
  isModelHidden,
  readHiddenModelsMap,
  subscriptionPreferencesPath,
  unhideAllSubscriptionModels,
  unhideSubscriptionModel,
} from "../subscription-preferences.ts";
import { readBody, type ServerContext } from "./context.ts";

export async function handleModelsRoutes(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<boolean> {
  const { subagentManager } = ctx;

  if (url.pathname === "/api/models") {
    // Re-heal if a later OAuth refresh wrote availableModelIds: [] again.
    if (sanitizeEmptyAvailableModelIds()) {
      try {
        const newRuntime = await ModelRuntime.create({ allowModelNetwork: true });
        ctx.updateModelRuntime(newRuntime);
        subagentManager.updateModelRuntime(newRuntime);
      } catch (reloadErr) {
        console.warn("[server] Failed to reload model runtime after auth sanitize:", reloadErr);
      }
    }

    const runtime = ctx.getModelRuntime();
    const models = [...(await runtime.getAvailable())];
    const seen = new Set(models.map((m) => `${m.provider}\0${m.id}`));
    const availableProviders = new Set(models.map((m) => m.provider));
    const storedCredentials = readAuthCredentials();
    const hiddenModels = readHiddenModelsMap();

    // Safety net: configured providers that still yield zero available models (filter edge
    // cases) should still appear in the picker using their catalog models.
    for (const provider of runtime.getProviders()) {
      if (availableProviders.has(provider.id)) continue;
      const configured =
        runtime.hasConfiguredAuth(provider.id) || Boolean(storedCredentials[provider.id]);
      if (!configured) continue;
      for (const m of provider.getModels()) {
        const key = `${m.provider}\0${m.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        models.push(m);
      }
    }

    const visible = models.filter((m) => !isModelHidden(hiddenModels, m.provider, m.id));

    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(
      JSON.stringify(
        visible.map((m) => ({
          provider: m.provider,
          id: m.id,
          name: (m as { name?: string }).name,
          reasoning: (m as { reasoning?: boolean }).reasoning,
        })),
      ),
    );
    return true;
  }

  if (url.pathname === "/api/subscription-models") {
    const getSubscriptionResponse = (): UISubscriptionModelsResponse => {
      const credentials = readAuthCredentials();
      const hiddenMap = readHiddenModelsMap();
      const customProviders = new Set(readCustomModels().providers.map((p) => p.key));

      const KNOWN_PROVIDER_METAS: Record<string, { name: string; envKey: string }> = {
        "opencode-go": { name: "OpenCode Go", envKey: "OPENCODE_API_KEY" },
        "opencode": { name: "OpenCode", envKey: "OPENCODE_API_KEY" },
        "openai-codex": { name: "OpenAI Codex", envKey: "OPENAI_API_KEY" },
        "xai": { name: "xAI Grok", envKey: "XAI_API_KEY" },
        "github-copilot": { name: "GitHub Copilot", envKey: "GITHUB_COPILOT_TOKEN" },
        "anthropic": { name: "Anthropic Claude", envKey: "ANTHROPIC_API_KEY" },
        "google-gemini": { name: "Google Gemini", envKey: "GEMINI_API_KEY" },
        "google-vertex": { name: "Google Vertex AI", envKey: "GOOGLE_APPLICATION_CREDENTIALS" },
        "deepseek": { name: "DeepSeek", envKey: "DEEPSEEK_API_KEY" },
        "minimax": { name: "MiniMax", envKey: "MINIMAX_API_KEY" },
        "openrouter": { name: "OpenRouter", envKey: "OPENROUTER_API_KEY" },
        "mistral": { name: "Mistral AI", envKey: "MISTRAL_API_KEY" },
        "groq": { name: "Groq", envKey: "GROQ_API_KEY" },
        "cerebras": { name: "Cerebras", envKey: "CEREBRAS_API_KEY" },
        "cohere": { name: "Cohere", envKey: "COHERE_API_KEY" },
      };

      const allCandidateIds = new Set<string>([
        ...Object.keys(KNOWN_PROVIDER_METAS),
        ...Object.keys(credentials),
      ]);

      const providers = Array.from(allCandidateIds)
        .filter((id) => {
          // 排除用户在 models.json 中显式定义了 baseUrl/模型的自定义提供方
          if (customProviders.has(id)) return false;
          // 排除带 -custom 后缀的自定义提供方
          if (id.endsWith("-custom")) return false;
          // 必须在已知订阅服务商中，或在 auth.json 且属于原生订阅/网关服务
          return Boolean(KNOWN_PROVIDER_METAS[id] || credentials[id]);
        })
        .map((id) => {
          const runtime = ctx.getModelRuntime();
          const authStatus = runtime.getProviderAuthStatus(id);
          const provider = runtime.getProvider(id);
          const models = provider?.getModels() ?? [];
          const cred = credentials[id];
          const meta = KNOWN_PROVIDER_METAS[id] ?? {
            name: id.charAt(0).toUpperCase() + id.slice(1),
            envKey: `${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`,
          };
          const isConfigured = Boolean(cred || authStatus.configured);
          const hidden = hiddenMap.get(id) ?? new Set<string>();
          const allModels = models.map((m) => ({
            id: m.id,
            name: m.name,
            reasoning: m.reasoning,
          }));
          return {
            id,
            name: meta.name,
            envKey: meta.envKey,
            configured: isConfigured,
            authSource: cred ? "auth.json" : authStatus.source,
            authType: cred?.type ?? (authStatus.configured ? "oauth" : "api_key"),
            models: allModels.filter((m) => !hidden.has(m.id)),
            hiddenModels: allModels.filter((m) => hidden.has(m.id)),
          };
        })
        .filter((p) => p.configured);

      return {
        providers,
        path: authPath(),
        preferencesPath: subscriptionPreferencesPath(),
      };
    };

    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(getSubscriptionResponse()));
      return true;
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      try {
        const parsed = JSON.parse(body) as {
          action?: string;
          provider?: string;
          apiKey?: string;
          modelId?: string;
        };

        // Configure model visibility (hide / unhide) without touching auth.
        if (
          parsed.action === "hide_model" ||
          parsed.action === "unhide_model" ||
          parsed.action === "unhide_all"
        ) {
          const provider = typeof parsed.provider === "string" ? parsed.provider.trim() : "";
          if (!provider) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "provider ID is required" }));
            return true;
          }
          try {
            if (parsed.action === "hide_model") {
              const modelId = typeof parsed.modelId === "string" ? parsed.modelId.trim() : "";
              if (!modelId) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "modelId is required" }));
                return true;
              }
              hideSubscriptionModel(provider, modelId);
            } else if (parsed.action === "unhide_model") {
              const modelId = typeof parsed.modelId === "string" ? parsed.modelId.trim() : "";
              if (!modelId) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "modelId is required" }));
                return true;
              }
              unhideSubscriptionModel(provider, modelId);
            } else {
              unhideAllSubscriptionModels(provider);
            }
          } catch (prefErr) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: prefErr instanceof Error ? prefErr.message : String(prefErr),
              }),
            );
            return true;
          }

          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(getSubscriptionResponse()));
          return true;
        }

        const { provider, apiKey } = parsed;
        if (!provider || typeof provider !== "string" || !provider.trim()) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "provider ID is required" }));
          return true;
        }
        if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "apiKey is required" }));
          return true;
        }

        writeAuthApiKey(provider.trim(), apiKey.trim());

        try {
          const newRuntime = await ModelRuntime.create({ allowModelNetwork: true });
          ctx.updateModelRuntime(newRuntime);
          subagentManager.updateModelRuntime(newRuntime);
        } catch (reloadErr) {
          console.warn("[server] Failed to reload model runtime after adding auth:", reloadErr);
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(getSubscriptionResponse()));
        return true;
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `invalid JSON: ${String(err)}` }));
        return true;
      }
    }

    if (req.method === "DELETE") {
      let providerId = url.searchParams.get("provider");
      if (!providerId) {
        try {
          const body = await readBody(req);
          if (body) {
            const parsed = JSON.parse(body);
            if (parsed && typeof parsed.provider === "string") {
              providerId = parsed.provider;
            }
          }
        } catch {}
      }

      if (!providerId || !providerId.trim()) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "provider ID is required for deletion" }));
        return true;
      }

      const id = providerId.trim();
      deleteAuthCredential(id);
      clearProviderHiddenModels(id);

      try {
        const newRuntime = await ModelRuntime.create();
        ctx.updateModelRuntime(newRuntime);
        subagentManager.updateModelRuntime(newRuntime);
      } catch (reloadErr) {
        console.warn("[server] Failed to reload model runtime after deleting auth:", reloadErr);
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(getSubscriptionResponse()));
      return true;
    }

    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return true;
  }

  if (url.pathname === "/api/fetch-custom-models") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return true;
    }

    const body = await readBody(req);
    try {
      const { baseUrl, apiKey, api } = JSON.parse(body) as {
        baseUrl?: string;
        apiKey?: string;
        api?: string;
      };

      if (!baseUrl || typeof baseUrl !== "string" || !baseUrl.trim()) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Base URL is required" }));
        return true;
      }

      const result = await probeCustomModels(baseUrl.trim(), apiKey, api);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
      return true;
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      return true;
    }
  }

  if (url.pathname === "/api/custom-models") {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(readCustomModels()));
      return true;
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      let providers: UICustomProvider[];
      try {
        providers = (JSON.parse(body) as { providers: UICustomProvider[] }).providers;
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `invalid JSON: ${String(err)}` }));
        return true;
      }
      const invalid = validateProviders(providers);
      if (invalid) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: invalid }));
        return true;
      }
      writeCustomModels(providers);
      const warning = await ctx.reloadModelProviders(providers);
      const result: UICustomModelsResponse = { ...readCustomModels(), warning };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
      return true;
    }
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return true;
  }

  return false;
}
