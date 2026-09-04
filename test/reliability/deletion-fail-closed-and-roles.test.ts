import assert from "node:assert/strict";
import { execSync as nodeExecSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  CANONICAL_ROLES,
  ConstraintResolver,
  getAllRoleConfigs,
  getAllRoleDefinitions,
  getRoleConfig,
  getRoleDefinition,
  isCanonicalRole,
  RoleRegistry,
  saveRolesConfig,
  type RoleConfigV2,
} from "../../server/contracts/index.ts";
import { handleProjectsRoutes } from "../../server/http/routes-projects.ts";
import { handleSessionsRoutes } from "../../server/http/routes-sessions.ts";
import { getTaskMemoryDir, initTaskMemory } from "../../server/task-memory.ts";
import { persistTask, taskFilePath } from "../../server/subagent/task-store.ts";
import {
  subagentTasks,
  SubagentManager,
  tryParseReviewResult,
} from "../../server/subagent-manager.ts";
import { resolveExpectedEffects } from "../../server/runtime-verifier.ts";
import { cleanupDeletedSessionResources } from "../../server/session/session-cleanup.ts";
import { SessionRegistry } from "../../server/session/session-registry.ts";
import { getOrCreateIntegrationWorkspace } from "../../server/git/integration-workspace.ts";

function initGitRepo(dir: string) {
  nodeExecSync("git init", { cwd: dir, stdio: "ignore" });
  nodeExecSync("git config user.name 'Test Runner'", { cwd: dir, stdio: "ignore" });
  nodeExecSync("git config user.email 'test@runner.local'", { cwd: dir, stdio: "ignore" });
  nodeExecSync("git commit --allow-empty -m 'initial commit'", { cwd: dir, stdio: "ignore" });
}

function createMockResponse() {
  let statusCode = 200;
  let headers: Record<string, string> = {};
  let body = "";

  return {
    res: {
      writeHead(code: number, hdrs?: Record<string, string>) {
        statusCode = code;
        if (hdrs) headers = { ...headers, ...hdrs };
        return this;
      },
      end(data?: string) {
        if (data) body = data;
      },
    } as any,
    getStatusCode: () => statusCode,
    getHeaders: () => headers,
    getBody: () => (body ? JSON.parse(body) : null),
    getRawBody: () => body,
  };
}

