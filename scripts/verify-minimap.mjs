/**
 * Message minimap + hover preview behaviour verification (real browser).
 *
 * Runs the actual MessageList in a ChatPage-like column (test/fixtures/minimap-harness)
 * and asserts the navigation bar contract after the rework:
 *   - exactly one line per *user question* (role === "user"), never assistant
 *   - lines are laid out as an evenly spaced, left-aligned flex column whose
 *     rendered position is decoupled from the document offset
 *   - the lines covered by the current viewport are highlighted (multi-select)
 *   - hovering a line shows the matching USER question preview (hit by rendered
 *     position) and clicking a line jumps the scroll container
 *   - the slot height compresses adaptively so many questions never overflow
 *   - streaming growth rebuilds offsets without adding lines
 *   - the bar hides below md: and only uses theme tokens
 *
 * Usage:
 *   node scripts/verify-minimap.mjs            # starts its own vite server
 *   HARNESS_URL=http://localhost:5274 node scripts/verify-minimap.mjs
 *
 * Exit code 0 = all scenarios pass.
 */
import { spawn } from "node:child_process";
import process from "node:process";
import { chromium } from "playwright";

const HARNESS_URL = process.env.HARNESS_URL ?? "http://localhost:5274/";
const SPAWN_SERVER = !process.env.HARNESS_URL;
const UNIFORM_LINE_WIDTH = 12;
const SLOT_HEIGHT = 10;
const LINE_HEIGHT = 2;
const TOP_PAD = 8;

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
    ["vite", "--config", "test/fixtures/minimap-harness/vite.config.ts"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

async function setScrollTop(page, value) {
  await page.evaluate((v) => {
    const el = document.querySelector(".thin-scroll");
    if (el) el.scrollTop = v;
  }, value);
  await sleep(140);
}

const lineBox = (page, msgIndex) =>
  page.locator(`[data-minimap-line][data-msg-index-line="${msgIndex}"]`).boundingBox();

const lineInfo = (page) =>
  page.$$eval("[data-minimap-line]", (els) =>
    els.map((e) => ({
      idx: Number(e.dataset.msgIndexLine),
      width: parseFloat(e.style.width),
      role: e.dataset.role,
      active: e.dataset.active === "1",
    })),
  );

const activeIndexes = (page) =>
  page.$$eval('[data-minimap-line][data-active="1"]', (els) =>
    els.map((e) => Number(e.dataset.msgIndexLine)).sort((a, b) => a - b),
  );

const slotBoxes = (page) =>
  page.$$eval("[data-minimap-slot]", (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  );

const containerBox = (page) => page.locator(".thin-scroll").boundingBox();

/** Document offset (px) of every user message, invariant to scrollTop. */
const userOffsets = (page, indexes) =>
  page.evaluate((idxs) => {
    const el = document.querySelector(".thin-scroll");
    const containerTop = el.getBoundingClientRect().top;
    return idxs.map((i) => {
      const node = document.querySelector(`[data-msg-index="${i}"]`);
      return { i, top: node.getBoundingClientRect().top - containerTop + el.scrollTop };
    });
  }, indexes);

/** Expected active set: tops in [scrollTop, scrollTop+clientHeight], else nearest before. */
function expectedActive(offsets, scrollTop, clientHeight) {
  const bottom = scrollTop + clientHeight;
  const inView = offsets
    .filter((o) => o.top >= scrollTop - 0.5 && o.top <= bottom)
    .map((o) => o.i)
    .sort((a, b) => a - b);
  if (inView.length > 0) return inView;
  let nearest = null;
  for (const o of offsets) if (o.top <= scrollTop && (!nearest || o.top > nearest.top)) nearest = o;
  return nearest ? [nearest.i] : [];
}

const sameArray = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

async function run(page) {
  await page.waitForFunction(() => Boolean(window.__minimap));
  const userCount = await page.evaluate(() => window.__minimap.userCount);
  const users = await page.evaluate(() => window.__minimap.users);
  const roles = await page.evaluate(() => window.__minimap.roles);
  const messageCount = await page.evaluate(() => window.__minimap.count);
  const userIndexes = users.map((u) => u.index);

  await page.waitForFunction(
    (n) => document.querySelectorAll("[data-minimap-line]").length === n,
    userCount,
  );

  // ---- Scenario 1: one line per user question, roles preserved ----
  const info = await lineInfo(page);
  check("M1 line count equals the user message count (not the total)", info.length === userCount,
    `lines=${info.length} users=${userCount} messages=${messageCount}`);
  check("M2 every line is a user question", info.every((l) => l.role === "user"),
    `roles=[${[...new Set(info.map((l) => l.role))].join(", ")}]`);
  check("M3 no line maps to an assistant/custom message",
    info.every((l) => roles[l.idx] === "user"),
    `lineIndexes=[${info.map((l) => l.idx).join(", ")}]`);

  // ---- Scenario 2: uniform line width ----
  check("M4 every line has the same uniform width",
    info.every((l) => Math.abs(l.width - info[0].width) < 0.01),
    `widths=[${[...new Set(info.map((l) => l.width.toFixed(1)))].join(", ")}]`);

  // ---- Scenario 3: evenly spaced, left-aligned, compact layout ----
  const slots = await slotBoxes(page);
  const centers = slots.map((s) => s.y + s.height / 2);
  const gaps = centers.slice(1).map((c, i) => c - centers[i]);
  const gapMin = Math.min(...gaps);
  const gapMax = Math.max(...gaps);
  check("M6 lines are evenly spaced (uniform gap, tolerance <= 2px)",
    gaps.length > 0 && gapMax - gapMin <= 2,
    `gapMin=${gapMin.toFixed(2)} gapMax=${gapMax.toFixed(2)}`);
  const slotH = slots[0]?.height ?? -1;
  check("M7 slot height is compact and within [line, preferred]",
    slotH >= LINE_HEIGHT - 0.01 && slotH <= SLOT_HEIGHT + 0.01,
    `slotHeight=${slotH.toFixed(2)}`);
  const cbox = await containerBox(page);
  const trackBox = await page.locator("[data-minimap-track]").boundingBox();
  check("M8 track fits inside the container without overflow",
    trackBox.y >= cbox.y - 1 && trackBox.y + trackBox.height <= cbox.y + cbox.height + 1,
    `track=[${trackBox.y.toFixed(0)}, ${(trackBox.y + trackBox.height).toFixed(0)}] container=[${cbox.y.toFixed(0)}, ${(cbox.y + cbox.height).toFixed(0)}]`);
  const lineXs = await page.$$eval("[data-minimap-line]", (els) =>
    els.map((e) => e.getBoundingClientRect().x),
  );
  check("M9 lines are left-aligned with a gutter from the edge",
    lineXs.every((x) => Math.abs(x - lineXs[0]) < 1) && lineXs[0] >= 4,
    `x=[${[...new Set(lineXs.map((x) => x.toFixed(1)))].join(", ")}]`);

  // ---- Scenario 4: hover preview shows the matching USER question ----
  const first = users[0];
  const box0 = await lineBox(page, first.index);
  await page.mouse.move(box0.x + Math.min(2, box0.width / 2), box0.y + box0.height / 2);
  await page.waitForSelector("[data-minimap-preview]", { state: "visible", timeout: 3000 });
  const previewText = await page.locator("[data-minimap-preview]").innerText();
  const hoveredWidth = await page.$eval(
    `[data-minimap-line][data-msg-index-line="${first.index}"]`,
    (e) => parseFloat(e.style.width),
  );
  check("M5 hovered line expands wider than the uniform width",
    Math.abs(info[0].width - UNIFORM_LINE_WIDTH) < 0.01 && hoveredWidth > UNIFORM_LINE_WIDTH + 4,
    `base=${info[0].width.toFixed(1)} hover=${hoveredWidth.toFixed(1)}`);
  check("M10 hover preview shows the hovered user question text",
    previewText.includes(first.text.slice(0, 30)),
    `preview="${previewText.slice(0, 60).replace(/\n/g, " ")}"`);
  check("M11 preview shows the USER badge", previewText.includes("USER"),
    `preview="${previewText.slice(0, 40).replace(/\n/g, " ")}"`);

  // Hit-testing must use rendered position, not document offset: the last line's
  // preview must be the last question even though its document offset is huge.
  const last = users[users.length - 1];
  const boxLast = await lineBox(page, last.index);
  await page.mouse.move(boxLast.x + Math.min(2, boxLast.width / 2), boxLast.y + boxLast.height / 2);
  await sleep(120);
  const lastPreview = await page.locator("[data-minimap-preview]").innerText();
  check("M12 hover hit-tests by rendered line position (last slot -> last question)",
    lastPreview.includes(last.text.slice(0, 20)),
    `preview="${lastPreview.slice(0, 60).replace(/\n/g, " ")}"`);
  const previewBox = await page.locator("[data-minimap-preview]").boundingBox();
  check("M13 preview card is clamped inside the viewport",
    previewBox.y >= cbox.y - 1 && previewBox.y + previewBox.height <= cbox.y + cbox.height + 1,
    `card=[${previewBox.y.toFixed(0)}, ${(previewBox.y + previewBox.height).toFixed(0)}]`);

  // ---- Scenario 5: pointer leaving the hot zone hides the preview ----
  await page.mouse.move(cbox.x + cbox.width - 40, cbox.y + cbox.height / 2);
  await sleep(150);
  check("M14 preview hides when the pointer leaves the hot zone",
    (await page.locator("[data-minimap-preview]").count()) === 0);

  // ---- Scenario 6: clicking a line jumps to that user message ----
  await setScrollTop(page, 0);
  const offsets = await userOffsets(page, userIndexes);
  const targetIdx = userIndexes[Math.floor(userIndexes.length / 2)];
  const targetOffset = offsets.find((o) => o.i === targetIdx).top;
  const metrics = await page.evaluate(() => window.__minimap.metrics());
  const expectedJump = Math.min(
    Math.max(targetOffset - TOP_PAD, 0),
    Math.max(0, metrics.scrollHeight - metrics.clientHeight),
  );
  const boxMid = await lineBox(page, targetIdx);
  await page.mouse.click(boxMid.x + Math.min(2, boxMid.width / 2), boxMid.y + boxMid.height / 2);
  await sleep(150);
  const after = await page.evaluate(() => window.__minimap.metrics().scrollTop);
  check("M15 clicking a line jumps to that user message",
    Math.abs(after - expectedJump) < 12,
    `after=${after.toFixed(1)} expected=${expectedJump.toFixed(1)}`);

  // ---- Scenario 7: viewport highlight matches the covered user questions ----
  await setScrollTop(page, 0);
  let offs = await userOffsets(page, userIndexes);
  const cHeight = (await page.evaluate(() => window.__minimap.metrics())).clientHeight;
  let expected = expectedActive(offs, 0, cHeight);
  let actual = await activeIndexes(page);
  check("M16 viewport highlight matches the questions whose top is in view",
    sameArray(actual, expected),
    `active=[${actual.join(", ")}] expected=[${expected.join(", ")}]`);

  // Multiple simultaneous highlights: scroll so two consecutive user questions
  // are both inside the viewport.
  let pair = null;
  for (let i = 0; i < offs.length - 1; i++) {
    if (offs[i + 1].i - offs[i].i === 1 && offs[i + 1].top - offs[i].top < cHeight - 10) {
      pair = offs[i];
      break;
    }
  }
  if (pair) {
    await setScrollTop(page, Math.max(0, pair.top - 5));
    actual = await activeIndexes(page);
    check("M17 two visible questions are highlighted at once",
      actual.includes(pair.i) && actual.includes(pair.i + 1),
      `active=[${actual.join(", ")}] pair=[${pair.i}, ${pair.i + 1}]`);
  } else {
    check("M17 two visible questions are highlighted at once", false, "no consecutive user pair in fixture");
  }

  // Scrolling to the bottom moves the highlight set.
  const activeTop = await activeIndexes(page);
  await setScrollTop(page, 999999);
  const activeBottom = await activeIndexes(page);
  offs = await userOffsets(page, userIndexes);
  const bottomScroll = (await page.evaluate(() => window.__minimap.metrics())).scrollTop;
  const expectedBottom = expectedActive(offs, bottomScroll, cHeight);
  check("M18 scrolling changes the highlighted set and tracks the viewport",
    !sameArray(activeTop, activeBottom) && sameArray(activeBottom, expectedBottom),
    `top=[${activeTop.join(", ")}] bottom=[${activeBottom.join(", ")}] expected=[${expectedBottom.join(", ")}]`);

  // ---- Scenario 8: streaming growth rebuilds offsets without adding lines ----
  const countBefore = (await lineInfo(page)).length;
  await page.evaluate(() => window.__minimap.appendStream(2400));
  await sleep(260);
  const infoAfter = await lineInfo(page);
  const slotsAfter = await slotBoxes(page);
  const centersAfter = slotsAfter.map((s) => s.y + s.height / 2);
  const gapsAfter = centersAfter.slice(1).map((c, i) => c - centersAfter[i]);
  check("M19 streamed growth keeps the line count and uniform spacing",
    infoAfter.length === countBefore &&
      gapsAfter.length > 0 &&
      Math.max(...gapsAfter) - Math.min(...gapsAfter) <= 2,
    `lines=${infoAfter.length} (before ${countBefore}) gaps=[${gapsAfter.map((g) => g.toFixed(1)).join(", ")}]`);

  // ---- Scenario 9: light theme still renders with a theme token colour ----
  const darkColor = await page
    .locator('[data-minimap-line][data-msg-index-line="' + userIndexes[0] + '"]')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await sleep(150);
  const lightCount = (await lineInfo(page)).length;
  const lightColor = await page
    .locator('[data-minimap-line][data-msg-index-line="' + userIndexes[0] + '"]')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  check("M20 minimap renders in light theme with a theme token colour",
    lightCount === userCount && lightColor.length > 0 && lightColor !== darkColor,
    `lines=${lightCount} dark=${darkColor} light=${lightColor}`);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
}

async function runBulk(browser) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(`${HARNESS_URL}?mode=bulk`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__minimap));
  const userCount = await page.evaluate(() => window.__minimap.userCount);
  await page.waitForFunction(
    (n) => document.querySelectorAll("[data-minimap-line]").length === n,
    userCount,
  );
  const slots = await slotBoxes(page);
  const info = await lineInfo(page);
  const cbox = await containerBox(page);
  const slotH = slots[0]?.height ?? -1;
  const trackBox = await page.locator("[data-minimap-track]").boundingBox();
  const centers = slots.map((s) => s.y + s.height / 2);
  const gaps = centers.slice(1).map((c, i) => c - centers[i]);
  check("M21 many user questions still yield one line each", info.length === userCount,
    `lines=${info.length} users=${userCount}`);
  check("M22 slot height compresses below the preferred height",
    slotH > LINE_HEIGHT - 0.01 && slotH < SLOT_HEIGHT - 0.5,
    `slotHeight=${slotH.toFixed(2)}`);
  check("M23 compressed track does not overflow or clip",
    trackBox.y >= cbox.y - 1 && trackBox.y + trackBox.height <= cbox.y + cbox.height + 1 &&
      slots.every((s) => s.y >= cbox.y - 1 && s.y + s.height <= cbox.y + cbox.height + 1),
    `track=[${trackBox.y.toFixed(0)}, ${(trackBox.y + trackBox.height).toFixed(0)}] container=[${cbox.y.toFixed(0)}, ${(cbox.y + cbox.height).toFixed(0)}]`);
  check("M24 compressed lines stay evenly spaced",
    gaps.length > 0 && Math.max(...gaps) - Math.min(...gaps) <= 2,
    `gapMin=${Math.min(...gaps).toFixed(2)} gapMax=${Math.max(...gaps).toFixed(2)}`);
  await page.close();
}

async function runNarrow(browser) {
  const page = await browser.newPage({ viewport: { width: 600, height: 700 } });
  await page.goto(HARNESS_URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__minimap));
  await sleep(200);
  const visible = await page.locator("[data-minimap-line]").first().isVisible().catch(() => false);
  check("M25 minimap is hidden below md:", visible === false, `visible=${visible}`);
  await page.close();
}

let server;
let browser;
try {
  if (SPAWN_SERVER) {
    server = startServer();
  }
  await waitForServer(HARNESS_URL);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.on("pageerror", (e) => log(`[pageerror] ${e.message}`));
  await page.goto(HARNESS_URL, { waitUntil: "networkidle" });
  await run(page);
  await runBulk(browser);
  await runNarrow(browser);

  await browser.close();
  browser = undefined;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill("SIGTERM");
}

const failed = results.filter((r) => !r.ok);
log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
