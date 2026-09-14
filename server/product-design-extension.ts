import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  canUseProductDesign,
  getMainSessionCapabilities,
  PRODUCT_DESIGN_IMAGEGEN_TOOL_NAME,
  PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME,
  resolveMainModelCapabilityBinding,
} from "./session/capabilities.ts";
import { resolveArtifactRef } from "./runtime-artifacts.ts";
import type { ProductDesignImageGenerationUpdate } from "./product-design-image-backend.ts";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const DEFAULT_VIEWPORT = { width: 1440, height: 1000 };

const SCREENSHOT_PARAMETERS = Type.Object({
  url: Type.String({ description: "只允许 localhost、127.0.0.1 或 ::1 的本地页面地址。" }),
  width: Type.Optional(Type.Integer({ minimum: 320, maximum: 3840 })),
  height: Type.Optional(Type.Integer({ minimum: 240, maximum: 2400 })),
  fullPage: Type.Optional(Type.Boolean()),
});

const IMAGE_REFERENCE_PARAMETERS = Type.Union([
  Type.Object({
    path: Type.String({ minLength: 1, description: "本地图片文件路径。" }),
    mimeType: Type.Optional(Type.String({ minLength: 1 })),
  }),
  Type.Object({
    artifactRef: Type.String({ minLength: 1, description: "可解析为图片文件的 artifact 引用。" }),
    mimeType: Type.Optional(Type.String({ minLength: 1 })),
  }),
]);

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

export function assertLocalRuntimeUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("截图目标 URL 无效；只允许本地 HTTP(S) 页面。");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("截图目标协议不允许；只允许本地 HTTP(S) 页面。");
  }
  if (parsed.username || parsed.password) {
    throw new Error("截图目标不允许携带用户名或密码。");
  }
  if (!LOCAL_HOSTS.has(normalizeHostname(parsed.hostname))) {
    throw new Error("截图目标被拒绝；Product Design 截图只允许 localhost、127.0.0.1 或 ::1。");
  }
  return parsed;
}

function capabilityBlockedMessage(): string {
  return "Product Design 当前被 Main Session capability gate 禁用。";
}

function makeScreenshotPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(getAgentDir(), "product-design-screenshots", `${stamp}.png`);
}

export async function captureLocalScreenshot(
  rawUrl: string,
  options: { width?: number; height?: number; fullPage?: boolean },
) {
  const url = assertLocalRuntimeUrl(rawUrl);
  const viewport = {
    width: options.width ?? DEFAULT_VIEWPORT.width,
    height: options.height ?? DEFAULT_VIEWPORT.height,
  };
  const screenshotPath = makeScreenshotPath();
  await mkdir(join(getAgentDir(), "product-design-screenshots"), { recursive: true });

  // Loaded lazily: `playwright` (and its browser binaries) must not be pulled in on
  // server startup / extension registration — only when a screenshot is actually taken.
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    let blockedRequest: string | undefined;

    await page.route("**/*", async (route) => {
      try {
        assertLocalRuntimeUrl(route.request().url());
        await route.continue();
      } catch (err) {
        blockedRequest = route.request().url();
        await route.abort();
        void err;
      }
    });

    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (blockedRequest) {
      throw new Error(`页面尝试访问非本地资源，截图已拒绝：${blockedRequest}`);
    }
    await page.waitForTimeout(250);
    await page.screenshot({ path: screenshotPath, fullPage: options.fullPage ?? false });
    const image = await readFile(screenshotPath);
    await context.close();

    return {
      screenshotPath,
      url: url.toString(),
      viewport,
      fullPage: options.fullPage ?? false,
      base64: image.toString("base64"),
    };
  } finally {
    await browser.close();
  }
}

