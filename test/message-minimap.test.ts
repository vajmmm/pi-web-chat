import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Structural regression suite for the message minimap + hover preview.
 *
 * There is no DOM/test-renderer harness in this repo, so these tests assert the
 * actual JSX composition and the runtime primitives used by the source. They pin
 * the integration contract:
 *   - MessageList keeps its scroll container as the direct scroll owner and
 *     mounts MessageMinimap inside a *relative* wrapper (so the stick-to-bottom
 *     logic is untouched).
 *   - every rendered message is addressable through data-msg-index.
 *   - the minimap only draws lines for *user questions* (role === "user").
 *   - lines are laid out in an evenly spaced flex column of fixed slots
 *     (compressed when the count exceeds the available height), decoupled from
 *     the document offset that is still cached for jump + highlight.
 *   - the lines covered by the current viewport are highlighted (multi-select).
 *   - hover hit-testing uses the *rendered* line positions, not document offsets.
 *   - MessageMinimap rebuilds geometry via ResizeObserver, throttles scroll
 *     updates through requestAnimationFrame, and never reads the full layout in
 *     a scroll frame.
 *   - hover preview + click jump wiring exists.
 *   - the bar hides below md: and only uses theme tokens (no hardcoded colors).
 *
 * The real browser behaviour (uniform spacing, viewport highlight, hover, jump,
 * narrow-screen hiding, adaptive compression) is verified by
 * scripts/verify-minimap.mjs against test/fixtures/minimap-harness.
 */

function readSource(relative: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
  } catch {
    return "";
  }
}

const messageList = readSource("../src/components/MessageList.tsx");
const minimap = readSource("../src/components/MessageMinimap.tsx");

describe("MessageList minimap integration", () => {
  it("keeps the scroll container classes that stick-to-bottom and the harness rely on", () => {
    assert.ok(
      messageList.includes("thin-scroll min-h-0 flex-1 overflow-y-auto"),
      "the scroll container must keep `thin-scroll min-h-0 flex-1 overflow-y-auto`",
    );
  });

  it("mounts the scroll container inside a relative flex wrapper (min-h-0 flex-1 preserved)", () => {
    assert.ok(messageList.includes("relative"), "the layout wrapper must be position:relative");
    assert.match(
      messageList,
      /relative[^"]*flex[^"]*min-h-0[^"]*flex-1[^"]*flex-col/,
      "wrapper must be `relative flex min-h-0 flex-1 flex-col`",
    );
  });

  it("renders MessageMinimap next to the scroll container", () => {
    assert.ok(messageList.includes("<MessageMinimap"), "MessageMinimap must be mounted from MessageList");
    assert.ok(messageList.includes("containerRef"), "the scroll container ref must be passed through");
  });

  it("tags every rendered message with data-msg-index", () => {
    assert.ok(messageList.includes("data-msg-index"), "messages must expose data-msg-index");
    assert.match(
      messageList,
      /data-msg-index=\{i\}/,
      "data-msg-index must be the message array index",
    );
  });
});

