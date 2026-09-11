import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createWebSearchExtension,
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
  it("loads pi-web-search and registers only web_search", () => {
    const registered: string[] = [];
    const events: string[] = [];
    const pi = {
      registerTool(tool: { name: string }) {
        registered.push(tool.name);
      },
      setActiveTools() {
        throw new Error("pi-web-search must not rewrite active tools");
      },
      getActiveTools() {
        return [];
      },
      on(event: string) {
        events.push(event);
      },
    } as unknown as ExtensionAPI;

    createWebSearchExtension().factory(pi);

    assert.deepEqual(registered, [WEB_SEARCH_TOOL]);
    assert.ok(events.includes("session_start"));
    assert.ok(events.includes("model_select"));
  });
});
