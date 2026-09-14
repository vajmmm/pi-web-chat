import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { handleStaticRoutes } from "../server/http/routes-static.ts";

const JS_BODY = `console.log('${"x".repeat(4000)}');\n`;
const CSS_BODY = `body{${"color:red;".repeat(800)}}\n`;
const HTML_BODY = "<!doctype html><html><body>index</body></html>\n";
const SW_BODY = "self.addEventListener('install', () => {});\n";
const MANIFEST_BODY = JSON.stringify({ name: "pi", start_url: "/" });
const PNG_BODY = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05,
]);

const HASHED_JS = "/assets/index-CnrhRkCg.js";
const HASHED_CSS = "/assets/index-xOag2R8j.css";

let distDir: string;

before(() => {
  distDir = mkdtempSync(join(tmpdir(), "pi-static-test-"));
  mkdirSync(join(distDir, "assets"), { recursive: true });
  writeFileSync(join(distDir, "assets", "index-CnrhRkCg.js"), JS_BODY);
  writeFileSync(join(distDir, "assets", "index-xOag2R8j.css"), CSS_BODY);
  writeFileSync(join(distDir, "index.html"), HTML_BODY);
  writeFileSync(join(distDir, "sw.js"), SW_BODY);
  writeFileSync(join(distDir, "manifest.webmanifest"), MANIFEST_BODY);
  writeFileSync(join(distDir, "logo.png"), PNG_BODY);
});

after(() => {
  rmSync(distDir, { recursive: true, force: true });
});

interface CapturedResponse {
  status?: number;
  headers?: Record<string, string>;
  body: Buffer;
}

function createRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { body: Buffer.alloc(0) };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
      return res;
    },
    end(body?: Buffer | string) {
      captured.body = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
      return res;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function serve(
  pathname: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<CapturedResponse & { handled: boolean }> {
  const { res, captured } = createRes();
  const req = { method, headers } as unknown as IncomingMessage;
  const handled = await handleStaticRoutes(new URL(pathname, "http://localhost"), req, res, distDir);
  return { ...captured, handled };
}

describe("handleStaticRoutes compression", () => {
  it("serves gzip with Content-Encoding + Vary and identical decoded bytes", async () => {
    const r = await serve(HASHED_JS, { "accept-encoding": "gzip" });
    assert.equal(r.handled, true);
    assert.equal(r.status, 200);
    assert.equal(r.headers?.["content-encoding"], "gzip");
    assert.equal(r.headers?.vary, "Accept-Encoding");
    assert.equal(gunzipSync(r.body).toString("utf8"), JS_BODY);
  });

  it("serves brotli when the client prefers it", async () => {
    const r = await serve(HASHED_CSS, { "accept-encoding": "br" });
    assert.equal(r.status, 200);
    assert.equal(r.headers?.["content-encoding"], "br");
    assert.equal(brotliDecompressSync(r.body).toString("utf8"), CSS_BODY);
  });

  it("falls back to identity with byte-identical body when compression is unsupported", async () => {
    const r = await serve(HASHED_JS, { "accept-encoding": "deflate" });
    assert.equal(r.status, 200);
    assert.equal(r.headers?.["content-encoding"], undefined);
    assert.equal(r.headers?.["content-length"], String(Buffer.byteLength(JS_BODY)));
    assert.equal(r.body.equals(Buffer.from(JS_BODY)), true);
  });

  it("does not compress already-compressed binaries", async () => {
    const r = await serve("/logo.png", { "accept-encoding": "gzip, br" });
    assert.equal(r.status, 200);
    assert.equal(r.headers?.["content-encoding"], undefined);
    assert.equal(r.body.equals(PNG_BODY), true);
  });

  it("reuses the cached compressed representation across requests (no per-request recompression)", async () => {
    const first = await serve(HASHED_JS, { "accept-encoding": "gzip" });
    const second = await serve(HASHED_JS, { "accept-encoding": "gzip" });
    assert.equal(first.body, second.body, "the same cached gzip Buffer must be reused");
  });
});

describe("handleStaticRoutes caching", () => {
  it("marks content-hashed assets immutable", async () => {
    const js = await serve(HASHED_JS);
    const css = await serve(HASHED_CSS);
    assert.equal(js.headers?.["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(css.headers?.["cache-control"], "public, max-age=31536000, immutable");
  });

  it("requires revalidation for non-hashed entry files", async () => {
    for (const path of ["/index.html", "/sw.js", "/manifest.webmanifest"]) {
      const r = await serve(path);
      assert.equal(
        r.headers?.["cache-control"],
        "no-cache, must-revalidate",
        `${path} must be revalidated, got ${r.headers?.["cache-control"]}`,
      );
      assert.equal((r.headers?.["cache-control"] ?? "").includes("immutable"), false);
    }
  });
});

describe("handleStaticRoutes conditional requests", () => {
  it("returns 304 with no body on ETag match", async () => {
    const first = await serve(HASHED_JS, { "accept-encoding": "gzip" });
    const etag = first.headers?.etag;
    assert.ok(etag, "ETag header must be present");

    const second = await serve(HASHED_JS, { "accept-encoding": "gzip", "if-none-match": etag! });
    assert.equal(second.status, 304);
    assert.equal(second.body.length, 0);
    assert.equal(second.headers?.etag, etag);
    assert.equal(second.headers?.vary, "Accept-Encoding");
  });

  it("returns 304 on If-Modified-Since match", async () => {
    const first = await serve("/index.html");
    const lastModified = first.headers?.["last-modified"];
    assert.ok(lastModified, "Last-Modified header must be present");

    const second = await serve("/index.html", { "if-modified-since": lastModified! });
    assert.equal(second.status, 304);
    assert.equal(second.body.length, 0);
  });
});

describe("handleStaticRoutes content + fallback", () => {
  it("keeps MIME types and SPA fallback behavior", async () => {
    const css = await serve(HASHED_CSS);
    assert.equal(css.headers?.["content-type"], "text/css");

    const fallback = await serve("/deep/unknown/route");
    assert.equal(fallback.status, 200);
    assert.equal(fallback.headers?.["content-type"], "text/html");
    assert.equal(fallback.body.toString("utf8"), HTML_BODY);
  });

  it("omits the body for HEAD but reports content-length", async () => {
    const r = await serve(HASHED_JS, {}, "HEAD");
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 0);
    assert.equal(r.headers?.["content-length"], String(Buffer.byteLength(JS_BODY)));
  });

  it("returns false when the dist directory does not exist", async () => {
    const { res } = createRes();
    const req = { method: "GET", headers: {} } as unknown as IncomingMessage;
    const handled = await handleStaticRoutes(
      new URL("/", "http://localhost"),
      req,
      res,
      join(distDir, "does-not-exist"),
    );
    assert.equal(handled, false);
  });
});
