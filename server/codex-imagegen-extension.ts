import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, withFileMutationQueue, type ExtensionAPI, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

export const CODEX_IMAGEGEN_TOOL_NAME = "codex_imagegen";
export const CODEX_PROVIDER = "openai-codex";
export const CODEX_IMAGEGEN_BACKEND_ID = "codex-imagegen";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const IMAGE_MODEL = "gpt-image-2";
const DEFAULT_RESPONSE_MODEL = "gpt-5.5";

const IMAGEGEN_PARAMETERS = Type.Object({
  prompt: Type.String({ description: "要生成的图片描述。" }),
  size: Type.Optional(
    Type.Union([
      Type.Literal("auto"),
      Type.Literal("1024x1024"),
      Type.Literal("1536x1024"),
      Type.Literal("1024x1536"),
    ]),
  ),
  quality: Type.Optional(
    Type.Union([
      Type.Literal("auto"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
    ]),
  ),
  background: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("opaque"), Type.Literal("transparent")]),
  ),
  outputFormat: Type.Optional(
    Type.Union([Type.Literal("png"), Type.Literal("webp"), Type.Literal("jpeg")]),
  ),
  thinking: Type.Optional(
    Type.Union([
      Type.Literal("off"),
      Type.Literal("minimal"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
    ]),
  ),
});

export type CodexImagegenParams = Static<typeof IMAGEGEN_PARAMETERS>;

interface CodexImageDetails {
  provider: typeof CODEX_PROVIDER;
  imageModel: typeof IMAGE_MODEL;
  responseModel: string;
  imageId: string;
  savedPath: string;
  mimeType: string;
  size: string;
  quality: string;
  background: string;
  outputFormat: string;
  thinking: string;
}

interface CodexAccountClaims {
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
}

interface CodexImageResult {
  id: string;
  base64: string;
  revisedPrompt?: string;
}

type ToolUpdate = (result: { content: Array<{ type: "text"; text: string }>; details?: unknown }) => void;

function decodeJwtPayload(token: string): CodexAccountClaims {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("Codex OAuth 凭证格式无效，无法读取账户信息。");
  }
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as CodexAccountClaims;
  } catch {
    throw new Error("Codex OAuth 凭证格式无效，无法读取账户信息。");
  }
}

function getAccountId(token: string): string {
  const accountId = decodeJwtPayload(token)["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (!accountId) {
    throw new Error("Codex OAuth 凭证中缺少 ChatGPT 账户标识。");
  }
  return accountId;
}

function mimeFromFormat(format: string): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function extensionFromFormat(format: string): string {
  return format === "jpeg" ? "jpg" : format;
}

function safeImageId(imageId: string): string {
  const safe = imageId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  return safe || "generated-image";
}

function defaultOutputPath(imageId: string, format: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(
    getAgentDir(),
    "generated-images",
    `${stamp}-${safeImageId(imageId)}.${extensionFromFormat(format)}`,
  );
}

async function saveImage(path: string, base64: string): Promise<void> {
  await withFileMutationQueue(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(base64, "base64"));
  });
}

function buildRequest(params: CodexImagegenParams, responseModel: string, sessionId: string): Record<string, unknown> {
  const size = params.size ?? "auto";
  const quality = params.quality ?? "auto";
  const background = params.background ?? "auto";
  const outputFormat = params.outputFormat ?? "png";
  const thinking = params.thinking ?? "low";

  const request: Record<string, any> = {
    model: responseModel,
    store: false,
    stream: true,
    instructions:
      "You are an image generation dispatcher. Use the image_generation tool to create exactly the image requested by the user. Do not write code.",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: `Generate this image: ${params.prompt}` }],
      },
    ],
    text: { verbosity: "low" },
    prompt_cache_key: sessionId,
    tool_choice: { type: "image_generation" },
    parallel_tool_calls: true,
    tools: [
      {
        type: "image_generation",
        background,
        model: IMAGE_MODEL,
        moderation: "auto",
        output_compression: 100,
        output_format: outputFormat,
        quality,
        size,
      },
    ],
  };

  if (thinking !== "off") {
    request.include = ["reasoning.encrypted_content"];
    request.reasoning = { effort: thinking, summary: "auto" };
  }

  return request;
}

export async function parseCodexImageSse(
  response: Response,
  signal?: AbortSignal,
): Promise<CodexImageResult> {
  if (!response.body) throw new Error("Codex 生图接口没有返回流式响应体。");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) throw new Error("Codex 生图请求已取消。");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator: RegExpMatchArray | null;
      while ((separator = buffer.match(/\r?\n\r?\n/)) !== null && separator.index !== undefined) {
        const separatorIndex = separator.index;
        const chunk = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + separator[0].length);
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
          .trim();
        if (!data || data === "[DONE]") continue;

        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        if (event.type === "error") {
          throw new Error(event.message || event.code || "Codex 生图请求失败。");
        }
        if (event.type === "response.failed") {
          throw new Error(event.response?.error?.message || "Codex 生图请求失败。");
        }

        const item = event.item;
        if (event.type === "response.output_item.done" && item?.type === "image_generation_call") {
          if (typeof item.result !== "string" || item.result.length === 0) {
            throw new Error("Codex 生图完成，但没有返回图片数据。");
          }
          return {
            id: typeof item.id === "string" ? item.id : `image-${Date.now()}`,
            base64: item.result,
            revisedPrompt:
              typeof item.revised_prompt === "string"
                ? item.revised_prompt
                : typeof item.revisedPrompt === "string"
                  ? item.revisedPrompt
                  : undefined,
          };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  throw new Error("Codex 响应中没有找到 image_generation 结果。");
}

