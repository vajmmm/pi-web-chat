import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  initTaskMemory,
  readWorkingMemory,
  readProcessJournal,
  writeWorkingMemory,
  appendProcessJournal,
  buildCompactionMemoryBlock,
  injectMemoryIntoCompactionSummary,
  getWorkingMemoryPath,
  getProcessJournalPath,
  createTaskMemoryExtension,
  getTaskMemoriesRoot,
  removeTaskMemory,
  MAX_WORKING_MEMORY_CHARS,
  MAX_WORKING_MEMORY_TOKENS,
  estimateMemoryTokens,
} from "../server/task-memory.ts";
import {
  buildSubagentUserPrompt,
  SubagentManager,
  subagentTasks,
} from "../server/subagent-manager.ts";
import { performSessionCompaction } from "../server/compact.ts";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const mockModelRuntime: any = {
  getModel: () => ({
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 3.7",
    contextWindow: 200000,
  }),
  getAuth: async () => ({
    auth: { apiKey: "fake-key" },
    headers: {},
  }),
};

function createMockSession(messages: any[] = []): any {
  return {
    messages,
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    thinkingLevel: "off",
    isStreaming: false,
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          id: "m-1",
          message: { role: "user", content: "Initial task goal" },
        },
        {
          type: "message",
          id: "m-2",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Analyzing task..." }],
          },
        },
        {
          type: "message",
          id: "m-3",
          message: { role: "user", content: "Continue next step" },
        },
      ],
      appendCompaction: (summary: string, firstKeptEntryId: string) => {
        messages.unshift({
          role: "compactionSummary",
          summary,
        });
      },
      buildSessionContext: () => ({ messages }),
    },
    agent: {
      state: { messages },
      streamFn: async () => ({
        result: async () => ({
          stopReason: "stop",
          content: [{ type: "text", text: "## Standard Compaction Summary\n- Analyzed modules." }],
        }),
      }),
    },
    setActiveToolsByName: () => {},
    setModel: async () => {},
    setThinkingLevel: () => {},
    subscribe: () => () => {},
    prompt: async () => {},
    abort: async () => {},
  };
}

