import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

function count(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

describe("Pi 0.84.4 real Subagent system prompt regression", () => {
  it("uses the Harness prompt authority on every provider turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagent-system-prompt-"));
    const agentDir = join(root, "agent");
    const repoRoot = join(root, "repo");
    const worktree = join(repoRoot, ".worktrees", "task-diagnostic");
    const skillDir = join(worktree, ".pi", "skills", "diagnostic-skill");
    const modelId = "claude-haiku-4-5";
    const agentsMarker = "AGENTS_DIAGNOSTIC_MARKER";
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    const previousOffline = process.env.PI_OFFLINE;

    mkdirSync(agentDir, { recursive: true });
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(worktree, "AGENTS.md"),
      `# Project Rules\n${agentsMarker}\n- Use npm only.\n`,
      "utf8",
    );
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: diagnostic-skill\ndescription: Diagnostic project skill.\n---\n\n# Diagnostic Skill\n",
      "utf8",
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "anthropic",
        defaultModel: modelId,
        defaultThinkingLevel: "off",
        compaction: {
          enabled: true,
          reserveTokens: 1,
          keepRecentTokens: 1,
        },
      }),
      "utf8",
    );

    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.ANTHROPIC_API_KEY = "diagnostic-key-not-sent";
    process.env.PI_OFFLINE = "1";

    try {
      const {
        ConstraintResolver,
        DEFAULT_ROLES_V2,
        PromptAssembler,
        RoleRegistry,
        convertDefinitionToConfig,
      } = await import("../server/contracts/index.ts");
      const { buildSubagentUserPrompt } = await import("../server/subagent/prompt-builder.ts");
      const { createSubagentSessionRuntime } = await import("../server/subagent/agent-runtime.ts");
      const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");

      const roles = Object.values(DEFAULT_ROLES_V2).map((definition) => {
        const configured = definition.id === "developer"
          ? {
              ...definition,
              allowedSkills: ["diagnostic-skill"],
              defaultModel: {
                provider: "anthropic",
                modelId,
                thinkingLevel: "off" as const,
              },
            }
          : definition;
        return convertDefinitionToConfig(configured);
      });
      writeFileSync(join(agentDir, "roles.json"), JSON.stringify(roles), "utf8");
      RoleRegistry.getInstance().reload();

      const taskContract = {
        taskId: "task-system-prompt-diagnostic",
        parentSessionId: "run-system-prompt-diagnostic",
        role: "developer" as const,
        goal: "Capture the real first-turn system prompt",
        scope: { include: ["server/**", "test/**"] },
        acceptanceCriteria: ["Capture provider-bound context"],
      };
      const effectiveContext = ConstraintResolver.resolve({
        role: "developer",
        cwd: worktree,
        projectRoot: repoRoot,
        isGitRepo: true,
        branchName: "codex/diagnostic",
        worktreePath: worktree,
        taskContract,
      });
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
      });
      const created = await createSubagentSessionRuntime({
        taskId: taskContract.taskId,
        runId: taskContract.parentSessionId,
        role: "developer",
        effectiveCwd: worktree,
        effectiveContext,
        modelRuntime,
      });
      const { runtime, session, resolvedModelDetails } = created;
      const providerCalls: Array<{ model: any; context: any }> = [];

      session.agent.streamFunction = async (model: any, context: any) => {
        providerCalls.push({ model, context });
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

      const userPrompt = buildSubagentUserPrompt("Capture the prompt", taskContract, {
        workspaceContext: {
          cwd: worktree,
          projectRoot: repoRoot,
          workspaceType: "isolated_worktree",
          gitBranch: "codex/diagnostic",
          isWorktree: true,
        },
      });
      await session.prompt(userPrompt);
      const firstProviderPrompt = providerCalls[0]?.context.systemPrompt as string;
      await session.prompt("Continue the same task without changing the model.");
      const secondProviderPrompt = providerCalls[1]?.context.systemPrompt as string;
      await session.compact("Keep the diagnostic task context concise.");
      await session.prompt("Continue after compaction without changing the model.");
      const agentTurnCalls = providerCalls.filter(
        (call) => call.context.systemPrompt === firstProviderPrompt,
      );

      assert.equal(agentTurnCalls.length, 3, "the real AgentSession must reach the provider before and after compaction");
      assert.ok(
        providerCalls.length > agentTurnCalls.length,
        "the compaction summary must use an additional provider call",
      );
      assert.ok(firstProviderPrompt, "the first provider call must include a system prompt");
      assert.equal(secondProviderPrompt, firstProviderPrompt);
      assert.equal(agentTurnCalls[2]!.context.systemPrompt, firstProviderPrompt);
      assert.equal(session.systemPrompt, firstProviderPrompt);
      const providerPrompt = firstProviderPrompt;
      assert.equal(
        providerPrompt,
        PromptAssembler.assemble(effectiveContext, {
          runtimeModel: { provider: session.model.provider, id: session.model.id },
        }).systemPrompt,
      );
      const providerUserText = providerCalls[0]!.context.messages
        .flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("\n");
      const nativeSkillLocations = [...providerPrompt.matchAll(/<location>([^<]+)<\/location>/g)]
        .map((match) => match[1]);
      const sectionOrder = {
        harnessGlobal: providerPrompt.indexOf('"system_runtime": "Pi Multi-Agent Harness"'),
        runtimeModel: providerPrompt.indexOf('"runtime_model"'),
        taskContract: providerPrompt.indexOf('"task_contract"'),
        piProjectContext: providerPrompt.indexOf("<project_context>"),
        piAvailableSkills: providerPrompt.indexOf("<available_skills>"),
        piCwd: providerPrompt.indexOf("Current working directory:"),
        taskContextUserMessage: providerUserText.indexOf("## Task Context"),
        workspaceContextUserMessage: providerUserText.indexOf("## Workspace Context"),
      };
      const report = {
        runtime_model_count: count(providerPrompt, '"runtime_model"'),
        task_contract_count: count(providerPrompt, '"task_contract"'),
        task_context_count: count(providerUserText, "## Task Context"),
        workspace_context_count: count(providerUserText, "## Workspace Context"),
        AGENTS_marker_count: count(providerPrompt, agentsMarker),
        available_skills_count: count(providerPrompt, "<available_skills>"),
        current_working_directory_count: count(providerPrompt, "Current working directory:"),
        worktree_absolute_path_present: providerPrompt.includes(worktree),
        task_context_contains_task_id: providerUserText.includes(taskContract.taskId),
        task_context_contains_goal: providerUserText.includes(taskContract.goal),
        workspace_context_contains_same_cwd: providerUserText.includes(`- cwd: ${worktree}`),
        workspace_context_contains_branch: providerUserText.includes("- git_branch: codex/diagnostic"),
        workspace_context_contains_is_worktree: providerUserText.includes("- is_worktree: true"),
        native_skill_locations: nativeSkillLocations,
        native_skill_location_contains_worktree: nativeSkillLocations.some((path) => path.startsWith(worktree)),
        final_session_model: resolvedModelDetails,
        active_tools: session.getActiveToolNames(),
        section_order: sectionOrder,
      };
      console.log(`SUBAGENT_SYSTEM_PROMPT_REGRESSION\n${JSON.stringify(report, null, 2)}`);

      for (const call of agentTurnCalls) {
        assert.equal(call.model.provider, session.model.provider);
        assert.equal(call.model.id, session.model.id);
      }
      assert.equal(report.runtime_model_count, 1);
      assert.equal(report.task_contract_count, 0);
      assert.equal(report.task_context_count, 1);
      assert.equal(report.workspace_context_count, 1);
      assert.equal(report.AGENTS_marker_count, 1);
      assert.equal(report.available_skills_count, 0);
      assert.equal(report.current_working_directory_count, 0);
      assert.equal(report.worktree_absolute_path_present, false);
      assert.equal(providerPrompt.includes(taskContract.taskId), false);
      assert.equal(providerPrompt.includes(taskContract.goal), false);
      assert.equal(providerPrompt.includes("codex/diagnostic"), false);
      assert.equal(report.workspace_context_contains_same_cwd, true);
      assert.equal(report.native_skill_location_contains_worktree, false);
      assert.deepEqual(resolvedModelDetails && {
        provider: resolvedModelDetails.provider,
        id: resolvedModelDetails.id,
      }, {
        provider: "anthropic",
        id: modelId,
      });
      assert.deepEqual(session.getActiveToolNames(), effectiveContext.runtime.activeTools);
      assert.ok(sectionOrder.harnessGlobal >= 0);
      assert.ok(sectionOrder.runtimeModel > sectionOrder.harnessGlobal);
      assert.equal(sectionOrder.taskContract, -1);
      assert.equal(sectionOrder.piProjectContext, -1);
      assert.equal(sectionOrder.piAvailableSkills, -1);
      assert.equal(sectionOrder.piCwd, -1);
      assert.ok(sectionOrder.taskContextUserMessage >= 0);
      assert.ok(sectionOrder.workspaceContextUserMessage >= 0);
      assert.ok(sectionOrder.workspaceContextUserMessage > sectionOrder.taskContextUserMessage);

      await runtime.dispose();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
