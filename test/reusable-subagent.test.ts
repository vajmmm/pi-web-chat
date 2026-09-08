import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const testAgentDir = mkdtempSync(join(tmpdir(), "pi-reuse-test-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

import { getRoleConfig, getRoleDefinition, RoleRegistry } from "../server/contracts/index.ts";
import {
  MAX_SUBAGENT_REUSE,
  extractKnowledgeFromTask,
  formatKnowledgeForPrompt,
  buildContinueBoundaryPrompt,
  ReusableSubagentRegistry,
} from "../server/reusable-subagent.ts";
import {
  buildSubagentUserPrompt,
  subagentTasks,
  SubagentManager,
} from "../server/subagent-manager.ts";
import { createCoordinatorExtension } from "../server/coordinator-tools.ts";

const mockModelRuntime = { getModel: () => null } as any;

function createMockSession(
  messages: any[] = [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }],
) {
  const subscribers: ((event: any) => void)[] = [];
  const normalizedMessages =
    messages.length > 0
      ? messages.map((m) => {
          if (m && m.role === "assistant" && m.stopReason === undefined && m.rawStopReason === undefined) {
            return { stopReason: "stop", ...m };
          }
          return m;
        })
      : [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }];

  return {
    messages: normalizedMessages,
    subscribe: (fn: (event: any) => void) => {
      subscribers.push(fn);
    },
    prompt: async () => {},
    setModel: async () => {},
    setThinkingLevel: () => {},
    setActiveToolsByName: () => {},
    model: { provider: "mock", id: "mock-model", name: "Mock Model" },
    emit: (event: any) => {
      for (const s of subscribers) s(event);
    },
  };
}

function explorationMessages() {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "c1",
          name: "bash",
          arguments: { command: "which python && python --version" },
        },
        {
          type: "toolCall",
          id: "c2",
          name: "bash",
          arguments: { command: "pytest --version" },
        },
        {
          type: "toolCall",
          id: "c3",
          name: "bash",
          arguments: { command: "ls /Users/me/missing-py39" },
        },
        { type: "text", text: "Environment ready. pytest works." },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      content: [{ type: "text", text: "/opt/anaconda3/envs/py39/bin/python\nPython 3.9.18" }],
      isError: false,
    },
    {
      role: "toolResult",
      toolCallId: "c2",
      content: [{ type: "text", text: "pytest 8.3.2" }],
      isError: false,
    },
    {
      role: "toolResult",
      toolCallId: "c3",
      content: [{ type: "text", text: "No such file or directory" }],
      isError: true,
    },
    {
      role: "assistant",
      stopReason: "stop",
      content: [
        {
          type: "text",
          text: "Known: use /opt/anaconda3/envs/py39/bin/python. Evidence in docs/evidence/spike-20260901/. Avoid /Users/me/missing-py39.",
        },
      ],
    },
  ];
}

