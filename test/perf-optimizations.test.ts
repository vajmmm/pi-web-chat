import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Structural regression suite for the cold-path / snapshot / streaming perf pass.
 *
 * There is no DOM/render harness for these paths, so the tests pin the actual
 * source composition. Read-only string assertions; no runtime side effects.
 */

function readSource(relative: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
  } catch {
    return "";
  }
}

const serverIndex = readSource("../server/index.ts");
const chatPage = readSource("../src/components/ChatPage.tsx");
const messageList = readSource("../src/components/MessageList.tsx");

describe("Cold path opens an existing session with a single runtime", () => {
  it("createEntry uses SessionManager.open for the existing-session path", () => {
    assert.ok(
      serverIndex.includes("SessionManager.open(path, undefined, effectiveCwd)"),
      "existing-session cold bind must open the session file directly",
    );
    assert.ok(
      serverIndex.includes("SessionManager.create(effectiveCwd)"),
      "new-session path must keep SessionManager.create",
    );
  });

  it("createEntry no longer tears down and rebuilds via runtime.switchSession", () => {
    assert.ok(
      !serverIndex.includes("runtime.switchSession"),
      "hot cold-bind switchSession teardown must be gone",
    );
  });

  it("passes the resume session start event only on the existing-session path", () => {
    assert.ok(
      serverIndex.includes('type: "session_start" as const, reason: "resume" as const'),
      "resume sessionStartEvent must be constructed inline",
    );
    assert.ok(
      !serverIndex.includes("previousSessionFile"),
      "must not fabricate previousSessionFile",
    );
  });
});

describe("MessageList is no longer remounted per session", () => {
  it("ChatPage does not key MessageList by sessionId", () => {
    assert.ok(!chatPage.includes("key={sessionId"), "per-session key must be removed");
    assert.ok(chatPage.includes("<MessageList"), "MessageList must still render");
  });

  it("MessageList accepts a sessionId prop and resets stick-to-bottom on change", () => {
    assert.ok(
      messageList.includes("sessionId?: string | null"),
      "MessageList must accept an optional sessionId",
    );
    assert.ok(
      /useEffect\(\(\) => \{[\s\S]*?sessionId === undefined[\s\S]*?stickToBottom\.current = true/.test(
        messageList,
      ),
      "sessionId changes must reset stick-to-bottom",
    );
  });
});

describe("Streaming text bypasses react-markdown", () => {
  it("does not route streamText through LazyMarkdown", () => {
    assert.ok(
      !messageList.includes("<LazyMarkdown text={streamText}"),
      "streaming text must not run the markdown parser",
    );
  });

  it("renders streaming text as plain whitespace-pre-wrap text", () => {
    assert.ok(
      messageList.includes(
        "text-[15px] whitespace-pre-wrap leading-relaxed break-words [overflow-wrap:anywhere]",
      ),
      "streaming branch must use the plain-text fallback styling",
    );
    assert.ok(
      messageList.includes("{streamText}"),
      "streaming branch must render the raw stream text",
    );
  });

  it("keeps historical assistant bubbles on the markdown path", () => {
    assert.ok(
      messageList.includes("<LazyMarkdown key={i} text={b.text} />"),
      "committed history must still render markdown",
    );
  });
});
