import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { Type } from "typebox";

export const WEB_SEARCH_TOOL = "web_search";
export const URL_CONTEXT_TOOL = "url_context";

const WEB_SEARCH_TOOL_DESCRIPTION =
  "Search the web using the current supported provider (Google Gemini, xAI Grok, OpenAI, or Anthropic). Optionally include URLs to analyze alongside search results.";

/**
 * Static mirror of `pi-web-search`'s `WebSearchSchema`. Declared locally so the tool
 * can be registered without triggering jiti transpilation of the package.
 */
const WEB_SEARCH_PARAMETERS = Type.Object({
  query: Type.String({ description: "The search query or question to answer" }),
  urls: Type.Optional(
    Type.Array(Type.String(), {
      description: "Additional URLs to analyze along with search (up to 20)",
      maxItems: 20,
    }),
  ),
});

export interface WebSearchToolDefinition {
  name: string;
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: any,
    ctx: any,
  ) => Promise<any>;
}

export function wrapProviderNativeWebSearchExtension(
  inner: (pi: ExtensionAPI) => void,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const wrapped = new Proxy(pi, {
      get(target, prop, receiver) {
        if (prop === "setActiveTools") {
          return () => {};
        }
        if (prop === "registerTool") {
          return (tool: { name?: string }, ...rest: unknown[]) => {
            if (tool?.name === URL_CONTEXT_TOOL) return;
            return (target.registerTool as (...args: unknown[]) => unknown)(tool, ...rest);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    inner(wrapped);
  };
}

let cachedTool: WebSearchToolDefinition | undefined;

/**
 * jiti-transpile `pi-web-search` and capture its `web_search` tool definition.
 * Only invoked when the tool is actually executed, never during extension setup.
 */
export function loadPiWebSearchTool(): WebSearchToolDefinition {
  if (cachedTool) return cachedTool;

  const jiti = createJiti(import.meta.url);
  const mod = jiti("pi-web-search") as
    | { default?: (pi: ExtensionAPI) => void }
    | ((pi: ExtensionAPI) => void);
  const inner = typeof mod === "function" ? mod : mod.default;
  if (typeof inner !== "function") {
    throw new Error("pi-web-search did not export an extension factory");
  }

  const captured: { tool?: WebSearchToolDefinition } = {};
  const capture = {
    registerTool: (tool: { name?: string }) => {
      if (tool?.name === WEB_SEARCH_TOOL) {
        captured.tool = tool as unknown as WebSearchToolDefinition;
      }
    },
    on: () => {},
    getActiveTools: () => [] as string[],
    setActiveTools: () => {},
  } as unknown as ExtensionAPI;

  wrapProviderNativeWebSearchExtension(inner)(capture);
  if (!captured.tool) {
    throw new Error("pi-web-search did not register web_search");
  }
  cachedTool = captured.tool;
  return cachedTool;
}

/**
 * Registers `web_search` eagerly (so the model sees the same tool), but defers the
 * jiti transpilation of `pi-web-search` until the tool's `execute` is invoked.
 */
export function createWebSearchExtension(options?: {
  loadTool?: () => WebSearchToolDefinition;
}): InlineExtension {
  const loadTool = options?.loadTool ?? loadPiWebSearchTool;
  return {
    name: "pi-web-search",
    factory: (pi: ExtensionAPI) => {
      pi.registerTool({
        name: WEB_SEARCH_TOOL,
        label: "Web Search",
        description: WEB_SEARCH_TOOL_DESCRIPTION,
        parameters: WEB_SEARCH_PARAMETERS,
        async execute(
          toolCallId: string,
          params: any,
          signal: AbortSignal | undefined,
          onUpdate: any,
          ctx: any,
        ) {
          const tool = loadTool();
          return tool.execute(toolCallId, params, signal, onUpdate, ctx);
        },
      } as any);
    },
  };
}
