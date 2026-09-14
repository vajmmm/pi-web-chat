import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-coordinator-boundary-test-"));

import type { AgentRole, UISubagentTask } from "../shared/protocol.ts";
import {
  COORDINATOR_TASK_SUMMARY_LIMIT,
  COORDINATOR_TOOL_OUTPUT_LIMIT,
  createCoordinatorExtension,
} from "../server/coordinator-tools.ts";
import { DEFAULT_ROLE_TOOLS, getRoleConfig, getRoleDefinition, RoleRegistry, rolesPath } from "../server/contracts/index.ts";
import { getTaskRuntimeDir, readToolExecutionFacts } from "../server/runtime-artifacts.ts";
import { DEFAULT_OUTPUT_BUDGETS } from "../server/subagent/output-virtualizer.ts";
import { createTaskContextExtension } from "../server/subagent/compaction-evidence-index.ts";

function setupCoordinatorTools(
  task: UISubagentTask,
  activeRole: AgentRole = "coordinator",
): { tools: Record<string, any>; events: Record<string, Function>; setRole: (role: AgentRole) => void } {
  const tools: Record<string, any> = {};
  const events: Record<string, Function> = {};
  let currentRole = activeRole;
  const manager = {
    getTask: (taskId: string) => (taskId === task.taskId ? task : undefined),
  } as any;
  const extension = createCoordinatorExtension(manager, () => ({
    parentSessionId: task.parentSessionId,
    parentCwd: process.cwd(),
    activeRole: currentRole,
  }));

  extension.factory({
    registerTool: (tool: any) => {
      tools[tool.name] = tool;
    },
    on: (event: string, handler: Function) => {
      events[event] = handler;
    },
  } as any);

  return {
    tools,
    events,
    setRole: (role) => {
      currentRole = role;
    },
  };
}

function makeTask(overrides: Partial<UISubagentTask> = {}): UISubagentTask {
  return {
    taskId: "task-summary-1",
    parentSessionId: "parent-1",
    role: "verifier",
    agentId: "agent-1",
    taskTitle: "Investigate task",
    taskPrompt: "Inspect the failure",
    status: "failed",
    createdAt: new Date().toISOString(),
    error: "Root cause summary",
    summary: "Short task summary",
    logs: ["[Tool] bash -> Error FULL_LOG_SENTINEL"],
    messages: [{ role: "assistant", content: [{ type: "text", text: "FULL_HISTORY_SENTINEL" }] } as any],
    taskResult: {
      taskId: "task-summary-1",
      role: "verifier",
      status: "failed",
      summary: "Result summary",
      completedAt: new Date().toISOString(),
      verification: {
        diff: { name: "diff", status: "fail", detail: "Diff failure summary" },
        scope: { name: "scope", status: "pass" },
        commands: [],
        overall: "fail",
      },
    },
    verification: {
      diff: { name: "diff", status: "fail", detail: "Diff failure summary" },
      scope: { name: "scope", status: "pass" },
      commands: [],
      overall: "fail",
    },
    ...overrides,
  } as UISubagentTask;
}

function taskContextHandler(role: AgentRole, runId = "parent-1"): Function {
  const events: Record<string, Function> = {};
  createTaskContextExtension({
    runId,
    taskId: "coordinator",
    role,
    state: { compactionCount: 0 },
  }).factory({ on: (event: string, handler: Function) => { events[event] = handler; } } as any);
  return events.tool_result;
}

