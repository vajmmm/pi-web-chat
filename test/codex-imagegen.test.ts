import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CODEX_IMAGEGEN_TOOL_NAME,
  CODEX_PROVIDER,
  createCodexImagegenExtension,
  parseCodexImageSse,
} from "../server/codex-imagegen-extension.ts";
import { serializeMessages } from "../server/serialize.ts";

describe("Codex image generation", () => {
  it("parses a native Codex image_generation SSE result", async () => {
    const response = new Response(
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: {
          type: "image_generation_call",
          id: "img_test",
          result: "aGVsbG8=",
          revised_prompt: "a test image",
        },
      })}\r\n\r\n`,
      { headers: { "content-type": "text/event-stream" } },
    );

    const result = await parseCodexImageSse(response);
    assert.deepEqual(result, {
      id: "img_test",
      base64: "aGVsbG8=",
      revisedPrompt: "a test image",
    });
  });

  it("only activates and permits the tool for openai-codex", () => {
    const active = ["read"];
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const registered: string[] = [];
    const pi = {
      registerTool(tool: { name: string }) {
        registered.push(tool.name);
      },
      getActiveTools() {
        return [...active];
      },
      setActiveTools(next: string[]) {
        active.splice(0, active.length, ...next);
      },
      on(event: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;

    createCodexImagegenExtension().factory(pi);
    assert.deepEqual(registered, [CODEX_IMAGEGEN_TOOL_NAME]);

    handlers.get("model_select")?.({ model: { provider: "xai" } }, {});
    assert.deepEqual(active, ["read"]);

    handlers.get("model_select")?.({ model: { provider: CODEX_PROVIDER } }, {});
    assert.ok(active.includes(CODEX_IMAGEGEN_TOOL_NAME));

    const blocked = handlers.get("tool_call")?.(
      { toolName: CODEX_IMAGEGEN_TOOL_NAME },
      { model: { provider: "xai" } },
    ) as { block?: boolean } | undefined;
    assert.equal(blocked?.block, true);

    const allowed = handlers.get("tool_call")?.(
      { toolName: CODEX_IMAGEGEN_TOOL_NAME },
      { model: { provider: CODEX_PROVIDER } },
    );
    assert.equal(allowed, undefined);
  });

  it("serializes generated tool images for the web UI", () => {
    const messages = serializeMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: CODEX_IMAGEGEN_TOOL_NAME,
            arguments: { prompt: "test" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: CODEX_IMAGEGEN_TOOL_NAME,
        isError: false,
        content: [
          { type: "text", text: "done" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      },
    ]);

    assert.equal(messages.length, 2);
    assert.equal(messages[1]?.role, "assistant");
    assert.deepEqual(messages[1]?.content, [
      { type: "image", dataUrl: "data:image/png;base64,aGVsbG8=" },
    ]);
  });
});