export function createProductDesignExtension(): InlineExtension {
  return {
    name: "pi-product-design-runtime",
    factory: (pi: ExtensionAPI) => {
      pi.registerTool({
        name: PRODUCT_DESIGN_IMAGEGEN_TOOL_NAME,
        label: "Product Design 生图",
        description:
          "通过当前 Main Session 声明的 image-generation capability 生成 Product Design 视觉方案。",
        promptSnippet: "生成 Product Design 视觉方案图片",
        promptGuidelines: [
          "仅在 Product Design capability gate 通过时使用。",
          "生成视觉方向时一次只生成一个方案；ideate 阶段总共生成三个可区分方向。",
          "保留返回的图片和 savedPath 作为 source visual truth evidence。",
        ],
        parameters: Type.Object({
          prompt: Type.String({ description: "视觉方向或界面设计的详细描述。" }),
          size: Type.Optional(Type.Union([
            Type.Literal("auto"),
            Type.Literal("1024x1024"),
            Type.Literal("1536x1024"),
            Type.Literal("1024x1536"),
          ])),
          quality: Type.Optional(Type.Union([
            Type.Literal("auto"),
            Type.Literal("low"),
            Type.Literal("medium"),
            Type.Literal("high"),
          ])),
          background: Type.Optional(Type.Union([
            Type.Literal("auto"),
            Type.Literal("opaque"),
            Type.Literal("transparent"),
          ])),
          outputFormat: Type.Optional(Type.Union([
            Type.Literal("png"),
            Type.Literal("webp"),
            Type.Literal("jpeg"),
          ])),
          thinking: Type.Optional(Type.Union([
            Type.Literal("off"),
            Type.Literal("minimal"),
            Type.Literal("low"),
            Type.Literal("medium"),
            Type.Literal("high"),
          ])),
          referenceImages: Type.Optional(Type.Array(IMAGE_REFERENCE_PARAMETERS, { maxItems: 4 })),
        }),
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          const capabilities = getMainSessionCapabilities(ctx.model);
          if (!canUseProductDesign(capabilities)) {
            return {
              isError: true,
              details: { blocked: true, reason: "capability" },
              content: [{ type: "text", text: capabilityBlockedMessage() }],
            };
          }
          const binding = resolveMainModelCapabilityBinding(ctx.model);
          if (!binding?.imageGeneration) {
            return {
              isError: true,
              details: { blocked: true, reason: "backend_not_registered" },
              content: [{ type: "text", text: "Product Design image-generation backend 未注册，已 fail-closed。" }],
            };
          }

          const result = await binding.imageGeneration.generate(
            params,
            signal,
            onUpdate as ProductDesignImageGenerationUpdate | undefined,
            {
              cwd: ctx.cwd,
              model: ctx.model
                ? { provider: ctx.model.provider, id: ctx.model.id }
                : undefined,
              getApiKeyForProvider: (provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
              resolveArtifactPath: resolveArtifactRef,
            },
          );
          return {
            content: [
              { type: "text", text: result.text },
              { type: "image", data: result.image.base64, mimeType: result.mimeType },
            ],
            details: {
              ...result.details,
              savedPath: result.savedPath,
              mimeType: result.mimeType,
              productDesign: true,
              imageGenerationBackend: binding.imageGeneration.id,
            },
          };
        },
      });

      pi.registerTool({
        name: PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME,
        label: "Product Design 本地截图",
        description:
          "捕获 localhost、127.0.0.1 或 ::1 上的本地实现，用于 Product Design source visual truth 对比和 design QA。",
        promptSnippet: "捕获本地页面截图用于 design QA",
        promptGuidelines: [
          "只允许本地开发页面；禁止访问外部 URL、局域网地址和 metadata endpoint。",
          "截图必须作为 browser screenshot evidence 保存并用于后续 visual QA。",
        ],
        parameters: SCREENSHOT_PARAMETERS,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const capabilities = getMainSessionCapabilities(ctx.model);
          if (!canUseProductDesign(capabilities)) {
            return {
              isError: true,
              details: { blocked: true, reason: "capability" },
              content: [{ type: "text", text: capabilityBlockedMessage() }],
            };
          }

          try {
            const captured = await captureLocalScreenshot(params.url, params);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    screenshotPath: captured.screenshotPath,
                    url: captured.url,
                    viewport: captured.viewport,
                    fullPage: captured.fullPage,
                  }, null, 2),
                },
                { type: "image", data: captured.base64, mimeType: "image/png" },
              ],
              details: {
                screenshotPath: captured.screenshotPath,
                sourceUrl: captured.url,
                viewport: captured.viewport,
                fullPage: captured.fullPage,
                productDesign: true,
              },
            };
          } catch (err) {
            return {
              isError: true,
              details: { blocked: true, reason: "screenshot_failed" },
              content: [{ type: "text", text: `本地截图失败（fail-closed）：${String(err instanceof Error ? err.message : err)}` }],
            };
          }
        },
      });

      pi.on("tool_call", (event, ctx) => {
        if (event.toolName !== PRODUCT_DESIGN_IMAGEGEN_TOOL_NAME && event.toolName !== PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME) {
          return;
        }
        if (canUseProductDesign(getMainSessionCapabilities(ctx.model))) return;
        return {
          block: true,
          terminate: true,
          reason: capabilityBlockedMessage(),
        };
      });
    },
  };
}