describe("Deletion Lifecycle Fail-Closed, Role Alias & Verifier Workspace Regression Tests", () => {
  let testAgentDir: string;
  let testInboxDir: string;
  let mockModelRuntime: any;

  beforeEach(() => {
    testAgentDir = mkdtempSync(join(tmpdir(), "pi-fail-closed-agent-"));
    testInboxDir = join(testAgentDir, "inbox");
    process.env.PI_AGENT_DIR = testAgentDir;
    RoleRegistry.getInstance().reload();

    mockModelRuntime = {
      getModel: () => null,
      initSession: async () => ({
        session: {
          messages: [],
          isStreaming: false,
          abort: async () => {},
          prompt: async () => {},
          setThinkingLevel: () => {},
          setModel: async () => {},
        },
      }),
    };
    subagentTasks.clear();
  });

  afterEach(() => {
    subagentTasks.clear();
    delete process.env.PI_AGENT_DIR;
    rmSync(testAgentDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. deleteTask fail-closed on active/running tasks when abort fails
  // -------------------------------------------------------------------------
  it("delete_subagent_task / deleteTask fail-closed: preserves instance, persistence, runtime handle and memory when abort fails", async () => {
    const manager = new SubagentManager(mockModelRuntime);
    const taskId = `task-abort-fail-${Date.now()}`;
    let abortAttempts = 0;

    const mockRuntime: any = {
      session: {
        messages: [],
        isStreaming: true,
        abort: async () => {
          abortAttempts++;
          throw new Error("simulated abort failure in runtime");
        },
      },
      dispose: async () => {},
    };

    initTaskMemory(taskId, "Test Memory for abort-fail task");
    const taskObj: any = {
      taskId,
      parentSessionId: "parent-session-1",
      role: "developer",
      taskTitle: "Active Task",
      status: "running",
      createdAt: new Date().toISOString(),
    };

    persistTask(taskObj);
    subagentTasks.set(taskId, {
      task: taskObj,
      runtime: mockRuntime,
    });

    // Attempt to delete running task
    const ok = await manager.deleteTask(taskId);

    // Fail-closed verification
    assert.equal(ok, false, "deleteTask must return false on abort failure");
    assert.ok(abortAttempts >= 1, "abort must have been attempted");
    assert.ok(subagentTasks.has(taskId), "Task instance must NOT be removed from memory");
    assert.equal(subagentTasks.get(taskId)?.runtime, mockRuntime, "Runtime handle must remain attached");

    // Task metadata file must remain intact
    const taskFile = taskFilePath(taskId);
    assert.equal(existsSync(taskFile), true, "Task persistence file must NOT be deleted");

    // Task memory must remain intact
    const memoryDir = getTaskMemoryDir(taskId);
    assert.equal(existsSync(memoryDir), true, "Task memory directory must NOT be deleted");
  });

  // -------------------------------------------------------------------------
  // 2. clearTasksForParent fail-closed: does not orphan running runtime
  // -------------------------------------------------------------------------
  it("clear_subagent_tasks / clearTasksForParent: throws and does not orphan running runtime when a task cannot abort", async () => {
    const manager = new SubagentManager(mockModelRuntime);
    const parentId = `parent-session-${Date.now()}`;

    // Task 1: already completed
    const task1Id = `task-completed-${Date.now()}`;
    const task1: any = {
      taskId: task1Id,
      parentSessionId: parentId,
      role: "developer",
      taskTitle: "Completed Task",
      status: "completed",
      createdAt: new Date().toISOString(),
    };
    persistTask(task1);
    subagentTasks.set(task1Id, { task: task1 });

    // Task 2: running and abort fails
    const task2Id = `task-stuck-${Date.now()}`;
    const stuckRuntime: any = {
      session: {
        messages: [],
        isStreaming: true,
        abort: async () => {
          throw new Error("abort timeout/failure");
        },
      },
    };
    const task2: any = {
      taskId: task2Id,
      parentSessionId: parentId,
      role: "developer",
      taskTitle: "Stuck Running Task",
      status: "running",
      createdAt: new Date().toISOString(),
    };
    persistTask(task2);
    subagentTasks.set(task2Id, { task: task2, runtime: stuckRuntime });

    // clearTasksForParent should fail-closed
    await assert.rejects(
      async () => {
        await manager.clearTasksForParent(parentId);
      },
      /could not be quiesced or deleted/,
      "clearTasksForParent must throw when any active task cannot be safely stopped",
    );

    // The stuck task must still be preserved in memory with runtime handle
    assert.ok(subagentTasks.has(task2Id), "Stuck task must NOT be orphaned or deleted from subagentTasks");
    assert.equal(subagentTasks.get(task2Id)?.runtime, stuckRuntime, "Runtime handle must remain intact");
  });

  // -------------------------------------------------------------------------
  // 3. Single session delete preserves Session JSONL on quiescence failure
  // -------------------------------------------------------------------------
  it("Single session delete: preserves Session JSONL and returns 409 Conflict when quiescence fails", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-single-del-"));
    initGitRepo(gitRepoDir);

    const sessionId = `session-del-fail-${Date.now()}`;
    const projectSessionsDir = join(testAgentDir, "sessions", "git-proj-del");
    mkdirSync(projectSessionsDir, { recursive: true });
    const sessionFile = join(projectSessionsDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
    writeFileSync(sessionFile, JSON.stringify({ type: "session_header", cwd: gitRepoDir }) + "\n");

    const manager = new SubagentManager(mockModelRuntime);
    const registry = new SessionRegistry();

    const taskId = `task-in-del-${Date.now()}`;
    const stuckRuntime: any = {
      session: {
        messages: [],
        isStreaming: false,
        abort: async () => {
          throw new Error("Abort error");
        },
      },
      dispose: async () => {},
    };

    subagentTasks.set(taskId, {
      task: {
        taskId,
        parentSessionId: sessionId,
        role: "developer",
        taskTitle: "Running Task",
        status: "running",
        createdAt: new Date().toISOString(),
      },
      runtime: stuckRuntime,
    });

    registry.set(sessionId, {
      id: sessionId,
      runtime: { session: { messages: [] }, dispose: async () => {}, switchSession: async () => {} } as any,
      clients: new Set(),
      lastActive: Date.now(),
      published: true,
      activeRole: "coordinator",
      cwd: gitRepoDir,
      isGitRepo: true,
    });

    const ctx: any = {
      sessionRegistry: registry,
      subagentManager: manager,
      agentCwd: gitRepoDir,
    };

    const mockResp = createMockResponse();
    await handleSessionsRoutes(
      new URL(`http://localhost/api/sessions/${sessionId}?cwd=${encodeURIComponent(gitRepoDir)}`),
      { method: "DELETE" } as any,
      mockResp.res,
      ctx,
    );

    // Assert: HTTP 409 Conflict returned
    assert.equal(mockResp.getStatusCode(), 409, "Must return HTTP 409 Conflict on quiescence failure");
    const body = mockResp.getBody();
    assert.equal(body.ok, false, "Must return ok: false");
    assert.ok(/quiescence failure/i.test(body.error), "Error must explain quiescence failure");

    // Assert: Session JSONL file still exists on disk
    assert.equal(existsSync(sessionFile), true, "Session JSONL file must NOT be deleted on quiescence failure");

    // Assert: Session registry entry preserved
    assert.ok(registry.get(sessionId), "SessionRegistry entry must remain preserved");

    // Assert: Task instance preserved
    assert.ok(subagentTasks.has(taskId), "Task instance must remain preserved");

    rmSync(gitRepoDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 4. Bulk project/folder deletion fail-closed on quiescence failure
  // -------------------------------------------------------------------------
  it("Bulk folder/project delete: returns 409 and does not report full success when a session fails quiescence", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-bulk-del-"));
    initGitRepo(gitRepoDir);

    const folderDir = join(gitRepoDir, "subpkg");
    mkdirSync(folderDir, { recursive: true });

    const manager = new SubagentManager(mockModelRuntime);
    const registry = new SessionRegistry();

    // Session 1: idle/quiescent session
    const sid1 = `session-bulk-idle-${Date.now()}`;
    const projectSessionsDir = join(testAgentDir, "sessions", "git-proj-bulk");
    mkdirSync(projectSessionsDir, { recursive: true });
    const sessionFile1 = join(projectSessionsDir, `2026-01-01T00-00-00-000Z_${sid1}.jsonl`);
    writeFileSync(sessionFile1, JSON.stringify({ type: "session_header", cwd: folderDir }) + "\n");
    registry.set(sid1, {
      id: sid1,
      runtime: { session: { messages: [] }, dispose: async () => {}, switchSession: async () => {} } as any,
      clients: new Set(),
      lastActive: Date.now(),
      published: true,
      activeRole: "coordinator",
      cwd: folderDir,
      isGitRepo: true,
    });

    // Session 2: active task that fails to abort
    const sid2 = `session-bulk-stuck-${Date.now()}`;
    const sessionFile2 = join(projectSessionsDir, `2026-01-01T00-00-00-001Z_${sid2}.jsonl`);
    writeFileSync(sessionFile2, JSON.stringify({ type: "session_header", cwd: folderDir }) + "\n");
    registry.set(sid2, {
      id: sid2,
      runtime: { session: { messages: [] }, dispose: async () => {}, switchSession: async () => {} } as any,
      clients: new Set(),
      lastActive: Date.now(),
      published: true,
      activeRole: "coordinator",
      cwd: folderDir,
      isGitRepo: true,
    });

    const stuckTaskId = `task-bulk-stuck-${Date.now()}`;
    subagentTasks.set(stuckTaskId, {
      task: {
        taskId: stuckTaskId,
        parentSessionId: sid2,
        role: "developer",
        taskTitle: "Stuck Task",
        status: "running",
        createdAt: new Date().toISOString(),
      },
      runtime: {
        session: {
          messages: [],
          isStreaming: false,
          abort: async () => {
            throw new Error("abort rejected");
          },
        },
        dispose: async () => {},
      } as any,
    });

    const ctx: any = {
      sessionRegistry: registry,
      subagentManager: manager,
      agentCwd: gitRepoDir,
    };

    const mockResp = createMockResponse();
    await handleProjectsRoutes(
      new URL(`http://localhost/api/projects?folder=${encodeURIComponent(folderDir)}`),
      { method: "DELETE" } as any,
      mockResp.res,
      ctx,
    );

    // Must NOT report ok: true
    assert.equal(mockResp.getStatusCode(), 409, "Must return HTTP 409 Conflict when a session fails quiescence");
    const body = mockResp.getBody();
    assert.equal(body.ok, false, "Must return ok: false");
    assert.deepEqual(body.failedSessionIds, [sid2], "Must report the failed session ID");

    // Session 2 JSONL file must NOT have been deleted
    assert.equal(existsSync(sessionFile2), true, "Stuck session JSONL file must NOT be deleted");

    // Session 2 task and registry must remain
    assert.ok(subagentTasks.has(stuckTaskId), "Stuck session task must remain in subagentTasks");
    assert.ok(registry.get(sid2), "Stuck session must remain in sessionRegistry");

    rmSync(gitRepoDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 5. Canonical Roles Only: legacy aliases are strictly rejected fail-closed
  // -------------------------------------------------------------------------
  it("Canonical Roles: aliases do not exist, legacy IDs are rejected fail-closed", () => {
    const registry = RoleRegistry.getInstance();
    const allRoles = registry.getAllRoles();
    const allDefs = registry.getAllDefinitions();

    const expectedCanonical = ["coordinator", "developer", "verifier", "researcher", "default"].sort();
    assert.deepEqual(allRoles.map((r) => r.id).sort(), expectedCanonical);
    assert.deepEqual(allDefs.map((d) => d.id).sort(), expectedCanonical);

    const legacyIds = ["reviewer", "tester", "junior_fe", "junior_be", "fullstack", "implementer", "debugger", "acceptance"];

    // Aliases must NOT be recognized as canonical roles
    for (const id of legacyIds) {
      assert.equal(isCanonicalRole(id), false, `${id} must not be a canonical role`);
      assert.throws(
        () => registry.getRole(id as any),
        /Unknown or invalid role/,
        `getRole(${id}) must throw fail-closed`,
      );
      assert.throws(
        () => registry.getDefinition(id as any),
        /Unknown or invalid role/,
        `getDefinition(${id}) must throw fail-closed`,
      );
    }

    // Saving an alias config must throw fail-closed
    const aliasConfig: any = {
      id: "reviewer",
      name: "Old Reviewer",
      description: "Obsolete alias",
      definition: {
        id: "reviewer",
        name: "Old Reviewer",
        description: "Obsolete alias",
        responsibilities: [],
        strictProhibitions: [],
        instructions: "",
      },
    };
    assert.throws(
      () => saveRolesConfig([aliasConfig]),
      /unsupported or invalid role/,
      "Saving non-canonical role must throw fail-closed",
    );
  });

  // -------------------------------------------------------------------------
  // 6. Runtime Verification: ExpectedEffects enforces canonical roles
  // -------------------------------------------------------------------------
  it("Runtime Verification: resolveExpectedEffects handles canonical roles and rejects legacy roles", () => {
    // Canonical roles
    assert.deepEqual(resolveExpectedEffects("verifier"), ["analysis"]);
    assert.deepEqual(resolveExpectedEffects("developer"), ["code_change"]);
    assert.deepEqual(resolveExpectedEffects("coordinator"), ["analysis"]);
    assert.deepEqual(resolveExpectedEffects("researcher"), ["analysis"]);
    assert.deepEqual(resolveExpectedEffects("default"), ["code_change"]);

    // Explicit override takes precedence
    assert.deepEqual(resolveExpectedEffects("developer", ["analysis"]), ["analysis"]);

    // Legacy roles must throw fail-closed
    assert.throws(() => resolveExpectedEffects("reviewer" as any), /Unknown or invalid role/);
    assert.throws(() => resolveExpectedEffects("tester" as any), /Unknown or invalid role/);
    assert.throws(() => resolveExpectedEffects("junior_fe" as any), /Unknown or invalid role/);
    assert.throws(() => resolveExpectedEffects("fullstack" as any), /Unknown or invalid role/);
  });

  // -------------------------------------------------------------------------
  // 7. Explicit REWORK is never overwritten to APPROVE by parser
  // -------------------------------------------------------------------------
  it("Review Verdict: explicit REWORK is faithfully canonicalized to REQUEST_CHANGES even with only minor findings", () => {
    const jsonOutput = `
\`\`\`json
{
  "verdict": "REWORK",
  "findings": [
    {
      "id": "finding-1",
      "severity": "minor",
      "problem": "Formatting nit",
      "evidence": "extra space"
    }
  ]
}
\`\`\`
    `;

    const res = tryParseReviewResult(jsonOutput);
    assert.ok(res);
    assert.equal(res.onlyMinorFindings, true);
    assert.equal(
      res.verdict,
      "REQUEST_CHANGES",
      "Explicit REWORK must be faithfully canonicalized to REQUEST_CHANGES",
    );

    // PASS must parse to APPROVE
    const passOutput = `
\`\`\`json
{
  "verdict": "PASS",
  "findings": [
    {
      "id": "finding-1",
      "severity": "minor",
      "problem": "A non-blocking suggestion",
      "evidence": "line 1"
    }
  ]
}
\`\`\`
    `;
    const resPass = tryParseReviewResult(passOutput);
    assert.ok(resPass);
    assert.equal(resPass.verdict, "APPROVE");
  });

  // -------------------------------------------------------------------------
  // 8. Verifier executes in Integration Workspace without Task Worktree/merge
  // -------------------------------------------------------------------------
  it("Verifier Workspace: executes in Integration Workspace directly, without creating Task Worktree or branch", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-verifier-ws-"));
    initGitRepo(gitRepoDir);

    const manager = new SubagentManager(mockModelRuntime);
    const parentSessionId = `parent-verifier-${Date.now()}`;

    const mockSession = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: '```json\n{\n  "verdict": "PASS",\n  "findings": []\n}\n```',
            },
          ],
          stopReason: "stop",
        },
      ],
      isStreaming: false,
      abort: async () => {},
      prompt: async () => {},
      subscribe: () => () => {},
      setThinkingLevel: () => {},
      setModel: async () => {},
    };

    // Spawn Verifier task
    const verifierTask = await manager.spawn({
      parentSessionId,
      role: "verifier",
      taskTitle: "Verify Code",
      taskPrompt: "Verify integration results",
      parentCwd: gitRepoDir,
      customSession: mockSession as any,
      taskContract: {
        taskId: `task-verifier-${Date.now()}`,
        parentSessionId,
        role: "verifier",
        goal: "Verify Code",
      },
    });

    // Assert: Verifier does NOT have its own task worktree or branch
    assert.equal(verifierTask.worktreePath, undefined, "Verifier must NOT create its own worktreePath");
    assert.equal(verifierTask.branchName, undefined, "Verifier must NOT create its own branchName");

    // Assert: Verifier baseDir is the Integration Workspace
    const integration = await manager.getOrCreateIntegration(parentSessionId, gitRepoDir);
    assert.ok(existsSync(integration.worktreePath), "Integration worktree must exist");

    // Complete the task
    await manager.handleSubagentCompletion(verifierTask.taskId);

    // Assert: Completed without git merge conflicts or branch merging
    assert.equal(verifierTask.status, "completed");

    rmSync(gitRepoDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 9. Parent Quiescence: DELETE returns 409 and protects session if parent runtime fails abort
  // -------------------------------------------------------------------------
  it("Parent Quiescence: DELETE /api/sessions/:id returns 409 and aborts deletion if parent streaming runtime fails to abort", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-parent-quiesce-"));
    initGitRepo(gitRepoDir);

    const manager = new SubagentManager(mockModelRuntime);
    const registry = new SessionRegistry();

    const sessionId = `session-parent-stuck-${Date.now()}`;
    const projectSessionsDir = join(testAgentDir, "sessions", "git-proj-parent");
    mkdirSync(projectSessionsDir, { recursive: true });
    const sessionFile = join(projectSessionsDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
    writeFileSync(sessionFile, JSON.stringify({ type: "session_header", cwd: gitRepoDir }) + "\n");

    let abortCalled = false;
    registry.set(sessionId, {
      id: sessionId,
      runtime: {
        session: {
          messages: [],
          isStreaming: true,
          abort: async () => {
            abortCalled = true;
            throw new Error("Parent runtime abort failed due to stream lock");
          },
        },
        dispose: async () => {},
        switchSession: async () => {},
      } as any,
      clients: new Set(),
      lastActive: Date.now(),
      published: true,
      activeRole: "coordinator",
      cwd: gitRepoDir,
      isGitRepo: true,
    });

    const ctx: any = {
      sessionRegistry: registry,
      subagentManager: manager,
      agentCwd: gitRepoDir,
    };

    const mockResp = createMockResponse();
    await handleSessionsRoutes(
      new URL(`http://localhost/api/sessions/${sessionId}?cwd=${encodeURIComponent(gitRepoDir)}`),
      { method: "DELETE" } as any,
      mockResp.res,
      ctx,
    );

    assert.equal(abortCalled, true, "Parent abort() must have been called");
    assert.equal(mockResp.getStatusCode(), 409, "Must return HTTP 409 Conflict when parent session abort fails");
    const body = mockResp.getBody();
    assert.equal(body.ok, false);
    assert.ok(/quiescence failure/i.test(body.error));
    assert.ok(body.details && body.details.some((d: string) => /parent runtime/i.test(d)));

    // Session JSONL file must NOT be deleted
    assert.equal(existsSync(sessionFile), true, "Session file must not be deleted on parent quiescence failure");
    // Session registry entry preserved
    assert.ok(registry.get(sessionId), "Session registry entry must be preserved");

    rmSync(gitRepoDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 10. Deletion Lifecycle Gate: blocks spawn, continueAgent, and startBlockedTask
  // -------------------------------------------------------------------------
  it("Deletion Lifecycle Gate: markRunDeleting locks run and refuses new lifecycles", async () => {
    const manager = new SubagentManager(mockModelRuntime);
    const parentSessionId = `parent-gate-${Date.now()}`;

    // Mark run deleting
    manager.markRunDeleting(parentSessionId);
    assert.equal(manager.isRunDeleting(parentSessionId), true);

    // spawn must throw fail-closed
    await assert.rejects(
      () =>
        manager.spawn({
          parentSessionId,
          role: "developer",
          taskTitle: "Blocked Spawn",
          taskPrompt: "Do not execute",
          parentCwd: process.cwd(),
        }),
      /lifecycle gate locked/,
    );

    // continueAgent must throw fail-closed
    const agentId = `agent-gate-${Date.now()}`;
    const agent = manager.reusableAgents.create({
      agentId,
      parentSessionId,
      role: "developer",
      taskId: "task-orig",
      taskTitle: "Original",
    });
    agent.state = "idle_reusable";

    await assert.rejects(
      () =>
        manager.continueAgent({
          agentId,
          parentSessionId,
          taskTitle: "Blocked Continue",
          taskPrompt: "Do not execute",
          parentCwd: process.cwd(),
        }),
      /lifecycle gate locked/,
    );

    // startBlockedTask must return false and refuse to start
    const blockedTaskId = `task-gate-blocked-${Date.now()}`;
    subagentTasks.set(blockedTaskId, {
      task: {
        taskId: blockedTaskId,
        parentSessionId,
        role: "developer",
        taskTitle: "Blocked Task",
        status: "blocked",
        createdAt: new Date().toISOString(),
      },
      spawnOptions: {
        parentSessionId,
        role: "developer",
        taskTitle: "Blocked Task",
        taskPrompt: "Do not run",
        parentCwd: process.cwd(),
      },
    });

    const started = await manager.startBlockedTask(blockedTaskId);
    assert.equal(started, false, "startBlockedTask must return false when run is deleting");
    assert.equal(subagentTasks.get(blockedTaskId)?.task.status, "blocked", "Task must remain blocked");
  });

  // -------------------------------------------------------------------------
  // 11. Timeout Watchdog Preservation: abort failure preserves timeoutTimer
  // -------------------------------------------------------------------------
  it("Watchdog Preservation: timeoutTimer is NOT cleared if abort fails", async () => {
    const manager = new SubagentManager(mockModelRuntime);
    const taskId = `task-watchdog-${Date.now()}`;
    const dummyTimer = setTimeout(() => {}, 100_000);

    subagentTasks.set(taskId, {
      task: {
        taskId,
        parentSessionId: "session-watchdog",
        role: "developer",
        taskTitle: "Watchdog Task",
        status: "running",
        createdAt: new Date().toISOString(),
      },
      timeoutTimer: dummyTimer,
      runtime: {
        session: {
          messages: [],
          isStreaming: true,
          abort: async () => {
            throw new Error("Abort failed");
          },
        },
      } as any,
    });

    const aborted = await manager.abort(taskId, { source: "timeout" });
    assert.equal(aborted, false, "abort() must return false on error");

    const instance = subagentTasks.get(taskId);
    assert.ok(instance, "Instance must exist");
    assert.equal(instance.timeoutTimer, dummyTimer, "timeoutTimer must remain preserved on abort failure");

    clearTimeout(dummyTimer);
  });

  // -------------------------------------------------------------------------
  // 12. Verifier Mutation Guard: detects file modification and fails verification
  // -------------------------------------------------------------------------
  it("Verifier Mutation Guard: detects unauthorized file mutation in integration workspace and requests changes", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-verifier-guard-"));
    initGitRepo(gitRepoDir);

    const manager = new SubagentManager(mockModelRuntime);
    const parentSessionId = `parent-guard-${Date.now()}`;

    // Get integration workspace first
    const integration = await manager.getOrCreateIntegration(parentSessionId, gitRepoDir);

    const mockSession = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: '```json\n{\n  "verdict": "PASS",\n  "findings": []\n}\n```',
            },
          ],
          stopReason: "stop",
        },
      ],
      isStreaming: false,
      abort: async () => {},
      prompt: async () => {},
      subscribe: () => () => {},
      setThinkingLevel: () => {},
      setModel: async () => {},
    };

    const verifierTask = await manager.spawn({
      parentSessionId,
      role: "verifier",
      taskTitle: "Verify Code",
      taskPrompt: "Verify integration results",
      parentCwd: gitRepoDir,
      customSession: mockSession as any,
      taskContract: {
        taskId: `task-guard-${Date.now()}`,
        parentSessionId,
        role: "verifier",
        goal: "Verify Code",
        expectedEffects: ["analysis"],
      },
    });

    // Simulate unauthorized file mutation by Verifier in integration workspace
    const unauthorizedFile = join(integration.worktreePath, "unauthorized-patch.txt");
    writeFileSync(unauthorizedFile, "console.log('tampered');\n");

    // Complete the task
    await manager.handleSubagentCompletion(verifierTask.taskId);

    // Assert: Mutation Guard caught the modification
    assert.equal(verifierTask.verification?.overall, "fail", "Verification must fail due to unauthorized mutation");
    assert.equal(verifierTask.verification?.diff.status, "fail");
    assert.ok(/UNAUTHORIZED_MUTATION/i.test(verifierTask.verification?.diff.detail || ""));

    // Assert: Review verdict changed from PASS to REQUEST_CHANGES
    assert.ok(verifierTask.review, "Review result must be present");
    assert.equal(verifierTask.review.verdict, "REQUEST_CHANGES", "Review verdict must be forced to REQUEST_CHANGES");
    assert.ok(verifierTask.review.findings.some((f) => f.id === "unauthorized-mutation"));

    rmSync(gitRepoDir, { recursive: true, force: true });
  });
});
