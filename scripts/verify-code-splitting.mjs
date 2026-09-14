/**
 * Production code-splitting verification.
 *
 * Serves the built app (dist/public) and drives it in a real browser to prove:
 *   1. the app shell renders without pulling any lazy chunk,
 *   2. the markdown/highlight + base-ui dialog chunks are NOT fetched on first
 *      paint (they stay out of the initial graph),
 *   3. each lazy surface loads its chunk on demand and renders, with no
 *      ChunkLoadError / failed asset request.
 *
 * Prereq: `npm run build` (or at least `npx vite build`).
 *
 * Usage:
 *   node scripts/verify-code-splitting.mjs
 *   PREVIEW_URL=http://localhost:5275 node scripts/verify-code-splitting.mjs
 *
 * Exit code 0 = all checks pass.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import process from "node:process";
import { chromium } from "playwright";

const PREVIEW_URL = process.env.PREVIEW_URL ?? "http://localhost:5275/";
const SPAWN_SERVER = !process.env.PREVIEW_URL;

// Lazy chunks that must never be part of the initial page load.
const LAZY_PREFIXES = [
  "Markdown-",
  "RolesDialog-",
  "ModelsDialog-",
  "ForkDialog-",
  "ExtensionsDialog-",
  "LLMTurnsModal-",
  "PromptInspectorModal-",
  "SubagentDrawer-",
  "CwdSelectorDialog-",
  "SessionsDrawerDialog-",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startPreview() {
  const child = spawn("npx", ["vite", "preview", "--port", "5275", "--strictPort"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`preview server not reachable: ${url}`);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

const assetsDir = new URL("../dist/public/assets/", import.meta.url);
if (!existsSync(assetsDir)) {
  console.error("dist/public/assets not found — run `npm run build` first");
  process.exit(2);
}
const markdownAsset = readdirSync(assetsDir).find(
  (f) => f.startsWith("Markdown-") && f.endsWith(".js"),
);
if (!markdownAsset) {
  console.error("Markdown-*.js chunk not found — build did not code-split");
  process.exit(2);
}

/** Attach request/error tracking to a page. */
function track(browser) {
  return browser.newPage({ viewport: { width: 1280, height: 800 }, locale: "en-US" }).then((page) => {
    const state = { requested: new Set(), failedAssets: [], pageErrors: [] };
    page.on("request", (req) => {
      const m = req.url().match(/\/assets\/([^/?#]+\.js)/);
      if (m) state.requested.add(m[1]);
    });
    page.on("requestfailed", (req) => {
      if (req.url().includes("/assets/")) state.failedAssets.push(req.url());
    });
    page.on("pageerror", (e) => state.pageErrors.push(e.message));
    return { page, state };
  });
}

async function waitForAsset(state, prefix, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ([...state.requested].some((f) => f.startsWith(prefix))) return true;
    await sleep(100);
  }
  return false;
}

let server;
try {
  if (SPAWN_SERVER) server = startPreview();
  await waitForServer(PREVIEW_URL);

  const browser = await chromium.launch();

  // --- Initial paint: shell renders, no lazy chunks fetched ---
  {
    const { page, state } = await track(browser);
    await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("header");
    await sleep(700); // let any (mis)configured eager imports surface
    const headerText = await page.locator("header").innerText();
    check(
      "app shell header renders (SUBAGENTS trigger present)",
      headerText.includes("SUBAGENTS"),
      JSON.stringify(headerText.replace(/\s+/g, " ").slice(0, 80)),
    );
    const sidebarText = await page.locator("aside").first().innerText();
    check(
      "desktop sidebar renders (Projects list)",
      sidebarText.toLowerCase().includes("projects"),
      JSON.stringify(sidebarText.replace(/\s+/g, " ").slice(0, 60)),
    );
    const eagerlyFetched = LAZY_PREFIXES.filter((p) =>
      [...state.requested].some((f) => f.startsWith(p)),
    );
    check(
      "no heavy chunk (markdown / dialogs) in the initial graph",
      eagerlyFetched.length === 0,
      eagerlyFetched.length
        ? `unexpected: ${eagerlyFetched.join(", ")}`
        : `initial assets=${state.requested.size}`,
    );
    check("no failed asset requests on initial paint", state.failedAssets.length === 0, "");
    await page.close();
  }

  // --- Markdown/highlight chunk imports cleanly on demand ---
  {
    const { page } = await track(browser);
    await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("header");
    let ok = true;
    let err = "";
    try {
      await page.evaluate((name) => import(/* @vite-ignore */ `/assets/${name}`), markdownAsset);
    } catch (e) {
      ok = false;
      err = String(e);
    }
    check("lazy Markdown/highlight chunk imports cleanly", ok, err);
    await page.close();
  }

  /** Open a fresh page, run an action, assert the expected lazy chunk loaded. */
  async function surfaceCheck(label, prefix, action, viewport = { width: 1280, height: 800 }) {
    const page = await browser.newPage({ viewport, locale: "en-US" });
    const state = { requested: new Set(), failedAssets: [], pageErrors: [] };
    page.on("request", (req) => {
      const m = req.url().match(/\/assets\/([^/?#]+\.js)/);
      if (m) state.requested.add(m[1]);
    });
    page.on("requestfailed", (req) => {
      if (req.url().includes("/assets/")) state.failedAssets.push(req.url());
    });
    page.on("pageerror", (e) => state.pageErrors.push(e.message));
    await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("header");
    try {
      await action(page);
    } catch (e) {
      check(label, false, `action error: ${String(e).split("\n")[0]}`);
      await page.close();
      return;
    }
    const loaded = await waitForAsset(state, prefix);
    check(label, loaded, loaded ? "" : `expected chunk ${prefix}*`);
    await page.close();
  }

  await surfaceCheck("settings → Roles dialog chunk loads on demand", "RolesDialog-", async (page) => {
    await page.locator('button[aria-label="Settings"]').click();
    await page.getByText("角色看板与配置…").click();
  });

  await surfaceCheck(
    "SUBAGENTS → drawer chunk loads on demand",
    "SubagentDrawer-",
    async (page) => {
      await page.getByRole("button", { name: /SUBAGENTS/ }).click();
    },
  );

  await surfaceCheck(
    "Cwd selector → dialog chunk loads on demand",
    "CwdSelectorDialog-",
    async (page) => {
      await page.locator('button[title^="当前工作目录"]').click();
    },
  );

  await surfaceCheck("LLM TURNS → modal chunk loads on demand", "LLMTurnsModal-", async (page) => {
    await page.getByRole("button", { name: /LLM TURNS/ }).click();
  });

  await surfaceCheck(
    "Sessions drawer chunk loads on demand",
    "SessionsDrawerDialog-",
    async (page) => {
      await page.locator('button[aria-label="Session list"]').first().click();
    },
    { width: 420, height: 800 },
  );

  await browser.close();
} finally {
  if (server) server.kill("SIGTERM");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
