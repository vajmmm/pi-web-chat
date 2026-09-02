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
        role: "tester",
        cwd: t.worktreePath,
        projectRoot: repoRoot,
        branchName: t.branchName,
        worktreePath: t.worktreePath,
        taskContract: {
          taskId: t.taskId,
          parentSessionId: "session-main",
          role: "tester",
          goal: t.goal,
        },
      });

      const assembled = PromptAssembler.assemble(effectiveContext);
      session._systemPromptOverride = assembled.systemPrompt;
      session.setActiveToolsByName([
        ...effectiveContext.runtime.activeTools,
        "update_working_memory",
        "append_process_journal",
      ]);

      const userPrompt = buildSubagentUserPrompt(t.taskPrompt, effectiveContext.taskContract, {
        workspaceContext: {
          cwd: t.worktreePath,
          projectRoot: repoRoot,
          workspaceType: "isolated_worktree",
          gitBranch: t.branchName,
        },
        memoryPaths: {
          workingMemoryPath: `/tmp/memories/${t.taskId}/working-memory.md`,
          processJournalPath: `/tmp/memories/${t.taskId}/process-journal.md`,
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
    const testerContext = ConstraintResolver.resolve({ role: "tester", cwd: repoRoot });
    assert.deepEqual(
      A.fp.toolNames,
      [
        ...testerContext.runtime.activeTools,
        "update_working_memory",
        "append_process_journal",
      ],
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
      role: "tester",
      cwd: worktreePath,
      projectRoot: repoRoot,
      branchName,
      worktreePath,
      taskContract: {
        taskId,
        parentSessionId: "session-main",
        role: "tester",
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

    // 检查 User Prompt 包含了正确的动态内容
    const userPrompt = buildSubagentUserPrompt("Perform leak check", effectiveContext.taskContract, {
      workspaceContext: {
        cwd: worktreePath,
        projectRoot: repoRoot,
        workspaceType: "isolated_worktree",
        gitBranch: branchName,
      },
      memoryPaths: {
        workingMemoryPath: wmPath,
        processJournalPath: pjPath,
      },
    });

    assert.ok(userPrompt.includes(worktreePath), "User prompt must contain worktree cwd");
    assert.ok(userPrompt.includes(branchName), "User prompt must contain branchName");
    assert.ok(userPrompt.includes(wmPath), "User prompt must contain workingMemoryPath");
    assert.ok(userPrompt.includes(pjPath), "User prompt must contain processJournalPath");
    assert.ok(userPrompt.includes("## Workspace Context"), "User prompt must contain Workspace Context block");
  });

  it("3. AGENTS.md / Project Rules semantic modification correctly updates system fingerprint (semantic cache invalidation)", () => {
    // 原始规则下的 Prompt
    const contextOriginal = ConstraintResolver.resolve({
      role: "tester",
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
      role: "tester",
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

  it("4. Cross-role isolation maintains separate stable cache families (Tester vs Reviewer)", () => {
    const contextTester1 = ConstraintResolver.resolve({
      role: "tester",
      cwd: join(repoRoot, "wt-1"),
      projectRoot: repoRoot,
    });
    const contextTester2 = ConstraintResolver.resolve({
      role: "tester",
      cwd: join(repoRoot, "wt-2"),
      projectRoot: repoRoot,
    });

    const contextReviewer1 = ConstraintResolver.resolve({
      role: "reviewer",
      cwd: join(repoRoot, "wt-3"),
      projectRoot: repoRoot,
    });
    const contextReviewer2 = ConstraintResolver.resolve({
      role: "reviewer",
      cwd: join(repoRoot, "wt-4"),
      projectRoot: repoRoot,
    });

    const hashT1 = sha256(PromptAssembler.assemble(contextTester1).systemPrompt);
    const hashT2 = sha256(PromptAssembler.assemble(contextTester2).systemPrompt);
    const hashR1 = sha256(PromptAssembler.assemble(contextReviewer1).systemPrompt);
    const hashR2 = sha256(PromptAssembler.assemble(contextReviewer2).systemPrompt);

    // 同角色内部稳定
    assert.equal(hashT1, hashT2, "Tester tasks must share identical system fingerprint");
    assert.equal(hashR1, hashR2, "Reviewer tasks must share identical system fingerprint");

    // 跨角色隔离互不混淆
    assert.notEqual(hashT1, hashR1, "Tester and Reviewer must have distinct system fingerprints");
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

    assert.ok(startResultA.message, "Coordinator first turn must inject workspace context message");
    assert.equal(startResultA.message.customType, "workspace-context");
    assert.ok(startResultA.message.content.includes("## Workspace Context"));
    assert.ok(startResultA.message.content.includes(`- cwd: ${cwdA}`));
    assert.ok(startResultA.message.content.includes(`- workspace_type: coordinator_workspace`));

    // 模拟 session 接收到 message
    sessionA._systemPromptOverride = startResultA.systemPrompt;
    // 注入 custom message (转换为 user message 发给 LLM)
    entriesA.push({
      type: "message",
      message: {
        role: "custom",
        customType: "workspace-context",
        content: startResultA.message.content,
      },
    });

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
    const sessionEntries: any[] = [];

    const mockSessionManager = {
      getEntries: () => sessionEntries,
    };

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

    const beforeStart = handlers.get("before_agent_start")!;

    // Turn 1: 初始首轮 -> 必须注入 Workspace Context
    const turn1Result = await beforeStart({ systemPrompt: "base" }, {
      cwd: activeCwd,
      sessionManager: mockSessionManager,
    });
    assert.ok(turn1Result.message, "Turn 1 must inject workspace context message");
    assert.ok(turn1Result.message.content.includes(`- cwd: ${cwdA}`));

    // 记录 Turn 1 到 session entries (模拟运行时持久化)
    sessionEntries.push({
      type: "message",
      message: {
        role: "user",
        content: "Turn 1 user request",
      },
    });
    sessionEntries.push({
      type: "message",
      message: {
        role: "custom",
        customType: "workspace-context",
        content: turn1Result.message.content,
      },
    });
    sessionEntries.push({
      type: "message",
      message: {
        role: "assistant",
        content: "Turn 1 response",
      },
    });

    // Turn 2: 会话多轮 Continuation (cwd 相同) -> 不得重复注入 Workspace Context
    const turn2Result = await beforeStart({ systemPrompt: turn1Result.systemPrompt }, {
      cwd: activeCwd,
      sessionManager: mockSessionManager,
    });
    assert.equal(turn2Result.message, undefined, "Turn 2 with same cwd must NOT duplicate workspace context");

    // Turn 3: 模拟恢复会话 (Restored Session, cwd 相同) -> 不得重复注入
    const turn3Result = await beforeStart({ systemPrompt: turn1Result.systemPrompt }, {
      cwd: activeCwd,
      sessionManager: mockSessionManager,
    });
    assert.equal(turn3Result.message, undefined, "Restored session with same cwd must NOT duplicate workspace context");

    // Turn 4: 工作区切换至 cwdB (set_session_cwd / 工作区实际变化) -> 必须注入新的 Workspace Context
    activeCwd = cwdB;
    const turn4Result = await beforeStart({ systemPrompt: turn1Result.systemPrompt }, {
      cwd: activeCwd,
      sessionManager: mockSessionManager,
    });
    assert.ok(turn4Result.message, "Turn 4 with changed cwd MUST inject updated workspace context");
    assert.ok(turn4Result.message.content.includes(`- cwd: ${cwdB}`));
  });
});

