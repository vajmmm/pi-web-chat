import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Structural layout regression suite.
 *
 * There is no DOM/test-renderer harness in this repo, so these tests assert the
 * actual JSX composition of the top bar, sidebar and composer. They pin the
 * "top bar decompression" contract: model/thinking/role controls live in the
 * composer, LLM TURNS / CONTEXT live at the top of the sidebar, and the header
 * keeps only the trigger / brand / connection / cwd / subagents / settings.
 */

function readSource(relative: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
  } catch {
    return "";
  }
}

const chatPage = readSource("../src/components/ChatPage.tsx");
const sessionsDrawer = readSource("../src/components/SessionsDrawer.tsx");
const composer = readSource("../src/components/Composer.tsx");
const modelPicker = readSource("../src/components/ModelPicker.tsx");

describe("Header decompression", () => {
  it("removes LLM TURNS / CONTEXT controls from the header", () => {
    assert.ok(!chatPage.includes("LLM TURNS"), "LLM TURNS must not remain in the header");
    assert.ok(!/👁️\s*CONTEXT|>\s*CONTEXT\s*</.test(chatPage), "CONTEXT must not remain in the header");
  });

  it("removes role / model / thinking selectors from the header", () => {
    assert.ok(!chatPage.includes("<RoleSelector"), "RoleSelector must move to the composer");
    assert.ok(!chatPage.includes("<ModelMenu"), "ModelMenu must be replaced by the composer picker");
    assert.ok(!chatPage.includes("<ThinkingMenu"), "ThinkingMenu must be merged into the composer picker");
  });

  it("keeps only trigger / brand / connection / cwd / subagents / settings", () => {
    assert.ok(chatPage.includes("<SessionsDrawer"), "sidebar trigger must stay in the header");
    assert.ok(chatPage.includes("<CwdSelector"), "cwd selector must stay in the header");
    assert.ok(chatPage.includes("SUBAGENTS"), "subagents button must stay in the header");
    assert.ok(chatPage.includes("<SettingsMenu"), "settings must stay in the header");
    assert.ok(chatPage.includes("connectionDotClass"), "connection indicator must stay in the header");
  });
});

describe("Sidebar top actions", () => {
  it("hosts LLM TURNS and CONTEXT at the top of the sidebar panel", () => {
    assert.ok(sessionsDrawer.includes("LLM TURNS"), "LLM TURNS must live in the sidebar");
    assert.ok(sessionsDrawer.includes("CONTEXT"), "CONTEXT must live in the sidebar");
    // The modals are still rendered from the sidebar, but now go through the
    // lazy-loading indirection (see src/components/lazy-modals.ts) so the heavy
    // dialog code stays out of the initial bundle.
    assert.ok(sessionsDrawer.includes("<LazyLLMTurnsModal"), "LLMTurnsModal must be rendered from the sidebar");
    assert.ok(sessionsDrawer.includes("<LazyPromptInspectorModal"), "PromptInspectorModal must be rendered from the sidebar");
  });
});

describe("Composer control row", () => {
  it("renders RoleSelector immediately to the right of the attach (+) button", () => {
    assert.ok(composer.includes("<RoleSelector"), "RoleSelector must render inside the composer");
    const roleIdx = composer.indexOf("<RoleSelector");
    const attachIdx = composer.indexOf("fileInputRef.current?.click()");
    const uploadIdx = composer.indexOf("<input\n            ref={fileInputRef}");
    assert.ok(roleIdx > 0);
    assert.ok(roleIdx > attachIdx, "RoleSelector must come after the attach button");
    assert.ok(roleIdx > uploadIdx, "RoleSelector must come after the hidden file input");
  });

  it("renders the merged model + thinking picker just left of the send button", () => {
    assert.ok(composer.includes("<ModelPicker"), "ModelPicker must render inside the composer");
    const pickerIdx = composer.indexOf("<ModelPicker");
    const sendIdx = composer.indexOf('aria-label={t("send")}');
    assert.ok(pickerIdx > 0);
    assert.ok(sendIdx > 0);
    assert.ok(pickerIdx < sendIdx, "ModelPicker must appear before the send button");
  });
});

describe("Merged model + thinking picker", () => {
  it("sends both set_model and set_thinking_level commands", () => {
    assert.ok(modelPicker.includes('type: "set_model"'), "picker must send set_model");
    assert.ok(modelPicker.includes('type: "set_thinking_level"'), "picker must send set_thinking_level");
  });

  it("uses a compact first screen with a thinking slider", () => {
    assert.ok(modelPicker.includes('type="range"'), "thinking control must be a slider");
    assert.ok(modelPicker.includes('aria-label="思考程度"'), "slider must be labelled");
    assert.ok(modelPicker.includes('view === "catalog"') || modelPicker.includes('setView("catalog")'), "catalog must be a drill-in, not the default panel");
    assert.ok(modelPicker.includes('view === "compact"') || modelPicker.includes('"compact"'), "default view must be the compact Codex card");
  });
});
