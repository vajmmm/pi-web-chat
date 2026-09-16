import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Structural regression suite for two hidden frontend defects:
 *
 *  H1 — the reconnect `setTimeout` handle in `src/lib/chat.ts` was never saved,
 *       so a pending auto-reconnect could not be cancelled when the user switched
 *       sessions. The stale timer then fired against the newly bound session and
 *       silently rebound the old target.
 *
 *  M1 — `src/components/MessageList.tsx` keyed top-level messages by array index.
 *       Because the list no longer remounts per session, React reused the same
 *       DOM position across a session switch, leaking uncontrolled state
 *       (`<details>` expand, `<img>` load) into the next session's messages.
 *
 * There is no DOM/render harness in this repo, so these tests pin the actual
 * source composition (read-only string assertions; no runtime side effects).
 */

function readSource(relative: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
  } catch {
    return "";
  }
}

const chat = readSource("../src/lib/chat.ts");
const messageList = readSource("../src/components/MessageList.tsx");

describe("H1: reconnect timer is stored and cancellable", () => {
  it("holds the reconnect handle on the instance", () => {
    assert.ok(
      chat.includes("private reconnectTimer: ReturnType<typeof setTimeout> | null = null"),
      "reconnect setTimeout handle must be saved as an instance field",
    );
    assert.ok(
      chat.includes("this.reconnectTimer = setTimeout("),
      "the scheduled reconnect must assign its handle to this.reconnectTimer",
    );
  });

  it("clearReconnectTimer clears and nulls the handle", () => {
    assert.match(
      chat,
      /private clearReconnectTimer\(\) \{\s*if \(this\.reconnectTimer !== null\) \{\s*clearTimeout\(this\.reconnectTimer\);\s*this\.reconnectTimer = null;\s*\}\s*\}/,
      "clearReconnectTimer must clearTimeout and null the saved handle",
    );
  });

  it("closeSocket cancels a pending reconnect", () => {
    assert.match(
      chat,
      /private closeSocket\(\) \{\s*this\.clearReconnectTimer\(\);/,
      "closeSocket must cancel any pending reconnect before tearing down the socket",
    );
  });

  it("connect cancels a pending reconnect for a previous drop", () => {
    assert.ok(
      chat.includes(
        "this.clearReconnectTimer();\n    if (opts?.force) this.haltReconnect = false;",
      ),
      "every explicit connect (session switch / force) must cancel the stale reconnect",
    );
  });

  it("the reconnect callback drops its handle and abandons a stale target", () => {
    assert.match(
      chat,
      /this\.reconnectTimer = setTimeout\(\(\) => \{\s*this\.reconnectTimer = null;/,
      "the reconnect callback must null the handle as soon as it runs",
    );
    assert.ok(
      chat.includes("if (this.intentionalClose || this.haltReconnect) return;"),
      "the callback must still honour intentionalClose / haltReconnect",
    );
    assert.ok(
      chat.includes("const currentTarget = this.state.sessionId ?? this.target;"),
      "the callback must recompute the current target",
    );
    assert.ok(
      chat.includes("if (currentTarget !== retryTarget) return;"),
      "the callback must abandon the reconnect when the user switched sessions",
    );
  });

  it("preserves exponential backoff and the normal retry path", () => {
    assert.ok(chat.includes("private reconnectDelay = 400;"), "base backoff must remain 400ms");
    assert.ok(
      chat.includes("this.reconnectDelay = Math.min(Math.round(this.reconnectDelay * 1.6), 8_000);"),
      "exponential backoff (x1.6, capped at 8s) must be preserved",
    );
    assert.ok(
      chat.includes(
        "this.connect(retryTarget, retryCwd ? { cwd: retryCwd } : undefined);",
      ),
      "the callback must still reconnect when the target is unchanged",
    );
  });

  it("haltReconnect paths also cancel the pending reconnect", () => {
    assert.match(
      chat,
      /this\.haltReconnect = true;\s*this\.clearReconnectTimer\(\);/,
      "'Session not found' must cancel a pending reconnect",
    );
    assert.match(
      chat,
      /if \(this\.intentionalClose \|\| this\.haltReconnect\) \{\s*this\.clearReconnectTimer\(\);\s*return;/,
      "onclose early-return must also cancel any pending reconnect",
    );
  });
});

describe("M1: top-level message keys are not reused across sessions", () => {
  it("does not key top-level messages by array index", () => {
    assert.ok(
      !messageList.includes("<Message key={i} message={m} />"),
      "top-level messages must not use the raw positional index as key",
    );
    assert.match(
      messageList,
      /<div key=\{messageKey\(m, i, sessionId\)\} data-msg-index=\{i\}[^>]*>\s*<Message message=\{m\} \/>/,
      "the indexed top-level wrapper must carry the composite messageKey",
    );
  });

  it("derives a session-scoped composite key when no stable message id exists", () => {
    assert.ok(messageList.includes("function messageKey("), "messageKey helper must exist");
    assert.ok(
      messageList.includes('sessionId ?? "-"'),
      "messageKey must include the bound session so keys are never reused across sessions",
    );
    assert.ok(
      messageList.includes("function firstBlockKey("),
      "messageKey must fold in a first-block feature (stable id for toolCall)",
    );
  });

  it("keeps block-level keys index-based (order stable within a message)", () => {
    assert.ok(
      messageList.includes("<LazyMarkdown key={i} text={b.text} />"),
      "block-level index keys inside a single message remain acceptable",
    );
  });
});
