import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConstraintResolver, getRoleConfig } from "../server/contracts/index.ts";
import { applyRoleToSession } from "../server/session/role-binding.ts";
import { createSubagentSessionRuntime } from "../server/subagent/agent-runtime.ts";
import {
  filterCapabilityGatedTools,
  getMainSessionCapabilities,
} from "../server/session/capabilities.ts";

const disabled = {
  productDesign: false,
  imageInput: false,
  imageGeneration: false,
  webSearch: false,
};

function bindRole(role: "coordinator" | "researcher", model: { provider: string; id: string }) {
  let activeTools: string[] = [];
  const session = {
    model,
    agent: { state: { systemPrompt: "" } },
    setActiveToolsByName(tools: string[]) {
      activeTools = [...tools];
    },
  };
  applyRoleToSession({
    runtime: { session },
    activeRole: role,
    cwd: process.cwd(),
    isGitRepo: false,
    clients: new Set(),
    lastActive: Date.now(),
    published: true,
    queuedMessages: [],
  } as any, role);
  return { activeTools, systemPrompt: session.agent.state.systemPrompt };
}

describe("web_search model capability gate", () => {
  it("中央 registry 对 Codex/Grok 开启，其它及未知模型 fail-closed", () => {
    assert.equal(getMainSessionCapabilities({ provider: "openai-codex", id: "gpt-5.5" }).webSearch, true);
    assert.equal(getMainSessionCapabilities({ provider: "xai", id: "grok-4" }).webSearch, true);
    assert.deepEqual(getMainSessionCapabilities({ provider: "minimax", id: "MiniMax-M2" }), disabled);
    assert.deepEqual(getMainSessionCapabilities({ provider: "deepseek", id: "deepseek-chat" }), disabled);
    assert.deepEqual(getMainSessionCapabilities({ provider: "unknown", id: "unknown-model" }), disabled);
  });

  it("RoleConfig 保留 web_search，但最终 active tools 由 capability 过滤", () => {
    assert.equal(getRoleConfig("coordinator").allowedTools?.includes("web_search"), true);
    assert.equal(getRoleConfig("researcher").allowedTools?.includes("web_search"), true);
    assert.equal(
      filterCapabilityGatedTools(["read", "web_search"], getMainSessionCapabilities({ provider: "openai-codex", id: "gpt-5.5" })).includes("web_search"),
      true,
    );
    assert.equal(
      filterCapabilityGatedTools(["read", "web_search"], getMainSessionCapabilities({ provider: "minimax", id: "MiniMax-M2" })).includes("web_search"),
      false,
    );
  });

  it("Coordinator / Researcher 均按当前模型暴露 web_search", () => {
    for (const role of ["coordinator", "researcher"] as const) {
      const codex = bindRole(role, { provider: "openai-codex", id: "gpt-5.5" });
      const grok = bindRole(role, { provider: "xai", id: "grok-4" });
      const minimax = bindRole(role, { provider: "minimax", id: "MiniMax-M2" });
      const unknown = bindRole(role, { provider: "unknown", id: "unknown-model" });
      assert.equal(codex.activeTools.includes("web_search"), true);
      assert.equal(grok.activeTools.includes("web_search"), true);
      assert.equal(minimax.activeTools.includes("web_search"), false);
      assert.equal(unknown.activeTools.includes("web_search"), false);
      assert.match(codex.systemPrompt, /web_search/);
      assert.match(grok.systemPrompt, /web_search/);
      assert.doesNotMatch(minimax.systemPrompt, /web_search/);
      assert.doesNotMatch(unknown.systemPrompt, /web_search/);
    }
  });

  it("Subagent active tools 使用其实际 runtime model 的 capability", async () => {
    const getActiveTools = async (provider: string) => {
      let activeTools: string[] = [];
      const model = { provider, id: "runtime-model" };
      const session: any = {
        model: { provider: "bootstrap", id: "bootstrap-model" },
        setModel(nextModel: any) {
          this.model = nextModel;
        },
        setActiveToolsByName(tools: string[]) {
          activeTools = [...tools];
        },
      };
      const effectiveContext = ConstraintResolver.resolve({
        role: "researcher",
        cwd: process.cwd(),
        executionOptions: { model: { provider, modelId: model.id } },
      });
      const created = await createSubagentSessionRuntime({
        taskId: `web-search-${provider}`,
        role: "researcher",
        effectiveCwd: process.cwd(),
        effectiveContext,
        modelRuntime: { getModel: () => model } as any,
        customSession: session,
      });
      await created.runtime.dispose();
      return activeTools;
    };

    assert.equal((await getActiveTools("xai")).includes("web_search"), true);
    assert.equal((await getActiveTools("minimax")).includes("web_search"), false);
  });

  it("模型切换后 active tools 与最终 Prompt 同步恢复/撤销", () => {
    const sessionState = {
      model: { provider: "openai-codex", id: "gpt-5.5" },
      agent: { state: { systemPrompt: "" } },
      activeTools: [] as string[],
      setActiveToolsByName(tools: string[]) {
        this.activeTools = [...tools];
      },
    };
    const entry = {
      runtime: { session: sessionState },
      activeRole: "coordinator",
      cwd: process.cwd(),
      isGitRepo: false,
      clients: new Set(),
      lastActive: Date.now(),
      published: true,
      queuedMessages: [],
    } as any;

    applyRoleToSession(entry, "coordinator");
    assert.equal(sessionState.activeTools.includes("web_search"), true);
    assert.match(sessionState.agent.state.systemPrompt, /web_search/);

    sessionState.model = { provider: "minimax", id: "MiniMax-M2" };
    applyRoleToSession(entry, "coordinator");
    assert.equal(sessionState.activeTools.includes("web_search"), false);
    assert.doesNotMatch(sessionState.agent.state.systemPrompt, /web_search/);

    sessionState.model = { provider: "openai-codex", id: "gpt-5.5" };
    applyRoleToSession(entry, "coordinator");
    assert.equal(sessionState.activeTools.includes("web_search"), true);
    assert.match(sessionState.agent.state.systemPrompt, /web_search/);
  });

  it("Researcher capability gate 不影响其默认 resolver 角色工具权限", () => {
    const context = ConstraintResolver.resolve({ role: "researcher", cwd: process.cwd() });
    assert.equal(context.runtime.activeTools.includes("web_search"), true);
  });
});
