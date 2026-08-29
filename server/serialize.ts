import type { UIContentBlock, UIMessage } from "../shared/protocol.ts";

type AnyMessage = {
  role: string;
  content?: unknown;
  errorMessage?: string;
  toolCallId?: string;
  isError?: boolean;
  [key: string]: unknown;
};

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

export function serializeMessages(messages: unknown[]): UIMessage[] {
  const msgs = messages as AnyMessage[];

  const results = new Map<string, { text: string; isError: boolean }>();
  for (const m of msgs) {
    if (m.role === "toolResult" && typeof m.toolCallId === "string") {
      results.set(m.toolCallId, {
        text: textFromContent(m.content),
        isError: m.isError === true,
      });
    }
  }

  const out: UIMessage[] = [];
  for (const m of msgs) {
    if (m.role === "toolResult") continue;

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
      if (Array.isArray(m.content)) {
        for (const b of m.content as Record<string, unknown>[]) {
          if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
            blocks.push({ type: "text", text: b.text });
          } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.length > 0) {
            blocks.push({ type: "thinking", text: b.thinking });
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
      if (blocks.length > 0 || m.errorMessage) {
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
          errorMessage: typeof m.errorMessage === "string" ? m.errorMessage : undefined,
          usage,
        });
      }
      continue;
    }

    const text = textFromContent(m.content);
    if (text) out.push({ role: "custom", content: [{ type: "text", text }] });
  }

  return out;
}