export interface CodexImageGenerationContext {
  cwd: string;
  model?: { provider: string; id: string };
  modelRegistry: {
    getApiKeyForProvider: (provider: string) => Promise<string | undefined>;
  };
}

export async function generateCodexImage(
  params: CodexImagegenParams,
  signal: AbortSignal | undefined,
  onUpdate: ToolUpdate | undefined,
  ctx: CodexImageGenerationContext,
) {
  if (ctx.model?.provider !== CODEX_PROVIDER) {
    throw new Error("codex_imagegen 仅允许 openai-codex 模型调用。");
  }

  const token = await ctx.modelRegistry.getApiKeyForProvider(CODEX_PROVIDER);
  if (!token) {
    throw new Error("未找到 Codex OAuth 凭证，请先登录 Codex 订阅账号。");
  }

  const accountId = getAccountId(token);
  const responseModel = ctx.model?.id || DEFAULT_RESPONSE_MODEL;
  const sessionId = randomUUID();
  const outputFormat = params.outputFormat ?? "png";
  const mimeType = mimeFromFormat(outputFormat);

  onUpdate?.({
    content: [{ type: "text", text: `正在通过 Codex/${IMAGE_MODEL} 生成图片…` }],
    details: { provider: CODEX_PROVIDER, imageModel: IMAGE_MODEL, responseModel },
  });

  const response = await fetch(`${CODEX_BASE_URL}/codex/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "chatgpt-account-id": accountId,
      originator: "pi-web-chat",
      "OpenAI-Beta": "responses=experimental",
      accept: "text/event-stream",
      "content-type": "application/json",
      session_id: sessionId,
      "x-client-request-id": sessionId,
      "User-Agent": `pi-web-chat (${process.platform}; ${process.arch})`,
    },
    body: JSON.stringify(buildRequest(params, responseModel, sessionId)),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Codex 生图请求失败（HTTP ${response.status}）：${errorText.slice(0, 1000)}`);
  }

  const image = await parseCodexImageSse(response, signal);
  const savedPath = defaultOutputPath(image.id, outputFormat);
  await saveImage(savedPath, image.base64);

  const details: CodexImageDetails = {
    provider: CODEX_PROVIDER,
    imageModel: IMAGE_MODEL,
    responseModel,
    imageId: image.id,
    savedPath,
    mimeType,
    size: params.size ?? "auto",
    quality: params.quality ?? "auto",
    background: params.background ?? "auto",
    outputFormat,
    thinking: params.thinking ?? "low",
  };

  return {
    image,
    details,
    text: [
      `已通过 Codex/${IMAGE_MODEL} 生成图片。`,
      `已保存到：${savedPath}`,
      image.revisedPrompt ? `修订后的提示词：${image.revisedPrompt}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function syncToolAvailability(pi: ExtensionAPI, model: { provider?: string } | undefined): void {
  const active = pi.getActiveTools();
  const shouldEnable = model?.provider === CODEX_PROVIDER;
  const next = shouldEnable
    ? [...new Set([...active, CODEX_IMAGEGEN_TOOL_NAME])]
    : active.filter((name) => name !== CODEX_IMAGEGEN_TOOL_NAME);

  if (next.length !== active.length || next.some((name, index) => name !== active[index])) {
    pi.setActiveTools(next);
  }
}

export function createCodexImagegenExtension(): InlineExtension {
  return {
    name: "pi-codex-imagegen",
    factory: (pi: ExtensionAPI) => {
      pi.registerTool({
        name: CODEX_IMAGEGEN_TOOL_NAME,
        label: "Codex 生图",
        description:
          "仅使用当前 openai-codex 订阅，通过 Codex 原生 image_generation 工具生成图片并返回图片附件。其他 provider 不可调用。",
        promptSnippet: "使用 Codex 订阅生成图片",
        promptGuidelines: [
          "仅当当前模型 provider 为 openai-codex 时使用 codex_imagegen。",
          "用户要求实际生成或绘制图片时使用 codex_imagegen，不要伪造图片链接。",
        ],
        parameters: IMAGEGEN_PARAMETERS,
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          const result = await generateCodexImage(
            params,
            signal,
            onUpdate as ToolUpdate | undefined,
            ctx,
          );
          return {
            content: [
              { type: "text", text: result.text },
              { type: "image", data: result.image.base64, mimeType: result.details.mimeType },
            ],
            details: result.details,
          };
        },
      });

      pi.on("session_start", (_event, ctx) => {
        syncToolAvailability(pi, ctx.model);
      });

      pi.on("model_select", (event) => {
        syncToolAvailability(pi, event.model);
      });

      pi.on("tool_call", (event, ctx) => {
        if (event.toolName !== CODEX_IMAGEGEN_TOOL_NAME) return;
        if (ctx.model?.provider === CODEX_PROVIDER) return;
        return {
          block: true,
          terminate: true,
          reason: "codex_imagegen 仅允许 openai-codex 模型调用。",
        };
      });
    },
  };
}
