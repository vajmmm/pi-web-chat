import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { handleHttpRequest } from "../server/http/router.ts";
import type { ServerContext } from "../server/http/context.ts";

let distDir: string;
const INDEX_HTML = "<!doctype html><html><body>index</body></html>\n";

before(() => {
  distDir = mkdtempSync(join(tmpdir(), "pi-origin-guard-test-"));
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.html"), INDEX_HTML);
});

after(() => {
  rmSync(distDir, { recursive: true, force: true });
});

function ctx(): ServerContext {
  // Minimal fields the route handlers touch before falling through to static.
  return {
    distDir,
    sessionRegistry: { entries: new Map() },
    homeDir: tmpdir(),
    packageVersion: "test",
  } as unknown as ServerContext;
}

interface Captured {
  status?: number;
  body: string;
}

function createRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { body: "" };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    setHeader() {
      return res;
    },
    end(body?: Buffer | string) {
      if (body) captured.body = Buffer.isBuffer(body) ? body.toString("utf8") : body;
      return res;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

function makeReq(
  method: string,
  headers: Record<string, string>,
  body?: string,
): IncomingMessage {
  const req = body ? Readable.from([Buffer.from(body)]) : Readable.from([]);
  (req as any).method = method;
  (req as any).headers = headers;
  return req as unknown as IncomingMessage;
}

async function run(
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Captured> {
  const { res, captured } = createRes();
  await handleHttpRequest(makeReq(method, headers, body), res, ctx());
  return captured;
}

describe("handleHttpRequest CSWSH guard (state-changing methods)", () => {
  it("rejects a cross-site Origin on POST with 403", async () => {
    const r = await run("/api/custom-models", "POST", {
      host: "localhost:3141",
      origin: "https://evil.com",
    }, "{}");
    assert.equal(r.status, 403);
    assert.match(r.body, /forbidden origin/);
  });

  it("rejects a cross-site Origin on PUT with 403", async () => {
    const r = await run("/api/custom-models", "PUT", {
      host: "127.0.0.1:3141",
      origin: "http://attacker.example.com",
    }, "{}");
    assert.equal(r.status, 403);
  });

  it("does not require an Origin (CLI/curl) for state-changing requests", async () => {
    const r = await run("/api/__unknown", "POST", { host: "localhost:3141" }, "{}");
    assert.notEqual(r.status, 403);
  });

  it("allows a same-host Origin on a different port (vite dev :5173)", async () => {
    const r = await run("/api/__unknown", "POST", {
      host: "localhost:3141",
      origin: "http://localhost:5173",
    }, "{}");
    assert.notEqual(r.status, 403);
  });
});

describe("handleHttpRequest DNS-rebinding guard (Host header)", () => {
  it("rejects an untrusted Host on GET with 403", async () => {
    const r = await run("/", "GET", { host: "attacker.com" });
    assert.equal(r.status, 403);
    assert.match(r.body, /forbidden host/);
  });

  it("allows a normal GET page load (Host: localhost) — static not broken", async () => {
    const r = await run("/", "GET", { host: "localhost:3141" });
    assert.equal(r.status, 200);
    assert.equal(r.body, INDEX_HTML);
  });

  it("does not require an Origin on GET page loads", async () => {
    const r = await run("/", "GET", { host: "127.0.0.1:3141" });
    assert.equal(r.status, 200);
  });
});
