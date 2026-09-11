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
import { getRoleConfig, getRoleDefinition, RoleRegistry, rolesPath } from "../server/contracts/index.ts";
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

describe("Coordinator large-volume investigation boundary", () => {
  it("uses the intended role-specific default tool output budgets", () => {
    assert.equal(COORDINATOR_TOOL_OUTPUT_LIMIT, 24 * 1024);
    assert.equal(DEFAULT_OUTPUT_BUDGETS.coordinator, 24 * 1024);
    assert.equal(DEFAULT_OUTPUT_BUDGETS.subagent, 32 * 1024);
    assert.equal(DEFAULT_OUTPUT_BUDGETS.verifier, 40 * 1024);
    assert.equal(COORDINATOR_TASK_SUMMARY_LIMIT, 4 * 1024);
  });

  it("describes get_task_summary as a bounded Episode view and does not teach foreign read_artifact", () => {
    const { tools } = setupCoordinatorTools(makeTask());
    assert.match(tools.get_task_summary.description, /TaskEpisodeView|有界 Task 状态视图/);
    assert.doesNotMatch(tools.get_task_summary.description, /压缩状态/);
    const spawnText = [
      tools.spawn_subagent.description,
      ...(tools.spawn_subagent.promptGuidelines ?? []),
    ].join("\n");
    assert.match(spawnText, /TaskEpisodeView/);
    assert.match(spawnText, /context_files/);
    assert.doesNotMatch(spawnText, /由执行角色在其任务范围内用 read_artifact/);
    assert.doesNotMatch(spawnText, /read_artifact them/);
  });

  it("documents a data-volume/complexity boundary without banning ordinary log checks", () => {
    const coordinator = getRoleDefinition("coordinator");
    assert.match(coordinator.instructions, /large-volume investigation/);
    assert.match(coordinator.instructions, /少量状态、错误摘要、短日志片段/);
    assert.match(coordinator.instructions, /大量日志\/JSONL\/历史记录/);
    assert.match(coordinator.instructions, /Verifier\/Subagent/);
    assert.doesNotMatch(coordinator.instructions, /禁止读取日志/);
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

  it("migrates an existing Coordinator config without resetting other role customizations", () => {
    const coordinator = getRoleConfig("coordinator");
    const developer = getRoleConfig("developer");
    writeFileSync(
      rolesPath(),
      JSON.stringify([
        {
          ...coordinator,
          allowedTools: ["read", "bash"],
          definition: {
            ...coordinator.definition,
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
    assert.match(migrated.definition.instructions ?? "", /large-volume investigation boundary/);
    assert.match(migrated.definition.instructions ?? "", /Mutation Ownership/);
    assert.match(migrated.definition.instructions ?? "", /Direct Path/);
    assert.match(migrated.definition.instructions ?? "", /recovery_manifest/);
    assert.deepEqual(migrated.allowedTools, [
      "read",
      "bash",
      "get_task_summary",
      "edit",
      "write",
      "read_transcript",
      "search_transcript",
      "read_artifact",
      "web_search",
    ]);
    assert.match(migrated.definition.instructions ?? "", /#### Web search/);
    assert.equal(getRoleConfig("developer").description, "Custom Developer description");
  });

  it("leaves an explicit Coordinator tool choice untouched after Mutation Ownership is persisted", () => {
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
    assert.match(reloaded.definition.instructions ?? "", /Mutation Ownership/);
    assert.deepEqual(reloaded.allowedTools, ["read", "bash", "get_task_summary"]);
  });

  it("refreshes Coordinator definition for promotion-before-mutation without resetting tools", () => {
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
            instructions: "Has Mutation Ownership but not the new promotion-before-mutation rule.",
          },
        },
        developer,
      ]),
      "utf8",
    );

    RoleRegistry.getInstance().reload();
    const refreshed = getRoleConfig("coordinator");
    assert.match(refreshed.definition.instructions ?? "", /Prefer promotion before the first repository mutation/);
    assert.equal(refreshed.definition.responsibilities.length, 6);
    assert.deepEqual(refreshed.allowedTools, [
      "read",
      "bash",
      "get_task_summary",
      "read_transcript",
      "search_transcript",
      "read_artifact",
      "web_search",
    ]);
  });

  it("refreshes Coordinator definition for Worktree Reclamation without resetting tools", () => {
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
            instructions:
              "Has Mutation Ownership and Prefer promotion before the first repository mutation, but not the new reclaim rule.",
          },
        },
        developer,
      ]),
      "utf8",
    );

    RoleRegistry.getInstance().reload();
    const refreshed = getRoleConfig("coordinator");
    assert.match(refreshed.definition.instructions ?? "", /Worktree Reclamation/);
    assert.ok(
      refreshed.definition.strictProhibitions.some((p) =>
        p.includes("禁止在改动已同步到主工作区后遗留本轮创建的 Task/Integration Worktree"),
      ),
    );
    assert.deepEqual(refreshed.allowedTools, [
      "read",
      "bash",
      "get_task_summary",
      "read_transcript",
      "search_transcript",
      "read_artifact",
      "web_search",
    ]);
  });

  it("appends Context recovery guidance and adds missing recovery tools", () => {
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
            instructions: [
              "Mutation Ownership",
              "Prefer promotion before the first repository mutation",
              "Worktree Reclamation",
              "large-volume investigation boundary",
            ].join("\n"),
          },
        },
        {
          ...developer,
          allowedTools: ["read", "bash", "edit", "write", "report_blocker"],
          definition: {
            ...developer.definition,
            description: "Custom Developer description",
            instructions: "Contract → Root Cause → Minimal Change → Verification → Evidence",
          },
        },
      ]),
      "utf8",
    );

    RoleRegistry.getInstance().reload();
    const migratedCoordinator = getRoleConfig("coordinator");
    const migratedDeveloper = getRoleConfig("developer");
    assert.match(migratedCoordinator.definition.instructions ?? "", /#### Context recovery/);
    assert.match(migratedCoordinator.definition.instructions ?? "", /get_task_summary/);
    assert.match(migratedCoordinator.definition.instructions ?? "", /TaskEpisodeView/);
    assert.doesNotMatch(migratedCoordinator.definition.instructions ?? "", /recovery_manifest\.boundary/);
    assert.deepEqual(migratedCoordinator.allowedTools, [
      "read",
      "bash",
      "get_task_summary",
      "read_transcript",
      "search_transcript",
      "read_artifact",
      "web_search",
    ]);
    assert.match(migratedDeveloper.definition.instructions ?? "", /#### Context recovery/);
    assert.equal(migratedDeveloper.description, "Custom Developer description");
    assert.deepEqual(migratedDeveloper.allowedTools, [
      "read",
      "bash",
      "edit",
      "write",
      "report_blocker",
      "read_transcript",
      "search_transcript",
      "read_artifact",
    ]);
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
            instructions: [
              "Mutation Ownership",
              "Prefer promotion before the first repository mutation",
              "Worktree Reclamation",
              "large-volume investigation boundary",
              "#### Context recovery",
            ].join("\n"),
          },
        },
        {
          ...researcher,
          allowedTools: ["read", "bash", "report_blocker"],
          definition: {
            ...researcher.definition,
            instructions: "Findings Evidence Recommendation Uncertainties\n#### Context recovery",
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