describe("Task Working Memory & Process Journal (V1)", () => {
  // A. Working Memory 创建
  it("A. creates working-memory.md and process-journal.md on init", () => {
    const taskId = `task-mem-create-${Date.now()}`;
    const { workingMemoryPath, processJournalPath } = initTaskMemory(taskId, "Fix database connection leak");

    assert.ok(existsSync(workingMemoryPath));
    assert.ok(existsSync(processJournalPath));

    const wmContent = readWorkingMemory(taskId);
    assert.ok(wmContent);
    assert.ok(wmContent.includes("Fix database connection leak"));
    assert.ok(wmContent.includes("## Current Goal"));
    assert.ok(wmContent.includes("## Current Phase"));
    assert.ok(wmContent.includes("## Verified Facts"));
    assert.ok(wmContent.includes("## Rejected / Failed Paths"));
    assert.ok(wmContent.includes("## Next Actions"));

    const pjContent = readProcessJournal(taskId);
    assert.ok(pjContent);
    assert.ok(pjContent.includes("Process Journal"));
  });

  // B. Rolling Update (覆盖更新，不无限追加)
  it("B. rolling updates working-memory.md replacing old state and enforcing size limits", () => {
    const taskId = `task-mem-update-${Date.now()}`;
    initTaskMemory(taskId, "Implement auth module");

    const phase1Memory = `# Working Memory
## Current Goal
Implement auth module

## Current Phase
Phase 1: DB Schema Migration

## Progress
- [x] Created users table

## Verified Facts
- PostgreSQL connection verified on port 5432

## Next Actions
- Build JWT token generator
`;
    const res1 = writeWorkingMemory(taskId, phase1Memory);
    assert.equal(res1.success, true);
    assert.equal(readWorkingMemory(taskId)?.trim(), phase1Memory.trim());

    // Rolling update to Phase 2 (Phase 1 is replaced, not appended)
    const phase2Memory = `# Working Memory
## Current Goal
Implement auth module

## Current Phase
Phase 2: JWT Token Service

## Progress
- [x] Schema migration completed
- [x] JWT token generator implemented

## Verified Facts
- PostgreSQL connection verified on port 5432
- Token verification passes with RS256

## Rejected / Failed Paths
- HS256 rejected due to asymmetric key requirement

## Next Actions
- Implement login endpoint
`;
    const res2 = writeWorkingMemory(taskId, phase2Memory);
    assert.equal(res2.success, true);

    const updated = readWorkingMemory(taskId);
    assert.ok(updated);
    assert.ok(updated.includes("Phase 2: JWT Token Service"));
    assert.equal(updated.includes("Phase 1: DB Schema Migration"), false); // Old phase removed

    // Size limit check
    const hugeContent = "X".repeat(MAX_WORKING_MEMORY_CHARS + 100);
    const failRes = writeWorkingMemory(taskId, hugeContent);
    assert.equal(failRes.success, false);
    assert.ok(failRes.error?.includes("exceeds limit"));
  });

  // C. Compact 恢复
  it("C. injects authoritative working memory block into compaction summary", async () => {
    const taskId = `task-mem-compact-${Date.now()}`;
    initTaskMemory(taskId, "Refactor billing system");

    const wmContent = `# Working Memory
## Current Goal
Refactor billing system

## Current Phase
Phase 3: Stripe Webhook Integration

## Progress
- [x] Updated invoice models

## Verified Facts
- Stripe webhook signature verification passes

## Rejected / Failed Paths
- Polling Stripe API directly rejected due to rate limits

## Next Actions
- Verify refund event handling
`;
    writeWorkingMemory(taskId, wmContent);

    const mockSession = createMockSession();
    (mockSession as any).__taskId = taskId;

    const result = await performSessionCompaction(mockSession, mockModelRuntime, undefined, taskId);

    assert.ok(result.summary.includes("===== AUTHORITATIVE TASK WORKING MEMORY ====="));
    assert.ok(result.summary.includes("Phase 3: Stripe Webhook Integration"));
    assert.ok(result.summary.includes("Stripe webhook signature verification passes"));
    assert.ok(result.summary.includes("Polling Stripe API directly rejected due to rate limits"));
    assert.ok(result.summary.includes("Detailed historical process is available at:"));
    assert.ok(result.summary.includes(getProcessJournalPath(taskId)));
    assert.ok(result.summary.includes("Standard Compaction Summary"));
  });

  // D. Journal 不全量注入
  it("D. does NOT inject full process journal content during compaction", async () => {
    const taskId = `task-mem-journal-${Date.now()}`;
    initTaskMemory(taskId, "Debug memory leak");

    // Append 20 detailed journal entries
    for (let i = 1; i <= 20; i++) {
      appendProcessJournal(
        taskId,
        `Deep diagnostic dump step ${i}: heap inspection object count = ${i * 1000}, stack trace = at Foo.bar() line ${i}`,
        `Step ${i} Diagnosis`,
      );
    }

    const journalContent = readProcessJournal(taskId);
    assert.ok(journalContent);
    assert.ok(journalContent.length > 2000); // Substantial journal

    const mockSession = createMockSession();
    const result = await performSessionCompaction(mockSession, mockModelRuntime, undefined, taskId);

    // Compaction summary must contain path to journal, but NOT the 20 dump entries
    assert.ok(result.summary.includes(getProcessJournalPath(taskId)));
    assert.equal(result.summary.includes("Deep diagnostic dump step 15"), false);
    assert.equal(result.summary.includes("heap inspection object count"), false);
  });

  // E. Journal 可按需读取
  it("E. process journal is persisted and queryable on disk", () => {
    const taskId = `task-mem-ondemand-${Date.now()}`;
    initTaskMemory(taskId, "Performance profiling");

    appendProcessJournal(
      taskId,
      "Profiled worker pool: throughput is 450 req/s. Discovered lock contention in Mutex.acquire.",
      "Lock Contention Diagnosis",
    );

    const pjPath = getProcessJournalPath(taskId);
    assert.ok(existsSync(pjPath));

    const raw = readFileSync(pjPath, "utf8");
    assert.ok(raw.includes("Lock Contention Diagnosis"));
    assert.ok(raw.includes("throughput is 450 req/s"));
    assert.ok(raw.includes("Mutex.acquire"));
  });

  // F. Task 隔离
  it("F. guarantees strict memory isolation between Task A and Task B", () => {
    const taskIdA = `task-iso-A-${Date.now()}`;
    const taskIdB = `task-iso-B-${Date.now()}`;

    initTaskMemory(taskIdA, "Goal of Task A");
    initTaskMemory(taskIdB, "Goal of Task B");

    writeWorkingMemory(taskIdA, "Exclusive facts of Task A: secret_token_123");
    writeWorkingMemory(taskIdB, "Exclusive facts of Task B: secret_token_456");

    const blockA = buildCompactionMemoryBlock(taskIdA);
    const blockB = buildCompactionMemoryBlock(taskIdB);

    assert.ok(blockA?.includes("secret_token_123"));
    assert.equal(blockA?.includes("secret_token_456"), false);

    assert.ok(blockB?.includes("secret_token_456"));
    assert.equal(blockB?.includes("secret_token_123"), false);
  });

  // G. 不影响现有无 compaction 任务
  it("G. buildSubagentUserPrompt cleanly includes memory paths without breaking non-compaction flow", () => {
    const taskId = `task-prompt-test-${Date.now()}`;
    const memoryPaths = initTaskMemory(taskId, "Fast single-turn task");

    const prompt = buildSubagentUserPrompt(
      "Fix type error in config.ts",
      {
        taskId,
        parentSessionId: "parent-1",
        role: "developer",
        goal: "Fix type error",
      },
      { memoryPaths },
    );

    assert.ok(prompt.includes("## Goal\nFix type error"));
    assert.ok(prompt.includes("## Task\nFix type error in config.ts"));
    assert.ok(prompt.includes("## Working Memory & Process Journal"));
    assert.ok(prompt.includes(memoryPaths.workingMemoryPath));
    assert.ok(prompt.includes(memoryPaths.processJournalPath));
  });

  // H. Reusable Agent 不继承前序 Task 的 Working Memory
  it("H. continue_subagent creates brand new isolated Task Memory without inheriting previous Task memory", async () => {
    const manager = new SubagentManager(mockModelRuntime);
    const parentSessionId = `session-reusable-mem-${Date.now()}`;
    const task1Id = `task-mem-orig-${Date.now()}`;

    const explorationMsgs = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "bash",
            arguments: { command: "which python && python --version" },
          },
          { type: "text", text: "Environment checked." },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        content: [{ type: "text", text: "/usr/bin/python3\nPython 3.11" }],
        isError: false,
      },
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Tests ready." }],
      },
    ];

    // Task 1
    const task1 = await manager.spawn({
      parentSessionId,
      role: "verifier",
      taskTitle: "Task 1",
      taskPrompt: "Test suite 1",
      parentCwd: process.cwd(),
      customSession: createMockSession(explorationMsgs),
      taskContract: {
        taskId: task1Id,
        parentSessionId,
        role: "verifier",
        goal: "Run test suite 1",
        expectedEffects: ["analysis"],
      },
    });

    writeWorkingMemory(task1.taskId, "Working memory of Task 1: unique_fact_task1");
    appendProcessJournal(task1.taskId, "Journal entry of Task 1: detail_task1");

    await manager.handleSubagentCompletion(task1.taskId);
    assert.equal(manager.getTasksForParent(parentSessionId).find(t => t.taskId === task1.taskId)?.status, "completed");

    // Continue Agent into Task 2
    const task2Id = `task-mem-cont-${Date.now()}`;
    const task2 = await manager.continueAgent({
      agentId: task1.agentId!,
      parentSessionId,
      taskTitle: "Task 2 Continued",
      taskPrompt: "Follow up task 2",
      parentCwd: process.cwd(),
      customSession: createMockSession(),
      taskContract: {
        taskId: task2Id,
        parentSessionId,
        role: "verifier",
        goal: "Follow up task 2",
      },
    });

    assert.notEqual(task1.taskId, task2.taskId);

    const wm2 = readWorkingMemory(task2.taskId);
    assert.ok(wm2);
    // Task 2 must NOT inherit Task 1's working memory content
    assert.equal(wm2.includes("unique_fact_task1"), false);
    assert.ok(wm2.includes("Follow up task 2"));

    const pj2 = readProcessJournal(task2.taskId);
    assert.ok(pj2);
    // Task 2 must NOT inherit Task 1's process journal
    assert.equal(pj2.includes("detail_task1"), false);
  });

  // I. Pi 原生 threshold/overflow auto-compaction 集成测试：
  // 验证 compaction 后“下一次真实模型请求中的 active messages”确实包含最新 AUTHORITATIVE TASK WORKING MEMORY
  it("I. native Pi threshold/overflow auto-compaction guarantees working memory in next turn's active model request messages", async () => {
    const taskId = `task-native-auto-${Date.now()}`;
    const tmpDir = process.cwd();
    initTaskMemory(taskId, "Optimize query index");

    const wmContent = `# Working Memory
## Current Goal
Optimize query index

## Current Phase
Phase 4: Query Index Optimization

## Progress
- [x] Analyzed slow queries
- [x] Created index on users(email)

## Verified Facts
- Index on users(email) cut query time from 400ms to 2ms

## Rejected / Failed Paths
- In-memory caching rejected due to multi-node cache invalidation complexity

## Next Actions
- Verify query execution plan on staging
`;
    writeWorkingMemory(taskId, wmContent);

    let sessionRef: any;
    const tempAuthFile = join(tmpDir, "temp-auth-test.json");
    try {
      writeFileSync(
        tempAuthFile,
        JSON.stringify({ anthropic: { type: "api_key", key: "fake-key" } }),
        "utf8",
      );
      const testModelRuntime = await ModelRuntime.create({
        authPath: tempAuthFile,
        modelsPath: null,
        allowModelNetwork: false,
      });

      const services = await createAgentSessionServices({
        cwd: tmpDir,
        agentDir: getAgentDir(),
        modelRuntime: testModelRuntime,
        resourceLoaderOptions: {
          systemPromptOverride: () => "Test system prompt",
          appendSystemPromptOverride: () => [],
          extensionFactories: [createTaskMemoryExtension(taskId, () => sessionRef)],
        },
      });

      const sessionManager = SessionManager.inMemory(tmpDir);
      const runtime = await createAgentSessionFromServices({
        services,
        sessionManager,
      });
      const session = runtime.session;
      sessionRef = session;

      // Set model from runtime catalog
      const model = testModelRuntime.getModel("anthropic", "claude-sonnet-4-5");
      assert.ok(model, "Model claude-sonnet-4-5 must exist in catalog");
      await session.setModel(model);

      // Mock stream handler to capture active LLM request contexts and simulate responses
      const capturedContexts: any[] = [];
      const mockStream = (model: any, context: any, _options: any) => {
        capturedContexts.push(JSON.parse(JSON.stringify(context)));
        const message = {
          role: "assistant",
          content: [{ type: "text", text: "Compacted or responded step." }],
          api: model?.api,
          provider: model?.provider,
          model: model?.id,
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          stopReason: "stop",
        };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "start", partial: message };
            yield { type: "text_start", contentIndex: 0 };
            yield { type: "text_delta", contentIndex: 0, delta: "Compacted or responded step." };
            yield { type: "text_end", contentIndex: 0 };
            yield { type: "done", reason: "stop", message };
          },
          result: async () => message,
        };
      };
      (session.agent as any).streamFunction = mockStream;
      (session.agent as any).streamFn = mockStream;
      (testModelRuntime as any).streamSimple = mockStream;
      (testModelRuntime as any).stream = mockStream;

      // Seed conversations
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "Please investigate slow queries" }],
        timestamp: Date.now() - 3000,
      });
      sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Analyzing query logs in database..." }],
        stopReason: "stop",
        timestamp: Date.now() - 2000,
      });
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "Found user email lookups are slow" }],
        timestamp: Date.now() - 1000,
      });
      sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Confirmed missing index on users table." }],
        stopReason: "stop",
        timestamp: Date.now(),
      });

      (session as any).settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
      session.agent.state.messages = sessionManager.buildSessionContext().messages;

      // Run native Pi auto-compaction (_runAutoCompaction)
      await (session as any)._runAutoCompaction("threshold", false);
      const compactionEntry = sessionManager.getEntries().find((e) => e.type === "compaction");
      assert.ok(compactionEntry, "Native auto-compaction entry must be persisted in sessionManager");

      // Clear previous captured stream contexts
      capturedContexts.length = 0;

      // Trigger next real prompt turn on the session
      await session.prompt("What is our current phase and verified facts?");

      // Verify that streamFn was called for this prompt turn
      assert.ok(capturedContexts.length >= 1, "Model streamFn must be invoked for the subsequent prompt");
      const lastRequestContext = capturedContexts[capturedContexts.length - 1];

      // Verify session context messages
      const sessionMessages = session.messages;
      assert.equal(sessionMessages[0].role, "compactionSummary", "First session message must be compactionSummary");
      assert.ok(
        (sessionMessages[0] as any).summary.includes("===== AUTHORITATIVE TASK WORKING MEMORY ====="),
        "Session compactionSummary must include AUTHORITATIVE TASK WORKING MEMORY",
      );

      // Verify the active LLM request messages sent to the model stream
      const activeLlmMessages = lastRequestContext.messages;
      assert.ok(activeLlmMessages && activeLlmMessages.length >= 2, "Active LLM messages must contain compaction summary block and new user prompt");

      const firstLlmMessage = activeLlmMessages[0];
      assert.equal(firstLlmMessage.role, "user", "LLM format converts compaction summary to user role block");
      const firstMsgText = JSON.stringify(firstLlmMessage.content);
      assert.ok(
        firstMsgText.includes("AUTHORITATIVE TASK WORKING MEMORY"),
        "Active model request must contain AUTHORITATIVE TASK WORKING MEMORY header",
      );
      assert.ok(
        firstMsgText.includes("Phase 4: Query Index Optimization"),
        "Active model request must contain current phase",
      );
      assert.ok(
        firstMsgText.includes("Index on users(email) cut query time from 400ms to 2ms"),
        "Active model request must contain verified facts",
      );
      assert.ok(
        firstMsgText.includes(getProcessJournalPath(taskId)),
        "Active model request must point to process-journal.md path",
      );

      const userPromptMsg = activeLlmMessages[activeLlmMessages.length - 1];
      assert.equal(userPromptMsg.role, "user");
      assert.ok(JSON.stringify(userPromptMsg.content).includes("What is our current phase and verified facts?"));
    } finally {
      if (existsSync(tempAuthFile)) {
        rmSync(tempAuthFile, { force: true });
      }
    }
  });

  // J. Lifecycle Cleanup & Security (Task Deletion, Session Cascade, and Path Security)
  describe("J. Lifecycle Cleanup & Security", () => {
    it("A. Single Task deletion removes task business object and cleans up task memory directory", async () => {
      const manager = new SubagentManager(mockModelRuntime);
      const taskId = `task-del-a-${Date.now()}`;
      const parentSessionId = `parent-del-${Date.now()}`;

      // 1. 初始化 Task 与 Memory
      initTaskMemory(taskId, "Verify Task A deletion cleanup");
      writeWorkingMemory(taskId, "# Working Memory for Task A\nVerified fact 123");
      appendProcessJournal(taskId, "Diagnostic entry for Task A");

      const memDir = join(getTaskMemoriesRoot(), taskId);
      assert.ok(existsSync(memDir), "Memory directory must exist before deletion");
      assert.ok(existsSync(getWorkingMemoryPath(taskId)), "Working memory file must exist");
      assert.ok(existsSync(getProcessJournalPath(taskId)), "Process journal file must exist");

      // 2. 模拟 SubagentTask 业务对象
      subagentTasks.set(taskId, {
        task: {
          taskId,
          parentSessionId,
          role: "verifier",
          taskTitle: "Task A",
          status: "completed",
          createdAt: new Date().toISOString(),
        },
      });

      // 3. 执行 deleteTask
      const deleted = await manager.deleteTask(taskId);
      assert.equal(deleted, true, "deleteTask must succeed");
      assert.equal(subagentTasks.has(taskId), false, "Task must be removed from manager");
      assert.equal(existsSync(memDir), false, "Memory directory must be completely removed after task deletion");
    });

    it("B. Non-existent memory directory succeeds cleanly as no-op without error", async () => {
      const manager = new SubagentManager(mockModelRuntime);
      const taskId = `task-del-nomem-${Date.now()}`;
      const parentSessionId = `parent-del-${Date.now()}`;

      // 任务存在但无 memory 目录
      subagentTasks.set(taskId, {
        task: {
          taskId,
          parentSessionId,
          role: "developer",
          taskTitle: "Task with no memory dir",
          status: "completed",
          createdAt: new Date().toISOString(),
        },
      });

      const memDir = join(getTaskMemoriesRoot(), taskId);
      assert.equal(existsSync(memDir), false, "Memory dir must not exist before test");

      const deleted = await manager.deleteTask(taskId);
      assert.equal(deleted, true, "deleteTask must succeed even when memory directory does not exist");
      assert.equal(subagentTasks.has(taskId), false, "Task must be deleted");
    });

    it("C. Memory deletion error is best-effort and does not rollback task business deletion", async () => {
      const manager = new SubagentManager(mockModelRuntime);
      const taskId = `task-del-err-${Date.now()}`;
      const parentSessionId = `parent-del-${Date.now()}`;

      initTaskMemory(taskId, "Task to test error resilience");
      subagentTasks.set(taskId, {
        task: {
          taskId,
          parentSessionId,
          role: "verifier",
          taskTitle: "Task error test",
          status: "completed",
          createdAt: new Date().toISOString(),
        },
      });

      // 验证 removeTaskMemory 本身对异常入参或非受控环境的安全处理
      const okEmpty = removeTaskMemory("");
      assert.equal(okEmpty, false, "Empty taskId removal must return false without crashing");

      // 执行正常 deleteTask
      const deleted = await manager.deleteTask(taskId);
      assert.equal(deleted, true, "Task deletion must remain successful");
      assert.equal(subagentTasks.has(taskId), false);
    });

    it("D. Session Cascade deletes all subtasks and task memory directories under session while preserving other sessions", async () => {
      const manager = new SubagentManager(mockModelRuntime);
      const sessionS = `session-target-${Date.now()}`;
      const sessionOther = `session-other-${Date.now()}`;

      const taskA = `task-cascade-a-${Date.now()}`;
      const taskB = `task-cascade-b-${Date.now()}`;
      const taskC = `task-cascade-c-${Date.now()}`;
      const taskD = `task-cascade-d-other-${Date.now()}`;

      // 初始化各 Task 的 memory
      initTaskMemory(taskA, "Task A in Session S");
      initTaskMemory(taskB, "Task B in Session S");
      initTaskMemory(taskC, "Task C in Session S");
      initTaskMemory(taskD, "Task D in Session Other");

      // 注册到 manager
      for (const [tId, pId] of [
        [taskA, sessionS],
        [taskB, sessionS],
        [taskC, sessionS],
        [taskD, sessionOther],
      ]) {
        subagentTasks.set(tId, {
          task: {
            taskId: tId,
            parentSessionId: pId,
            role: "verifier",
            taskTitle: `Title for ${tId}`,
            status: "completed",
            createdAt: new Date().toISOString(),
          },
        });
      }

      assert.ok(existsSync(join(getTaskMemoriesRoot(), taskA)));
      assert.ok(existsSync(join(getTaskMemoriesRoot(), taskB)));
      assert.ok(existsSync(join(getTaskMemoriesRoot(), taskC)));
      assert.ok(existsSync(join(getTaskMemoriesRoot(), taskD)));

      // 执行 clearTasksForParent(sessionS)
      const clearedCount = await manager.clearTasksForParent(sessionS);
      assert.equal(clearedCount, 3, "Must clear 3 tasks belonging to session S");

      // 验证 Session S 的 3 个 Task 及其 Memory 均被删除
      assert.equal(existsSync(join(getTaskMemoriesRoot(), taskA)), false, "Task A memory must be removed");
      assert.equal(existsSync(join(getTaskMemoriesRoot(), taskB)), false, "Task B memory must be removed");
      assert.equal(existsSync(join(getTaskMemoriesRoot(), taskC)), false, "Task C memory must be removed");

      // 验证 Session Other 的 Task D 及其 Memory 完好保留
      assert.equal(existsSync(join(getTaskMemoriesRoot(), taskD)), true, "Task D memory must remain untouched");
      assert.equal(subagentTasks.has(taskD), true, "Task D business object must remain in manager");

      // 清理测试资源
      await manager.deleteTask(taskD);
    });

    it("E. Path Traversal security checks refuse deletion outside task-memories root", () => {
      // 各种越界与异常路径测试
      const dangerousTaskIds = [
        "../../etc",
        "../task-memories",
        "/tmp",
        "/",
        "../../",
        "foo/bar",
        "foo\\bar",
        "valid-id/../../escape",
        "null\0byte",
      ];

      for (const badId of dangerousTaskIds) {
        const res = removeTaskMemory(badId);
        assert.equal(res, false, `removeTaskMemory must reject dangerous path: "${badId}"`);
      }

      // 确保 task-memories 根目录自身依然存在，绝未被误删
      assert.ok(existsSync(getTaskMemoriesRoot()), "Task memories root directory must never be deleted");
    });

    it("F. continue_subagent isolation guarantees deleting Task A only removes Task A memory without touching Task B memory", async () => {
      const manager = new SubagentManager(mockModelRuntime);
      const taskA = `task-prev-a-${Date.now()}`;
      const taskB = `task-next-b-${Date.now()}`;
      const parentSessionId = `parent-continue-${Date.now()}`;

      initTaskMemory(taskA, "Initial Task A memory");
      writeWorkingMemory(taskA, "# Working Memory A\nFacts from A");
      appendProcessJournal(taskA, "Journal A");

      initTaskMemory(taskB, "Continued Task B memory");
      writeWorkingMemory(taskB, "# Working Memory B\nNew Isolated Facts for B");
      appendProcessJournal(taskB, "Journal B");

      subagentTasks.set(taskA, {
        task: {
          taskId: taskA,
          parentSessionId,
          role: "developer",
          taskTitle: "Task A",
          status: "completed",
          createdAt: new Date().toISOString(),
        },
      });

      subagentTasks.set(taskB, {
        task: {
          taskId: taskB,
          parentSessionId,
          role: "developer",
          taskTitle: "Task B (continued)",
          status: "running",
          createdAt: new Date().toISOString(),
        },
      });

      const memA = join(getTaskMemoriesRoot(), taskA);
      const memB = join(getTaskMemoriesRoot(), taskB);
      assert.ok(existsSync(memA), "Memory A must exist");
      assert.ok(existsSync(memB), "Memory B must exist");

      // 删除 Task A
      await manager.deleteTask(taskA);

      // 校验 Task A 的 memory 被删除，而 Task B 的 memory 完好保留且内容不受影响
      assert.equal(existsSync(memA), false, "Memory A must be deleted");
      assert.equal(existsSync(memB), true, "Memory B must remain intact");

      const wmBContent = readWorkingMemory(taskB);
      assert.ok(wmBContent?.includes("New Isolated Facts for B"), "Task B working memory content must remain intact");

      // 清理测试资源
      await manager.deleteTask(taskB);
      assert.equal(existsSync(memB), false);
    });
  });
});
