import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

export const WEB_SEARCH_TOOL = "web_search";
export const URL_CONTEXT_TOOL = "url_context";

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

let cachedFactory: ((pi: ExtensionAPI) => void) | undefined;

function loadPiWebSearchFactory(): (pi: ExtensionAPI) => void {
  if (cachedFactory) return cachedFactory;
  const jiti = createJiti(import.meta.url);
  const mod = jiti("pi-web-search") as
    | { default?: (pi: ExtensionAPI) => void }
    | ((pi: ExtensionAPI) => void);
  if (typeof mod === "function") {
    cachedFactory = mod;
    return cachedFactory;
  }
  if (typeof mod.default === "function") {
    cachedFactory = mod.default;
    return cachedFactory;
  }
  throw new Error("pi-web-search did not export an extension factory");
}

export function createWebSearchExtension(): InlineExtension {
  return {
    name: "pi-web-search",
    factory: wrapProviderNativeWebSearchExtension(loadPiWebSearchFactory()),
  };
}
