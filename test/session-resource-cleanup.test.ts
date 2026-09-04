import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const testAgentDir = mkdtempSync(join(tmpdir(), "pi-cleanup-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

import { SubagentManager, subagentTasks } from "../server/subagent-manager.ts";
import { initTaskMemory, getTaskMemoriesRoot } from "../server/task-memory.ts";
import { SessionRegistry, type SessionEntry } from "../server/session/session-registry.ts";
import { handleSessionsRoutes } from "../server/http/routes-sessions.ts";
import { handleProjectsRoutes } from "../server/http/routes-projects.ts";
import { persistTask } from "../server/subagent/task-store.ts";
import {
  createWorktree,
  getOrCreateIntegrationWorkspace,
  loadPersistedRuntimeResources,
  registerRuntimeResource,
} from "../server/worktree.ts";
import { hasRuntimeOwnership } from "../server/git/runtime-resources.ts";
import { cleanupDeletedSessionResources } from "../server/session/session-cleanup.ts";
import { runGit } from "../server/git/git.ts";

const mockModelRuntime = { getModel: () => null } as any;

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Test Repo\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir });
}

describe("Q7.5 Session Resource Cleanup & Git Runtime Closure", () => {

  after(() => {
    rmSync(testAgentDir, { recursive: true, force: true });
  });

  function createMockResponse() {
    let statusCode = 0;
    let body = "";
    return {
      res: {
        writeHead: (code: number) => {
          statusCode = code;
        },
        end: (data?: string) => {
          if (data) body = data;
        },
      } as any,
      getStatusCode: () => statusCode,
      getBody: () => (body ? JSON.parse(body) : null),
    };
  }

  // 1. Single Session Delete: DELETE /api/sessions/:id
  it("1. Single Session Delete (DELETE /api/sessions/:id) cleans up subagent tasks, coordinator state, and registry", async () => {
    const sessionId = `session-single-${Date.now()}`;
    const projectSessionsDir = join(testAgentDir, "sessions", "single-proj");
    mkdirSync(projectSessionsDir, { recursive: true });
    const sessionFile = join(projectSessionsDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
    writeFileSync(sessionFile, JSON.stringify({ type: "session_header", cwd: "/tmp" }) + "\n");

    const manager = new SubagentManager(mockModelRuntime);
    const registry = new SessionRegistry();

    manager.notifyCoordinatorTurnStart(sessionId);
    manager.notifyCoordinatorTurnEnd(sessionId);

    const taskId = `task-single-${Date.now()}`;
    initTaskMemory(taskId, "Task memory content");
    subagentTasks.set(taskId, {
      task: {
        taskId,
        parentSessionId: sessionId,
        role: "verifier",
        taskTitle: "Single Task",
        status: "completed",
        createdAt: new Date().toISOString(),
      },
    });

    const entry: SessionEntry = {
      id: sessionId,
      runtime: { session: { messages: [] }, dispose: async () => {}, switchSession: async () => {} } as any,
      clients: new Set(),
      lastActive: Date.now(),
      published: true,
      activeRole: "coordinator",
      cwd: "/tmp",
      isGitRepo: false,
    };
    registry.set(sessionId, entry);

    const taskMemDir = join(getTaskMemoriesRoot(), taskId);
    assert.ok(existsSync(sessionFile));
    assert.ok(existsSync(taskMemDir));
    assert.ok(registry.get(sessionId));

    const serverContext: any = {
      sessionRegistry: registry,
      subagentManager: manager,
      agentCwd: "/tmp",
    };

    const { res, getStatusCode, getBody } = createMockResponse();
    const handled = await handleSessionsRoutes(
      new URL(`http://localhost/api/sessions/${sessionId}`),
      { method: "DELETE" } as any,
      res,
      serverContext,
    );

    assert.equal(handled, true);
    assert.equal(getStatusCode(), 200);
    assert.equal(getBody().ok, true);

    // Assert absence of orphans
    assert.equal(existsSync(sessionFile), false);
    assert.equal(existsSync(taskMemDir), false);
    assert.equal(registry.get(sessionId), undefined);
    assert.equal(subagentTasks.has(taskId), false);
  });

  // 2. Folder Delete: cleans active and inactive sessions
  it("2. Folder Delete (DELETE /api/projects?folder=...) cleans both active and inactive sessions", async () => {
    const folderCwd = resolve(testAgentDir, "folder-workspace");
    mkdirSync(folderCwd, { recursive: true });

    const sessionAId = `session-active-${Date.now()}`;
    const sessionBId = `session-inactive-${Date.now()}`;

    const projectDir = join(testAgentDir, "sessions", "folder-proj");
    mkdirSync(projectDir, { recursive: true });

    const fileA = join(projectDir, `2026-01-01T00-00-00-000Z_${sessionAId}.jsonl`);
    const fileB = join(projectDir, `2026-01-01T00-00-00-001Z_${sessionBId}.jsonl`);
    writeFileSync(fileA, JSON.stringify({ type: "session_header", cwd: folderCwd }) + "\n");
    writeFileSync(fileB, JSON.stringify({ type: "session_header", cwd: folderCwd }) + "\n");

    const manager = new SubagentManager(mockModelRuntime);
    const registry = new SessionRegistry();

    // Session A is active in SessionRegistry; Session B is inactive
    registry.set(sessionAId, {
      id: sessionAId,
      runtime: { session: { messages: [] }, dispose: async () => {}, switchSession: async () => {} } as any,
      clients: new Set(),
      lastActive: Date.now(),
      published: true,
      activeRole: "coordinator",
      cwd: folderCwd,
      isGitRepo: false,
    });

    const taskAId = `task-a-${Date.now()}`;
    const taskBId = `task-b-${Date.now()}`;
    initTaskMemory(taskAId, "Memory for task A");
    initTaskMemory(taskBId, "Memory for task B");
    subagentTasks.set(taskAId, {
      task: { taskId: taskAId, parentSessionId: sessionAId, role: "verifier", taskTitle: "Task A", status: "completed", createdAt: new Date().toISOString() },
    });
    subagentTasks.set(taskBId, {
      task: { taskId: taskBId, parentSessionId: sessionBId, role: "verifier", taskTitle: "Task B", status: "completed", createdAt: new Date().toISOString() },
    });

    const serverContext: any = {
      sessionRegistry: registry,
      subagentManager: manager,
      agentCwd: folderCwd,
      homeDir: tmpdir(),
    };

    const { res, getStatusCode, getBody } = createMockResponse();
    const handled = await handleProjectsRoutes(
      new URL(`http://localhost/api/projects?folder=${encodeURIComponent(folderCwd)}`),
      { method: "DELETE" } as any,
      res,
      serverContext,
    );

    assert.equal(handled, true);
    assert.equal(getStatusCode(), 200);
    const body = getBody();
    assert.equal(body.ok, true);

    // Observable behavior: files and derived resources for both A and B are cleaned
    assert.equal(existsSync(fileA), false);
    assert.equal(existsSync(fileB), false);
    assert.equal(existsSync(join(getTaskMemoriesRoot(), taskAId)), false);
    assert.equal(existsSync(join(getTaskMemoriesRoot(), taskBId)), false);
    assert.equal(registry.get(sessionAId), undefined);
    assert.equal(subagentTasks.has(taskAId), false);
    assert.equal(subagentTasks.has(taskBId), false);
  });

  // Test A: Single Session deletion cleans Git resources
  it("Test A: Single Session deletion cleans integration & task worktrees, branches and ownership records", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-git-repo-a-"));
    initGitRepo(gitRepoDir);

    const sessionId = `session-git-a-${Date.now()}`;
    const projectSessionsDir = join(testAgentDir, "sessions", "git-proj-a");
    mkdirSync(projectSessionsDir, { recursive: true });
    const sessionFile = join(projectSessionsDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
    writeFileSync(sessionFile, JSON.stringify({ type: "session_header", cwd: gitRepoDir }) + "\n");

    const manager = new SubagentManager(mockModelRuntime);
    const registry = new SessionRegistry();

    // 1. Create real Integration Workspace
    const integration = await getOrCreateIntegrationWorkspace(gitRepoDir, sessionId);
    assert.ok(existsSync(integration.worktreePath), "Integration worktree must exist");

    // 2. Create real Task Worktree and branch using createWorktree
    const taskId = `task-git-${Date.now()}`;
    const wtResult = await createWorktree(gitRepoDir, taskId, sessionId);
    const taskWorktree = wtResult.worktreePath;
    const taskBranch = wtResult.branch;
    assert.ok(existsSync(taskWorktree), "Task worktree must exist");

    // Verify branches exist in git refs
    const branchesBefore = await runGit(gitRepoDir, ["branch", "--list"]);
    assert.ok(branchesBefore.includes(taskBranch), "Task branch must exist in git refs");
    assert.ok(branchesBefore.includes(integration.branch), "Integration branch must exist in git refs");

    // 3. Register Task with worktreePath & branchName
    initTaskMemory(taskId, "Git Task Memory");
    subagentTasks.set(taskId, {
      task: {
        taskId,
        parentSessionId: sessionId,
        role: "verifier",
        taskTitle: "Git Task",
        status: "completed",
        createdAt: new Date().toISOString(),
        worktreePath: taskWorktree,
        branchName: taskBranch,
      },
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

    // Check ownership records exist
    const persistedBefore = loadPersistedRuntimeResources(gitRepoDir);
    assert.ok(persistedBefore.some((r) => r.runId === sessionId && r.type === "integration_worktree"));
    assert.ok(persistedBefore.some((r) => r.runId === sessionId && r.type === "task_worktree"));

    // 4. Execute DELETE /api/sessions/:id
    const serverContext: any = {
      sessionRegistry: registry,
      subagentManager: manager,
      agentCwd: gitRepoDir,
    };

    const { res, getStatusCode, getBody } = createMockResponse();
    const handled = await handleSessionsRoutes(
      new URL(`http://localhost/api/sessions/${sessionId}`),
      { method: "DELETE" } as any,
      res,
      serverContext,
    );

    assert.equal(handled, true);
    assert.equal(getStatusCode(), 200);
    assert.equal(getBody().ok, true);

    // 5. Assert: Git resources removed
    assert.equal(existsSync(sessionFile), false, "Session file must be deleted");
    assert.equal(existsSync(taskWorktree), false, "Task worktree must be removed");
    assert.equal(existsSync(integration.worktreePath), false, "Integration worktree must be removed");

    const branchesAfter = await runGit(gitRepoDir, ["branch", "--list"]);
    assert.equal(branchesAfter.includes(taskBranch), false, "Task branch must be deleted");
    assert.equal(branchesAfter.includes(integration.branch), false, "Integration branch must be deleted");

    const persistedAfter = loadPersistedRuntimeResources(gitRepoDir);
    assert.equal(persistedAfter.some((r) => r.runId === sessionId), false, "All ownership records for sessionId must be removed");

    // 6. Assert: Metadata removed
    assert.equal(subagentTasks.has(taskId), false);
    assert.equal(existsSync(join(getTaskMemoriesRoot(), taskId)), false);
    assert.equal(registry.get(sessionId), undefined);

    rmSync(gitRepoDir, { recursive: true, force: true });
  });

  // Test B: Inactive Session cleanup after simulated restart
  it("Test B: Inactive Session cleanup after simulated restart safely cleans Git runtime resources", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-git-repo-b-"));
    initGitRepo(gitRepoDir);

    const inactiveSessionId = `session-inactive-git-${Date.now()}`;
    const projectSessionsDir = join(testAgentDir, "sessions", "git-proj-b");
    mkdirSync(projectSessionsDir, { recursive: true });
    const sessionFile = join(projectSessionsDir, `2026-01-01T00-00-00-000Z_${inactiveSessionId}.jsonl`);
    writeFileSync(sessionFile, JSON.stringify({ type: "session_header", cwd: gitRepoDir }) + "\n");

    // Create Git resources & persist them
    const integration = await getOrCreateIntegrationWorkspace(gitRepoDir, inactiveSessionId);
    const taskId = `task-inactive-${Date.now()}`;
    const wtResult = await createWorktree(gitRepoDir, taskId, inactiveSessionId);
    const taskWorktree = wtResult.worktreePath;
    const taskBranch = wtResult.branch;

    // Persist task to disk so that a restarted SubagentManager loads it
    persistTask({
      taskId,
      parentSessionId: inactiveSessionId,
      role: "verifier",
      taskTitle: "Inactive Git Task",
      status: "completed",
      createdAt: new Date().toISOString(),
      worktreePath: taskWorktree,
      branchName: taskBranch,
    });
    initTaskMemory(taskId, "Inactive Task Memory");

    // Simulate Server Restart:
    // Create new SubagentManager instance (loads persisted task from disk)
    // Create empty SessionRegistry (inactiveSessionId is NOT in registry!)
    const restartedManager = new SubagentManager(mockModelRuntime);
    const restartedRegistry = new SessionRegistry();

    assert.equal(restartedRegistry.get(inactiveSessionId), undefined, "Inactive session must not be in registry");
    assert.ok(existsSync(taskWorktree), "Task worktree exists before restart cleanup");
    assert.ok(existsSync(integration.worktreePath), "Integration worktree exists before restart cleanup");

    const serverContext: any = {
      sessionRegistry: restartedRegistry,
      subagentManager: restartedManager,
      agentCwd: gitRepoDir,
      homeDir: tmpdir(),
    };

    // Execute DELETE /api/projects?folder=...
    const { res, getStatusCode, getBody } = createMockResponse();
    const handled = await handleProjectsRoutes(
      new URL(`http://localhost/api/projects?folder=${encodeURIComponent(gitRepoDir)}`),
      { method: "DELETE" } as any,
      res,
      serverContext,
    );

    assert.equal(handled, true);
    assert.equal(getStatusCode(), 200);
    assert.equal(getBody().ok, true);

    // Assert: Inactive session Git resources are all cleanly removed
    assert.equal(existsSync(sessionFile), false);
    assert.equal(existsSync(taskWorktree), false, "Task worktree must be removed for inactive session");
    assert.equal(existsSync(integration.worktreePath), false, "Integration worktree must be removed for inactive session");

    const branchesAfter = await runGit(gitRepoDir, ["branch", "--list"]);
    assert.equal(branchesAfter.includes(taskBranch), false, "Task branch must be deleted for inactive session");
    assert.equal(branchesAfter.includes(integration.branch), false, "Integration branch must be deleted for inactive session");

    const persistedAfter = loadPersistedRuntimeResources(gitRepoDir);
    assert.equal(persistedAfter.some((r) => r.runId === inactiveSessionId), false, "Ownership records must be cleaned");

    rmSync(gitRepoDir, { recursive: true, force: true });
  });

  // Test C: Ownership protection
  it("Test C: Ownership protection ensures foreign and user-created worktrees and branches are preserved", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-git-repo-c-"));
    initGitRepo(gitRepoDir);

    const targetSessionId = `session-target-${Date.now()}`;
    const projectSessionsDir = join(testAgentDir, "sessions", "git-proj-c");
    mkdirSync(projectSessionsDir, { recursive: true });
    const sessionFile = join(projectSessionsDir, `2026-01-01T00-00-00-000Z_${targetSessionId}.jsonl`);
    writeFileSync(sessionFile, JSON.stringify({ type: "session_header", cwd: gitRepoDir }) + "\n");

    // 1. Create target session-owned resources
    const targetIntegration = await getOrCreateIntegrationWorkspace(gitRepoDir, targetSessionId);
    const targetTaskId = `task-target-${Date.now()}`;
    const targetWtResult = await createWorktree(gitRepoDir, targetTaskId, targetSessionId);
    const targetTaskWorktree = targetWtResult.worktreePath;
    const targetTaskBranch = targetWtResult.branch;

    // 2. Create FOREIGN resources (belonging to another run)
    const foreignRunId = "other-run-id-12345";
    const foreignBranch = "feature/user-custom-branch";
    const foreignWorktree = resolve(gitRepoDir, ".worktrees", "foreign-user-wt");
    await runGit(gitRepoDir, ["worktree", "add", "-b", foreignBranch, foreignWorktree, "main"]);
    registerRuntimeResource(foreignRunId, "task_worktree", foreignWorktree, gitRepoDir);
    registerRuntimeResource(foreignRunId, "task_branch", foreignBranch, gitRepoDir);

    const manager = new SubagentManager(mockModelRuntime);
    const registry = new SessionRegistry();

    subagentTasks.set(targetTaskId, {
      task: {
        taskId: targetTaskId,
        parentSessionId: targetSessionId,
        role: "verifier",
        taskTitle: "Target Task",
        status: "completed",
        createdAt: new Date().toISOString(),
        worktreePath: targetTaskWorktree,
        branchName: targetTaskBranch,
      },
    });

    const serverContext: any = {
      sessionRegistry: registry,
      subagentManager: manager,
      agentCwd: gitRepoDir,
    };

    // Delete target session
    const { res, getStatusCode, getBody } = createMockResponse();
    const handled = await handleSessionsRoutes(
      new URL(`http://localhost/api/sessions/${targetSessionId}`),
      { method: "DELETE" } as any,
      res,
      serverContext,
    );

    assert.equal(handled, true);
    assert.equal(getStatusCode(), 200);
    assert.equal(getBody().ok, true);

    // Target session resources must be removed
    assert.equal(existsSync(targetTaskWorktree), false, "Target task worktree must be removed");
    assert.equal(existsSync(targetIntegration.worktreePath), false, "Target integration worktree must be removed");

    // FOREIGN resources must be strictly PRESERVED!
    assert.ok(existsSync(foreignWorktree), "Foreign worktree must NOT be deleted");
    const branchesAfter = await runGit(gitRepoDir, ["branch", "--list"]);
    assert.ok(branchesAfter.includes(foreignBranch), "Foreign branch must NOT be deleted");

    // Clean up foreign worktree manually before rmSync
    execFileSync("git", ["worktree", "remove", "--force", foreignWorktree], { cwd: gitRepoDir });
    rmSync(gitRepoDir, { recursive: true, force: true });
  });

  // Test D: HTTP contract regression
  it("Test D: DELETE /api/projects returns strictly { ok, deletedCount } without deletedSessionIds", async () => {
    const projectCwd = resolve(testAgentDir, "contract-workspace");
    mkdirSync(projectCwd, { recursive: true });

    const manager = new SubagentManager(mockModelRuntime);
    const registry = new SessionRegistry();

    const serverContext: any = {
      sessionRegistry: registry,
      subagentManager: manager,
      agentCwd: projectCwd,
      homeDir: tmpdir(),
    };

    // 1. DELETE /api/projects?folder=...
    const resp1 = createMockResponse();
    await handleProjectsRoutes(
      new URL(`http://localhost/api/projects?folder=${encodeURIComponent(projectCwd)}`),
      { method: "DELETE" } as any,
      resp1.res,
      serverContext,
    );
    assert.equal(resp1.getStatusCode(), 200);
    const body1 = resp1.getBody();
    assert.deepEqual(Object.keys(body1).sort(), ["deletedCount", "ok"]);
    assert.equal(typeof body1.ok, "boolean");
    assert.equal(typeof body1.deletedCount, "number");
    assert.equal((body1 as any).deletedSessionIds, undefined);

    // 2. DELETE /api/projects?cwd=...
    const resp2 = createMockResponse();
    await handleProjectsRoutes(
      new URL(`http://localhost/api/projects?cwd=${encodeURIComponent(projectCwd)}`),
      { method: "DELETE" } as any,
      resp2.res,
      serverContext,
    );
    assert.equal(resp2.getStatusCode(), 200);
    const body2 = resp2.getBody();
    assert.deepEqual(Object.keys(body2).sort(), ["deletedCount", "ok"]);
    assert.equal(typeof body2.ok, "boolean");
    assert.equal(typeof body2.deletedCount, "number");
    assert.equal((body2 as any).deletedSessionIds, undefined);
  });

  // Test E: Running Subagent Session deletion: abort completes BEFORE Git cleanup, and is silent (no report)
  it("Test E: Running Subagent Session deletion aborts before Git cleanup and produces no report", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-git-repo-e-"));
    initGitRepo(gitRepoDir);

    const sessionId = `session-running-${Date.now()}`;
    const projectSessionsDir = join(testAgentDir, "sessions", "git-proj-e");
    mkdirSync(projectSessionsDir, { recursive: true });
    const sessionFile = join(projectSessionsDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
    writeFileSync(sessionFile, JSON.stringify({ type: "session_header", cwd: gitRepoDir }) + "\n");

    const manager = new SubagentManager(mockModelRuntime);
    const registry = new SessionRegistry();

    const integration = await getOrCreateIntegrationWorkspace(gitRepoDir, sessionId);
    const taskId = `task-running-${Date.now()}`;
    const wtResult = await createWorktree(gitRepoDir, taskId, sessionId);
    const taskWorktree = wtResult.worktreePath;
    const taskBranch = wtResult.branch;

    const executionLog: string[] = [];
    let reportCalls = 0;

    // Running subagent mock with asynchronous abort
    const mockRuntime: any = {
      session: {
        messages: [],
        abort: async () => {
          executionLog.push("runtime_abort_start");
          assert.ok(existsSync(taskWorktree), "Task worktree must still exist while runtime abort is starting");
          await new Promise((resolve) => setTimeout(resolve, 50));
          assert.ok(existsSync(taskWorktree), "Task worktree must still exist while runtime abort is completing");
          executionLog.push("runtime_abort_end");
        },
      },
      dispose: async () => {},
    };

    initTaskMemory(taskId, "Running Task Memory");
    subagentTasks.set(taskId, {
      task: {
        taskId,
        parentSessionId: sessionId,
        role: "verifier",
        taskTitle: "Running Task",
        status: "running",
        createdAt: new Date().toISOString(),
        worktreePath: taskWorktree,
        branchName: taskBranch,
      },
      runtime: mockRuntime,
      onReport: () => {
        reportCalls++;
      },
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

    const serverContext: any = {
      sessionRegistry: registry,
      subagentManager: manager,
      agentCwd: gitRepoDir,
    };

    const { res, getStatusCode, getBody } = createMockResponse();
    const handled = await handleSessionsRoutes(
      new URL(`http://localhost/api/sessions/${sessionId}`),
      { method: "DELETE" } as any,
      res,
      serverContext,
    );

    assert.equal(handled, true);
    assert.equal(getStatusCode(), 200);
    assert.equal(getBody().ok, true);

    // 1. Quiescence sequence: runtime.session.abort() must start and finish before worktree cleanup
    assert.deepEqual(executionLog, ["runtime_abort_start", "runtime_abort_end"]);

    // 2. Silent abort: no parent report called
    assert.equal(reportCalls, 0, "No onReport must be triggered on session deletion");

    // 3. Git resources and tasks fully cleaned
    assert.equal(existsSync(taskWorktree), false, "Task worktree must be removed after quiescence");
    assert.equal(existsSync(integration.worktreePath), false, "Integration worktree must be removed");
    assert.equal(subagentTasks.has(taskId), false);
    assert.equal(existsSync(join(getTaskMemoriesRoot(), taskId)), false);

    rmSync(gitRepoDir, { recursive: true, force: true });
  });

  // Test F: In-flight Auto Finalize vs Session delete serialization and deletion gate blocks new Auto Finalize
  it("Test F: In-flight Auto Finalize serializes with Session delete, and deletion gate blocks new Auto Finalize", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-git-repo-f-"));
    initGitRepo(gitRepoDir);

    const sessionId = `session-race-${Date.now()}`;
    const projectSessionsDir = join(testAgentDir, "sessions", "git-proj-f");
    mkdirSync(projectSessionsDir, { recursive: true });
    const sessionFile = join(projectSessionsDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
    writeFileSync(sessionFile, JSON.stringify({ type: "session_header", cwd: gitRepoDir }) + "\n");

    const manager = new SubagentManager(mockModelRuntime);
    const registry = new SessionRegistry();

    await manager.getOrCreateIntegration(sessionId, gitRepoDir);

    // Create a deferred finalize to simulate an in-flight Auto Finalize merge
    let resolveFinalize: (val: any) => void = () => {};
    const finalizeDeferred = new Promise<any>((resolve) => {
      resolveFinalize = resolve;
    });

    const executionLog: string[] = [];
    let finalizeCallCount = 0;
    (manager as any).finalizeRun = async (sid: string, opts: any) => {
      finalizeCallCount++;
      executionLog.push("finalize_in_flight_start");
      const res = await finalizeDeferred;
      executionLog.push("finalize_in_flight_end");
      return res;
    };

    // Make session satisfy lineage so tryAutoFinalizeRun proceeds
    (manager as any).isSessionLineageSatisfied = () => true;

    // Start in-flight Auto Finalize
    const autoFinalizePromise = manager.tryAutoFinalizeRun(sessionId);

    // Concurrently trigger session deletion
    const serverContext: any = {
      sessionRegistry: registry,
      subagentManager: manager,
      agentCwd: gitRepoDir,
    };

    const { res, getStatusCode, getBody } = createMockResponse();
    const deletePromise = handleSessionsRoutes(
      new URL(`http://localhost/api/sessions/${sessionId}`),
      { method: "DELETE" } as any,
      res,
      serverContext,
    );

    // While deletion is waiting for the in-flight finalize, verify deletion gate blocks new Auto Finalize
    await new Promise((resolve) => setTimeout(resolve, 30));
    const blockedFinalizeResult = await manager.tryAutoFinalizeRun(sessionId);
    assert.equal(blockedFinalizeResult, null, "Deletion gate must immediately return null for new Auto Finalize attempts");
    assert.equal(finalizeCallCount, 1, "No second finalizeRun should be triggered");

    // Settle in-flight finalize
    resolveFinalize({
      success: true,
      status: "FINALIZED",
      mode: "working_tree",
      changedFiles: [],
    });

    await autoFinalizePromise;
    await deletePromise;

    assert.equal(getStatusCode(), 200);
    assert.equal(getBody().ok, true);
    assert.ok(executionLog.includes("finalize_in_flight_start"));
    assert.ok(executionLog.includes("finalize_in_flight_end"));

    rmSync(gitRepoDir, { recursive: true, force: true });
  });

  // Test G: Public API Audit: server/worktree.ts and server/subagent-manager.ts
  it("Test G: Public API Audit confirms legacy barrels do not leak runGit, findRepoRootForWorktree, or AbortSource", async () => {
    const worktreeModule = await import("../server/worktree.ts");
    assert.equal("runGit" in worktreeModule, false, "server/worktree.ts must NOT export runGit");
    assert.equal("findRepoRootForWorktree" in worktreeModule, false, "server/worktree.ts must NOT export findRepoRootForWorktree");

    const subagentManagerModule = await import("../server/subagent-manager.ts");
    assert.equal("AbortSource" in subagentManagerModule, false, "server/subagent-manager.ts must NOT export AbortSource");
    assert.equal("hasCoordinatorState" in (subagentManagerModule.SubagentManager.prototype as any), false);
    assert.equal("hasState" in subagentManagerModule, false);
  });

  // Test H: Abort failure blocks Git cleanup
  it("Test H: Abort failure blocks Git cleanup while unconfirmed and produces no report", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-git-repo-h-"));
    initGitRepo(gitRepoDir);

    const sessionId = `session-abort-fail-${Date.now()}`;
    const projectSessionsDir = join(testAgentDir, "sessions", "git-proj-h");
    mkdirSync(projectSessionsDir, { recursive: true });
    const sessionFile = join(projectSessionsDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
    writeFileSync(sessionFile, JSON.stringify({ type: "session_header", cwd: gitRepoDir }) + "\n");

    const manager = new SubagentManager(mockModelRuntime);
    const registry = new SessionRegistry();

    // 1. Create real Integration Workspace
    const integration = await getOrCreateIntegrationWorkspace(gitRepoDir, sessionId);
    assert.ok(existsSync(integration.worktreePath), "Integration worktree must exist");

    // 2. Create real Task Worktree and branch
    const taskId = `task-h-${Date.now()}`;
    const wtResult = await createWorktree(gitRepoDir, taskId, sessionId);
    const taskWorktree = wtResult.worktreePath;
    const taskBranch = wtResult.branch;
    assert.ok(existsSync(taskWorktree), "Task worktree must exist initially");

    let abortAttempts = 0;
    let reportCalls = 0;

    // Mock runtime whose session.abort fails
    const mockRuntime: any = {
      session: {
        messages: [],
        abort: async () => {
          abortAttempts++;
          throw new Error("abort failed");
        },
      },
      dispose: async () => {},
    };

    initTaskMemory(taskId, "Task Memory H");
    subagentTasks.set(taskId, {
      task: {
        taskId,
        parentSessionId: sessionId,
        role: "coder",
        taskTitle: "Task H",
        status: "running",
        createdAt: new Date().toISOString(),
        worktreePath: taskWorktree,
        branchName: taskBranch,
      },
      runtime: mockRuntime,
      onReport: () => {
        reportCalls++;
      },
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

    const serverContext: any = {
      sessionRegistry: registry,
      subagentManager: manager,
      agentCwd: gitRepoDir,
    };

    // Execute session deletion via cleanupDeletedSessionResources
    const cleanupResult = await cleanupDeletedSessionResources(sessionId, serverContext, gitRepoDir);

    // Assert: abort attempted
    assert.ok(abortAttempts >= 1, "abort must be attempted on the running subagent session");

    // Assert: Git worktree cleanup NOT executed while runtime is unconfirmed
    assert.equal(cleanupResult.gitCleanup, undefined, "Git runtime cleanup must NOT be executed on quiescence failure");

    // Assert: Task worktree remains
    assert.equal(existsSync(taskWorktree), true, "Task worktree must remain intact when abort fails");
    assert.equal(existsSync(integration.worktreePath), true, "Integration worktree must remain intact when abort fails");

    // Assert: ownership remains or is not falsely declared cleaned
    assert.equal(
      hasRuntimeOwnership(sessionId, "task_worktree", taskWorktree, gitRepoDir),
      true,
      "Runtime ownership for task worktree must remain preserved",
    );
    assert.equal(
      hasRuntimeOwnership(sessionId, "task_branch", taskBranch, gitRepoDir),
      true,
      "Runtime ownership for task branch must remain preserved",
    );

    // Assert: cleanup result/log contains quiescence failure
    assert.equal(cleanupResult.quiescence?.success, false, "Quiescence result must be failure");
    assert.ok(
      cleanupResult.errors?.some((e) => /quiescence failure/i.test(e)),
      "cleanup result errors must record quiescence failure",
    );

    // Assert: Parent report = 0
    assert.equal(reportCalls, 0, "No parent report must be generated on session deletion failure");

    // Assert: Fail-closed preservation
    assert.equal(existsSync(sessionFile), true, "Session JSONL file must NOT be deleted when quiescence fails");
    assert.ok(subagentTasks.has(taskId), "Task instance must NOT be removed from subagentTasks when abort fails");
    assert.ok(registry.get(sessionId), "SessionRegistry entry must NOT be removed when quiescence fails");

    // Clean up test instance from global map to avoid leaking into other tests
    subagentTasks.delete(taskId);
    registry.remove(sessionId);

    rmSync(gitRepoDir, { recursive: true, force: true });
  });

  // Test I: deletion gate remains active through full cleanup
  it("Test I: deletion gate remains active through full cleanup until finishRunDeletion", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-git-repo-i-"));
    initGitRepo(gitRepoDir);

    const sessionId = `session-gate-order-${Date.now()}`;
    const projectSessionsDir = join(testAgentDir, "sessions", "git-proj-i");
    mkdirSync(projectSessionsDir, { recursive: true });
    const sessionFile = join(projectSessionsDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
    writeFileSync(sessionFile, JSON.stringify({ type: "session_header", cwd: gitRepoDir }) + "\n");

    const manager = new SubagentManager(mockModelRuntime);
    const registry = new SessionRegistry();

    const taskId = `task-i-${Date.now()}`;
    initTaskMemory(taskId, "Task Memory I");
    subagentTasks.set(taskId, {
      task: {
        taskId,
        parentSessionId: sessionId,
        role: "verifier",
        taskTitle: "Task I",
        status: "completed",
        createdAt: new Date().toISOString(),
      },
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

    const serverContext: any = {
      sessionRegistry: registry,
      subagentManager: manager,
      agentCwd: gitRepoDir,
    };

    // Create an observable pause after clearTasksForParent and before SessionRegistry.remove
    let pauseResolve: () => void = () => {};
    const pausePromise = new Promise<void>((r) => {
      pauseResolve = r;
    });

    let clearTasksFinished = false;
    const origClearTasks = manager.clearTasksForParent.bind(manager);
    manager.clearTasksForParent = async (id: string) => {
      const res = await origClearTasks(id);
      if (id === sessionId) {
        clearTasksFinished = true;
        // Pause here: clearTasksForParent has finished, but registry.remove and finishRunDeletion haven't run yet
        await pausePromise;
      }
      return res;
    };

    // Trigger cleanup in the background
    const cleanupPromise = cleanupDeletedSessionResources(sessionId, serverContext, gitRepoDir);

    // Wait until clearTasksForParent has finished and is paused
    while (!clearTasksFinished) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // While paused after clearTasksForParent:
    // Assert tryAutoFinalizeRun is still blocked by deletion gate (returns null)
    const blockedDuringCleanup = await manager.tryAutoFinalizeRun(sessionId);
    assert.equal(
      blockedDuringCleanup,
      null,
      "tryAutoFinalizeRun must return null because deletion gate remains active after clearTasksForParent",
    );

    // Also assert direct finalizeRun is rejected by deletion gate
    const finalizeDuringCleanup = await manager.finalizeRun(sessionId);
    assert.equal(finalizeDuringCleanup.success, false);
    assert.ok(
      finalizeDuringCleanup.error?.includes("being deleted"),
      "finalizeRun must report deletion gate error",
    );

    // Resume cleanup to execute SessionRegistry remove and finishRunDeletion
    pauseResolve();
    await cleanupPromise;

    // After cleanup completes and finishRunDeletion runs, deletion gate is released!
    const finalizeAfterCleanup = await manager.finalizeRun(sessionId);
    assert.notEqual(finalizeAfterCleanup.error, `Session ${sessionId} is currently being deleted; refusing finalize`);

    rmSync(gitRepoDir, { recursive: true, force: true });
  });

  // Test J: clear_subagent_tasks does not mutate lifecycle locks
  it("Test J: clear_subagent_tasks does not mutate lifecycle locks (deletingRuns or in-flight finalize)", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-git-repo-j-"));
    initGitRepo(gitRepoDir);

    const sessionId = `session-locks-j-${Date.now()}`;
    const manager = new SubagentManager(mockModelRuntime);

    // Part 1: clear_subagent_tasks does NOT release deletingRuns
    await manager.prepareRunForDeletion(sessionId);

    // Simulate standard clear_subagent_tasks invocation
    await manager.clearTasksForParent(sessionId);

    // Assert deleting gate is still active: tryAutoFinalizeRun returns null
    const blockedFinalize = await manager.tryAutoFinalizeRun(sessionId);
    assert.equal(blockedFinalize, null, "clearTasksForParent must NOT release deletingRuns gate");

    const directFinalize = await manager.finalizeRun(sessionId);
    assert.equal(directFinalize.success, false);
    assert.ok(
      directFinalize.error?.includes("being deleted"),
      "finalizeRun must still see active deletion gate",
    );

    // Explicitly release deletion gate
    manager.finishRunDeletion(sessionId);

    // Part 2: clear_subagent_tasks does NOT clear in-flight finalize tracking
    const sessionId2 = `session-locks-j2-${Date.now()}`;
    await manager.getOrCreateIntegration(sessionId2, gitRepoDir);
    (manager as any).isSessionLineageSatisfied = () => true;

    let finalizeCallCount = 0;
    let resolveFinalize: (val: any) => void = () => {};
    const finalizeDeferred = new Promise<any>((r) => {
      resolveFinalize = r;
    });

    (manager as any).finalizeRun = async (sid: string, opts: any) => {
      finalizeCallCount++;
      return await finalizeDeferred;
    };

    // Start in-flight Auto Finalize
    const autoFinalizePromise = manager.tryAutoFinalizeRun(sessionId2);

    // While finalize is in-flight, execute clear_subagent_tasks
    await manager.clearTasksForParent(sessionId2);

    // Attempt a concurrent tryAutoFinalizeRun: it must still see finalizingRuns lock and return null without triggering another finalizeRun
    const concurrentFinalize = await manager.tryAutoFinalizeRun(sessionId2);
    assert.equal(concurrentFinalize, null, "clearTasksForParent must NOT clear in-flight finalize lock");
    assert.equal(finalizeCallCount, 1, "No second finalizeRun should be triggered while one is in flight");

    // Settle the in-flight finalize
    resolveFinalize({
      success: true,
      status: "FINALIZED",
      mode: "working_tree",
      changedFiles: [],
    });
    await autoFinalizePromise;

    rmSync(gitRepoDir, { recursive: true, force: true });
  });
});