describe("Reusable Subagent (Scheme B)", () => {
  let gitRepoDir: string;

  before(() => {
    RoleRegistry.getInstance().reload();
    gitRepoDir = mkdtempSync(join(tmpdir(), "pi-reuse-repo-"));
    execFileSync("git", ["init", "-b", "main", gitRepoDir]);
    execFileSync("git", ["-C", gitRepoDir, "config", "user.name", "Test Agent"]);
    execFileSync("git", ["-C", gitRepoDir, "config", "user.email", "agent@test.com"]);
    writeFileSync(join(gitRepoDir, ".gitignore"), ".worktrees\n");
    writeFileSync(join(gitRepoDir, "README.md"), "# reuse test\n");
    mkdirSync(join(gitRepoDir, "docs", "evidence", "spike-20260901"), { recursive: true });
    writeFileSync(join(gitRepoDir, "docs", "evidence", "spike-20260901", "note.md"), "ok\n");
    execFileSync("git", ["-C", gitRepoDir, "add", "."]);
    execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "init"]);
  });

  after(() => {
    try {
      rmSync(testAgentDir, { recursive: true, force: true });
      rmSync(gitRepoDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    subagentTasks.clear();
  });

  describe("rule-based knowledge extraction", () => {
    it("extracts env facts, commands, paths, and failed approaches without transcript dump", () => {
      const task: UISubagentTask = {
        taskId: "task-extract-1",
        parentSessionId: "s1",
        role: "verifier",
        taskTitle: "Spike-05",
        taskPrompt: "explore pytest",
        status: "completed",
        createdAt: new Date().toISOString(),
        changedFiles: ["docs/evidence/spike-20260901/note.md"],
        logs: ["[Tool] bash -> Success", "[Tool] bash -> Error"],
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "c1",
                name: "bash",
                args: { command: "which python && python --version" },
                result: {
                  text: "/opt/anaconda3/envs/py39/bin/python\nPython 3.9.18",
                  isError: false,
                },
              },
              {
                type: "toolCall",
                id: "c2",
                name: "bash",
                args: { command: "pytest --version" },
                result: { text: "pytest 8.3.2", isError: false },
              },
              {
                type: "toolCall",
                id: "c3",
                name: "bash",
                args: { command: "ls /Users/me/missing-py39" },
                result: { text: "No such file or directory", isError: true },
              },
              {
                type: "text",
                text: "Use docs/evidence/spike-20260901/ and /opt/anaconda3/envs/py39/bin/python",
              },
            ],
          },
        ],
      };

      const knowledge = extractKnowledgeFromTask(task);
      assert.ok(knowledge.environmentFacts.some((f) => f.includes("python") || f.includes("py39")));
      assert.ok(knowledge.knownCommands.some((c) => c.includes("pytest") || c.includes("python")));
      assert.ok(
        knowledge.relevantFiles.some((p) => p.includes("docs/evidence/spike-20260901")),
      );
      assert.ok(knowledge.failedApproaches.some((f) => f.includes("missing-py39")));
      const blob = JSON.stringify(knowledge);
      assert.ok(!blob.includes('"role":"assistant"'));
      assert.ok(blob.length < 8000);
    });

    it("records only stable env/path unavailability in failedApproaches and keeps command/output paired", () => {
      const task: UISubagentTask = {
        taskId: "task-extract-failures",
        parentSessionId: "s1",
        role: "verifier",
        taskTitle: "mixed failures",
        taskPrompt: "x",
        status: "completed",
        createdAt: new Date().toISOString(),
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "f1",
                name: "bash",
                args: { command: "ls /opt/does-not-exist/bin/python" },
                result: { text: "No such file or directory", isError: true },
              },
              {
                type: "toolCall",
                id: "f2",
                name: "bash",
                args: { command: "pytest tests/test_login.py -q" },
                result: {
                  text: "FAILED tests/test_login.py::test_ok - AssertionError: expected 200",
                  isError: true,
                },
              },
              {
                type: "toolCall",
                id: "f3",
                name: "bash",
                args: { command: "python /tmp/missing_script.py" },
                result: { text: "", isError: true },
              },
              {
                type: "toolCall",
                id: "f4",
                name: "bash",
                args: { command: "which py39-missing" },
                result: { text: "py39-missing not found", isError: true },
              },
              {
                type: "toolCall",
                id: "f5",
                name: "bash",
                args: { command: "npm test" },
                result: { text: "Test suite failed\n1 failing", isError: true },
              },
            ],
          },
        ],
      };

      const knowledge = extractKnowledgeFromTask(task);
      assert.ok(
        knowledge.failedApproaches.some((f) => f.includes("/opt/does-not-exist/bin/python")),
        "stable missing path should be kept",
      );
      assert.ok(
        knowledge.failedApproaches.some((f) => f.includes("py39-missing")),
        "command-not-found style env failure should be kept",
      );
      assert.ok(
        !knowledge.failedApproaches.some((f) => /AssertionError|FAILED tests\/|Test suite failed/i.test(f)),
        "ordinary test failures must not become long-term knowledge",
      );
      // Empty-output error must not shift pairing: py39-missing output stays with its command
      const py39 = knowledge.failedApproaches.find((f) => f.includes("py39-missing"));
      assert.ok(py39);
      assert.ok(/py39-missing/.test(py39!));
      assert.ok(!/AssertionError/.test(py39!));
      assert.ok(!knowledge.failedApproaches.some((f) => f.includes("missing_script.py")));
    });

    it("formats knowledge and new-task boundary for prompt injection", () => {
      const knowledge = extractKnowledgeFromTask({
        taskId: "t1",
        parentSessionId: "s1",
        role: "verifier",
        taskTitle: "Spike-05",
        taskPrompt: "x",
        status: "completed",
        createdAt: new Date().toISOString(),
        changedFiles: ["src/a.ts"],
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "c1",
                name: "bash",
                args: { command: "node -v" },
                result: { text: "v20.11.0", isError: false },
              },
            ],
          },
        ],
      });

      const section = formatKnowledgeForPrompt(knowledge);
      assert.ok(section.includes("Reusable Knowledge"));
      assert.ok(!section.includes("Acceptance Criteria"));

      const boundary = buildContinueBoundaryPrompt({
        taskId: "task-b",
        goal: "Spike-06",
        scopeInclude: ["docs/**"],
        acceptanceCriteria: ["produce evidence note"],
        knowledge,
      });
      assert.ok(boundary.includes("===== NEW TASK ====="));
      assert.ok(boundary.includes("task-b"));
      assert.ok(boundary.includes("不得继承上一任务的"));
      assert.ok(boundary.includes("Reusable Knowledge") || boundary.includes("Known"));
    });
  });

  describe("registry lifecycle", () => {
    it("creates running agent and becomes idle_reusable only after completed knowledge update", () => {
      const registry = new ReusableSubagentRegistry();
      const agent = registry.create({
        parentSessionId: "parent-1",
        role: "verifier",
        taskId: "task-a",
        taskTitle: "Spike-05",
      });
      assert.equal(agent.state, "running");
      assert.equal(agent.reuseCount, 0);

      const taskLike: UISubagentTask = {
        taskId: "task-a",
        parentSessionId: "parent-1",
        role: "verifier",
        taskTitle: "Spike-05",
        taskPrompt: "x",
        status: "completed",
        createdAt: new Date().toISOString(),
        changedFiles: ["README.md"],
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "c1",
                name: "bash",
                args: { command: "pwd" },
                result: { text: "/tmp/proj", isError: false },
              },
            ],
          },
        ],
      };
      const after = registry.markCompleted(agent.agentId, taskLike);
      assert.equal(after.state, "idle_reusable");
      assert.ok(after.knowledge.knownCommands.length + after.knowledge.relevantFiles.length > 0);
      assert.equal(after.reuseCount, 0);
    });

    it(`refuses continue after ${MAX_SUBAGENT_REUSE} reuses and retires`, () => {
      const registry = new ReusableSubagentRegistry();
      const agent = registry.create({
        parentSessionId: "parent-2",
        role: "verifier",
        taskId: "task-0",
        taskTitle: "T0",
      });
      const baseTask = (id: string): UISubagentTask => ({
        taskId: id,
        parentSessionId: "parent-2",
        role: "verifier",
        taskTitle: id,
        taskPrompt: "x",
        status: "completed",
        createdAt: new Date().toISOString(),
        messages: [],
      });
      registry.markCompleted(agent.agentId, baseTask("task-0"));

      for (let i = 1; i <= MAX_SUBAGENT_REUSE; i++) {
        const gate = registry.beginContinue(agent.agentId, `task-${i}`, `T${i}`);
        assert.equal(gate.ok, true, `continue #${i} should be allowed`);
        registry.markCompleted(agent.agentId, baseTask(`task-${i}`));
      }

      const blocked = registry.beginContinue(agent.agentId, "task-overflow", "overflow");
      assert.equal(blocked.ok, false);
      assert.equal(registry.get(agent.agentId)?.state, "retired");
      assert.equal(registry.get(agent.agentId)?.reuseCount, MAX_SUBAGENT_REUSE);
    });
  });

  describe("SubagentManager continue path", () => {
    it("spawn creates reusable agentId; completion unlocks idle_reusable; continue creates new task/worktree/session with knowledge", async () => {
      const manager = new SubagentManager(mockModelRuntime);
      const parentSessionId = `session-reuse-${Date.now()}`;
      const taskAId = `task-reuse-a-${Date.now()}`;

      const taskA = await manager.spawn({
        parentSessionId,
        role: "developer",
        taskTitle: "Spike-05 env discovery",
        taskPrompt: "Discover python and pytest",
        parentCwd: gitRepoDir,
        customSession: createMockSession(explorationMessages()),
        taskContract: {
          taskId: taskAId,
          parentSessionId,
          role: "developer",
          goal: "Discover python and pytest",
          expectedEffects: ["code_change"],
        },
      });

      assert.ok(taskA.agentId, "spawn must attach agentId");
      assert.ok(taskA.worktreePath);
      const agentId = taskA.agentId!;

      await manager.handleSubagentCompletion(taskAId);
      assert.equal(taskA.status, "completed");

      const listed = manager.listReusableAgents(parentSessionId);
      const idle = listed.find((a) => a.agentId === agentId);
      assert.equal(idle?.state, "idle_reusable");
      assert.ok(
        (idle?.knowledge.environmentFacts.length ?? 0) +
          (idle?.knowledge.knownCommands.length ?? 0) +
          (idle?.knowledge.relevantFiles.length ?? 0) >
          0,
      );

      const taskBId = `task-reuse-b-${Date.now()}`;
      const continued = await manager.continueAgent({
        agentId,
        parentSessionId,
        taskTitle: "Spike-06 follow-up",
        taskPrompt: "Run a related check using known env",
        parentCwd: gitRepoDir,
        parentModel: null,
        customSession: createMockSession([
          { role: "assistant", content: [{ type: "text", text: "used prior knowledge" }] },
        ]),
        taskContract: {
          taskId: taskBId,
          parentSessionId,
          role: "developer",
          goal: "Spike-06 follow-up",
          expectedEffects: ["code_change"],
          acceptanceCriteria: ["reuse prior env facts"],
        },
      });

      assert.equal(continued.taskId, taskBId);
      assert.notEqual(continued.taskId, taskAId);
      assert.equal(continued.agentId, agentId);
      assert.ok(continued.worktreePath);
      assert.notEqual(continued.worktreePath, taskA.worktreePath);
      assert.equal(continued.status, "running");

      // New underlying session (customSession) + injected knowledge in stored prompt
      assert.ok(continued.taskPrompt.includes("===== NEW TASK ====="));
      assert.ok(
        continued.taskPrompt.includes("Reusable Knowledge") ||
          continued.taskPrompt.includes("Known environment") ||
          continued.taskPrompt.includes("python"),
      );
      assert.ok(!continued.taskPrompt.includes('"role":"assistant"'));

      const afterContinue = manager.listReusableAgents(parentSessionId).find((a) => a.agentId === agentId);
      assert.equal(afterContinue?.state, "running");
      assert.equal(afterContinue?.reuseCount, 1);
      assert.equal(afterContinue?.lastTaskId, taskBId);
    });

    it("rolls back reusable agent when continueAgent spawn/start fails after beginContinue", async () => {
      const manager = new SubagentManager(mockModelRuntime);
      const parentSessionId = `session-rollback-${Date.now()}`;
      const taskId = `task-rollback-a-${Date.now()}`;

      const task = await manager.spawn({
        parentSessionId,
        role: "developer",
        taskTitle: "seed",
        taskPrompt: "seed",
        parentCwd: gitRepoDir,
        customSession: createMockSession(explorationMessages()),
        taskContract: {
          taskId,
          parentSessionId,
          role: "developer",
          goal: "seed",
        },
      });
      await manager.handleSubagentCompletion(taskId);

      const agentId = task.agentId!;
      const before = manager.reusableAgents.get(agentId)!;
      assert.equal(before.state, "idle_reusable");
      assert.equal(before.reuseCount, 0);
      const prevLastTaskId = before.lastTaskId;
      const prevLastTaskTitle = before.lastTaskTitle;

      await assert.rejects(
        () =>
          manager.continueAgent({
            agentId,
            parentSessionId,
            taskTitle: "should fail start",
            taskPrompt: "x",
            parentCwd: "/path/that/does/not/exist/for-continue-rollback",
            parentModel: null,
            taskContract: {
              taskId: `task-rollback-b-${Date.now()}`,
              parentSessionId,
              role: "developer",
              goal: "fail",
            },
          }),
        /SubagentManager|not inside a Git repository|worktree|Fail-closed|ENOENT|no such file/i,
      );

      const after = manager.reusableAgents.get(agentId)!;
      assert.equal(after.state, "idle_reusable", "must not stay stuck in running");
      assert.equal(after.reuseCount, 0, "reuseCount must roll back");
      assert.equal(after.lastTaskId, prevLastTaskId);
      assert.equal(after.lastTaskTitle, prevLastTaskTitle);
    });

    it("does not update knowledge on failed tasks", async () => {
      const manager = new SubagentManager(mockModelRuntime);
      const parentSessionId = `session-failed-${Date.now()}`;
      const taskId = `task-failed-${Date.now()}`;

      const failingSession = createMockSession(explorationMessages());
      // Emulate session failure: finishReason = error
      const lastMsg = failingSession.messages[failingSession.messages.length - 1] as any;
      lastMsg.stopReason = "error";
      lastMsg.rawStopReason = "error";

      const task = await manager.spawn({
        parentSessionId,
        role: "verifier",
        taskTitle: "will fail",
        taskPrompt: "x",
        parentCwd: gitRepoDir,
        customSession: failingSession as any,
        taskContract: {
          taskId,
          parentSessionId,
          role: "verifier",
          goal: "x",
        },
      });
      await manager.handleSubagentCompletion(taskId);
      assert.equal(task.status, "failed");

      const agent = manager.listReusableAgents(parentSessionId).find((a) => a.agentId === task.agentId);
      assert.ok(agent);
      assert.notEqual(agent!.state, "idle_reusable");
      assert.equal(agent!.knowledge.environmentFacts.length, 0);
    });
  });

  describe("coordinator tools", () => {
    it("registers list_subagents and continue_subagent; coordinator allowlist includes them", () => {
      const coordinator = getRoleConfig("coordinator");
      assert.ok(coordinator.allowedTools?.includes("list_subagents"));
      assert.ok(coordinator.allowedTools?.includes("continue_subagent"));
      assert.ok(coordinator.allowedTools?.includes("spawn_subagent"));

      const manager = new SubagentManager(mockModelRuntime);
      const registered: string[] = [];
      const fakePi = {
        registerTool: (tool: { name: string }) => {
          registered.push(tool.name);
        },
        on: () => {},
      };
      const ext = createCoordinatorExtension(manager, () => ({
        parentSessionId: "p",
        parentCwd: gitRepoDir,
        parentModel: null,
        activeRole: "coordinator",
      }));
      ext.factory(fakePi as any);
      assert.ok(registered.includes("list_subagents"));
      assert.ok(registered.includes("continue_subagent"));
      assert.ok(registered.includes("spawn_subagent"));
    });

    it("list_subagents returns reusable agents with preview fields", async () => {
      const manager = new SubagentManager(mockModelRuntime);
      const parentSessionId = `session-list-${Date.now()}`;
      const taskId = `task-list-${Date.now()}`;
      const task = await manager.spawn({
        parentSessionId,
        role: "verifier",
        taskTitle: "Spike-05",
        taskPrompt: "discover",
        parentCwd: gitRepoDir,
        customSession: createMockSession(explorationMessages()),
        taskContract: {
          taskId,
          parentSessionId,
          role: "verifier",
          goal: "discover",
        },
      });
      await manager.handleSubagentCompletion(taskId);

      const registered: Record<string, any> = {};
      const fakePi = {
        registerTool: (tool: any) => {
          registered[tool.name] = tool;
        },
        on: () => {},
      };
      const ext = createCoordinatorExtension(manager, () => ({
        parentSessionId,
        parentCwd: gitRepoDir,
        parentModel: null,
        activeRole: "coordinator",
      }));
      ext.factory(fakePi as any);

      const result = await registered.list_subagents.execute("call-1", {});
      const payload = JSON.parse(result.content[0].text);
      assert.ok(Array.isArray(payload.tasks));
      assert.ok(Array.isArray(payload.reusable_agents));
      const agent = payload.reusable_agents.find((a: any) => a.agent_id === task.agentId);
      assert.ok(agent);
      assert.equal(agent.state, "idle_reusable");
      assert.equal(agent.role, "verifier");
      assert.equal(agent.last_task_id, taskId);
      assert.ok(typeof agent.reuse_count === "number");
      assert.ok(Array.isArray(agent.topics));
      assert.ok(agent.knowledge_preview);
    });

    it("list_subagents filters tasks by status and limits count", async () => {
      const manager = new SubagentManager(mockModelRuntime);
      const parentSessionId = `session-filter-${Date.now()}`;
      const taskId1 = `task-filter-1-${Date.now()}`;
      const taskId2 = `task-filter-2-${Date.now()}`;
      const task1 = await manager.spawn({
        parentSessionId,
        role: "verifier",
        taskTitle: "Task-1",
        taskPrompt: "prompt-1",
        parentCwd: gitRepoDir,
        customSession: createMockSession(explorationMessages()),
        taskContract: {
          taskId: taskId1,
          parentSessionId,
          role: "verifier",
          goal: "prompt-1",
        },
      });
      const task2 = await manager.spawn({
        parentSessionId,
        role: "verifier",
        taskTitle: "Task-2",
        taskPrompt: "prompt-2",
        parentCwd: gitRepoDir,
        customSession: createMockSession([]),
        taskContract: {
          taskId: taskId2,
          parentSessionId,
          role: "verifier",
          goal: "prompt-2",
        },
      });
      await manager.handleSubagentCompletion(taskId1);

      const registered: Record<string, any> = {};
      const fakePi = {
        registerTool: (tool: any) => {
          registered[tool.name] = tool;
        },
        on: () => {},
      };
      const ext = createCoordinatorExtension(manager, () => ({
        parentSessionId,
        parentCwd: gitRepoDir,
        parentModel: null,
        activeRole: "coordinator",
      }));
      ext.factory(fakePi as any);

      // Default (all) - should be sorted newest first (task2 then task1)
      const allRes = await registered.list_subagents.execute("call-all", {});
      const allPayload = JSON.parse(allRes.content[0].text);
      assert.equal(allPayload.tasks.length, 2);
      assert.equal(allPayload.tasks[0].task_id, task2.taskId);
      assert.equal(allPayload.tasks[1].task_id, task1.taskId);
      assert.ok(allPayload.tasks[0].created_at);

      // Filter: running
      const runningRes = await registered.list_subagents.execute("call-running", { status: "running" });
      const runningPayload = JSON.parse(runningRes.content[0].text);
      assert.equal(runningPayload.tasks.length, 1);
      assert.equal(runningPayload.tasks[0].task_id, task2.taskId);

      // Filter: completed
      const completedRes = await registered.list_subagents.execute("call-completed", { status: "completed" });
      const completedPayload = JSON.parse(completedRes.content[0].text);
      assert.equal(completedPayload.tasks.length, 1);
      assert.equal(completedPayload.tasks[0].task_id, task1.taskId);

      // Filter: active (running is active, completed is not)
      const activeRes = await registered.list_subagents.execute("call-active", { status: "active" });
      const activePayload = JSON.parse(activeRes.content[0].text);
      assert.equal(activePayload.tasks.length, 1);
      assert.equal(activePayload.tasks[0].task_id, task2.taskId);

      // Limit: 1 (returns newest task, which is task2)
      const limitRes = await registered.list_subagents.execute("call-limit", { limit: 1 });
      const limitPayload = JSON.parse(limitRes.content[0].text);
      assert.equal(limitPayload.tasks.length, 1);
      assert.equal(limitPayload.tasks[0].task_id, task2.taskId);
    });
  });

  describe("prompt builder keeps contract + knowledge separate", () => {
    it("buildSubagentUserPrompt can append continue boundary without copying transcript", () => {
      const prompt = buildSubagentUserPrompt("do follow-up", {
        taskId: "task-x",
        parentSessionId: "s",
        role: "verifier",
        goal: "follow-up",
        scope: { include: ["docs/**"], exclude: [] },
        acceptanceCriteria: ["ok"],
      }, {
        continueBoundary: buildContinueBoundaryPrompt({
          taskId: "task-x",
          goal: "follow-up",
          scopeInclude: ["docs/**"],
          acceptanceCriteria: ["ok"],
          knowledge: {
            repoFacts: ["monorepo"],
            environmentFacts: ["Python: /opt/anaconda3/envs/py39/bin/python"],
            relevantFiles: ["docs/evidence/spike-20260901/"],
            knownCommands: ["pytest --version"],
            failedApproaches: ["/Users/me/missing-py39 does not exist"],
            topics: ["pytest", "python"],
          },
        }),
      });
      assert.ok(prompt.includes("## Task Kickoff"));
      assert.ok(prompt.includes("===== NEW TASK ====="));
      assert.ok(prompt.includes("/opt/anaconda3/envs/py39/bin/python"));
      assert.ok(!prompt.includes("toolCall"));
    });
  });

  describe("Coordinator Tool continue_subagent real path lifecycle (Scenarios 1 - 5)", () => {
    function setupTools(manager: SubagentManager, parentSessionId: string, repoDir: string) {
      const registered: Record<string, any> = {};
      const fakePi = {
        registerTool: (tool: any) => {
          registered[tool.name] = tool;
        },
        on: () => {},
      };
      const ext = createCoordinatorExtension(manager, () => ({
        parentSessionId,
        parentCwd: repoDir,
        parentModel: null,
        activeRole: "coordinator",
        customSession: createMockSession(explorationMessages()),
      }));
      ext.factory(fakePi as any);
      return registered;
    }

    // Scenario 1: 正常 Continue
    it("Scenario 1: Normal continue_subagent via Tool execute transitions agent to running, increments reuseCount, and returns continued status", async () => {
      const manager = new SubagentManager(mockModelRuntime);
      const parentSessionId = `session-tool-scen1-${Date.now()}`;
      const taskIdA = `task-tool-1a-${Date.now()}`;

      const taskA = await manager.spawn({
        parentSessionId,
        role: "verifier",
        taskTitle: "Spike A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(explorationMessages()),
        taskContract: { taskId: taskIdA, parentSessionId, role: "verifier", goal: "Do A" },
      });
      await manager.handleSubagentCompletion(taskIdA);

      const agentId = taskA.agentId!;
      const agentBefore = manager.reusableAgents.get(agentId)!;
      assert.equal(agentBefore.state, "idle_reusable");
      assert.equal(agentBefore.reuseCount, 0);

      const tools = setupTools(manager, parentSessionId, gitRepoDir);

      const res = await tools.continue_subagent.execute("call-1", {
        agent_id: agentId,
        task_title: "Task B follow-up",
        prompt: "Do B",
      });

      assert.equal(res.isError, undefined);
      const payload = JSON.parse(res.content[0].text);
      assert.equal(payload.status, "continued");
      assert.equal(payload.agent_id, agentId);

      const agentDuring = manager.reusableAgents.get(agentId)!;
      assert.equal(agentDuring.state, "running");
      assert.equal(agentDuring.reuseCount, 1);
      assert.equal(agentDuring.lastTaskId, payload.task_id);

      await manager.handleSubagentCompletion(payload.task_id);
      const agentAfter = manager.reusableAgents.get(agentId)!;
      assert.equal(agentAfter.state, "idle_reusable");
      assert.equal(agentAfter.lastTaskId, payload.task_id);
    });

    // Scenario 2: 并发 Continue 被拒绝
    it("Scenario 2: Concurrent continue_subagent on already running agent is rejected via Tool execute", async () => {
      const manager = new SubagentManager(mockModelRuntime);
      const parentSessionId = `session-tool-scen2-${Date.now()}`;
      const taskIdA = `task-tool-2a-${Date.now()}`;

      const taskA = await manager.spawn({
        parentSessionId,
        role: "verifier",
        taskTitle: "Spike A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(explorationMessages()),
        taskContract: { taskId: taskIdA, parentSessionId, role: "verifier", goal: "Do A" },
      });
      await manager.handleSubagentCompletion(taskIdA);
      const agentId = taskA.agentId!;

      const tools = setupTools(manager, parentSessionId, gitRepoDir);

      // 1st continue: transitions to running
      const res1 = await tools.continue_subagent.execute("call-1", {
        agent_id: agentId,
        task_title: "Task B running",
        prompt: "Do B",
      });
      assert.equal(res1.isError, undefined);
      assert.equal(manager.reusableAgents.get(agentId)?.state, "running");

      // 2nd continue while A is running: must be rejected!
      const res2 = await tools.continue_subagent.execute("call-2", {
        agent_id: agentId,
        task_title: "Task C concurrent",
        prompt: "Do C",
      });
      assert.equal(res2.isError, true);
      assert.ok(res2.content[0].text.includes("is not idle_reusable"));
      assert.equal(manager.reusableAgents.get(agentId)?.state, "running");
      assert.equal(manager.reusableAgents.get(agentId)?.reuseCount, 1);
    });

    // Scenario 3: 启动失败 rollback
    it("Scenario 3: Startup failure triggers rollbackContinue and restores agent state via Tool execute", async () => {
      const manager = new SubagentManager(mockModelRuntime);
      const parentSessionId = `session-tool-scen3-${Date.now()}`;
      const taskIdA = `task-tool-3a-${Date.now()}`;

      const taskA = await manager.spawn({
        parentSessionId,
        role: "verifier",
        taskTitle: "Spike A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(explorationMessages()),
        taskContract: { taskId: taskIdA, parentSessionId, role: "verifier", goal: "Do A" },
      });
      await manager.handleSubagentCompletion(taskIdA);
      const agentId = taskA.agentId!;

      const tools = setupTools(manager, parentSessionId, gitRepoDir);

      const res = await tools.continue_subagent.execute("call-fail", {
        agent_id: agentId,
        task_title: "Task Fail",
        prompt: "Fail",
        cwd: "/path/that/does/not/exist/for-startup-failure",
      });

      assert.equal(res.isError, true);
      assert.ok(res.content[0].text.includes("失败"));

      const agentAfter = manager.reusableAgents.get(agentId)!;
      assert.equal(agentAfter.state, "idle_reusable");
      assert.equal(agentAfter.reuseCount, 0);
      assert.equal(agentAfter.lastTaskId, taskIdA);
    });

    // Scenario 4: Reuse 不自动变 Rework
    it("Scenario 4: Reuse without rework_of_task_id does not create rework lineage via Tool execute", async () => {
      const manager = new SubagentManager(mockModelRuntime);
      const parentSessionId = `session-tool-scen4-${Date.now()}`;
      const taskIdA = `task-tool-4a-${Date.now()}`;

      const taskA = await manager.spawn({
        parentSessionId,
        role: "verifier",
        taskTitle: "Spike A",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(explorationMessages()),
        taskContract: { taskId: taskIdA, parentSessionId, role: "verifier", goal: "Do A" },
      });
      await manager.handleSubagentCompletion(taskIdA);
      const agentId = taskA.agentId!;

      const tools = setupTools(manager, parentSessionId, gitRepoDir);

      const res = await tools.continue_subagent.execute("call-reuse", {
        agent_id: agentId,
        task_title: "Task B Independent",
        prompt: "Do B",
      });

      assert.equal(res.isError, undefined);
      const payload = JSON.parse(res.content[0].text);
      const taskB = manager.getTask(payload.task_id);
      assert.ok(taskB);
      assert.equal(taskB.reworkOfTaskId, undefined);
    });

    // Scenario 5: 显式 Rework
    it("Scenario 5: Explicit rework_of_task_id sets rework lineage and passes validateReworkTarget via Tool execute", async () => {
      const manager = new SubagentManager(mockModelRuntime);
      const parentSessionId = `session-tool-scen5-${Date.now()}`;
      const taskIdA = `task-tool-5a-${Date.now()}`;

      const taskA = await manager.spawn({
        parentSessionId,
        role: "verifier",
        taskTitle: "Task A Failed",
        taskPrompt: "Do A",
        parentCwd: gitRepoDir,
        customSession: createMockSession(explorationMessages()),
        taskContract: { taskId: taskIdA, parentSessionId, role: "verifier", goal: "Do A" },
      });
      taskA.status = "completed";
      taskA.verification = { diff: { name: "diff", status: "fail" }, scope: { name: "scope", status: "pass" }, commands: [], overall: "fail" };
      manager.reusableAgents.markCompleted(taskA.agentId!, taskA);
      const agentId = taskA.agentId!;

      const tools = setupTools(manager, parentSessionId, gitRepoDir);

      // 1. Explicit rework succeeds:
      const res = await tools.continue_subagent.execute("call-rework", {
        agent_id: agentId,
        task_title: "Task B Fix A",
        prompt: "Fix A",
        rework_of_task_id: taskIdA,
      });

      assert.equal(res.isError, undefined);
      const payload = JSON.parse(res.content[0].text);
      const taskB = manager.getTask(payload.task_id);
      assert.ok(taskB);
      assert.equal(taskB.reworkOfTaskId, taskIdA);

      // 2. Non-existent rework target is rejected via Tool execute:
      const taskBInstance = manager.getTask(payload.task_id)!;
      taskBInstance.status = "completed";
      taskBInstance.verification = { diff: { name: "diff", status: "pass" }, scope: { name: "scope", status: "pass" }, commands: [], overall: "pass" };
      manager.reusableAgents.markCompleted(agentId, taskBInstance);

      const resBad = await tools.continue_subagent.execute("call-bad", {
        agent_id: agentId,
        task_title: "Task Bad",
        prompt: "Bad",
        rework_of_task_id: "non-existent-task-id",
      });
      assert.equal(resBad.isError, true);
      assert.ok(resBad.content[0].text.includes("target task does not exist"));
    });
  });
});
