import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { SubagentManager, subagentTasks } from "../server/subagent-manager.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pi-startup-deferral-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const tasksDir = join(agentDir, "subagent-tasks");

function writeTask(taskId: string, task: Record<string, unknown>): void {
  writeFileSync(join(tasksDir, `${taskId}.json`), JSON.stringify(task, null, 2), "utf8");
}

before(() => {
  mkdirSync(tasksDir, { recursive: true });
  writeTask("persisted-sync-guard", {
    taskId: "persisted-sync-guard",
    parentSessionId: "session-1",
    role: "developer",
    taskTitle: "Sync guard",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
  });
  writeTask("persisted-running", {
    taskId: "persisted-running",
    parentSessionId: "session-1",
    role: "developer",
    taskTitle: "Was running",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  writeTask("persisted-bad-role", {
    taskId: "persisted-bad-role",
    parentSessionId: "session-1",
    role: "legacy-role",
    taskTitle: "Quarantined",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
  });
  writeTask("persisted-with-deps", {
    taskId: "persisted-with-deps",
    parentSessionId: "session-1",
    role: "verifier",
    taskTitle: "Has deps",
    status: "blocked",
    createdAt: "2026-01-01T00:00:00.000Z",
    taskContract: {
      taskId: "persisted-with-deps",
      parentSessionId: "session-1",
      role: "verifier",
      goal: "dependency graph reconstruction",
      dependsOn: ["persisted-sync-guard"],
    },
  });
});

after(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe("SubagentManager startup hydration", () => {
  it("does not synchronously parse persisted tasks in the constructor", async () => {
    subagentTasks.clear();
    const manager = new SubagentManager({} as any);

    assert.equal(
      subagentTasks.has("persisted-sync-guard"),
      false,
      "constructor must not synchronously readdir + parse persisted tasks",
    );

    await manager.persistedTasksReady;
    assert.equal(subagentTasks.has("persisted-sync-guard"), true, "hydration must populate tasks");
  });

  it("preserves restart semantics (interrupt, quarantine, dependency reconstruction)", async () => {
    subagentTasks.clear();
    const manager = new SubagentManager({} as any);
    await manager.persistedTasksReady;

    const interrupted = subagentTasks.get("persisted-running");
    assert.ok(interrupted, "running task must be hydrated");
    assert.equal(interrupted.task.status, "interrupted");
    assert.equal(interrupted.task.error, "服务重启已终止");
    assert.ok(interrupted.task.durationMs !== undefined);

    assert.equal(subagentTasks.has("persisted-bad-role"), false, "non-canonical roles must be quarantined");

    assert.deepEqual(
      manager.taskGraph.getDependencies("persisted-with-deps"),
      ["persisted-sync-guard"],
      "dependency graph must be reconstructed from persisted contracts",
    );
  });

  it("hydrates only once and tolerates concurrent readiness awaits", async () => {
    subagentTasks.clear();
    const manager = new SubagentManager({} as any);
    await Promise.all([
      manager.persistedTasksReady,
      manager.persistedTasksReady,
      manager.persistedTasksReady,
    ]);
    assert.equal(subagentTasks.has("persisted-sync-guard"), true);
  });

  it("skips corrupt files and quarantines role mismatches without aborting hydration", async () => {
    writeFileSync(join(tasksDir, "persisted-corrupt.json"), "{ not valid json", "utf8");
    writeFileSync(join(tasksDir, "persisted-empty.json"), "", "utf8");
    writeFileSync(join(tasksDir, "persisted-missing-id.json"), JSON.stringify({ role: "developer" }), "utf8");
    writeFileSync(
      join(tasksDir, "persisted-role-mismatch.json"),
      JSON.stringify({
        taskId: "persisted-role-mismatch",
        parentSessionId: "session-1",
        role: "developer",
        taskTitle: "Mismatched contract role",
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        taskContract: { role: "verifier" },
      }),
      "utf8",
    );

    subagentTasks.clear();
    const manager = new SubagentManager({} as any);
    await manager.persistedTasksReady;

    assert.equal(subagentTasks.has("persisted-corrupt"), false);
    assert.equal(subagentTasks.has("persisted-empty"), false);
    assert.equal(subagentTasks.has("persisted-missing-id"), false);
    assert.equal(subagentTasks.has("persisted-role-mismatch"), false);
    assert.equal(subagentTasks.has("persisted-sync-guard"), true, "valid tasks must still hydrate");

    rmSync(join(tasksDir, "persisted-corrupt.json"), { force: true });
    rmSync(join(tasksDir, "persisted-empty.json"), { force: true });
    rmSync(join(tasksDir, "persisted-missing-id.json"), { force: true });
    rmSync(join(tasksDir, "persisted-role-mismatch.json"), { force: true });
  });
});

describe("deferred heavy imports", () => {
  it("product-design loads playwright dynamically, never at module top level", () => {
    const source = readFileSync(join(process.cwd(), "server", "product-design-extension.ts"), "utf8");
    assert.equal(
      /^\s*import\s+[^;]*from\s+["']playwright["']/m.test(source),
      false,
      "playwright must not be statically imported",
    );
    assert.match(source, /await\s+import\(\s*["']playwright["']\s*\)/, "playwright must be loaded on demand");
  });

  it("built server bundle has no top-level playwright import", () => {
    const bundlePath = join(process.cwd(), "dist", "index.js");
    let bundle: string;
    try {
      bundle = readFileSync(bundlePath, "utf8");
    } catch {
      return; // bundle not built in this environment; source-level check above still applies
    }
    assert.equal(
      /^\s*import\s+[^;]*from\s+["']playwright["']/m.test(bundle),
      false,
      "dist/index.js must not contain a top-level playwright import",
    );
    assert.match(bundle, /import\(\s*["']playwright["']\s*\)/, "dist/index.js must lazily import playwright");
  });
});
