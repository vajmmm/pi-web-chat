import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const testAgentDir = mkdtempSync(join(tmpdir(), "pi-model-reload-test-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

import { handleHttpRequest, type ServerContext } from "../server/http/index.ts";
import { SessionRegistry } from "../server/session/index.ts";
import { SubagentManager } from "../server/subagent-manager.ts";

describe("Phase 8.1 Regression: ServerContext ModelRuntime dynamic reload", () => {
  after(() => {
    try {
      rmSync(testAgentDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("should always query the newest ModelRuntime after updateModelRuntime is called", async () => {
    // 1. 模拟初始 ModelRuntime，提供 model-alpha
    const initialRuntime = {
      getAvailable: async () => [
        { provider: "mock-prov", id: "model-alpha", name: "Model Alpha", reasoning: false },
      ],
      getProviders: () => [],
      hasConfiguredAuth: () => false,
      getProviderAuthStatus: () => ({ configured: false, source: "none" }),
      getProvider: () => null,
      getModel: () => null,
    } as any;

    let currentModelRuntime = initialRuntime;
    const sessionRegistry = new SessionRegistry();
    const subagentManager = new SubagentManager(initialRuntime);

    const ctx: ServerContext = {
      sessionRegistry,
      subagentManager,
      getModelRuntime: () => currentModelRuntime,
      get modelRuntime() {
        return currentModelRuntime;
      },
      homeDir: tmpdir(),
      agentCwd: tmpdir(),
      distDir: tmpdir(),
      packageVersion: "0.1.19-test",
      createRuntime: async () => ({} as any),
      reloadModelProviders: async () => undefined,
      updateModelRuntime: (newRuntime) => {
        currentModelRuntime = newRuntime;
      },
    };

    // 2. 启动真实 HTTP 服务
    const server = createServer(async (req, res) => {
      await handleHttpRequest(req, res, ctx);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 3. 第一次请求 /api/models：确认读取到初始 ModelRuntime
      const res1 = await fetch(`${baseUrl}/api/models`);
      assert.equal(res1.status, 200);
      const data1 = (await res1.json()) as Array<{ provider: string; id: string; name: string }>;
      assert.equal(data1.length, 1);
      assert.equal(data1[0]?.id, "model-alpha");

      // 4. 触发 Runtime reload / updateModelRuntime：切换到 model-beta
      const updatedRuntime = {
        getAvailable: async () => [
          { provider: "mock-prov", id: "model-beta", name: "Model Beta", reasoning: true },
        ],
        getProviders: () => [],
        hasConfiguredAuth: () => false,
        getProviderAuthStatus: () => ({ configured: false, source: "none" }),
        getProvider: () => null,
        getModel: () => null,
      } as any;

      ctx.updateModelRuntime(updatedRuntime);
      subagentManager.updateModelRuntime(updatedRuntime);

      // 验证 getter 返回的是新实例，而不是 stale reference
      assert.strictEqual(ctx.getModelRuntime(), updatedRuntime);
      assert.strictEqual(ctx.modelRuntime, updatedRuntime);

      // 5. 第二次请求 /api/models：必须读取到更新后的 ModelRuntime (model-beta)
      const res2 = await fetch(`${baseUrl}/api/models`);
      assert.equal(res2.status, 200);
      const data2 = (await res2.json()) as Array<{ provider: string; id: string; name: string }>;
      assert.equal(data2.length, 1);
      assert.equal(data2[0]?.id, "model-beta");
      assert.equal(data2[0]?.name, "Model Beta");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
