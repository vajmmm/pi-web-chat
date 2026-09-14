import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createCoordinatorExtension } from "../server/coordinator-tools.ts";
import { getRoleConfig, RoleRegistry } from "../server/contracts/roles.ts";
import { createProductDesignExtension } from "../server/product-design-extension.ts";
import { applyRoleToSession } from "../server/session/role-binding.ts";
import { SubagentManager } from "../server/subagent-manager.ts";
import {
  getMainSessionCapabilities,
  PRODUCT_DESIGN_IMAGEGEN_TOOL_NAME,
  PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME,
  PRODUCT_DESIGN_SKILL_NAME,
  registerMainModelCapabilityBinding,
  unregisterMainModelCapabilityBinding,
} from "../server/session/capabilities.ts";

const PRODUCT_DESIGN_MARKER = `\"name\": \"${PRODUCT_DESIGN_SKILL_NAME}\"`;

function countMarker(prompt: string): number {
  return prompt.split(PRODUCT_DESIGN_MARKER).length - 1;
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

describe("Product Design dynamic final System Prompt gate", () => {
  it("在同一 Main Session 中随模型切换恢复/撤销且不会累积 Skill marker", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-product-design-prompt-gate-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const bindingId = "test-product-design-minimax-disabled";
    let session: any;

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const coordinator = structuredClone(getRoleConfig("coordinator"));
      coordinator.allowedSkills = [PRODUCT_DESIGN_SKILL_NAME];
      coordinator.definition.allowedSkills = [PRODUCT_DESIGN_SKILL_NAME];
      coordinator.allowedTools = [
        ...(coordinator.allowedTools ?? []),
        PRODUCT_DESIGN_IMAGEGEN_TOOL_NAME,
        PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME,
      ];
      writeFileSync(join(agentDir, "roles.json"), JSON.stringify([coordinator], null, 2), "utf8");
      mkdirSync(join(projectDir, ".pi", "skills", PRODUCT_DESIGN_SKILL_NAME), { recursive: true });
      writeFileSync(
        join(projectDir, ".pi", "skills", PRODUCT_DESIGN_SKILL_NAME, "SKILL.md"),
        "---\nname: product-design\ndescription: test project skill\n---\n\nproject skill\n",
        "utf8",
      );
      RoleRegistry.getInstance().reload();

      const codexModelId = "codex-prompt-gate";
      const minimaxModelId = "minimax-prompt-gate";
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
      });
      modelRuntime.registerProvider("openai-codex", {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1",
        apiKey: "diagnostic-key",
        models: [createModelConfig(codexModelId), createModelConfig(minimaxModelId)],
      });
      registerMainModelCapabilityBinding({
        id: bindingId,
        selector: { provider: "openai-codex", modelIds: [minimaxModelId] },
        capabilities: { productDesign: false, imageInput: false, imageGeneration: false, webSearch: false },
      });

      const codexModel = modelRuntime.getModel("openai-codex", codexModelId);
      const minimaxModel = modelRuntime.getModel("openai-codex", minimaxModelId);
      assert.ok(codexModel);
      assert.ok(minimaxModel);

      const subagentManager = new SubagentManager(modelRuntime);
      const coordinatorExtension = createCoordinatorExtension(subagentManager, () => ({
        parentSessionId: "diagnostic-session",
        parentCwd: projectDir,
        parentModel: session?.model
          ? { provider: session.model.provider, id: session.model.id }
          : null,
        getMainSessionCapabilities: () => getMainSessionCapabilities(session?.model),
        activeRole: "coordinator",
      }));
      const services = await createAgentSessionServices({
        cwd: projectDir,
        agentDir,
        modelRuntime,
        resourceLoaderOptions: {
          noSkills: true,
          extensionFactories: [coordinatorExtension, createProductDesignExtension()],
        },
      });
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.inMemory(projectDir),
        model: codexModel,
      });
      session = created.session;
      const entry = {
        runtime: { session },
        activeRole: "coordinator",
        cwd: projectDir,
        isGitRepo: true,
        clients: new Set(),
        lastActive: Date.now(),
        published: true,
        queuedMessages: [],
      } as any;

      applyRoleToSession(entry, "coordinator");
      assert.ok(session.getActiveToolNames().includes(PRODUCT_DESIGN_IMAGEGEN_TOOL_NAME));
      assert.ok(session.getActiveToolNames().includes(PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME));

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

      await session.prompt("turn 1");
      await session.setModel(minimaxModel, { persist: false });
      applyRoleToSession(entry, "coordinator");
      assert.ok(!session.getActiveToolNames().includes(PRODUCT_DESIGN_IMAGEGEN_TOOL_NAME));
      assert.ok(!session.getActiveToolNames().includes(PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME));
      await session.prompt("turn 2");
      await session.setModel(codexModel, { persist: false });
      applyRoleToSession(entry, "coordinator");
      assert.ok(session.getActiveToolNames().includes(PRODUCT_DESIGN_IMAGEGEN_TOOL_NAME));
      assert.ok(session.getActiveToolNames().includes(PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME));
      await session.prompt("turn 3");

      assert.equal(providerPrompts.length, 3);
      assert.equal(countMarker(providerPrompts[0]!), 1, "Codex turn must include one Product Design skill");
      assert.equal(countMarker(providerPrompts[1]!), 0, "MiniMax turn must remove Product Design skill");
      assert.equal(countMarker(providerPrompts[2]!), 1, "Codex turn must restore one Product Design skill");
      assert.ok(providerPrompts.every((prompt) => countMarker(prompt) <= 1));
    } finally {
      unregisterMainModelCapabilityBinding(bindingId);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      try {
        RoleRegistry.getInstance().reload();
      } catch {
        // The test's temporary role directory is isolated; cleanup must not hide the assertion result.
      }
      if (session) await session.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Product Design 工具必须同时满足 capability 与 RoleConfig.allowedTools", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-product-design-tool-gate-"));
    const agentDir = join(root, "agent");
    const projectDir = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(projectDir, ".pi", "skills", PRODUCT_DESIGN_SKILL_NAME), { recursive: true });
    writeFileSync(
      join(projectDir, ".pi", "skills", PRODUCT_DESIGN_SKILL_NAME, "SKILL.md"),
      "---\nname: product-design\ndescription: isolated project skill\n---\n\nproject skill\n",
      "utf8",
    );

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const coordinator = structuredClone(getRoleConfig("coordinator"));
      coordinator.allowedSkills = [PRODUCT_DESIGN_SKILL_NAME];
      coordinator.definition.allowedSkills = [PRODUCT_DESIGN_SKILL_NAME];
      coordinator.allowedTools = (coordinator.allowedTools ?? []).filter(
        (tool) =>
          tool !== PRODUCT_DESIGN_IMAGEGEN_TOOL_NAME &&
          tool !== PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME,
      );
      writeFileSync(join(agentDir, "roles.json"), JSON.stringify([coordinator], null, 2), "utf8");
      RoleRegistry.getInstance().reload();

      const activeToolSnapshots: string[][] = [];
      const entry = {
        runtime: {
          session: {
            model: { provider: "openai-codex", id: "gpt-5.5" },
            setActiveToolsByName(tools: string[]) {
              activeToolSnapshots.push([...tools]);
            },
          },
        },
        activeRole: "coordinator",
        cwd: projectDir,
        isGitRepo: false,
        clients: new Set(),
        lastActive: Date.now(),
        published: true,
        queuedMessages: [],
      } as any;

      applyRoleToSession(entry, "coordinator");
      assert.equal(activeToolSnapshots.length, 1);
      assert.equal(activeToolSnapshots[0]?.includes(PRODUCT_DESIGN_IMAGEGEN_TOOL_NAME), false);
      assert.equal(activeToolSnapshots[0]?.includes(PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME), false);

      coordinator.allowedTools = [
        ...(coordinator.allowedTools ?? []),
        PRODUCT_DESIGN_IMAGEGEN_TOOL_NAME,
      ];
      writeFileSync(join(agentDir, "roles.json"), JSON.stringify([coordinator], null, 2), "utf8");
      RoleRegistry.getInstance().reload();
      applyRoleToSession(entry, "coordinator");
      assert.equal(activeToolSnapshots[1]?.includes(PRODUCT_DESIGN_IMAGEGEN_TOOL_NAME), true);
      assert.equal(activeToolSnapshots[1]?.includes(PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME), false);

      coordinator.allowedTools = [
        ...(coordinator.allowedTools ?? []),
        PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME,
      ];
      writeFileSync(join(agentDir, "roles.json"), JSON.stringify([coordinator], null, 2), "utf8");
      RoleRegistry.getInstance().reload();
      applyRoleToSession(entry, "coordinator");
      assert.equal(activeToolSnapshots[2]?.includes(PRODUCT_DESIGN_IMAGEGEN_TOOL_NAME), true);
      assert.equal(activeToolSnapshots[2]?.includes(PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME), true);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      try {
        RoleRegistry.getInstance().reload();
      } catch {
        // 恢复全局角色配置失败时不隐藏 gate 断言结果。
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