describe("Coordinator delegation and task evidence boundaries", () => {
  it("uses the intended role-specific default tool output budgets", () => {
    assert.equal(COORDINATOR_TOOL_OUTPUT_LIMIT, 24 * 1024);
    assert.equal(DEFAULT_OUTPUT_BUDGETS.coordinator, 24 * 1024);
    assert.equal(DEFAULT_OUTPUT_BUDGETS.subagent, 32 * 1024);
    assert.equal(DEFAULT_OUTPUT_BUDGETS.verifier, 40 * 1024);
    assert.equal(COORDINATOR_TASK_SUMMARY_LIMIT, 4 * 1024);
  });

  it("describes bounded task evidence and keeps Subagent dispatch asynchronous", () => {
    const { tools } = setupCoordinatorTools(makeTask());
    assert.match(tools.get_task_summary.description, /TaskEpisodeView|有界 Task 状态视图/);
    assert.doesNotMatch(tools.get_task_summary.description, /压缩状态/);
    const spawnText = [
      tools.spawn_subagent.description,
      tools.spawn_subagent.promptSnippet,
      ...(tools.spawn_subagent.promptGuidelines ?? []),
    ].join("\n");
    const continueText = [
      tools.continue_subagent.description,
      ...(tools.continue_subagent.promptGuidelines ?? []),
    ].join("\n");
    assert.match(spawnText, /异步/);
    assert.match(spawnText, /Runtime/);
    assert.match(spawnText, /不要轮询或探测/);
    assert.match(spawnText, /Developer\/Verifier/);
    assert.match(spawnText, /Researcher.*只读|只读.*Researcher/);
    assert.match(spawnText, /小而明确、自包含/);
    assert.match(spawnText, /不要求代码实现闭环/);
    assert.match(spawnText, /减少 Coordinator Context 消耗或带来有价值并行/);
    assert.doesNotMatch(spawnText, /必须从 list_available_roles 获取|派发前可调用 list_available_roles/);
    assert.doesNotMatch(spawnText, /Scout Gate|Worktree Reclamation|TaskEpisodeView/);
    assert.match(tools.list_available_roles.description, /按需/);
    assert.match(tools.list_available_roles.description, /不是调用 spawn_subagent 的强制前置步骤/);
    assert.match(continueText, /异步/);
    assert.match(continueText, /Runtime 会自动回传结果/);
    assert.match(continueText, /不要轮询或探测/);
    assert.match(continueText, /rework_of_task_id/);
    assert.doesNotMatch(continueText, /新 Worktree|新 Session|Knowledge 注入|Scout Gate|Worktree Reclamation/);
  });

  it("accepts a canonical Researcher probe without a list_available_roles call", async () => {
    let spawnedRole: string | undefined;
    const tools: Record<string, any> = {};
    const manager = {
      getTask: () => undefined,
      spawn: async (options: { role: string }) => {
        spawnedRole = options.role;
        return makeTask({
          taskId: "researcher-probe-1",
          role: "researcher",
          status: "running",
          agentId: "agent-researcher-1",
        });
      },
    } as any;
    const extension = createCoordinatorExtension(manager, () => ({
      parentSessionId: "parent-1",
      parentCwd: process.cwd(),
      activeRole: "coordinator",
    }));
    extension.factory({
      registerTool: (tool: any) => { tools[tool.name] = tool; },
      on: () => {},
    } as any);

    const result = await tools.spawn_subagent.execute("call-researcher-probe", {
      role: "researcher",
      task_title: "核对调用链入口",
      prompt: "只读确认该行为的实际调用链并返回 file:line 证据。",
      goal: "确认调用链入口",
      expected_effects: ["analysis"],
      acceptance_criteria: ["返回事实、证据和出处"],
    });

    assert.equal(result.isError, undefined);
    assert.equal(spawnedRole, "researcher");
  });

  it("uses Researcher defaults for a probe and preserves explicit contract fields", async () => {
    const received: any[] = [];
    const tools: Record<string, any> = {};
    const manager = {
      getTask: () => undefined,
      spawn: async (options: any) => {
        received.push(options);
        return makeTask({ role: options.role, status: "running" });
      },
    } as any;
    createCoordinatorExtension(manager, () => ({
      parentSessionId: "parent-1",
      parentCwd: process.cwd(),
      activeRole: "coordinator",
    })).factory({
      registerTool: (tool: any) => { tools[tool.name] = tool; },
      on: () => {},
    } as any);

    await tools.spawn_subagent.execute("call-default-researcher", {
      role: "researcher",
      task_title: "核对事实",
      prompt: "只读核对事实并返回出处。",
    });
    assert.deepEqual(received[0].taskContract.expectedEffects, ["analysis"]);
    assert.deepEqual(received[0].taskContract.scope, { include: [], exclude: [] });
    assert.deepEqual(received[0].taskContract.acceptanceCriteria, ["返回请求的事实结论、关键证据与出处"]);

    await tools.spawn_subagent.execute("call-explicit-researcher", {
      role: "researcher",
      task_title: "按显式契约核对",
      prompt: "只读核对。",
      expected_effects: [],
      scope_include: ["docs/**"],
      scope_exclude: ["docs/private/**"],
      acceptance_criteria: ["返回指定证据"],
    });
    assert.deepEqual(received[1].taskContract.expectedEffects, []);
    assert.deepEqual(received[1].taskContract.scope, {
      include: ["docs/**"],
      exclude: ["docs/private/**"],
    });
    assert.deepEqual(received[1].taskContract.acceptanceCriteria, ["返回指定证据"]);
  });

  it("documents proactive read-only Researcher scouting and Runtime-owned Integration lifecycle", () => {
    const coordinator = getRoleDefinition("coordinator");
    assert.match(coordinator.instructions, /Delegation is optional, not a goal/);
    assert.match(coordinator.instructions, /implementation delegation.*read-only scouting/);
    assert.match(coordinator.instructions, /Researcher 是 Coordinator 手边低成本、高频、可并行的只读探索工具/);
    assert.match(coordinator.instructions, /不要等到调查已经变大或变复杂/);
    assert.match(coordinator.instructions, /preserve Coordinator context or gain useful parallelism/);
    assert.match(coordinator.instructions, /小而明确、自包含的 factual probe 是合法且鼓励的 Researcher 用途/);
    assert.match(coordinator.instructions, /简单、明确的一次性定向 read\/grep 仍可由 Coordinator 直接完成/);
    assert.doesNotMatch(coordinator.instructions, /Researcher preferred, not required/);
    assert.doesNotMatch(coordinator.instructions, /每次.*(?:必须|至少|固定).*(?:Scout|Researcher)/);
    assert.doesNotMatch(coordinator.instructions, /(?:至少|固定).*(?:Scout|Researcher)/);
    assert.doesNotMatch(coordinator.instructions, /比例|调用次数/);
    assert.match(coordinator.instructions, /Worktree \/ runtime branch lifecycle is owned by Runtime/);
    assert.match(coordinator.instructions, /Coordinator does not own Harness worktree cleanup/);
    assert.match(coordinator.instructions, /不要通过 bash\/git 手工清理 Harness 创建的 Task\/Integration Worktree 或 Task\/Integration runtime branch/);
    assert.match(coordinator.instructions, /Integration Workspace remains available through required verification\/rework/);
    assert.match(coordinator.instructions, /Runtime owns final resource reclamation/);
    assert.doesNotMatch(
      coordinator.instructions,
      /Scout Gate|Worktree Reclamation|git worktree remove|同步后立即 cleanup|Verifier 完成前不能 cleanup/,
    );
    assert.ok(
      coordinator.strictProhibitions.some((p) => p.includes("不适用于自包含的低成本 Researcher factual probe")),
      "Researcher factual probes must remain outside the process-only micro-task prohibition",
    );
    assert.ok(getRoleConfig("coordinator").allowedTools?.includes("get_task_summary"));
  });

  it("virtualizes oversized Coordinator bash/read results with a recoverable pointer", async () => {
    const onToolResult = taskContextHandler("coordinator");
    const oversized = `RAW_HEAD\n${"x".repeat(COORDINATOR_TOOL_OUTPUT_LIMIT + 500)}\nRAW_TAIL`;

    for (const toolName of ["bash", "read"]) {
      const patch = await onToolResult({
        toolCallId: `oversized-${toolName}`,
        toolName,
        content: [{ type: "text", text: oversized }],
      });
      assert.ok(patch, `${toolName} should be truncated`);
      const output = patch.content[0].text;
      assert.ok(Buffer.byteLength(output, "utf8") <= COORDINATOR_TOOL_OUTPUT_LIMIT);
      assert.match(output, /Full output: artifacts:\/\/runs\//);
      assert.match(output, /Runtime path:/);
      assert.match(output, /RAW_HEAD/);
      assert.match(output, /RAW_TAIL/);
      const runtimePath = output.match(/\[Runtime path: ([^\]]+)\]/)?.[1];
      assert.ok(runtimePath);
      assert.equal(readFileSync(runtimePath, "utf8"), oversized);
    }
    assert.equal(readToolExecutionFacts("parent-1", "coordinator")
      .filter((fact) => fact.toolCallId.startsWith("oversized-")).length, 2);
  });

  it("returns Coordinator output below 24KB unchanged while still persisting it", async () => {
    const onToolResult = taskContextHandler("coordinator");
    const raw = `SMALL_HEAD\n${"x".repeat(COORDINATOR_TOOL_OUTPUT_LIMIT - 1024)}\nSMALL_TAIL`;
    const patch = await onToolResult({
      toolCallId: "small-bash",
      toolName: "bash",
      content: [{ type: "text", text: raw }],
    });

    assert.equal(patch, undefined);
    const runtimePath = `${getTaskRuntimeDir("parent-1", "coordinator")}/tool_outputs/small-bash_bash.log`;
    assert.equal(readFileSync(runtimePath, "utf8"), raw);
  });

  it("uses role-specific Task Context budgets", async () => {
    const oversized = "x".repeat(COORDINATOR_TOOL_OUTPUT_LIMIT + 500);

    for (const role of ["verifier", "developer"] as const) {
      const patch = await taskContextHandler(role, `parent-${role}`)({
        toolCallId: `budget-${role}`,
        toolName: "bash",
        content: [{ type: "text", text: oversized }],
      });
      assert.equal(patch, undefined, `${role} must retain its existing tool output behavior`);
    }
  });

  it("returns a bounded structured task summary without history or complete logs", async () => {
    const task = makeTask();
    const { tools } = setupCoordinatorTools(task);
    const result = await tools.get_task_summary.execute("call-1", { taskId: task.taskId });
    const output = result.content[0].text;
    const summary = JSON.parse(output);

    assert.ok(Buffer.byteLength(output, "utf8") <= COORDINATOR_TASK_SUMMARY_LIMIT);
    assert.deepEqual(
      Object.keys(summary).sort(),
      [
        "agent",
        "error",
        "failureSummary",
        "lastMeaningfulFailure",
        "resultSummary",
        "role",
        "status",
        "taskId",
        "truncated",
        "verificationStatus",
      ].sort(),
    );
    assert.equal(summary.taskId, task.taskId);
    assert.equal(summary.status, "failed");
    assert.equal(summary.role, "verifier");
    assert.equal(summary.agent, "agent-1");
    assert.equal(summary.verificationStatus, "fail");
    assert.equal(summary.error, "Root cause summary");
    assert.equal(summary.resultSummary, "Result summary");
    assert.equal(output.includes("FULL_HISTORY_SENTINEL"), false);
    assert.equal(output.includes("FULL_LOG_SENTINEL"), false);
  });

  it("limits oversized summaries while retaining valid JSON", async () => {
    const task = makeTask({
      summary: `${"summary ".repeat(1000)}SUMMARY_TAIL_SENTINEL`,
      taskResult: {
        ...makeTask().taskResult!,
        summary: `${"result ".repeat(1000)}RESULT_TAIL_SENTINEL`,
      },
    });
    const { tools } = setupCoordinatorTools(task);
    const result = await tools.get_task_summary.execute("call-2", { taskId: task.taskId });
    const output = result.content[0].text;
    const summary = JSON.parse(output);

    assert.ok(Buffer.byteLength(output, "utf8") <= COORDINATOR_TASK_SUMMARY_LIMIT);
    assert.equal(summary.truncated, true);
    assert.equal(output.includes("SUMMARY_TAIL_SENTINEL"), false);
    assert.equal(output.includes("RESULT_TAIL_SENTINEL"), false);
  });

  it("retains a complete TaskEpisodeView within 4KB", async () => {
    const taskId = "task-episode-within-budget";
    const reportedSummary = "Implemented the requested change and verified the focused behavior.";
    const task = makeTask({
      taskId,
      status: "completed",
      completedAt: "2026-09-08T00:00:01.000Z",
      changedFiles: ["server/a.ts", "test/a.test.ts"],
      taskResult: {
        ...makeTask().taskResult!,
        taskId,
        status: "completed",
        summary: reportedSummary,
        changedFiles: ["server/a.ts", "test/a.test.ts"],
      },
    });
    const { tools } = setupCoordinatorTools(task);
    const result = await tools.get_task_summary.execute("call-episode-small", { taskId });
    const output = result.content[0].text;
    const view = JSON.parse(output);

    assert.ok(Buffer.byteLength(output, "utf8") <= COORDINATOR_TASK_SUMMARY_LIMIT);
    assert.equal(view.truncated, undefined);
    assert.equal(view.agentReportedInterpretation.reportedSummary, reportedSummary);
    assert.deepEqual(view.physical.worktree.filesChanged, ["server/a.ts", "test/a.test.ts"]);
    assert.ok(view.artifactPointers.taskResult.ref);
    assert.ok(view.artifactPointers.verifier.ref);
  });

  it("degrades an oversized TaskEpisodeView within 4KB without losing artifact pointers", async () => {
    const taskId = "task-episode-over-budget";
    const task = makeTask({
      taskId,
      completedAt: "2026-09-08T00:00:01.000Z",
      changedFiles: Array.from({ length: 500 }, (_, index) => `src/very-long-file-name-${index}.ts`),
      taskResult: {
        ...makeTask().taskResult!,
        taskId,
        summary: "summary ".repeat(1000),
      },
    });
    const { tools } = setupCoordinatorTools(task);
    const result = await tools.get_task_summary.execute("call-episode-large", { taskId });
    const output = result.content[0].text;
    const view = JSON.parse(output);

    assert.ok(Buffer.byteLength(output, "utf8") <= COORDINATOR_TASK_SUMMARY_LIMIT);
    assert.equal(view.truncated, true);
    assert.ok(view.artifactPointers.transcript.ref);
    assert.ok(view.artifactPointers.taskResult.ref);
    assert.ok(view.artifactPointers.toolOutputsDir.ref);
    assert.ok(view.artifactPointers.verifier.ref);
  });

  it("leaves ordinary small-scope Coordinator checks available", async () => {
    const onToolResult = taskContextHandler("coordinator");
    const smallOutput = "short error summary\nline 2";
    const patch = await onToolResult({
      toolName: "bash",
      content: [{ type: "text", text: smallOutput }],
    });
    assert.equal(patch, undefined);
  });

  it("migrates an outdated Coordinator config without resetting other role customizations", () => {
    const coordinator = getRoleConfig("coordinator");
    const developer = getRoleConfig("developer");
    writeFileSync(
      rolesPath(),
      JSON.stringify([
        {
          ...coordinator,
          roleDefinitionVersion: 3,
          allowedTools: ["read", "bash"],
          definition: {
            ...coordinator.definition,
            definitionVersion: 3,
            instructions: "Legacy Coordinator instructions",
          },
        },
        {
          ...developer,
          description: "Custom Developer description",
          definition: {
            ...developer.definition,
            description: "Custom Developer description",
          },
        },
      ]),
      "utf8",
    );

    RoleRegistry.getInstance().reload();
    const migrated = getRoleConfig("coordinator");
    assert.match(migrated.definition.instructions ?? "", /#### Runtime Contract/);
    assert.match(migrated.definition.instructions ?? "", /Coordinator does not own Harness worktree cleanup/);
    assert.doesNotMatch(migrated.definition.instructions ?? "", /Scout Gate|Worktree Reclamation|git worktree remove/);
    assert.deepEqual(migrated.allowedTools, DEFAULT_ROLE_TOOLS.coordinator);
    assert.match(migrated.definition.instructions ?? "", /#### Web search/);
    assert.equal(getRoleConfig("developer").description, "Custom Developer description");
  });

  it("leaves an explicit Coordinator tool choice untouched after the canonical prompt is persisted", () => {
    const coordinator = getRoleConfig("coordinator");
    const developer = getRoleConfig("developer");
    writeFileSync(
      rolesPath(),
      JSON.stringify([
        {
          ...coordinator,
          allowedTools: ["read", "bash", "get_task_summary"],
          definition: {
            ...coordinator.definition,
            instructions: coordinator.definition.instructions,
          },
        },
        developer,
      ]),
      "utf8",
    );

    RoleRegistry.getInstance().reload();
    const reloaded = getRoleConfig("coordinator");
    assert.match(reloaded.definition.instructions ?? "", /#### Runtime Contract/);
    assert.match(reloaded.definition.instructions ?? "", /Runtime owns final resource reclamation/);
    assert.deepEqual(reloaded.allowedTools, ["read", "bash", "get_task_summary"]);
  });

  it("refreshes a current-version Coordinator definition when the scouting policy is missing", () => {
    const coordinator = getRoleConfig("coordinator");
    const developer = getRoleConfig("developer");
    writeFileSync(
      rolesPath(),
      JSON.stringify([
        {
          ...coordinator,
          allowedTools: ["read", "bash", "get_task_summary"],
          definition: {
            ...coordinator.definition,
            instructions: "Legacy Coordinator instructions\n#### Runtime Contract\n#### Web search",
          },
        },
        developer,
      ]),
      "utf8",
    );

    RoleRegistry.getInstance().reload();
    const refreshed = getRoleConfig("coordinator");
    assert.match(refreshed.definition.instructions ?? "", /#### Runtime Contract/);
    assert.match(refreshed.definition.instructions ?? "", /Coordinator does not own Harness worktree cleanup/);
    assert.match(refreshed.definition.instructions ?? "", /Would cheaply offloading this factual exploration preserve Coordinator context or gain useful parallelism/);
    assert.doesNotMatch(refreshed.definition.instructions ?? "", /Scout Gate|Worktree Reclamation|git worktree remove/);
    assert.equal(refreshed.definition.responsibilities.length, 5);
    assert.deepEqual(refreshed.allowedTools, ["read", "bash", "get_task_summary"]);
  });

  it("adds web_search to Coordinator and Researcher when #### Web search is missing", () => {
    const coordinator = getRoleConfig("coordinator");
    const researcher = getRoleConfig("researcher");
    const developer = getRoleConfig("developer");
    writeFileSync(
      rolesPath(),
      JSON.stringify([
        {
          ...coordinator,
          allowedTools: ["read", "bash", "get_task_summary"],
          definition: {
            ...coordinator.definition,
            instructions: "Legacy Coordinator instructions",
          },
        },
        {
          ...researcher,
          allowedTools: ["read", "bash", "report_blocker"],
          definition: {
            ...researcher.definition,
            instructions: "Findings Evidence Recommendation Uncertainties",
          },
        },
        developer,
      ]),
      "utf8",
    );

    RoleRegistry.getInstance().reload();
    const migratedCoordinator = getRoleConfig("coordinator");
    const migratedResearcher = getRoleConfig("researcher");
    assert.match(migratedCoordinator.definition.instructions ?? "", /#### Web search/);
    assert.match(migratedResearcher.definition.instructions ?? "", /#### Web search/);
    assert.ok(migratedCoordinator.allowedTools?.includes("web_search"));
    assert.ok(migratedResearcher.allowedTools?.includes("web_search"));
    assert.equal(getRoleConfig("developer").allowedTools?.includes("web_search"), false);
  });

  it("does not re-add web_search after #### Web search is persisted", () => {
    const coordinator = getRoleConfig("coordinator");
    const researcher = getRoleConfig("researcher");
    writeFileSync(
      rolesPath(),
      JSON.stringify([
        {
          ...coordinator,
          allowedTools: ["read", "bash", "get_task_summary"],
          definition: {
            ...coordinator.definition,
            instructions: `${coordinator.definition.instructions}\n\n#### Web search`,
          },
        },
        {
          ...researcher,
          allowedTools: ["read", "bash", "report_blocker"],
          definition: {
            ...researcher.definition,
            instructions: `${researcher.definition.instructions}\n\n#### Web search`,
          },
        },
      ]),
      "utf8",
    );

    RoleRegistry.getInstance().reload();
    assert.deepEqual(getRoleConfig("coordinator").allowedTools, ["read", "bash", "get_task_summary"]);
    assert.deepEqual(getRoleConfig("researcher").allowedTools, ["read", "bash", "report_blocker"]);
  });
});
