import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createWebSearchExtension,
  loadPiWebSearchTool,
  URL_CONTEXT_TOOL,
  WEB_SEARCH_TOOL,
  wrapProviderNativeWebSearchExtension,
} from "../server/web-search-extension.ts";

describe("wrapProviderNativeWebSearchExtension", () => {
  it("registers web_search and ignores url_context", () => {
    const registered: string[] = [];
    const pi = {
      registerTool(tool: { name: string }) {
        registered.push(tool.name);
      },
      setActiveTools() {
        throw new Error("host setActiveTools should not run from this test");
      },
    } as unknown as ExtensionAPI;

    const factory = wrapProviderNativeWebSearchExtension((inner) => {
      inner.registerTool({ name: WEB_SEARCH_TOOL } as any);
      inner.registerTool({ name: URL_CONTEXT_TOOL } as any);
    });
    factory(pi);

    assert.deepEqual(registered, [WEB_SEARCH_TOOL]);
  });

  it("swallows the inner extension's setActiveTools so the role allowlist stays in control", () => {
    const activeCalls: string[][] = [];
    const pi = {
      registerTool() {},
      setActiveTools(tools: string[]) {
        activeCalls.push([...tools]);
      },
    } as unknown as ExtensionAPI;

    const factory = wrapProviderNativeWebSearchExtension((inner) => {
      inner.setActiveTools(["read", "bash", WEB_SEARCH_TOOL, URL_CONTEXT_TOOL]);
    });
    factory(pi);

    assert.deepEqual(activeCalls, []);
  });
});

describe("createWebSearchExtension", () => {
  it("registers web_search without eagerly loading pi-web-search", () => {
    let loads = 0;
    const registered: { name: string }[] = [];
    const pi = {
      registerTool(tool: { name: string }) {
        registered.push(tool);
      },
      setActiveTools() {
        throw new Error("pi-web-search must not rewrite active tools");
      },
    } as unknown as ExtensionAPI;

    createWebSearchExtension({
      loadTool: () => {
        loads += 1;
        return { name: WEB_SEARCH_TOOL, execute: async () => ({ content: [] }) };
      },
    }).factory(pi);

    assert.equal(loads, 0, "extension factory must not trigger jiti transpilation");
    assert.deepEqual(registered.map((t) => t.name), [WEB_SEARCH_TOOL]);
  });

  it("loads pi-web-search lazily on the first web_search execute and delegates", async () => {
    let loads = 0;
    const calls: unknown[][] = [];
    const registered: any[] = [];
    const pi = {
      registerTool(tool: any) {
        registered.push(tool);
      },
      setActiveTools() {},
    } as unknown as ExtensionAPI;

    createWebSearchExtension({
      loadTool: () => {
        loads += 1;
        return {
          name: WEB_SEARCH_TOOL,
          execute: async (...args: unknown[]) => {
            calls.push(args);
            return { content: [{ type: "text", text: "delegated" }] };
          },
        };
      },
    }).factory(pi);

    assert.equal(loads, 0);
    const result = await registered[0].execute("call-1", { query: "pi web chat" }, undefined, undefined, {});
    assert.equal(loads, 1, "the loader must run exactly once, on execute");
    assert.deepEqual(calls[0][1], { query: "pi web chat" });
    assert.equal(result.content[0].text, "delegated");
  });

  it("the real loader exposes the pi-web-search web_search tool and caches it", () => {
    const tool = loadPiWebSearchTool();
    assert.equal(tool.name, WEB_SEARCH_TOOL);
    assert.equal(typeof tool.execute, "function");
    assert.equal(loadPiWebSearchTool(), tool, "the loaded tool must be cached");
  });
});
