import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

const PRODUCT_DESIGN_MARKER = "<product-design-dynamic-diagnostic>";

function countMarker(prompt: unknown): number {
  return typeof prompt === "string"
    ? prompt.split(PRODUCT_DESIGN_MARKER).length - 1
    : 0;
}

function createDynamicPromptProbe(codexModelId: string): InlineExtension {
  return {
    name: "main-session-system-prompt-diagnostic",
    factory: (pi: ExtensionAPI) => {
      pi.on("before_agent_start", (event, ctx) => {
        const base = (event.systemPrompt ?? "").split(PRODUCT_DESIGN_MARKER).join("").trimEnd();
        const enabled = ctx.model?.id === codexModelId;
        return {
          systemPrompt: enabled ? `${base}\n${PRODUCT_DESIGN_MARKER}` : base,
        };
      });
    },
  };
}

function createModelConfig(id: string) {
  return {
    id,
    name: id,
    api: "openai-completions" as const,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

describe("Main Session dynamic system prompt diagnostic", () => {
  it("rebuilds the final provider-bound prompt after every model switch without marker accumulation", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-main-session-system-prompt-"));
    const agentDir = join(root, "agent");
    const projectDir = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    const codexModelId = "codex-diagnostic";
    const minimaxModelId = "minimax-diagnostic";
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider("diagnostic", {
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "diagnostic-key",
      models: [createModelConfig(codexModelId), createModelConfig(minimaxModelId)],
    });

    const codexModel = modelRuntime.getModel("diagnostic", codexModelId);
    const minimaxModel = modelRuntime.getModel("diagnostic", minimaxModelId);
    assert.ok(codexModel);
    assert.ok(minimaxModel);

    const services = await createAgentSessionServices({
      cwd: projectDir,
      agentDir,
      modelRuntime,
      resourceLoaderOptions: {
        noSkills: true,
        extensionFactories: [createDynamicPromptProbe(codexModelId)],
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(projectDir),
      model: codexModel,
    });

    const providerPrompts: string[] = [];
    session.agent.streamFunction = async (model: any, context: any) => {
      providerPrompts.push(context.systemPrompt);
      const finalMessage = {
        role: "assistant",
        content: [{ type: "text", text: "diagnostic complete" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      return {
        async *[Symbol.asyncIterator]() {},
        result: async () => finalMessage,
      } as any;
    };

    try {
      await session.prompt("turn 1");
      await session.setModel(minimaxModel, { persist: false });
      await session.prompt("turn 2");
      await session.setModel(codexModel, { persist: false });
      await session.prompt("turn 3");

      assert.equal(providerPrompts.length, 3);
      assert.equal(countMarker(providerPrompts[0]), 1, "Codex turn must include one marker");
      assert.equal(countMarker(providerPrompts[1]), 0, "MiniMax turn must remove the marker");
      assert.equal(countMarker(providerPrompts[2]), 1, "Codex turn must restore one marker");
      assert.ok(providerPrompts.every((prompt) => countMarker(prompt) <= 1));
    } finally {
      await session.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