describe("MessageMinimap user-question lines", () => {
  it("only draws lines for user messages (no assistant/custom lines)", () => {
    assert.ok(
      minimap.includes('message.role === "user"'),
      'must select lines from messages with role === "user"',
    );
    assert.ok(
      minimap.includes('data-role="user"'),
      "every drawn line must be marked as a user line",
    );
    assert.ok(
      !minimap.includes('role: message.role'),
      "must not carry a per-message role onto the lines",
    );
  });

  it("lays lines out as an evenly spaced, vertically centred flex column", () => {
    assert.ok(minimap.includes("flex-col"), "the track must be a flex column");
    assert.ok(minimap.includes("justify-center"), "the track must be centred vertically");
    assert.ok(minimap.includes("data-minimap-slot"), "each line needs a fixed-height slot");
    assert.match(minimap, /SLOT_HEIGHT/, "a preferred slot height constant must exist");
    assert.ok(minimap.includes("items-center"), "the line must sit centred inside its slot");
  });

  it("compresses the slot height to fit when the count exceeds the available height", () => {
    assert.match(
      minimap,
      /Math\.min\(SLOT_HEIGHT/,
      "slot height must be min(preferred, available / count)",
    );
  });

  it("highlights every line covered by the current viewport", () => {
    assert.ok(minimap.includes("minimapActiveIndices"), "viewport coverage must be computed explicitly");
    assert.ok(minimap.includes("data-active"), "active lines need a data-active marker");
    assert.ok(
      minimap.includes("active.has(line.index)"),
      "each line must resolve its active state from the viewport set",
    );
  });

  it("hit-tests hover by rendered line position instead of the document offset", () => {
    assert.ok(minimap.includes("lineCentersRef"), "rendered line centres must be cached");
    assert.ok(minimap.includes("nearestLineIndex"), "hover must map a pointer y onto the nearest rendered line");
    assert.ok(
      !minimap.includes("nearestLine(linesRef.current, fraction)"),
      "hover must not map the pointer through normalised document positions",
    );
  });
});

describe("MessageMinimap behaviour wiring", () => {
  it("rebuilds geometry with ResizeObserver and throttles scroll with requestAnimationFrame", () => {
    assert.ok(minimap.includes("ResizeObserver"), "must observe container/content growth");
    assert.ok(minimap.includes("requestAnimationFrame"), "viewport updates must be rAF throttled");
    assert.ok(minimap.includes("cancelAnimationFrame"), "pending rAF must be cancelled on unmount");
  });

  it("caches document offsets from data-msg-index instead of re-measuring every scroll frame", () => {
    assert.ok(minimap.includes("data-msg-index"), "must read data-msg-index nodes");
    assert.ok(minimap.includes("getBoundingClientRect"), "must measure once into a cache");
    assert.ok(minimap.includes("querySelectorAll"), "must batch-read the rendered messages");
  });

  it("supports click jump without re-implementing stick-to-bottom", () => {
    assert.ok(minimap.includes("scrollTop ="), "clicking a line must set container.scrollTop");
    assert.ok(minimap.includes("offsetTop"), "click jump must use the cached document offset");
    assert.ok(!minimap.includes("stickToBottom"), "stick-to-bottom stays owned by MessageList");
    assert.ok(!minimap.includes("handleScroll"), "scroll semantics stay owned by MessageList");
  });

  it("renders the line / slot / hover-preview affordances", () => {
    assert.ok(minimap.includes("data-minimap-line"), "lines need data-minimap-line");
    assert.ok(minimap.includes("data-minimap-preview"), "the hover card needs data-minimap-preview");
    assert.ok(minimap.includes("pointermove"), "hover must react to pointermove");
    assert.ok(minimap.includes("pointerleave"), "hover must clear on pointerleave");
  });

  it("previews the hovered user question with a USER badge", () => {
    assert.ok(minimap.includes('"USER"'), "the preview badge must read USER");
    assert.ok(minimap.includes("minimapPreviewText"), "preview text must come from the shared helper");
  });

  it("uses a uniform line width that expands on hover", () => {
    assert.match(minimap, /const LINE_WIDTH =/, "a uniform width constant must exist");
    assert.match(minimap, /LINE_HOVER_WIDTH/, "hover must expand the line width");
    assert.match(minimap, /transition-all/, "width/colour changes must be smoothed");
    assert.ok(!minimap.includes("minimapLineWidth"), "length normalisation must be gone");
  });

  it("hides below md: and uses theme tokens only", () => {
    assert.match(minimap, /hidden[^"]*md:block/, "must be hidden below md:");
    assert.ok(minimap.includes("bg-ink"), "must use the ink token");
    assert.ok(minimap.includes("bg-card"), "preview card must use the card token");
    assert.ok(minimap.includes("border-line"), "preview card must use the line token");
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(minimap),
      "minimap must not hardcode hex colors",
    );
    assert.ok(!/rgba?\(/.test(minimap), "minimap must not hardcode rgb/rgba colors");
  });
});
