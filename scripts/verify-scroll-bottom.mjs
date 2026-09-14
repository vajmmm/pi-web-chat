/**
 * MessageList "stick to bottom during streaming" reproduction + regression check.
 *
 * Reproduces the defect with the real React component (no mocks). During
 * streaming, after the user scrolls up and then scrolls back to the bottom, the
 * list is never re-pinned: the async `scroll` event lands after the streaming
 * render already grew the content, so the handler measures a distance > 8px and
 * leaves stick-to-bottom false forever.
 *
 * Usage:
 *   node scripts/verify-scroll-bottom.mjs            # starts its own vite server
 *   HARNESS_URL=http://localhost:5273 node scripts/verify-scroll-bottom.mjs
 *
 * Exit code 0 = all scenarios pass.
 */
import { spawn } from "node:child_process";
import process from "node:process";
import { chromium } from "playwright";

const HARNESS_URL = process.env.HARNESS_URL ?? "http://localhost:5273/";
const SPAWN_SERVER = !process.env.HARNESS_URL;
const TOLERANCE = 8;
// The streaming cadence used by chat.ts (40ms coalescing) and a chunk that
// grows the list ~100px per render. One "growth frame" is therefore < ~250px.
const STREAM_INTERVAL_MS = 40;
const STREAM_CHUNK = 320;
const ONE_FRAME_GROWTH = 500;

function log(msg) {
  console.log(msg);
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
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`harness server not reachable: ${url}`);
}

function startServer() {
  const child = spawn(
    "npx",
    ["vite", "--config", "test/fixtures/scroll-harness/vite.config.ts"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

const metrics = (page) => page.evaluate(() => window.__harness.metrics());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPinned(page, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = await metrics(page);
    if (m && m.distanceFromBottom <= TOLERANCE && m.scrollHeight > m.clientHeight) return m;
    await sleep(50);
  }
  throw new Error("timed out waiting for the list to be pinned to the bottom");
}

async function sampleDistances(page, count, stepMs) {
  const out = [];
  for (let i = 0; i < count; i++) {
    await sleep(stepMs);
    out.push((await metrics(page)).distanceFromBottom);
  }
  return out;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

async function resetAndPin(page) {
  await page.evaluate(() => window.__harness.reset());
  await waitPinned(page);
  const box = await page.locator(".thin-scroll").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

async function run(page) {
  // ---- Scenario 1: scroll up, then return to the bottom while streaming ----
  await resetAndPin(page);
  await page.mouse.wheel(0, -800);
  await sleep(600);
  const up = await metrics(page);
  check("S1a scroll up detaches from the bottom", up.distanceFromBottom > 100,
    `distance=${up.distanceFromBottom}`);

  await page.mouse.wheel(0, 50000);
  const samples = await sampleDistances(page, 10, 100);
  const maxDist = Math.max(...samples);
  const finalDist = samples[samples.length - 1];
  check(
    "S1b reach + stay at the true bottom while streaming",
    finalDist <= ONE_FRAME_GROWTH && maxDist <= ONE_FRAME_GROWTH,
    `samples=[${samples.join(", ")}] max=${maxDist} final=${finalDist}`,
  );

  // ---- Scenario 2: a deliberate up-scroll must not be yanked back ----
  await resetAndPin(page);
  await page.mouse.wheel(0, -200);
  const s2 = await sampleDistances(page, 6, 100);
  const minS2 = Math.min(...s2);
  check("S2 up-scroll is not yanked back during streaming", minS2 > 100,
    `min=${minS2} samples=[${s2.join(", ")}]`);

  // ---- Scenario 3: repeated up-scrolls accumulate (no snap-fighting) ----
  await resetAndPin(page);
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, -120);
    await sleep(80);
  }
  const s3 = await metrics(page);
  check("S3 repeated up-scrolls are respected", s3.distanceFromBottom > 300,
    `distance=${s3.distanceFromBottom}`);
}

let server;
try {
  if (SPAWN_SERVER) {
    server = startServer();
  }
  await waitForServer(HARNESS_URL);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
  page.on("pageerror", (e) => log(`[pageerror] ${e.message}`));
  await page.goto(HARNESS_URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__harness));
  await page.evaluate(
    ([ms, chunk]) => {
      window.__harness.setIntervalMs(ms);
      window.__harness.setChunk(chunk);
      window.__harness.start();
    },
    [STREAM_INTERVAL_MS, STREAM_CHUNK],
  );
  await sleep(800);

  await run(page);

  await browser.close();
} finally {
  if (server) server.kill("SIGTERM");
}

const failed = results.filter((r) => !r.ok);
log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
