import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  serializeMessages,
  TOOL_RESULT_SNAPSHOT_MAX_CHARS,
} from "../server/serialize.ts";

const MAX = TOOL_RESULT_SNAPSHOT_MAX_CHARS;
const MARKER = "…(truncated)";

function toolResultMessages(
  text: string,
  extraToolResultBlocks: unknown[] = [],
): unknown[] {
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "x" } }],
    },
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text }, ...extraToolResultBlocks],
    },
  ];
}

function firstToolResultText(ui: ReturnType<typeof serializeMessages>): string | undefined {
  const block = ui[0]?.content.find((b) => b.type === "toolCall");
  return block && block.type === "toolCall" ? block.result?.text : undefined;
}

describe("serializeMessages tool result truncation", () => {
  it("leaves a short tool result unchanged when a cap is provided", () => {
    const ui = serializeMessages(toolResultMessages("short output"), {
      maxToolResultChars: MAX,
    });
    assert.equal(firstToolResultText(ui), "short output");
  });

  it("does not truncate a result exactly at the cap", () => {
    const text = "a".repeat(MAX);
    const ui = serializeMessages(toolResultMessages(text), { maxToolResultChars: MAX });
    assert.equal(firstToolResultText(ui), text);
  });

  it("truncates an over-long result to the cap and appends the marker", () => {
    const text = "a".repeat(MAX + 500);
    const ui = serializeMessages(toolResultMessages(text), { maxToolResultChars: MAX });
    const out = firstToolResultText(ui) ?? "";
    assert.equal(out, `${"a".repeat(MAX)}\n${MARKER}`);
    assert.ok(out.endsWith(MARKER));
    // The truncation only removes the tail; the visible head is intact.
    assert.equal(out.slice(0, MAX), text.slice(0, MAX));
  });

  it("does not truncate when no options are passed (full text preserved)", () => {
    const text = "a".repeat(MAX + 500);
    const ui = serializeMessages(toolResultMessages(text));
    assert.equal(firstToolResultText(ui), text);
  });

  it("keeps image blocks serialized even when tool results are truncated", () => {
    const ui = serializeMessages(
      toolResultMessages("x".repeat(MAX + 10), [
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ]),
      { maxToolResultChars: MAX },
    );
    assert.equal(ui.length, 2);
    assert.deepEqual(ui[1]?.content, [
      { type: "image", dataUrl: "data:image/png;base64,aGVsbG8=" },
    ]);
  });
});
