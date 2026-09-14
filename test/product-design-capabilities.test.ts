import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  canUseProductDesign,
  getMainSessionCapabilities,
  registerMainModelCapabilityBinding,
  unregisterMainModelCapabilityBinding,
} from "../server/session/capabilities.ts";
import {
  assertLocalRuntimeUrl,
  createProductDesignExtension,
} from "../server/product-design-extension.ts";
import { PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME } from "../server/session/capabilities.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function parsePng(buffer: Buffer): { width: number; height: number } {
  assert.ok(buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE));
  let offset = PNG_SIGNATURE.length;
  let dimensions: { width: number; height: number } | undefined;
  let sawIend = false;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const chunkEnd = offset + 12 + length;
    assert.ok(chunkEnd <= buffer.length, `PNG chunk ${type} exceeds file length`);
    if (type === "IHDR") {
      assert.equal(length, 13);
      dimensions = {
        width: buffer.readUInt32BE(offset + 8),
        height: buffer.readUInt32BE(offset + 12),
      };
    }
    if (type === "IEND") {
      sawIend = true;
      break;
    }
    offset = chunkEnd;
  }

  assert.ok(dimensions, "PNG must contain IHDR");
  assert.equal(sawIend, true, "PNG must contain IEND");
  assert.ok(dimensions.width > 0 && dimensions.height > 0);
  return dimensions;
}

describe("Product Design capability gate", () => {
  it("只从中央 registry 解析 Main Model capability", () => {
    assert.deepEqual(getMainSessionCapabilities({ provider: "openai-codex", id: "gpt-5.5" }), {
      productDesign: true,
      imageInput: true,
      imageGeneration: true,
      webSearch: true,
    });
    assert.deepEqual(getMainSessionCapabilities({ provider: "deepseek", id: "deepseek-chat" }), {
      productDesign: false,
      imageInput: false,
      imageGeneration: false,
      webSearch: false,
    });
  });

  it("Gate policy 与 capability fact 解耦", () => {
    assert.equal(
      canUseProductDesign({ productDesign: true, imageInput: true, imageGeneration: false, webSearch: false }),
      false,
    );
    assert.equal(
      canUseProductDesign({ productDesign: true, imageInput: false, imageGeneration: true, webSearch: false }),
      false,
    );
    assert.equal(
      canUseProductDesign({ productDesign: true, imageInput: true, imageGeneration: true, webSearch: false }),
      true,
    );
  });

  it("支持按 model binding 覆盖 capability，并可撤销测试 binding", () => {
    const bindingId = "test-product-design-disabled-model";
    registerMainModelCapabilityBinding({
      id: bindingId,
      selector: { provider: "openai-codex", modelIds: ["codex-no-image"] },
      capabilities: { productDesign: false, imageInput: true, imageGeneration: false, webSearch: false },
    });
    try {
      assert.equal(
        getMainSessionCapabilities({ provider: "openai-codex", id: "codex-no-image" }).productDesign,
        false,
      );
      assert.equal(
        getMainSessionCapabilities({ provider: "openai-codex", id: "codex-with-image" }).productDesign,
        true,
      );
    } finally {
      unregisterMainModelCapabilityBinding(bindingId);
    }
  });
});

describe("Product Design local screenshot URL gate", () => {
  it("允许三种 loopback host", () => {
    for (const rawUrl of [
      "http://localhost:3000",
      "https://localhost:3443/path",
      "http://127.0.0.1:5173",
      "http://[::1]:4173",
    ]) {
      assert.doesNotThrow(() => assertLocalRuntimeUrl(rawUrl));
    }
  });

  it("拒绝外部、局域网、metadata 和非 HTTP(S) 目标", () => {
    for (const rawUrl of [
      "https://example.com",
      "http://192.168.1.10:3000",
      "http://10.0.0.5:8080",
      "http://169.254.169.254/latest/meta-data/",
      "ftp://localhost/file",
      "http://user:pass@localhost:3000",
      "http://localhost.example.com:3000",
    ]) {
      assert.throws(() => assertLocalRuntimeUrl(rawUrl), /拒绝|不允许|无效/);
    }
  });

  it("真实 screenshot tool 可启动 Chromium 并生成可解析 PNG", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-product-design-screenshot-smoke-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><body><main>Product Design smoke test</main></body></html>");
    });

    const closeServer = async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    };

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const url = `http://127.0.0.1:${address.port}/`;

      let registeredTool: any;
      createProductDesignExtension().factory({
        registerTool(tool: any) {
          if (tool.name === PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME) registeredTool = tool;
        },
        on() {},
      } as any);
      assert.ok(registeredTool, "真实 screenshot tool 必须被注册");

      const result = await registeredTool.execute(
        "smoke-test",
        { url, width: 640, height: 480 },
        undefined,
        undefined,
        { model: { provider: "openai-codex", id: "gpt-5.5" } },
      );
      const errorText = result.content?.find((item: any) => item.type === "text")?.text;
      assert.notEqual(result.isError, true, errorText);
      assert.equal(result.details.productDesign, true);
      assert.equal(result.details.sourceUrl, url);

      const image = result.content?.find((item: any) => item.type === "image");
      assert.equal(image?.mimeType, "image/png");
      const screenshotPath = result.details.screenshotPath;
      const fileStats = statSync(screenshotPath);
      assert.equal(fileStats.isFile(), true);
      assert.ok(fileStats.size > PNG_SIGNATURE.length);
      const dimensions = parsePng(readFileSync(screenshotPath));
      assert.deepEqual(dimensions, { width: 640, height: 480 });
    } finally {
      await closeServer();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
