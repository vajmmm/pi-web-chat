import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CODEX_IMAGEGEN_TOOL_NAME,
  CODEX_PROVIDER,
  createCodexImagegenExtension,
  generateCodexImage,
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

  it("将 Product Design reference image 作为 input_image 发送到 Codex backend", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-codex-reference-image-"));
    const referencePath = join(root, "reference.png");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const originalFetch = globalThis.fetch;
    const referenceBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    let requestBody: any;

    writeFileSync(referencePath, Buffer.from(referenceBase64, "base64"));
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        `data: ${JSON.stringify({
          type: "response.output_item.done",
          item: { type: "image_generation_call", id: "img_reference_test", result: "aGVsbG8=" },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;

    const token = `header.${Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
    })).toString("base64url")}.signature`;
    try {
      const result = await generateCodexImage(
        {
          prompt: "redesign this interface",
          thinking: "off",
          referenceImages: [{ path: referencePath }, { artifactRef: "artifacts://reference.png" }],
        },
        undefined,
        undefined,
        {
          cwd: root,
          model: { provider: CODEX_PROVIDER, id: "gpt-5.5" },
          getApiKeyForProvider: async () => token,
          resolveArtifactPath: (ref) => ref === "artifacts://reference.png" ? referencePath : null,
        },
      );

      const content = requestBody.input[0].content;
      assert.equal(content[0].type, "input_text");
      assert.deepEqual(content[1], {
        type: "input_image",
        image_url: `data:image/png;base64,${referenceBase64}`,
      });
      assert.deepEqual(content[2], content[1], "artifact reference 也必须进入 backend request");
      assert.equal(result.savedPath.endsWith("img_reference_test.png"), true);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
