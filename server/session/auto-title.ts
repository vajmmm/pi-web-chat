/**
 * Asynchronous, best-effort session auto-titling.
 *
 * After the first non-empty user message lands, we ask the active model for a
 * short title and persist it via `session.setSessionName`. Everything here is
 * fail-open: a provider error, an empty answer, or a missing model must never
 * abort the agent pipeline or clobber an existing name.
 */

export interface AutoTitleSession {
  readonly sessionName?: string | undefined;
  readonly messages: readonly unknown[];
  setSessionName(name: string): void;
}

export interface AutoTitleContext {
  systemPrompt: string;
  messages: Array<{ role: "user"; content: string; timestamp: number }>;
}

export type AutoTitleComplete = (
  model: unknown,
  context: AutoTitleContext,
  options?: { maxTokens?: number; signal?: AbortSignal },
) => Promise<{ content?: unknown }>;

export interface AutoTitleState {
  /** True once an attempt has completed successfully; blocks repeat model calls. */
  attempted: boolean;
  /** True while a model call is in flight; dedupes concurrent triggers. */
  inFlight: boolean;
}

export interface AutoTitleDeps {
  completeSimple: AutoTitleComplete;
  onError?: (err: unknown) => void;
  maxTitleChars?: number;
  maxSourceChars?: number;
}

export function createAutoTitleState(): AutoTitleState {
  return { attempted: false, inFlight: false };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: "text"; text: string } =>
          !!block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text)
      .join(" ");
  }
  return "";
}

/**
 * Return the first non-empty user message text, in chronological order.
 * Image-only or blank user turns are skipped.
 */
export function firstUserMessageText(
  messages: readonly unknown[],
  maxChars = 2000,
): string | undefined {
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if ((message as { role?: unknown }).role !== "user") continue;
    const text = normalizeWhitespace(textFromContent((message as { content?: unknown }).content));
    if (text.length > 0) return text.slice(0, maxChars);
  }
  return undefined;
}

/** Flatten an assistant response into plain text (text blocks joined by spaces). */
export function extractAssistantText(message: { content?: unknown } | undefined | null): string {
  if (!message) return "";
  return normalizeWhitespace(textFromContent(message.content));
}

export const DEFAULT_MAX_TITLE_CHARS = 36;

/**
 * Some providers answer with a JSON envelope such as `{"title": "..."}`.
 * Pull the title out when present so braces/quotes never leak into the UI.
 */
function titleFromJson(value: string): string | undefined {
  const candidate = value.trim();
  if (!candidate.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed && typeof parsed === "object") {
      const title = (parsed as { title?: unknown }).title;
      if (typeof title === "string") return title;
    }
  } catch {
    /* not JSON — fall through to line parsing */
  }
  return undefined;
}

/**
 * Normalize a raw model answer into a usable display title.
 * Handles JSON envelopes, quotes/markdown fences, a leading "title:" label,
 * trailing punctuation, whitespace, and Unicode-safe truncation.
 * Returns undefined when nothing usable remains.
 */
export function sanitizeTitle(
  raw: string,
  maxChars = DEFAULT_MAX_TITLE_CHARS,
): string | undefined {
  if (typeof raw !== "string") return undefined;
  let value = raw.trim();

  // Drop wrapping markdown code fences before picking a line.
  value = value.replace(/^```[a-zA-Z0-9]*[ \t]*\r?\n?/, "");
  value = value.replace(/\r?\n?```[ \t]*$/, "");
  value = value.trim();

  const jsonTitle = titleFromJson(value);
  if (jsonTitle !== undefined) {
    value = jsonTitle;
  } else {
    // Prefer the first non-empty line so multi-line answers stay concise.
    const line = value
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0);
    value = line ?? "";
  }

  value = value.replace(/^["'`“”‘’]+/, "").replace(/["'`“”‘’]+$/, "").trim();
  value = value.replace(/^(session\s*)?title\s*[:：]\s*/i, "");
  value = value.replace(/^标题\s*[:：]\s*/, "");
  value = normalizeWhitespace(value);
  // A title is a label, not a sentence: drop trailing punctuation the model adds.
  value = value.replace(/[.,!?;:，。！？；：、…·]+$/u, "").trim();

  if (value.length === 0) return undefined;
  // Truncate by code points so surrogate pairs (emoji) never split.
  const limited = Array.from(value).slice(0, maxChars).join("");
  return limited.trim() || undefined;
}

const TITLE_SYSTEM_PROMPT =
  "You name coding chat sessions. Write a short, descriptive title that starts " +
  "with an imperative verb (for example \"Fix\", \"Add\", \"Refactor\"). " +
  "Write the title in the same language as the user's message. " +
  "Do not answer the user's request and do not add commentary. " +
  "Reply with ONLY the title text: no quotes, no markdown, no trailing " +
  "punctuation, at most 8 words.";

/**
 * Attempt to derive a session title from the first non-empty user message.
 *
 * Returns the written title on success, or undefined when skipped/failed.
 * Never throws. Concurrent calls share `state` and only trigger one model call.
 */
export async function maybeAutoTitle(args: {
  session: AutoTitleSession;
  model: unknown | null | undefined;
  state: AutoTitleState;
  deps: AutoTitleDeps;
}): Promise<string | undefined> {
  const { session, model, state, deps } = args;

  if (state.inFlight || state.attempted) return undefined;

  const existing =
    typeof session.sessionName === "string" ? session.sessionName.trim() : "";
  if (existing.length > 0) return undefined;

  const source = firstUserMessageText(session.messages, deps.maxSourceChars);
  if (!source) return undefined;

  if (!model) return undefined;

  state.inFlight = true;
  try {
    const result = await deps.completeSimple(
      model,
      {
        systemPrompt: TITLE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: source, timestamp: Date.now() }],
      },
      { maxTokens: 32 },
    );

    // The model call completed successfully; don't try again even if the
    // answer sanitized down to nothing.
    state.attempted = true;

    const title = sanitizeTitle(extractAssistantText(result), deps.maxTitleChars);
    if (!title) return undefined;

    // Re-check the live name: a newer value (e.g. a user rename) may have
    // landed while the model call was in flight and must win.
    const current =
      typeof session.sessionName === "string" ? session.sessionName.trim() : "";
    if (current.length > 0) return undefined;

    session.setSessionName(title);
    return title;
  } catch (err) {
    // A failed attempt must stay retryable: leave `attempted` false so a
    // later trigger for the same state can try again.
    state.attempted = false;
    try {
      deps.onError?.(err);
    } catch {
      /* logging must never break the pipeline */
    }
    return undefined;
  } finally {
    state.inFlight = false;
  }
}
