import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-coordinator-boundary-test-"));

import type { AgentRole, UISubagentTask } from "../shared/protocol.ts";
import {
  COORDINATOR_OUTPUT_TRUNCATION_MESSAGE,
  COORDINATOR_TASK_SUMMARY_LIMIT,
  COORDINATOR_TOOL_OUTPUT_LIMIT,
  createCoordinatorExtension,
} from "../server/coordinator-tools.ts";
import { getRoleConfig, getRoleDefinition, RoleRegistry, rolesPath } from "../server/contracts/index.ts";

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

describe("Coordinator large-volume investigation boundary", () => {
  it("documents a data-volume/complexity boundary without banning ordinary log checks", () => {
    const coordinator = getRoleDefinition("coordinator");
    assert.match(coordinator.instructions, /large-volume investigation/);
    assert.match(coordinator.instructions, /少量状态、错误摘要、短日志片段/);
    assert.match(coordinator.instructions, /大量日志\/JSONL\/历史记录/);
    assert.match(coordinator.instructions, /Verifier\/Subagent/);
    assert.doesNotMatch(coordinator.instructions, /禁止读取日志/);
    assert.ok(getRoleConfig("coordinator").allowedTools?.includes("get_task_summary"));
  });

  it("truncates oversized Coordinator bash/read results at the Coordinator threshold", async () => {
    const { events } = setupCoordinatorTools(makeTask());
    const oversized = "x".repeat(COORDINATOR_TOOL_OUTPUT_LIMIT + 500);

    for (const toolName of ["bash", "read"]) {
      const patch = await events.tool_result({
        toolName,
        content: [{ type: "text", text: oversized }],
      });
      assert.ok(patch, `${toolName} should be truncated`);
      const output = patch.content[0].text;
      assert.ok(Buffer.byteLength(output, "utf8") <= COORDINATOR_TOOL_OUTPUT_LIMIT);
      assert.ok(output.includes(COORDINATOR_OUTPUT_TRUNCATION_MESSAGE));
    }
  });

  it("does not apply the Coordinator threshold to Verifier or Developer", async () => {
    const setup = setupCoordinatorTools(makeTask());
    const oversized = "x".repeat(COORDINATOR_TOOL_OUTPUT_LIMIT + 500);

    for (const role of ["verifier", "developer"] as const) {
      setup.setRole(role);
      const patch = await setup.events.tool_result({
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

  it("leaves ordinary small-scope Coordinator checks available", async () => {
    const { events } = setupCoordinatorTools(makeTask());
    const smallOutput = "short error summary\nline 2";
    const patch = await events.tool_result({
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
    assert.deepEqual(migrated.allowedTools, ["read", "bash", "get_task_summary"]);
    assert.equal(getRoleConfig("developer").description, "Custom Developer description");
  });
});
