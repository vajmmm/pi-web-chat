import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const testAgentDir = mkdtempSync(join(tmpdir(), "pi-model-catalog-test-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

import { handleHttpRequest, type ServerContext } from "../server/http/index.ts";
import { SessionRegistry } from "../server/session/index.ts";
import { SubagentManager } from "../server/subagent-manager.ts";

interface RecordedRefreshOptions {
  allowNetwork?: boolean;
  force?: boolean;
  signal?: AbortSignal;
}

interface MockModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

type RefreshResult = { aborted: boolean; errors: ReadonlyMap<string, Error> };

function makeModelRuntimeMock(
  initialModels: MockModel[],
  onRefresh?: (opts: RecordedRefreshOptions) => Promise<RefreshResult>,
) {
  let available = initialModels;
  const calls: RecordedRefreshOptions[] = [];
  const mock = {
    runtime: {
      getAvailable: async () => available,
      getProviders: () => [],
      hasConfiguredAuth: () => false,
      getProviderAuthStatus: () => ({ configured: false, source: "none" }),
      getProvider: () => null,
      getModel: () => null,
      refresh: async (opts: RecordedRefreshOptions = {}): Promise<RefreshResult> => {
        calls.push(opts);
        if (onRefresh) return onRefresh(opts);
        return { aborted: false, errors: new Map<string, Error>() };
      },
    } as any,
    calls,
    setAvailable(next: MockModel[]) {
      available = next;
    },
  };
  return mock;
}

// distDir must not exist: an existing dir without index.html trips the SPA fallback
// (writeHead then throw) and leaves the response hanging on unmatched routes.
const MISSING_DIST_DIR = join(tmpdir(), "pi-model-catalog-test-no-such-dist");

function makeCtx(runtime: any, extra: Partial<ServerContext> = {}): ServerContext {
  let currentModelRuntime = runtime;
  return {
    sessionRegistry: new SessionRegistry(),
    subagentManager: new SubagentManager(runtime),
    getModelRuntime: () => currentModelRuntime,
    homeDir: tmpdir(),
    agentCwd: tmpdir(),
    distDir: MISSING_DIST_DIR,
    packageVersion: "0.1.19-test",
    createRuntime: async () => ({} as any),
    reloadModelProviders: async () => undefined,
    updateModelRuntime: (newRuntime) => {
      currentModelRuntime = newRuntime;
    },
    ...extra,
  };
}

async function withServer(ctx: ServerContext, fn: (baseUrl: string) => Promise<void>) {
  const server = createServer(async (req, res) => {
    await handleHttpRequest(req, res, ctx);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn(baseUrl);
  } finally {
    server.closeIdleConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const ALPHA: MockModel[] = [
  { provider: "mock-prov", id: "model-alpha", name: "Model Alpha", reasoning: false },
];

describe("Model catalog refresh (standalone web catalog)", () => {
  after(() => {
    try {
      rmSync(testAgentDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("GET /api/models triggers a non-force allowNetwork refresh and returns refreshed models", async () => {
    const mock = makeModelRuntimeMock(ALPHA, () => {
      // Catalog lands between refresh and list collection.
      mock.setAvailable([
        { provider: "mock-prov", id: "model-beta", name: "Model Beta", reasoning: true },
      ]);
      return { aborted: false, errors: new Map<string, Error>() };
    });

    await withServer(makeCtx(mock.runtime), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/models`);
      assert.equal(res.status, 200);
      assert.equal(mock.calls.length, 1, "GET /api/models must refresh the live runtime catalog");
      assert.equal(mock.calls[0]?.allowNetwork, true);
      assert.notEqual(mock.calls[0]?.force, true, "GET must not force-bypass provider freshness");
      const data = (await res.json()) as MockModel[];
      assert.equal(data.length, 1);
      assert.equal(data[0]?.id, "model-beta");
    });
  });

  it("keeps AGY models out of the main catalog but exposes them to role scope", async () => {
    const mock = makeModelRuntimeMock([
      ...ALPHA,
      { provider: "agy", id: "gemini-test", name: "Gemini test", reasoning: true },
    ]);

    await withServer(makeCtx(mock.runtime), async (baseUrl) => {
      const mainResponse = await fetch(`${baseUrl}/api/models`);
      assert.equal(mainResponse.status, 200);
      const mainModels = (await mainResponse.json()) as MockModel[];
      assert.equal(mainModels.some((model) => model.provider === "agy"), false);

      const refreshResponse = await fetch(`${baseUrl}/api/models/refresh`, { method: "POST" });
      assert.equal(refreshResponse.status, 200);
      const refreshedModels = (await refreshResponse.json()) as MockModel[];
      assert.equal(refreshedModels.some((model) => model.provider === "agy"), false);

      const roleResponse = await fetch(`${baseUrl}/api/models?scope=role`);
      assert.equal(roleResponse.status, 200);
      const roleModels = (await roleResponse.json()) as MockModel[];
      assert.equal(roleModels.some((model) => model.provider === "agy"), true);
      assert.equal(roleModels.some((model) => model.provider === "mock-prov"), true);
    });
  });

  it("POST /api/models/refresh forces a network refresh and returns the same list shape as GET", async () => {
    const mock = makeModelRuntimeMock(ALPHA);

    await withServer(makeCtx(mock.runtime), async (baseUrl) => {
      const getRes = await fetch(`${baseUrl}/api/models`);
      assert.equal(getRes.status, 200);
      const getList = await getRes.json();
      mock.calls.length = 0;

      const res = await fetch(`${baseUrl}/api/models/refresh`, { method: "POST" });
      assert.equal(res.status, 200);
      assert.equal(mock.calls.length, 1, "force endpoint must refresh the live runtime catalog");
      assert.equal(mock.calls[0]?.force, true);
      assert.equal(mock.calls[0]?.allowNetwork, true);
      const list = await res.json();
      assert.deepStrictEqual(list, getList, "force endpoint must return the GET list shape");
    });
  });

  it("GET /api/models fails open when the catalog refresh rejects", async () => {
    const mock = makeModelRuntimeMock(ALPHA, async () => {
      throw new Error("network down");
    });

    await withServer(makeCtx(mock.runtime), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/models`);
      assert.equal(res.status, 200);
      assert.equal(mock.calls.length, 1);
      const data = (await res.json()) as MockModel[];
      assert.equal(data.length, 1);
      assert.equal(data[0]?.id, "model-alpha", "cached models must still be served");
    });
  });

  it("GET /api/models fails open when the catalog refresh times out", async () => {
    const mock = makeModelRuntimeMock(ALPHA, (opts) => {
      // Simulate a provider refresh that only settles when the deadline aborts it.
      return new Promise<RefreshResult>((resolve) => {
        opts.signal?.addEventListener("abort", () => {
          resolve({ aborted: true, errors: new Map<string, Error>() });
        });
      });
    });

    await withServer(
      makeCtx(mock.runtime, { modelCatalogRefreshTimeoutMs: 50 }),
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/models`);
        assert.equal(res.status, 200);
        assert.equal(mock.calls.length, 1);
        assert.ok(mock.calls[0]?.signal instanceof AbortSignal, "refresh must be bounded");
        const data = (await res.json()) as MockModel[];
        assert.equal(data.length, 1);
        assert.equal(data[0]?.id, "model-alpha", "cached models must still be served");
      },
    );
  });

  it("POST /api/models/refresh fails open when the force refresh rejects", async () => {
    const mock = makeModelRuntimeMock(ALPHA, async () => {
      throw new Error("network down");
    });

    await withServer(makeCtx(mock.runtime), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/models/refresh`, { method: "POST" });
      assert.equal(res.status, 200);
      assert.equal(mock.calls.length, 1);
      assert.equal(mock.calls[0]?.force, true);
      const data = (await res.json()) as MockModel[];
      assert.equal(data.length, 1);
      assert.equal(data[0]?.id, "model-alpha", "cached models must still be served");
    });
  });

  it("startup background refresh kicks off without blocking the caller", async () => {
    const mod = (await import("../server/model-catalog.ts")) as {
      startBackgroundCatalogRefresh: (
        runtime: unknown,
        timeoutMs?: number,
      ) => Promise<{ completed: boolean; aborted: boolean }>;
    };

    let resolveRefresh!: (value: RefreshResult) => void;
    const refreshSettled = new Promise<RefreshResult>((resolve) => {
      resolveRefresh = resolve;
    });
    const mock = makeModelRuntimeMock(ALPHA, () => refreshSettled);

    let settled = false;
    const pending = mod.startBackgroundCatalogRefresh(mock.runtime, 60_000).then((outcome) => {
      settled = true;
      return outcome;
    });

    // The refresh must already be in flight while the caller (startup) continues.
    assert.equal(mock.calls.length, 1, "background refresh must kick off immediately");
    assert.equal(mock.calls[0]?.allowNetwork, true);
    assert.notEqual(mock.calls[0]?.force, true, "startup refresh must respect freshness throttle");
    assert.equal(settled, false, "startup must not block on the refresh settling");

    resolveRefresh({ aborted: false, errors: new Map<string, Error>() });
    const outcome = await pending;
    assert.equal(outcome.completed, true);
    assert.equal(outcome.aborted, false);
  });
});
