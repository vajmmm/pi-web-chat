import type { UIContentBlock, UIMessage } from "../shared/protocol.ts";
import {
  looksLikeHtmlErrorPage,
  sanitizeProviderErrorMessage,
} from "../shared/provider-error.ts";

export { sanitizeProviderErrorMessage } from "../shared/provider-error.ts";

type AnyMessage = {
  role: string;
  content?: unknown;
  errorMessage?: string;
  toolCallId?: string;
  isError?: boolean;
  [key: string]: unknown;
};

type SerializedToolResult = {
  text: string;
  isError: boolean;
};

function imageBlocksFromContent(content: unknown): UIContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "image")
    .map((b) => {
      const block = b as { data?: unknown; mimeType?: unknown };
      return {
        type: "image" as const,
        dataUrl:
          typeof block.data === "string" && typeof block.mimeType === "string"
            ? `data:${block.mimeType};base64,${block.data}`
            : undefined,
      };
    });
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
  }
  return "";
}

/**
 * Snapshot hot-path cap for tool result text. Matches the defensive slice in
 * `ToolCallCard` (slice(0, 4000)); other serializeMessages callers stay full.
 */
export const TOOL_RESULT_SNAPSHOT_MAX_CHARS = 4000;

export function serializeMessages(
  messages: unknown[],
  options?: { maxToolResultChars?: number },
): UIMessage[] {
  const msgs = messages as AnyMessage[];
  const maxToolResultChars = options?.maxToolResultChars;

  const results = new Map<string, SerializedToolResult>();
  for (const m of msgs) {
    if (m.role === "toolResult" && typeof m.toolCallId === "string") {
      const text = textFromContent(m.content);
      results.set(m.toolCallId, {
        text:
          typeof maxToolResultChars === "number" && text.length > maxToolResultChars
            ? `${text.slice(0, maxToolResultChars)}\n…(truncated)`
            : text,
        isError: m.isError === true,
      });
    }
  }

  const out: UIMessage[] = [];
  for (const m of msgs) {
    if (m.role === "toolResult") {
      const images = imageBlocksFromContent(m.content);
      if (images.length > 0) out.push({ role: "assistant", content: images });
      continue;
    }

    if (m.role === "user") {
      const blocks: UIContentBlock[] = [];
      if (typeof m.content === "string") {
        blocks.push({ type: "text", text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const b of m.content as { type: string; text?: string; data?: string; mimeType?: string }[]) {
          if (b.type === "text" && b.text) blocks.push({ type: "text", text: b.text });
          else if (b.type === "image") {
            blocks.push({
              type: "image",
              dataUrl:
                b.data && b.mimeType ? `data:${b.mimeType};base64,${b.data}` : undefined,
            });
          }
        }
      }
      if (blocks.length > 0) out.push({ role: "user", content: blocks });
      continue;
    }

    if (m.role === "assistant") {
      const blocks: UIContentBlock[] = [];
      let contentHtmlError: string | undefined;
      if (Array.isArray(m.content)) {
        for (const b of m.content as Record<string, unknown>[]) {
          if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
            if (looksLikeHtmlErrorPage(b.text)) {
              contentHtmlError = sanitizeProviderErrorMessage(b.text);
              continue;
            }
            blocks.push({ type: "text", text: b.text });
          } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.length > 0) {
            blocks.push({ type: "thinking", text: b.thinking });
          } else if (b.type === "image") {
            const data = typeof b.data === "string" ? b.data : undefined;
            const mimeType = typeof b.mimeType === "string" ? b.mimeType : undefined;
            blocks.push({
              type: "image",
              dataUrl: data && mimeType ? `data:${mimeType};base64,${data}` : undefined,
            });
          } else if (b.type === "toolCall") {
            const id = String(b.id ?? "");
            blocks.push({
              type: "toolCall",
              id,
              name: String(b.name ?? "unknown"),
              args: b.arguments,
              result: results.get(id),
            });
          }
        }
      }
      const rawError =
        typeof m.errorMessage === "string" && m.errorMessage.trim().length > 0
          ? sanitizeProviderErrorMessage(m.errorMessage)
          : contentHtmlError;
      if (blocks.length > 0 || rawError) {
        const u = m.usage as {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          totalTokens?: number;
        } | undefined;
        const usage = u
          ? {
              input: typeof u.input === "number" ? u.input : undefined,
              output: typeof u.output === "number" ? u.output : undefined,
              cacheRead: typeof u.cacheRead === "number" ? u.cacheRead : undefined,
              cacheWrite: typeof u.cacheWrite === "number" ? u.cacheWrite : undefined,
              totalTokens: typeof u.totalTokens === "number" ? u.totalTokens : undefined,
            }
          : undefined;

        out.push({
          role: "assistant",
          content: blocks,
          errorMessage: rawError,
          usage,
        });
      }
      continue;
    }

    if (m.display === false || (m as any).customType === "workspace-context") continue;

    const text = textFromContent(m.content);
    if (text) out.push({ role: "custom", content: [{ type: "text", text }] });
  }

  return out;
}
