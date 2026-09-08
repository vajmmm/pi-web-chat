import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  ConstraintResolver,
  PromptAssembler,
  type TaskContract,
} from "../server/contracts/index.ts";
import {
  buildSubagentUserPrompt,
  subagentTasks,
  SubagentManager,
} from "../server/subagent-manager.ts";
import {
  getSessionTurns,
  installTurnRecorderOnSession,
  clearSessionTurns,
} from "../server/turn-recorder.ts";
import { createCoordinatorExtension } from "../server/coordinator-tools.ts";
import type { UILLMTurnRecord } from "../shared/protocol.ts";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function computePromptFingerprints(turn: UILLMTurnRecord) {
  // 1. System Prompt Fingerprint
  const systemPromptStr =
    typeof turn.systemPrompt === "string"
      ? turn.systemPrompt
      : JSON.stringify(turn.systemPrompt);
  const systemPromptHash = sha256(systemPromptStr);

  // 2. Tools Schema + Tools Order Fingerprint
  const toolsStr = JSON.stringify(turn.tools);
  const toolsHash = sha256(toolsStr);

  // 3. Model/Provider Identity Fingerprint
  const modelId = `${turn.model.provider}/${turn.model.id}`;
  const modelHash = sha256(modelId);

  // 4. Combined Deterministic Stable Prefix Fingerprint
  const combinedPrefixHash = sha256(`${systemPromptHash}:${toolsHash}:${modelHash}`);

  return {
    systemPromptHash,
    toolsHash,
    modelId,
    modelHash,
    combinedPrefixHash,
    toolsCount: turn.tools?.length ?? 0,
    toolNames: turn.tools?.map((t: any) => t.name) ?? [],
  };
}

