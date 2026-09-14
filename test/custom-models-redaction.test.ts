import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, describe, it } from "node:test";

const testAgentDir = mkdtempSync(join(tmpdir(), "pi-custom-models-test-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const {
  readCustomModels,
  writeCustomModels,
  sanitizeCustomModelsResponse,
} = await import("../server/models-config.ts");
const { handleModelsRoutes } = await import("../server/http/routes-models.ts");
import type { ServerContext } from "../server/http/context.ts";
import type { UICustomProvider } from "../shared/protocol.ts";

after(() => {
  rmSync(testAgentDir, { recursive: true, force: true });
});

function provider(overrides: Partial<UICustomProvider> = {}): UICustomProvider {
  return {
    key: "acme",
    baseUrl: "https://api.acme.test/v1",
    api: "openai-completions",
    apiKey: "sk-secret-value",
    models: [{ id: "acme-large" }],
    ...overrides,
  };
}

interface Captured {
  status?: number;
  headers?: Record<string, string>;
  body: string;
}

function createRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { body: "" };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      if (headers) captured.headers = headers;
      return res;
    },
    end(body?: string) {
      if (body) captured.body = body;
      return res;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

function makeReq(method: string, body?: string): IncomingMessage {
  const req = body ? Readable.from([Buffer.from(body)]) : Readable.from([]);
  (req as any).method = method;
  (req as any).headers = {};
  return req as unknown as IncomingMessage;
}

describe("sanitizeCustomModelsResponse", () => {
  it("drops apiKey and reports hasApiKey per provider", () => {
    const input = {
      path: "~/.pi/models.json",
      providers: [
        provider({ key: "with-key", apiKey: "sk-abc" }),
        provider({ key: "no-key", apiKey: undefined }),
        provider({ key: "blank-key", apiKey: "   " }),
      ],
    };
    const out = sanitizeCustomModelsResponse(input);
    assert.equal(JSON.stringify(out).includes("sk-abc"), false);
    assert.equal(out.providers[0]?.apiKey, undefined);
    assert.equal(out.providers[0]?.hasApiKey, true);
    assert.equal(out.providers[1]?.hasApiKey, false);
    assert.equal(out.providers[2]?.hasApiKey, false);
  });
});

describe("writeCustomModels key preservation", () => {
  it("keeps the stored key when a later write omits apiKey", () => {
    writeCustomModels([provider({ apiKey: "sk-original" })]);
    assert.equal(readCustomModels().providers[0]?.apiKey, "sk-original");

    // Simulate the edit form re-submitting with a redacted (empty) key.
    writeCustomModels([provider({ apiKey: "" })]);
    assert.equal(
      readCustomModels().providers[0]?.apiKey,
      "sk-original",
      "empty apiKey on update must preserve the existing secret",
    );

    // A non-empty key still overwrites.
    writeCustomModels([provider({ apiKey: "sk-rotated" })]);
    assert.equal(readCustomModels().providers[0]?.apiKey, "sk-rotated");
  });
});

function makeCtx(reloadSpy: (p: UICustomProvider[]) => void): ServerContext {
  return {
    reloadModelProviders: async (providers: UICustomProvider[]) => {
      reloadSpy(providers);
      return undefined;
    },
  } as unknown as ServerContext;
}

describe("GET/PUT /api/custom-models over the route handler", () => {
  it("GET never returns plaintext apiKey but exposes hasApiKey", async () => {
    writeCustomModels([provider({ key: "acme", apiKey: "sk-live-123" })]);
    const { res, captured } = createRes();
    const handled = await handleModelsRoutes(
      new URL("http://localhost/api/custom-models"),
      makeReq("GET"),
      res,
      makeCtx(() => {}),
    );
    assert.equal(handled, true);
    assert.equal(captured.status, 200);
    assert.equal(captured.body.includes("sk-live-123"), false);
    const parsed = JSON.parse(captured.body) as { providers: UICustomProvider[] };
    const acme = parsed.providers.find((p) => p.key === "acme");
    assert.ok(acme);
    assert.equal(acme?.apiKey, undefined);
    assert.equal(acme?.hasApiKey, true);
  });

  it("PUT without a key preserves the stored key and reloads with the real key", async () => {
    writeCustomModels([provider({ key: "acme", apiKey: "sk-persisted" })]);

    let reloaded: UICustomProvider[] = [];
    const body = JSON.stringify({
      providers: [provider({ key: "acme", apiKey: "" })],
    });
    const { res, captured } = createRes();
    const handled = await handleModelsRoutes(
      new URL("http://localhost/api/custom-models"),
      makeReq("PUT", body),
      res,
      makeCtx((p) => {
        reloaded = p;
      }),
    );
    assert.equal(handled, true);
    assert.equal(captured.status, 200);
    // Response is redacted.
    assert.equal(captured.body.includes("sk-persisted"), false);
    const parsed = JSON.parse(captured.body) as { providers: UICustomProvider[] };
    assert.equal(parsed.providers[0]?.hasApiKey, true);
    // Stored secret is intact.
    assert.equal(readCustomModels().providers[0]?.apiKey, "sk-persisted");
    // Runtime reload received the real key, not the empty submitted one.
    assert.equal(reloaded[0]?.apiKey, "sk-persisted");
  });
});
