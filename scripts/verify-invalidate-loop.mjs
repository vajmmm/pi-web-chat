/**
 * Sessions sidebar invalidate-loop verification.
 *
 * Regression check for the `useInvalidateSessions` referential-stability bug:
 * the hook must return a stable function across renders, otherwise
 * `useSessionListSync`'s effects re-run on every render and trigger a
 * perpetual `/api/sessions` + `/api/projects` refetch loop.
 *
 * Uses the real hooks + real effect in test/fixtures/invalidate-harness, with
 * a counted in-memory fetch mock. No server/network required.
 *
 * Usage:
 *   node scripts/verify-invalidate-loop.mjs
 *   HARNESS_URL=http://localhost:5274 node scripts/verify-invalidate-loop.mjs
 *
 * Exit code 0 = stable (no loop).
 */
import { spawn } from "node:child_process";
import process from "node:process";
import { chromium } from "playwright";

const HARNESS_URL = process.env.HARNESS_URL ?? "http://localhost:5274/";
const SPAWN_SERVER = !process.env.HARNESS_URL;
const IDLE_MS = 1500;
const MOUNT_SETTLE_MS = 1200;
// After reset, a stable implementation issues at most one in-flight refetch.
const IDLE_BUDGET = 2;
const PING_BUDGET = 2;
const PING_COUNT = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const child = spawn(
    "npx",
    ["vite", "--config", "test/fixtures/invalidate-harness/vite.config.ts"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
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
  throw new Error(`harness server not reachable: ${url}`);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

let server;
try {
  if (SPAWN_SERVER) server = startServer();
  await waitForServer(HARNESS_URL);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(HARNESS_URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__harness));

  await sleep(MOUNT_SETTLE_MS);
  await page.evaluate(() => window.__harness.reset());
  await sleep(IDLE_MS);
  const idle = await page.evaluate(() => window.__harness.stats());
  const idleTotal = idle.sessions + idle.projects;
  check(
    "idle sidebar issues no repeated /api/sessions + /api/projects refetches",
    idleTotal <= IDLE_BUDGET,
    `sessions=${idle.sessions} projects=${idle.projects} renders=${idle.renders} (budget ${IDLE_BUDGET})`,
  );

  // Force parent re-renders with no data change: a stable invalidate identity
  // must not produce fresh requests.
  await page.evaluate(() => window.__harness.reset());
  await page.evaluate((n) => {
    for (let i = 0; i < n; i++) window.__harness.ping();
  }, PING_COUNT);
  await sleep(800);
  const afterPing = await page.evaluate(() => window.__harness.stats());
  const pingTotal = afterPing.sessions + afterPing.projects;
  check(
    "external re-renders do not retrigger invalidation",
    pingTotal <= PING_BUDGET,
    `sessions=${afterPing.sessions} projects=${afterPing.projects} (budget ${PING_BUDGET}, pings ${PING_COUNT})`,
  );

  // Positive control: the intended refresh signal (async session title) must
  // still trigger a sessions + projects refetch after the memoization fix.
  await page.evaluate(() => window.__harness.reset());
  await page.evaluate(() => window.__harness.emitTitleChange());
  await sleep(600);
  const afterTitle = await page.evaluate(() => window.__harness.stats());
  check(
    "session title change still refreshes sessions + projects",
    afterTitle.sessions >= 1 && afterTitle.projects >= 1,
    `sessions=${afterTitle.sessions} projects=${afterTitle.projects}`,
  );

  await browser.close();
} finally {
  if (server) server.kill("SIGTERM");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