describe("Provider-level Request Cache Stability & Deterministic Fingerprints", () => {
  const testRoot = mkdtempSync(join(tmpdir(), "pi-cache-test-"));
  const repoRoot = join(testRoot, "mock-repo");
  mkdirSync(repoRoot, { recursive: true });

  // 写入基础 AGENTS.md
  writeFileSync(
    join(repoRoot, "AGENTS.md"),
    "# Development Rules\n- Keep answers short and concise\n- Run tests before commit\n",
    "utf8",
  );

  after(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {}
  });

  it("1. Consecutive Tasks (A, B, C) have 100% identical System Prompt, Tools Schema, and Combined Fingerprints", async () => {
    const recordedPayloads: Map<string, { model: any; context: any; options: any }> = new Map();

    const createMockSession = (taskId: string) => {
      const messages: any[] = [];
      let activeTools: string[] = [];

      const sessionObj: any = {
        agent: {
          streamFn: async (model: any, context: any, options: any) => {
            recordedPayloads.set(taskId, { model, context, options });
            if (typeof options?.onPayload === "function") {
              // 模拟 Provider 捕获的底层请求 payload (如发往 Anthropic / DeepSeek 的实际 body)
              options.onPayload({
                model: model.id,
                system: context.systemPrompt,
                tools: context.tools,
                messages: context.messages,
              });
            }
            return {
              result: async () => ({
                stopReason: "stop",
                content: [{ type: "text", text: `Completed work for ${taskId}` }],
              }),
            };
          },
        },
        setActiveToolsByName: (tools: string[]) => {
          activeTools = tools;
        },
        setThinkingLevel: () => {},
        setModel: async () => {},
        subscribe: () => () => {},
        prompt: async (text: string) => {
          messages.push({ role: "user", content: text });
          const effectiveTools = activeTools.map((name) => ({
            name,
            description: `Tool for ${name}`,
            parameters: { type: "object", properties: {} },
          }));

          const resolvedContext = {
            systemPrompt: (sessionObj as any)._systemPromptOverride,
            messages,
            tools: effectiveTools,
          };

          return sessionObj.agent.streamFn(
            { provider: "anthropic", id: "claude-3-5-sonnet-20241022" },
            resolvedContext,
            {},
          );
        },
      };

      installTurnRecorderOnSession(sessionObj, () => taskId);
      return sessionObj;
    };

    // 构造 3 个不同 Task
    const tasks = [
      {
        taskId: `task-a-${Date.now()}`,
        worktreePath: join(repoRoot, ".pi/agent/worktrees/task-a"),
        branchName: "pi-subagent-task-a",
        taskPrompt: "Fix issue in module A",
        goal: "Fix bug in module A",
      },
      {
        taskId: `task-b-${Date.now()}`,
        worktreePath: join(repoRoot, ".pi/agent/worktrees/task-b"),
        branchName: "pi-subagent-task-b",
        taskPrompt: "Refactor service in module B",
        goal: "Refactor service in module B",
      },
      {
        taskId: `task-c-${Date.now()}`,
        worktreePath: join(repoRoot, ".pi/agent/worktrees/task-c"),
        branchName: "pi-subagent-task-c",
        taskPrompt: "Add test suite in module C",
        goal: "Add test suite in module C",
      },
    ];

    const fingerprintsList = [];

    for (const t of tasks) {
      clearSessionTurns(t.taskId);
      const session = createMockSession(t.taskId);

      const effectiveContext = ConstraintResolver.resolve({
        role: "verifier",
        cwd: t.worktreePath,
        projectRoot: repoRoot,
        branchName: t.branchName,
        worktreePath: t.worktreePath,
        taskContract: {
          taskId: t.taskId,
          parentSessionId: "session-main",
          role: "verifier",
          goal: t.goal,
        },
      });

      const assembled = PromptAssembler.assemble(effectiveContext);
      session._systemPromptOverride = assembled.systemPrompt;
      session.setActiveToolsByName([...effectiveContext.runtime.activeTools]);

      const userPrompt = buildSubagentUserPrompt(t.taskPrompt, effectiveContext.taskContract, {
        workspaceContext: {
          cwd: t.worktreePath,
          projectRoot: repoRoot,
          workspaceType: "isolated_worktree",
          gitBranch: t.branchName,
        },
      });

      await session.prompt(userPrompt);

      const turns = getSessionTurns(t.taskId);
      assert.equal(turns.length, 1, `Task ${t.taskId} must have exactly 1 recorded turn`);
      const turn = turns[0];
      const fp = computePromptFingerprints(turn);
      fingerprintsList.push({ task: t, turn, fp });
    }

    const [A, B, C] = fingerprintsList;

    // 1. 验证 System Prompt Fingerprint 字节级一致
    assert.equal(
      A.fp.systemPromptHash,
      B.fp.systemPromptHash,
      "Task A and Task B System Prompt fingerprint must match",
    );
    assert.equal(
      B.fp.systemPromptHash,
      C.fp.systemPromptHash,
      "Task B and Task C System Prompt fingerprint must match",
    );

    // 2. 验证 Tools Schema 与 Tools Order 顺序完全一致
    assert.equal(
      A.fp.toolsHash,
      B.fp.toolsHash,
      "Task A and Task B Tools fingerprint must match exactly",
    );
    assert.equal(
      B.fp.toolsHash,
      C.fp.toolsHash,
      "Task B and Task C Tools fingerprint must match exactly",
    );
    const testerContext = ConstraintResolver.resolve({ role: "verifier", cwd: repoRoot });
    assert.deepEqual(
      A.fp.toolNames,
      [...testerContext.runtime.activeTools],
      "Must match exact expected active tools list",
    );

    // 3. 验证 Combined Stable Prefix Fingerprint 完全一致
    assert.equal(
      A.fp.combinedPrefixHash,
      B.fp.combinedPrefixHash,
      "Combined Prefix Fingerprint for Task A and B must match",
    );
    assert.equal(
      B.fp.combinedPrefixHash,
      C.fp.combinedPrefixHash,
      "Combined Prefix Fingerprint for Task B and C must match",
    );

    // 4. 验证 vendorPayload 中捕获的系统提示词与 Tools 与内部一致
    assert.ok(A.turn.vendorPayload, "Vendor payload must be captured");
    assert.equal(
      (A.turn.vendorPayload as any).system,
      (B.turn.vendorPayload as any).system,
      "Vendor payload system prompt must be identical across tasks",
    );
    assert.deepEqual(
      (A.turn.vendorPayload as any).tools,
      (B.turn.vendorPayload as any).tools,
      "Vendor payload tools must be identical across tasks",
    );
  });

  it("2. Dynamic fields strictly appear only in User Message and never leak into System Prompt or Tool Schema", () => {
    const taskId = `task-leak-check-${Date.now()}`;
    const worktreePath = join(repoRoot, ".pi/agent/worktrees/task-leak-check");
    const branchName = "pi-subagent-task-leak-branch";
    const wmPath = `/custom/memories/${taskId}/working-memory.md`;
    const pjPath = `/custom/memories/${taskId}/process-journal.md`;

    const effectiveContext = ConstraintResolver.resolve({
      role: "verifier",
      cwd: worktreePath,
      projectRoot: repoRoot,
      branchName,
      worktreePath,
      taskContract: {
        taskId,
        parentSessionId: "session-main",
        role: "verifier",
        goal: "Leak check verification",
      },
    });

    const assembled = PromptAssembler.assemble(effectiveContext);
    const systemPromptStr = assembled.systemPrompt;

    // 严禁泄露到 System Prompt
    assert.equal(systemPromptStr.includes(taskId), false, "taskId must NOT be in system prompt");
    assert.equal(systemPromptStr.includes(worktreePath), false, "worktreePath must NOT be in system prompt");
    assert.equal(systemPromptStr.includes(branchName), false, "branchName must NOT be in system prompt");
    assert.equal(systemPromptStr.includes(wmPath), false, "workingMemoryPath must NOT be in system prompt");
    assert.equal(systemPromptStr.includes(pjPath), false, "processJournalPath must NOT be in system prompt");

    // Task Contract lives in the immutable task suffix; kickoff only carries workspace + trigger.
    const userPrompt = buildSubagentUserPrompt("Perform leak check", effectiveContext.taskContract, {
      workspaceContext: {
        cwd: worktreePath,
        projectRoot: repoRoot,
        workspaceType: "isolated_worktree",
        gitBranch: branchName,
      },
    });

    assert.ok(userPrompt.includes(worktreePath), "User prompt must contain worktree cwd");
    assert.ok(userPrompt.includes(branchName), "User prompt must contain branchName");
    assert.equal(userPrompt.includes(wmPath), false, "legacy working memory must not be injected");
    assert.equal(userPrompt.includes(pjPath), false, "legacy process journal must not be injected");
    assert.ok(userPrompt.includes("## Workspace Context"), "User prompt must contain Workspace Context block");
    assert.ok(assembled.taskSystemPrompt.includes(taskId), "task suffix must contain the contract");
  });

  it("3. AGENTS.md / Project Rules semantic modification correctly updates system fingerprint (semantic cache invalidation)", () => {
    // 原始规则下的 Prompt
    const contextOriginal = ConstraintResolver.resolve({
      role: "verifier",
      cwd: repoRoot,
      projectRoot: repoRoot,
    });
    const assembledOriginal = PromptAssembler.assemble(contextOriginal);
    const hashOriginal = sha256(assembledOriginal.systemPrompt);

    // 修改 AGENTS.md 规则
    const agentsMdPath = join(repoRoot, "AGENTS.md");
    const originalContent = readFileSync(agentsMdPath, "utf8");
    writeFileSync(
      agentsMdPath,
      originalContent + "\n- New Strict Rule: Always verify zero leaks before exit\n",
      "utf8",
    );

    // 规则更新后的 Prompt
    const contextUpdated = ConstraintResolver.resolve({
      role: "verifier",
      cwd: repoRoot,
      projectRoot: repoRoot,
    });
    const assembledUpdated = PromptAssembler.assemble(contextUpdated);
    const hashUpdated = sha256(assembledUpdated.systemPrompt);

    // 验证：规则更新后 System Fingerprint 必须产生差异（允许语义失效，不强制冻结）
    assert.notEqual(
      hashOriginal,
      hashUpdated,
      "System prompt fingerprint MUST change when AGENTS.md rules are modified",
    );

    // 恢复原规则
    writeFileSync(agentsMdPath, originalContent, "utf8");
  });

  it("4. Cross-role isolation maintains separate stable cache families (Verifier vs Developer)", () => {
    const contextVerifier1 = ConstraintResolver.resolve({
      role: "verifier",
      cwd: join(repoRoot, "wt-1"),
      projectRoot: repoRoot,
    });
    const contextVerifier2 = ConstraintResolver.resolve({
      role: "verifier",
      cwd: join(repoRoot, "wt-2"),
      projectRoot: repoRoot,
    });

    const contextDeveloper1 = ConstraintResolver.resolve({
      role: "developer",
      cwd: join(repoRoot, "wt-3"),
      projectRoot: repoRoot,
    });
    const contextDeveloper2 = ConstraintResolver.resolve({
      role: "developer",
      cwd: join(repoRoot, "wt-4"),
      projectRoot: repoRoot,
    });

    const hashV1 = sha256(PromptAssembler.assemble(contextVerifier1).systemPrompt);
    const hashV2 = sha256(PromptAssembler.assemble(contextVerifier2).systemPrompt);
    const hashD1 = sha256(PromptAssembler.assemble(contextDeveloper1).systemPrompt);
    const hashD2 = sha256(PromptAssembler.assemble(contextDeveloper2).systemPrompt);

    // 同角色内部稳定
    assert.equal(hashV1, hashV2, "Verifier tasks must share identical system fingerprint");
    assert.equal(hashD1, hashD2, "Developer tasks must share identical system fingerprint");

    // 跨角色隔离互不混淆
    assert.notEqual(hashV1, hashD1, "Verifier and Developer must have distinct system fingerprints");
  });

  it("5. Coordinator System Prompt contains zero dynamic cwd/worktree/branch while first-turn Provider Payload receives dynamic Workspace Context", async () => {
    const cwdA = join(repoRoot, "coord-project-a");
    const cwdB = join(repoRoot, "coord-project-b");
    mkdirSync(cwdA, { recursive: true });
    mkdirSync(cwdB, { recursive: true });

    const recordedPayloads: Map<string, any> = new Map();

    const createCoordinatorMockSession = (sessionId: string, sessionCwd: string, sessionManagerEntries: any[] = []) => {
      const messages: any[] = [];
      const sessionObj: any = {
        agent: {
          streamFn: async (model: any, context: any, options: any) => {
            recordedPayloads.set(sessionId, { model, context, options });
            if (typeof options?.onPayload === "function") {
              options.onPayload({
                model: model.id,
                system: context.systemPrompt,
                tools: context.tools,
                messages: context.messages,
              });
            }
            return {
              result: async () => ({
                stopReason: "stop",
                content: [{ type: "text", text: `Done for ${sessionId}` }],
              }),
            };
          },
        },
        sessionManager: {
          getEntries: () => sessionManagerEntries,
        },
        setActiveToolsByName: () => {},
        prompt: async (text: string) => {
          messages.push({ role: "user", content: text });
          const resolvedContext = {
            systemPrompt: (sessionObj as any)._systemPromptOverride,
            messages: [...messages],
            tools: [],
          };
          return sessionObj.agent.streamFn(
            { provider: "anthropic", id: "claude-3-5-sonnet-20241022" },
            resolvedContext,
            {},
          );
        },
      };

      installTurnRecorderOnSession(sessionObj, () => sessionId);
      return sessionObj;
    };

    // 1. 验证 System Prompt 字节级一致（跨不同 cwd）
    const contextCoordA = ConstraintResolver.resolve({
      role: "coordinator",
      cwd: cwdA,
      projectRoot: repoRoot,
      branchName: "main",
    });
    const contextCoordB = ConstraintResolver.resolve({
      role: "coordinator",
      cwd: cwdB,
      projectRoot: repoRoot,
      branchName: "main",
    });

    const assembledCoordA = PromptAssembler.assemble(contextCoordA);
    const assembledCoordB = PromptAssembler.assemble(contextCoordB);

    assert.equal(
      assembledCoordA.systemPrompt,
      assembledCoordB.systemPrompt,
      "Coordinator System Prompt must be 100% byte-for-byte identical across different cwds",
    );

    const parsedA = JSON.parse(assembledCoordA.systemPrompt);
    assert.equal((parsedA as any).workspace_context, undefined, "workspace_context must NOT be in system prompt");
    assert.equal(assembledCoordA.systemPrompt.includes(cwdA), false, "cwd must NOT be in system prompt");
    assert.equal(assembledCoordA.systemPrompt.includes("coord-project"), false);

    // 2. 验证 Coordinator Extension before_agent_start 动态注入 Workspace Context
    const subagentManager = new SubagentManager({} as any);

    // Session A
    clearSessionTurns("coord-session-a");
    const entriesA: any[] = [];
    const sessionA = createCoordinatorMockSession("coord-session-a", cwdA, entriesA);
    const extA = createCoordinatorExtension(subagentManager, () => ({
      parentSessionId: "coord-session-a",
      parentCwd: cwdA,
      activeRole: "coordinator",
    }));

    const handlersA = new Map<string, Function>();
    extA.factory({
      registerTool: () => {},
      on: (event: string, handler: Function) => handlersA.set(event, handler),
    } as any);

    const beforeStartA = handlersA.get("before_agent_start")!;
    const startResultA = await beforeStartA({ systemPrompt: "base" }, {
      cwd: cwdA,
      sessionManager: sessionA.sessionManager,
    });

    assert.equal(startResultA.message, undefined, "Coordinator before_agent_start must NOT emit a separate message");
    assert.ok(startResultA.systemPrompt, "Coordinator before_agent_start must return system prompt");

    const contextA = handlersA.get("context")!;
    const contextResultA = await contextA({
      type: "context",
      messages: [{ role: "user", content: [{ type: "text", text: "Fix coordinator bug" }] }],
    }, {
      cwd: cwdA,
      sessionManager: sessionA.sessionManager,
    });

    assert.ok(contextResultA?.messages, "Context hook must return updated messages");
    assert.equal(contextResultA.messages.length, 1, "Context hook must NOT create separate message entry");
    const userMsg = contextResultA.messages[0];
    const textContent = Array.isArray(userMsg.content) ? (userMsg.content[0] as any).text : userMsg.content;
    assert.ok(textContent.includes("## Workspace Context"), "Workspace Context must be prepended to user message");
    assert.ok(textContent.includes(`- cwd: ${cwdA}`));
    assert.ok(textContent.includes("- workspace_type: coordinator_workspace"));
    assert.ok(textContent.includes("Fix coordinator bug"));

    // 模拟 session 运行
    sessionA._systemPromptOverride = startResultA.systemPrompt;
    await sessionA.prompt("Fix coordinator bug");
    const turnsA = getSessionTurns("coord-session-a");
    assert.equal(turnsA.length, 1);
    assert.ok(turnsA[0].vendorPayload, "Vendor payload must be captured");
    assert.ok(
      JSON.stringify(turnsA[0].messages).includes("Fix coordinator bug"),
      "User original message must be present",
    );
  });

  it("6. Multi-turn continuation & Restored Coordinator Session avoids duplicate Workspace Context injection unless cwd changes", async () => {
    const cwdA = join(repoRoot, "coord-session-turns-test");
    const cwdB = join(repoRoot, "coord-session-turns-test-migrated");
    mkdirSync(cwdA, { recursive: true });
    mkdirSync(cwdB, { recursive: true });

    const subagentManager = new SubagentManager({} as any);
    let activeCwd = cwdA;

    const ext = createCoordinatorExtension(subagentManager, () => ({
      parentSessionId: "multi-turn-coord-session",
      parentCwd: activeCwd,
      activeRole: "coordinator",
    }));

    const handlers = new Map<string, Function>();
    ext.factory({
      registerTool: () => {},
      on: (event: string, handler: Function) => handlers.set(event, handler),
    } as any);

    const contextHandler = handlers.get("context")!;

    // Turn 1: 初始首轮 -> 必须在首个 user 消息开头前置拼入 Workspace Context
    const turn1Msgs = [
      { role: "user", content: [{ type: "text", text: "Turn 1 user request" }] },
    ];
    const turn1Result = await contextHandler({
      type: "context",
      messages: turn1Msgs,
    }, { cwd: activeCwd });

    assert.ok(turn1Result?.messages, "Turn 1 must return messages");
    assert.equal(turn1Result.messages.length, 1, "Must not create separate message entry");
    const t1Text = (turn1Result.messages[0].content[0] as any).text;
    assert.ok(t1Text.includes("## Workspace Context"));
    assert.ok(t1Text.includes(`- cwd: ${cwdA}`));
    assert.ok(t1Text.includes("Turn 1 user request"));

    // Turn 2: 会话多轮 Continuation (cwd 相同，历史已包含 Workspace Context) -> 不得重复注入
    const turn2Msgs = [
      turn1Result.messages[0], // 历史中已包含 cwdA 的 Workspace Context
      { role: "assistant", content: [{ type: "text", text: "Turn 1 response" }] },
      { role: "user", content: [{ type: "text", text: "Turn 2 user request" }] },
    ];
    const turn2Result = await contextHandler({
      type: "context",
      messages: turn2Msgs,
    }, { cwd: activeCwd });

    assert.equal(turn2Result, undefined, "Turn 2 with same cwd must NOT duplicate workspace context");

    // Turn 3: 模拟恢复会话 (Restored Session, cwd 相同) -> 不得重复注入
    const turn3Result = await contextHandler({
      type: "context",
      messages: turn2Msgs,
    }, { cwd: activeCwd });
    assert.equal(turn3Result, undefined, "Restored session with same cwd must NOT duplicate workspace context");

    // Turn 4: 后续轮次（即使工作区发生变化）严格遵循“只在第一条消息发送这个头”，后续用户消息不得再注入
    activeCwd = cwdB;
    const turn4Msgs = [
      turn1Result.messages[0],
      { role: "assistant", content: [{ type: "text", text: "Turn 1 response" }] },
      { role: "user", content: [{ type: "text", text: "Turn 4 user request in new cwd" }] },
    ];
    const turn4Result = await contextHandler({
      type: "context",
      messages: turn4Msgs,
    }, { cwd: activeCwd });

    assert.equal(turn4Result, undefined, "Subsequent user messages must NOT inject workspace context header");
  });
});
