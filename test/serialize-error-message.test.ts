import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeProviderErrorMessage, serializeMessages } from "../server/serialize.ts";

const OPENAI_BLOCKED_HTML = `<html> <head> <meta name="viewport" content="width=device-width, initial-scale=1" /> <style>body{font-family:Arial}.blocked-icon{color:#ef4444}.message{align-items:center}</style> <title>Request blocked</title> </head> <body> <div class="container"> <div class="logo">OpenAI</div> <div class="message">Request blocked</div> <div class="explanation">This request was blocked by the provider gateway.</div> <svg width="41" height="41"><path d="M37.5324 16.8707C37.9808"/></svg> </div> </body> </html>`;

describe("sanitizeProviderErrorMessage", () => {
  it("keeps ordinary provider errors unchanged", () => {
    assert.equal(
      sanitizeProviderErrorMessage("Model not found: foo/bar"),
      "Model not found: foo/bar",
    );
  });

  it("turns an HTML error page into a short error message", () => {
    const sanitized = sanitizeProviderErrorMessage(OPENAI_BLOCKED_HTML);
    assert.equal(sanitized.includes("<"), false);
    assert.equal(sanitized.includes("font-family"), false);
    assert.equal(sanitized.includes("M37.5324"), false);
    assert.match(sanitized, /模型调用失败/);
    assert.match(sanitized, /Request blocked/);
  });
});

describe("serializeMessages HTML error pages", () => {
  it("puts HTML errorMessage on the assistant as a readable error, not page source", () => {
    const ui = serializeMessages([
      {
        role: "assistant",
        content: [],
        errorMessage: OPENAI_BLOCKED_HTML,
      },
    ]);
    assert.equal(ui.length, 1);
    assert.equal(ui[0]?.role, "assistant");
    const err = ui[0]?.errorMessage ?? "";
    assert.equal(err.includes("<html"), false);
    assert.equal(err.includes("font-family:Arial"), false);
    assert.match(err, /模型调用失败/);
  });

  it("does not treat an HTML document in assistant text as a normal reply", () => {
    const ui = serializeMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: OPENAI_BLOCKED_HTML }],
      },
    ]);
    assert.equal(ui.length, 1);
    const text = ui[0]?.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.equal(text.includes("<html"), false);
    assert.equal(text.includes("font-family"), false);
    assert.match(ui[0]?.errorMessage ?? "", /模型调用失败/);
  });
});
