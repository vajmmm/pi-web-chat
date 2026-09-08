import assert from "node:assert/strict";
import { execSync as nodeExecSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  CANONICAL_ROLES,
  ConstraintResolver,
  RoleRegistry,
  type AgentRole,
} from "../../server/contracts/index.ts";
import {
  SubagentManager,
  subagentTasks,
  captureWorkspaceBaseline,
  detectWorkspaceMutations,
  computeFileContentHash,
} from "../../server/subagent-manager.ts";
import { cleanupDeletedSessionResources } from "../../server/session/session-cleanup.ts";
import { SessionRegistry } from "../../server/session/session-registry.ts";
import { isPendingDeletion } from "../../server/session/deletion-tombstone.ts";
import { applyRoleToSession } from "../../server/session/role-binding.ts";
import { handleCommand } from "../../server/ws/command-handler.ts";
import {
  hasRuntimeOwnership,
  loadPersistedRuntimeResources,
  registerRuntimeResource,
  unregisterRuntimeResource,
} from "../../server/git/runtime-resources.ts";
import { getTaskMemoryDir, removeTaskMemory } from "../../server/legacy-task-memory-cleanup.ts";

function initGitRepo(dir: string) {
  nodeExecSync("git init", { cwd: dir, stdio: "ignore" });
  nodeExecSync("git config user.name 'Test Runner'", { cwd: dir, stdio: "ignore" });
  nodeExecSync("git config user.email 'test@runner.local'", { cwd: dir, stdio: "ignore" });
  nodeExecSync("git commit --allow-empty -m 'initial commit'", { cwd: dir, stdio: "ignore" });
}

describe("In-Flight Quiescence, Legacy Role Hardening & Mutation Guard Regression Tests", () => {
  let testAgentDir: string;
  let mockModelRuntime: any;

  beforeEach(() => {
    testAgentDir = mkdtempSync(join(tmpdir(), "pi-inflight-agent-"));
    process.env.PI_CODING_AGENT_DIR = testAgentDir;
    RoleRegistry.getInstance().reload();

    mockModelRuntime = {
      initSession: async () => ({
        session: {
          messages: [],
          isStreaming: false,
          abort: async () => {},
          prompt: async () => {},
          subscribe: () => () => {},
        },
      }),
    };
    subagentTasks.clear();
  });

  afterEach(() => {
    subagentTasks.clear();
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(testAgentDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. P0: In-flight spawn/startTaskExecution paused on promise -> markRunDeleting -> release
  // -------------------------------------------------------------------------
  it("P0: in-flight spawn caught at async boundary during deletion aborts safely without orphan runtime or worktree", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-inflight-spawn-"));
    initGitRepo(gitRepoDir);

    const manager = new SubagentManager(mockModelRuntime);
    const parentSessionId = `parent-inflight-spawn-${Date.now()}`;

    let resolvePause!: () => void;
    const pausePromise = new Promise<void>((resolve) => {
      resolvePause = resolve;
    });

    let promptCalled = false;
    let disposeCalled = false;

    // Custom session whose prompt hook pauses or observes execution
    const pausedModelRuntime = {
      initSession: async () => {
        // Paused inside model runtime session creation
        await pausePromise;
        return {
          session: {
            messages: [],
            isStreaming: false,
            abort: async () => {},
            prompt: async () => {
              promptCalled = true;
            },
            subscribe: () => () => {},
            dispose: async () => {
              disposeCalled = true;
            },
          },
        };
      },
    };

    const pausedManager = new SubagentManager(pausedModelRuntime as any);

    // Launch spawn concurrently (it will pause during initSession)
    const spawnPromise = pausedManager.spawn({
      parentSessionId,
      role: "developer",
      taskTitle: "In-flight Task",
      taskPrompt: "Implement feature",
      parentCwd: gitRepoDir,
    });

    // Let the event loop advance so spawn enters inFlightTaskStarts and pauses on pausePromise
    await new Promise((r) => setTimeout(r, 20));

    // While spawn is paused in-flight, trigger Run Deletion
    const quiescePromise = pausedManager.prepareRunForDeletion(parentSessionId);

    // Release the pause promise so spawn resumes and hits the deletion check
    resolvePause();

    // Both should settle safely
    const [spawnResult, quiesceResult] = await Promise.all([spawnPromise, quiescePromise]);

    assert.equal(quiesceResult.success, true, "Quiescence must succeed");
    assert.equal(promptCalled, false, "session.prompt must NEVER be called for deleting run");
    assert.equal(spawnResult.status, "aborted", "Task must be safely marked aborted");

    // Verify task worktree was cleaned up
    const worktreesDir = join(gitRepoDir, ".worktrees");
    if (existsSync(worktreesDir)) {
      const nodeFs = await import("node:fs");
      const subdirs = nodeFs.readdirSync(worktreesDir);
      assert.equal(
        subdirs.some((d) => d.includes(spawnResult.taskId)),
        false,
        "Task worktree directory must be removed",
      );
    }

    rmSync(gitRepoDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 2. P0: In-flight startBlockedTask paused on promise -> markRunDeleting -> release
  // -------------------------------------------------------------------------
  it("P0: in-flight startBlockedTask caught at async boundary during deletion halts safely", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-inflight-blocked-"));
    initGitRepo(gitRepoDir);

    let resolvePause!: () => void;
    const pausePromise = new Promise<void>((resolve) => {
      resolvePause = resolve;
    });

    let promptCalled = false;
    const pausedModelRuntime = {
      initSession: async () => {
        await pausePromise;
        return {
          session: {
            messages: [],
            isStreaming: false,
            abort: async () => {},
            prompt: async () => {
              promptCalled = true;
            },
            subscribe: () => () => {},
          },
        };
      },
    };

    const manager = new SubagentManager(pausedModelRuntime as any);
    const parentSessionId = `parent-blocked-race-${Date.now()}`;

    // Spawn a blocked task
    const task = await manager.spawn({
      parentSessionId,
      role: "developer",
      taskTitle: "Blocked Task",
      taskPrompt: "Blocked prompt",
      parentCwd: gitRepoDir,
      taskContract: {
        taskId: `task-dep-${Date.now()}`,
        parentSessionId,
        role: "developer",
        goal: "Blocked Task",
        dependsOn: ["pre-requisite-task-999"],
      },
    });

    assert.equal(task.status, "blocked");

    // Begin starting blocked task
    const startPromise = manager.startBlockedTask(task.taskId);
    await new Promise((r) => setTimeout(r, 20));

    // Concurrently trigger prepareRunForDeletion
    const quiescePromise = manager.prepareRunForDeletion(parentSessionId);

    // Release pause
    resolvePause();

    const [started, quiesceResult] = await Promise.all([startPromise, quiescePromise]);

    assert.equal(started, false, "startBlockedTask must return false when session is deleting");
    assert.equal(quiesceResult.success, true, "prepareRunForDeletion must succeed");
    assert.equal(promptCalled, false, "session.prompt must not be invoked");

    rmSync(gitRepoDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 3. P1: RoleRegistry persistence load fails explicitly on legacy role
  // -------------------------------------------------------------------------
  it("P1: RoleRegistry.load / reload rejects disk roles.json with legacy role fail-closed", () => {
    const rolesFile = join(testAgentDir, "roles.json");
    const legacyConfig = [
      {
        id: "junior_fe",
        schemaVersion: 2,
        name: "Junior Frontend",
        definition: {
          id: "junior_fe",
          name: "Junior Frontend",
          description: "Legacy FE developer",
        },
      },
    ];
    writeFileSync(rolesFile, JSON.stringify(legacyConfig, null, 2));

    const registry = RoleRegistry.getInstance();
    assert.throws(
      () => {
        registry.reload();
      },
      /Unknown or unsupported legacy role "junior_fe"/i,
      "RoleRegistry must throw fail-closed on legacy role in roles.json",
    );
  });

  // -------------------------------------------------------------------------
  // 4. P1: WebSocket / applyRoleToSession rejects legacy role & does not pollute activeRole
  // -------------------------------------------------------------------------
  it("P1: applyRoleToSession & WebSocket set_session_role reject legacy role without polluting entry.activeRole", async () => {
    const mockSessionEntry: any = {
      id: "session-123",
      cwd: process.cwd(),
      activeRole: "developer",
      runtime: {
        session: {
          messages: [],
          agent: { state: { systemPrompt: "original prompt" } },
          setActiveToolsByName: () => {},
        },
      },
    };

    // Calling applyRoleToSession directly with legacy role
    assert.throws(
      () => {
        applyRoleToSession(mockSessionEntry, "junior_fe" as any);
      },
      /Cannot apply unknown or invalid role "junior_fe"/i,
      "applyRoleToSession must throw on invalid role",
    );

    // Assert: activeRole remains untouched!
    assert.equal(mockSessionEntry.activeRole, "developer", "entry.activeRole must NOT be polluted");
    assert.equal(
      mockSessionEntry.runtime.session.agent.state.systemPrompt,
      "original prompt",
      "System prompt must NOT be modified",
    );

    // Calling via WebSocket command handler
    const sentMessages: any[] = [];
    const mockWs: any = {
      OPEN: 1,
      readyState: 1, // WebSocket.OPEN
      send: (data: string) => {
        sentMessages.push(JSON.parse(data));
      },
    };

    const roleRegistry = new SessionRegistry();
    const mockCtx: any = {
      sessionRegistry: Object.assign(roleRegistry, {
        getByWs: () => mockSessionEntry,
      }),
      subagentManager: new SubagentManager(mockModelRuntime),
      getModelRuntime: () => mockModelRuntime,
    };

    await handleCommand(
      { type: "set_session_role", role: "junior_fe" as any },
      mockWs,
      mockCtx,
    );

    assert.equal(mockSessionEntry.activeRole, "developer", "activeRole must still remain unchanged");
    assert.ok(
      sentMessages.some((m) => m.type === "error" && /未知或非法的角色/i.test(m.message)),
      "WebSocket client must receive error message",
    );
  });

  // -------------------------------------------------------------------------
  // 5. P1: Session File deletion I/O failure halts destructive cleanup
  // -------------------------------------------------------------------------
  it("P1: session file deletion I/O failure halts cleanup immediately and preserves Registry & Tasks", async () => {
    const registry = new SessionRegistry();
    const sessionId = `session-io-fail-${Date.now()}`;
    const mockRuntime: any = {
      session: { isStreaming: false, abort: async () => {} },
      dispose: async () => {},
    };
    const entry: any = {
      id: sessionId,
      cwd: process.cwd(),
      runtime: mockRuntime,
      lastActive: Date.now(),
      clients: new Set(),
      activeRole: "developer",
    };
    registry.set(sessionId, entry);

    const manager = new SubagentManager(mockModelRuntime);
    // Add a dummy task under this session
    const taskContract = { taskId: `task-${sessionId}`, parentSessionId: sessionId, role: "developer" as const, goal: "test" };
    subagentTasks.set(taskContract.taskId, {
      task: {
        taskId: taskContract.taskId,
        parentSessionId: sessionId,
        role: "developer",
        status: "completed",
        taskContract,
      } as any,
      taskContract,
    });

    const mockCtx = {
      subagentManager: manager,
      sessionRegistry: registry,
    };

    // Create session file inside sessions/<project>/
    const sessionsDir = join(testAgentDir, "sessions");
    const projDir = join(sessionsDir, "test-project");
    mkdirSync(projDir, { recursive: true });
    const sessionFilePath = join(projDir, `session_${sessionId}.jsonl`);
    writeFileSync(sessionFilePath, "test session jsonl content\n");

    const nodeFs = await import("node:fs");
    // Make directory read-only so unlinkSync throws EACCES
    nodeFs.chmodSync(projDir, 0o555);

    try {
      const res = await cleanupDeletedSessionResources(sessionId, mockCtx as any, undefined, {
        deleteFile: true,
      });

      // Assert: cleanup returned failure (HTTP 500 equivalent)
      assert.equal(res.success, false, "cleanupResult.success must be false on I/O error");
      assert.ok(res.errors && res.errors.length > 0, "Errors array must record unlink failure");
      assert.ok(res.errors.some((e) => /Failed to unlink session file/i.test(e)));

      // Assert: Tombstone preserved and session file remains on disk
      assert.equal(isPendingDeletion(sessionId), true, "Tombstone must be preserved on unlink failure");
      assert.equal(existsSync(sessionFilePath), true, "Session JSONL file must remain on disk");
    } finally {
      // Restore permissions for cleanup
      nodeFs.chmodSync(projDir, 0o755);
    }
  });

  // -------------------------------------------------------------------------
  // 6. P1: SessionRegistry.remove/disposeAndRemoveStrict propagates dispose failure
  // -------------------------------------------------------------------------
  it("P1: SessionRegistry.disposeAndRemoveStrict retains entry and throws on dispose failure", async () => {
    const registry = new SessionRegistry();
    const sessionId = `session-dispose-fail-${Date.now()}`;
    let disposeAttempted = false;

    const mockRuntime: any = {
      session: { isStreaming: false, abort: async () => {} },
      dispose: async () => {
        disposeAttempted = true;
        throw new Error("Simulated dispose failure");
      },
    };

    const entry: any = {
      id: sessionId,
      cwd: process.cwd(),
      runtime: mockRuntime,
      lastActive: Date.now(),
      clients: new Set(),
      activeRole: "developer",
    };
    registry.set(sessionId, entry);
    assert.ok(registry.get(sessionId), "Entry should exist");

    await assert.rejects(
      async () => {
        await registry.disposeAndRemoveStrict(sessionId);
      },
      /Simulated dispose failure/,
      "disposeAndRemoveStrict must throw when dispose fails",
    );

    assert.equal(disposeAttempted, true, "dispose must have been attempted");
    assert.ok(registry.get(sessionId), "Entry must be PRESERVED when dispose fails (fail-closed)");
  });

  // -------------------------------------------------------------------------
  // 7. P2: Verifier Mutation Guard 5 Scenarios
  // -------------------------------------------------------------------------
  it("P2: Verifier Mutation Guard accurately detects new mutations across all 5 baseline scenarios", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-mutation-guard-5-"));
    initGitRepo(gitRepoDir);

    // Scenario A: Clean baseline -> new file created -> detected
    {
      const baseline = await captureWorkspaceBaseline(gitRepoDir);
      assert.equal(baseline.ok, true);
      assert.equal(baseline.files.size, 0);

      const newFile = join(gitRepoDir, "new-file.txt");
      writeFileSync(newFile, "hello\n");

      const res = await detectWorkspaceMutations(gitRepoDir, baseline);
      assert.equal(res.ok, true);
      assert.deepEqual(res.mutatedFiles, ["new-file.txt"]);

      rmSync(newFile);
    }

    // Scenario B: Dirty tracked baseline -> only one file modified further -> only that file detected
    {
      const file1 = join(gitRepoDir, "tracked1.txt");
      const file2 = join(gitRepoDir, "tracked2.txt");
      writeFileSync(file1, "initial 1\n");
      writeFileSync(file2, "initial 2\n");
      nodeExecSync("git add . && git commit -m 'commit tracked files'", { cwd: gitRepoDir, stdio: "ignore" });

      // Make both dirty before baseline
      writeFileSync(file1, "dirty 1\n");
      writeFileSync(file2, "dirty 2\n");

      const baseline = await captureWorkspaceBaseline(gitRepoDir);
      assert.equal(baseline.ok, true);
      assert.equal(baseline.files.size, 2);

      // Verifier ONLY modifies file1 further, leaves file2 untouched
      writeFileSync(file1, "dirty 1 modified by verifier\n");

      const res = await detectWorkspaceMutations(gitRepoDir, baseline);
      assert.equal(res.ok, true);
      assert.deepEqual(res.mutatedFiles, ["tracked1.txt"], "Only file1 should be detected as mutated!");
    }

    // Scenario C: Pre-existing untracked file -> content modified -> detected
    {
      const untrackedFile = join(gitRepoDir, "untracked.txt");
      writeFileSync(untrackedFile, "untracked content v1\n");

      const baseline = await captureWorkspaceBaseline(gitRepoDir);
      assert.equal(baseline.ok, true);
      assert.ok(baseline.files.has("untracked.txt"));

      // Verifier modifies content of untracked file
      writeFileSync(untrackedFile, "untracked content modified by verifier\n");

      const res = await detectWorkspaceMutations(gitRepoDir, baseline);
      assert.equal(res.ok, true);
      assert.ok(res.mutatedFiles.includes("untracked.txt"), "Modified untracked file must be detected");
    }

    // Scenario D: Baseline or detection unavailable -> fail-closed (returns ok: false)
    {
      const invalidBaseline = {
        ok: false,
        cwd: gitRepoDir,
        files: new Map(),
        error: "Simulated git baseline error",
      };

      const res = await detectWorkspaceMutations(gitRepoDir, invalidBaseline);
      assert.equal(res.ok, false, "Must return ok: false when baseline is invalid (fail-closed)");
      assert.ok(/Simulated git baseline error/i.test(res.error || ""));
    }

    // Scenario E: Baseline original modifications completely untouched -> 0 new mutations detected (passes)
    {
      const baseline = await captureWorkspaceBaseline(gitRepoDir);
      assert.equal(baseline.ok, true);

      // Verifier does nothing to the files
      const res = await detectWorkspaceMutations(gitRepoDir, baseline);
      assert.equal(res.ok, true);
      assert.equal(res.mutatedFiles.length, 0, "No new mutations should be detected when workspace was untouched");
    }

    rmSync(gitRepoDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 8. P0: Deletion during createRuntime + runtime.dispose injected failure
  // -------------------------------------------------------------------------
  it("P0: deletion during createRuntime with runtime.dispose failure fails quiescence and preserves runtime handle", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-dispose-fail-"));
    initGitRepo(gitRepoDir);

    const parentSessionId = `parent-dispose-fail-${Date.now()}`;
    const taskId = `task-dispose-fail-${Date.now()}`;
    let resolveEntered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    let resolvePause!: () => void;
    const pausePromise = new Promise<void>((resolve) => {
      resolvePause = resolve;
    });

    let disposeAttempted = false;
    const manager = new SubagentManager(mockModelRuntime);

    // Spawn task in-flight with customSession function that signals entered then returns failing dispose
    const spawnPromise = manager.spawn({
      parentSessionId,
      role: "developer",
      taskTitle: "Dispose Fail Task",
      taskPrompt: "Implement feature",
      parentCwd: gitRepoDir,
      taskContract: {
        taskId,
        parentSessionId,
        role: "developer",
        goal: "Dispose fail test",
      },
      customSession: async () => {
        resolveEntered();
        await pausePromise;
        return {
          session: {
            messages: [],
            isStreaming: false,
            abort: async () => {},
            prompt: async () => {},
            subscribe: () => () => {},
          },
          dispose: async () => {
            disposeAttempted = true;
            throw new Error("Simulated runtime dispose rejection during rollback");
          },
        };
      },
    });

    // Wait until customSession is definitely executing (worktree already created, runtime being initialized)
    await enteredPromise;

    // Deletion starts
    const quiescePromise = manager.prepareRunForDeletion(parentSessionId);

    // Release pause so spawn completes runtime creation, hits abortAndCleanupIfDeleted, calls runtime.dispose which throws
    resolvePause();

    const [spawnResult, quiesceResult] = await Promise.all([spawnPromise, quiescePromise]);

    // Assert: Quiescence MUST fail
    assert.equal(disposeAttempted, true, "runtime.dispose must have been attempted");
    assert.equal(quiesceResult.success, false, "Quiescence must fail when runtime.dispose fails");
    assert.ok(quiesceResult.failedTaskIds?.includes(spawnResult.taskId), "Failed task ID must be recorded");

    // Assert: Runtime handle is NOT lost (preserved on instance)
    const inst = subagentTasks.get(spawnResult.taskId);
    assert.ok(inst, "Instance must be preserved");
    assert.ok(inst.runtime, "Runtime handle must be preserved on instance");
    assert.ok(inst.initializationCleanupError, "initializationCleanupError must be recorded");
    assert.notEqual(inst.task.status, "aborted", "Task must NOT be marked aborted on failed rollback");

    // Assert: Destructive cleanup aborts and returns 409
    const registry = new SessionRegistry();
    const mockCtx = {
      subagentManager: manager,
      sessionRegistry: registry,
    };
    const cleanupRes = await cleanupDeletedSessionResources(parentSessionId, mockCtx as any);
    assert.equal(cleanupRes.success, false);
    assert.equal(cleanupRes.quiescence?.success, false);

    rmSync(gitRepoDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 9. P0: Deletion after createWorktree with removeWorktree failure
  // -------------------------------------------------------------------------
  it("P0: deletion after createWorktree with removeWorktree failure fails quiescence and preserves worktree & ownership", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-wt-fail-"));
    initGitRepo(gitRepoDir);

    const parentSessionId = `parent-wt-fail-${Date.now()}`;
    const taskId = `task-wt-fail-${Date.now()}`;
    let resolveEntered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    let resolvePause!: () => void;
    const pausePromise = new Promise<void>((resolve) => {
      resolvePause = resolve;
    });

    let spawnedTaskInstance: any;
    const manager = new SubagentManager(mockModelRuntime);

    const spawnPromise = manager.spawn({
      parentSessionId,
      role: "developer",
      taskTitle: "Worktree Fail Task",
      taskPrompt: "Implement feature",
      parentCwd: gitRepoDir,
      taskContract: {
        taskId,
        parentSessionId,
        role: "developer",
        goal: "Worktree fail test",
      },
      customSession: async () => {
        spawnedTaskInstance = subagentTasks.get(taskId);
        if (spawnedTaskInstance?.task.worktreePath) {
          // Write a file in worktree and chmod 0o555 so git worktree remove fails
          writeFileSync(join(spawnedTaskInstance.task.worktreePath, "locked.txt"), "locked");
          chmodSync(spawnedTaskInstance.task.worktreePath, 0o555);
        }
        resolveEntered();
        await pausePromise;
        return {
          session: {
            messages: [],
            isStreaming: false,
            abort: async () => {},
            prompt: async () => {},
            subscribe: () => () => {},
          },
          dispose: async () => {},
        };
      },
    });

    await enteredPromise;

    // Now trigger deletion
    const quiescePromise = manager.prepareRunForDeletion(parentSessionId);

    // Release pause
    resolvePause();

    try {
      const [spawnResult, quiesceResult] = await Promise.all([spawnPromise, quiescePromise]);

      // Assert: Quiescence must fail
      assert.equal(quiesceResult.success, false, "Quiescence must fail when worktree removal fails");

      // Assert: Task metadata & worktreePath preserved
      const inst = subagentTasks.get(spawnResult.taskId);
      assert.ok(inst, "Instance must be preserved");
      assert.ok(inst.task.worktreePath, "worktreePath must NOT be cleared");
      assert.notEqual(inst.task.status, "aborted", "Task must NOT be marked aborted");

      // Assert: Runtime resource ownership preserved
      const owned = hasRuntimeOwnership(parentSessionId, "task_worktree", inst.task.worktreePath!, gitRepoDir);
      assert.equal(owned, true, "Ownership must NOT be unregistered when removal fails");
    } finally {
      if (spawnedTaskInstance?.task.worktreePath) {
        try {
          chmodSync(spawnedTaskInstance.task.worktreePath, 0o755);
        } catch {}
      }
      rmSync(gitRepoDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 10. P0: Deletion with branch deletion failure
  // -------------------------------------------------------------------------
  it("P0: deletion with branch deletion failure preserves branch ownership and fails quiescence", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-branch-fail-"));
    initGitRepo(gitRepoDir);

    const parentSessionId = `parent-branch-fail-${Date.now()}`;
    const taskId = `task-branch-fail-${Date.now()}`;
    let resolveEntered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    let resolvePause!: () => void;
    const pausePromise = new Promise<void>((resolve) => {
      resolvePause = resolve;
    });

    let spawnedTaskInstance: any;
    const manager = new SubagentManager(mockModelRuntime);

    const spawnPromise = manager.spawn({
      parentSessionId,
      role: "developer",
      taskTitle: "Branch Fail Task",
      taskPrompt: "Implement feature",
      parentCwd: gitRepoDir,
      taskContract: {
        taskId,
        parentSessionId,
        role: "developer",
        goal: "Branch fail test",
      },
      customSession: async () => {
        spawnedTaskInstance = subagentTasks.get(taskId);
        // Lock .git/refs/heads/runtime so git branch -D cannot delete the branch
        const runtimeRefDir = join(gitRepoDir, ".git", "refs", "heads", "runtime");
        chmodSync(runtimeRefDir, 0o555);
        resolveEntered();
        await pausePromise;
        return {
          session: {
            messages: [],
            isStreaming: false,
            abort: async () => {},
            prompt: async () => {},
            subscribe: () => () => {},
          },
          dispose: async () => {},
        };
      },
    });

    await enteredPromise;

    // Deletion starts
    const quiescePromise = manager.prepareRunForDeletion(parentSessionId);
    resolvePause();

    try {
      const [spawnResult, quiesceResult] = await Promise.all([spawnPromise, quiescePromise]);

      const inst = subagentTasks.get(spawnResult.taskId);
      assert.ok(inst);
      assert.ok(inst.initializationCleanupError, "initializationCleanupError must be recorded");
      assert.equal(quiesceResult.success, false, "Quiescence must fail on branch cleanup error");
      assert.notEqual(inst.task.status, "aborted", "Task must not be marked aborted");
      if (inst.task.branchName) {
        const owned = hasRuntimeOwnership(parentSessionId, "task_branch", inst.task.branchName, gitRepoDir);
        assert.equal(owned, true, "Branch ownership must NOT be unregistered prematurely");
      }
    } finally {
      try {
        chmodSync(join(gitRepoDir, ".git", "refs", "heads", "runtime"), 0o755);
      } catch {}
      rmSync(gitRepoDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 11. P1: RoleRegistry.reload is atomic & transactional
  // -------------------------------------------------------------------------
  it("P1: RoleRegistry.reload is atomic: keeps pre-reload in-memory config intact when invalid role encountered", () => {
    const registry = RoleRegistry.getInstance();
    const rolesFile = join(testAgentDir, "roles.json");

    // 1. First save valid custom canonical roles
    const validCustomConfig = [
      {
        id: "developer",
        schemaVersion: 2,
        roleDefinitionVersion: 2,
        name: "Custom Developer",
        definition: {
          id: "developer",
          definitionVersion: 2,
          name: "Custom Developer",
          description: "Custom dev description",
          responsibilities: ["Develop code"],
          strictProhibitions: ["Do not break"],
        },
        allowedTools: ["read", "write"],
      },
    ];
    writeFileSync(rolesFile, JSON.stringify(validCustomConfig, null, 2));
    registry.reload();

    // Verify custom config was loaded
    const devRole = registry.getRole("developer");
    assert.equal(devRole.name, "Custom Developer");
    assert.deepEqual(devRole.allowedTools, ["read", "write"]);

    // 2. Overwrite roles.json with an invalid config containing legacy role junior_fe
    const invalidConfig = [
      {
        id: "junior_fe",
        schemaVersion: 2,
        name: "Junior Frontend",
        definition: {
          id: "junior_fe",
          name: "Junior Frontend",
          description: "Legacy FE developer",
          responsibilities: ["Write code"],
          strictProhibitions: ["None"],
        },
      },
    ];
    writeFileSync(rolesFile, JSON.stringify(invalidConfig, null, 2));

    // 3. reload() must throw fail-closed
    assert.throws(
      () => {
        registry.reload();
      },
      /Unknown or unsupported legacy role "junior_fe"/i,
    );

    // 4. In-memory registry must NOT be partially modified or reset to defaults!
    // It must retain the pre-reload valid custom configuration!
    const devRoleAfter = registry.getRole("developer");
    assert.equal(devRoleAfter.name, "Custom Developer", "In-memory role name must be preserved");
    assert.deepEqual(devRoleAfter.allowedTools, ["read", "write"], "In-memory allowedTools must be preserved");
  });

  // -------------------------------------------------------------------------
  // 12. P2: Mutation Guard fail-closed on hash read error
  // -------------------------------------------------------------------------
  it("P2: Mutation Guard fail-closed when file exists but hash read fails with EACCES", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-hash-read-fail-"));
    initGitRepo(gitRepoDir);

    const testFile = join(gitRepoDir, "unreadable.txt");
    writeFileSync(testFile, "sensitive content\n");
    // Make file completely unreadable (0o000)
    chmodSync(testFile, 0o000);

    try {
      // Direct computeFileContentHash test
      const hashRes = computeFileContentHash(testFile);
      assert.equal(hashRes.ok, false, "computeFileContentHash must return ok: false on read failure");
      assert.equal(hashRes.exists, true, "exists must be true when file exists on disk");
      assert.ok(/Failed to read file for hash computation/i.test(hashRes.error || ""));

      // captureWorkspaceBaseline must fail-closed (ok: false)
      const baseline = await captureWorkspaceBaseline(gitRepoDir);
      assert.equal(baseline.ok, false, "captureWorkspaceBaseline must fail-closed when file cannot be hashed");
      assert.ok(/Failed to compute hash/i.test(baseline.error || ""));

      // detectWorkspaceMutations must fail-closed (ok: false)
      const mutRes = await detectWorkspaceMutations(gitRepoDir, baseline);
      assert.equal(mutRes.ok, false, "detectWorkspaceMutations must return ok: false");
      assert.ok(mutRes.error && mutRes.error.length > 0);
    } finally {
      chmodSync(testFile, 0o644);
      rmSync(gitRepoDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 13. P0: completed Subagent delete must call runtime.dispose
  // -------------------------------------------------------------------------
  it("P0: completed Subagent delete must call runtime.dispose before removing instance", async () => {
    const manager = new SubagentManager(mockModelRuntime);
    const taskId = `task-comp-${Date.now()}`;
    let disposeCalled = 0;

    const mockRuntime = {
      session: {
        messages: [],
        isStreaming: false,
        abort: async () => {},
      },
      dispose: async () => {
        disposeCalled++;
      },
    };

    const inst: any = {
      task: {
        taskId,
        parentSessionId: "p-test",
        role: "developer",
        status: "completed",
        taskTitle: "Completed Task",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 100,
      },
      runtime: mockRuntime,
      reported: true,
      aborting: false,
    };
    subagentTasks.set(taskId, inst);

    const res = await manager.deleteTask(taskId);
    assert.equal(res, true, "deleteTask should succeed");
    assert.equal(disposeCalled, 1, "runtime.dispose must be called exactly once");
    assert.equal(subagentTasks.has(taskId), false, "Instance must be removed from subagentTasks");
  });

  // -------------------------------------------------------------------------
  // 14. P0: abort success + dispose failure must NOT delete Task
  // -------------------------------------------------------------------------
  it("P0: abort success + dispose failure must NOT delete Task and must preserve runtime/memory", async () => {
    const manager = new SubagentManager(mockModelRuntime);
    const taskId = `task-disp-fail-${Date.now()}`;
    let abortCalled = 0;
    let disposeCalled = 0;

    // Create task memory directory and file
    const memDir = getTaskMemoryDir(taskId);
    writeFileSync(join(memDir, "working-memory.md"), "important memory");

    const mockRuntime = {
      session: {
        messages: [],
        isStreaming: false,
        abort: async () => {
          abortCalled++;
        },
      },
      dispose: async () => {
        disposeCalled++;
        throw new Error("Simulated dispose failure");
      },
    };

    const inst: any = {
      task: {
        taskId,
        parentSessionId: "p-test",
        role: "developer",
        status: "running",
        taskTitle: "Running Task",
        startedAt: new Date().toISOString(),
      },
      runtime: mockRuntime,
      reported: false,
      aborting: false,
    };
    subagentTasks.set(taskId, inst);

    const res = await manager.deleteTask(taskId);
    assert.equal(res, false, "deleteTask must return false when runtime.dispose fails");
    assert.equal(abortCalled, 1, "abort must have been called");
    // abort() now disposes as part of terminal close; deleteTask retries dispose
    // if the handle remains. Either attempt failing is enough to fail-closed.
    assert.ok(disposeCalled >= 1, "dispose must have been attempted");

    // Must preserve instance in subagentTasks
    assert.equal(subagentTasks.has(taskId), true, "Task instance must remain in subagentTasks");
    const preservedInst = subagentTasks.get(taskId);
    assert.ok(preservedInst?.runtime, "Runtime handle must NOT be dropped");

    // Must preserve task memory
    assert.equal(existsSync(join(memDir, "working-memory.md")), true, "Task memory must be preserved");

    // Clean up memory after test
    removeTaskMemory(taskId);
    subagentTasks.delete(taskId);
  });

  // -------------------------------------------------------------------------
  // 15. P0: Parent Session success deletion disposes all Subagent Runtimes
  // -------------------------------------------------------------------------
  it("P0: Parent Session success deletion disposes all Subagent Runtimes before returning 200/success", async () => {
    const manager = new SubagentManager(mockModelRuntime);
    const parentSessionId = `parent-del-all-${Date.now()}`;
    const taskId1 = `task-1-${Date.now()}`;
    const taskId2 = `task-2-${Date.now()}`;
    let dispose1 = 0;
    let dispose2 = 0;

    const mockRuntime1 = {
      session: { messages: [], isStreaming: false, abort: async () => {} },
      dispose: async () => {
        dispose1++;
      },
    };
    const mockRuntime2 = {
      session: { messages: [], isStreaming: false, abort: async () => {} },
      dispose: async () => {
        dispose2++;
      },
    };

    subagentTasks.set(taskId1, {
      task: {
        taskId: taskId1,
        parentSessionId,
        role: "developer",
        status: "completed",
        taskTitle: "T1",
        startedAt: new Date().toISOString(),
      },
      runtime: mockRuntime1,
      reported: true,
      aborting: false,
    } as any);

    subagentTasks.set(taskId2, {
      task: {
        taskId: taskId2,
        parentSessionId,
        role: "researcher",
        status: "completed",
        taskTitle: "T2",
        startedAt: new Date().toISOString(),
      },
      runtime: mockRuntime2,
      reported: true,
      aborting: false,
    } as any);

    const registry = new SessionRegistry();
    const mockCtx = {
      subagentManager: manager,
      sessionRegistry: registry,
    };

    const cleanupRes = await cleanupDeletedSessionResources(parentSessionId, mockCtx as any);
    assert.equal(cleanupRes.success, true, "Parent session cleanup must succeed");
    assert.equal(dispose1, 1, "Subagent 1 runtime.dispose must be called");
    assert.equal(dispose2, 1, "Subagent 2 runtime.dispose must be called");
    assert.equal(subagentTasks.has(taskId1), false, "Task 1 must be removed from subagentTasks");
    assert.equal(subagentTasks.has(taskId2), false, "Task 2 must be removed from subagentTasks");
  });

  // -------------------------------------------------------------------------
  // 16. P0/P1: initialization rollback first DELETE fails (409), second succeeds
  // -------------------------------------------------------------------------
  it("P0/P1: initialization rollback first DELETE fails (409), second DELETE retries cleanup and succeeds", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-retry-del-"));
    initGitRepo(gitRepoDir);

    const parentSessionId = `parent-retry-del-${Date.now()}`;
    const taskId = `task-retry-del-${Date.now()}`;
    let resolveEntered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    let resolvePause!: () => void;
    const pausePromise = new Promise<void>((resolve) => {
      resolvePause = resolve;
    });

    let shouldFailDispose = true;
    let disposeAttempts = 0;
    const manager = new SubagentManager(mockModelRuntime);

    const spawnPromise = manager.spawn({
      parentSessionId,
      role: "developer",
      taskTitle: "Retry Delete Task",
      taskPrompt: "Implement feature",
      parentCwd: gitRepoDir,
      taskContract: { taskId, parentSessionId, role: "developer", goal: "Retry test" },
      customSession: async () => {
        resolveEntered();
        await pausePromise;
        return {
          session: {
            messages: [],
            isStreaming: false,
            abort: async () => {},
            prompt: async () => {},
            subscribe: () => () => {},
          },
          dispose: async () => {
            disposeAttempts++;
            if (shouldFailDispose) {
              throw new Error("Simulated transient dispose error");
            }
          },
        };
      },
    });

    await enteredPromise;

    // 1. First DELETE triggers while in-flight
    const quiesce1 = manager.prepareRunForDeletion(parentSessionId);
    resolvePause();

    const [spawnResult, quiesce1Res] = await Promise.all([spawnPromise, quiesce1]);
    assert.equal(quiesce1Res.success, false, "First deletion quiescence must fail");
    const inst = subagentTasks.get(taskId);
    assert.ok(inst, "Instance must be preserved after failed rollback");
    assert.ok(inst.initializationCleanupError, "initializationCleanupError must be set");
    assert.equal(inst.task.status, "failed");

    // 2. Second DELETE: transient error is now resolved!
    shouldFailDispose = false;
    const quiesce2Res = await manager.prepareRunForDeletion(parentSessionId);
    assert.equal(quiesce2Res.success, true, "Second deletion quiescence must succeed on retry");
    assert.equal(inst.initializationCleanupError, undefined, "initializationCleanupError must be cleared");
    assert.equal(inst.task.status, "aborted", "Task must now be marked aborted");
    assert.ok(disposeAttempts >= 2, "dispose must have been attempted at least twice");

    // Full session cleanup succeeds
    const registry = new SessionRegistry();
    const mockCtx = {
      subagentManager: manager,
      sessionRegistry: registry,
    };
    const cleanupRes = await cleanupDeletedSessionResources(parentSessionId, mockCtx as any);
    assert.equal(cleanupRes.success, true);
    assert.equal(subagentTasks.has(taskId), false, "Task must be cleanly removed");

    rmSync(gitRepoDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 17. P0/P1: initializationCleanupError Task cannot be deleted as terminal
  // -------------------------------------------------------------------------
  it("P0/P1: initializationCleanupError Task cannot be deleted as ordinary terminal task when retry fails", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-retry-block-"));
    initGitRepo(gitRepoDir);

    const parentSessionId = `parent-retry-block-${Date.now()}`;
    const taskId = `task-retry-block-${Date.now()}`;
    const manager = new SubagentManager(mockModelRuntime);

    const wtDir = join(gitRepoDir, ".worktrees", taskId);
    mkdirSync(wtDir, { recursive: true });
    // Write a file and chmod 0555 so git worktree remove fails
    writeFileSync(join(wtDir, "file.txt"), "data");
    chmodSync(wtDir, 0o555);

    const inst: any = {
      task: {
        taskId,
        parentSessionId,
        role: "developer",
        status: "failed", // Appears to be terminal
        taskTitle: "Rollback Failed Task",
        worktreePath: wtDir,
      },
      repoRoot: gitRepoDir,
      initializationCleanupError: "Failed to remove worktree",
    };
    subagentTasks.set(taskId, inst);

    try {
      // deleteTask must NOT treat this as a normal terminal task and must retry cleanup
      // Since wt is locked, retry fails, so deleteTask must return false!
      const ok = await manager.deleteTask(taskId);
      assert.equal(ok, false, "deleteTask must return false when initialization cleanup retry fails");
      assert.equal(subagentTasks.has(taskId), true, "Task must NOT be removed from subagentTasks");
      assert.ok(subagentTasks.get(taskId)?.initializationCleanupError);
    } finally {
      chmodSync(wtDir, 0o755);
      rmSync(gitRepoDir, { recursive: true, force: true });
      subagentTasks.delete(taskId);
    }
  });

  // -------------------------------------------------------------------------
  // 18. P1: Git cleanup failure preserves recovery metadata
  // -------------------------------------------------------------------------
  it("P1: Git cleanup failure preserves recovery metadata (integrations, tasks, registry) and aborts destructive cleanup", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-git-fail-1-"));
    initGitRepo(gitRepoDir);

    const parentSessionId = `parent-git-fail-1-${Date.now()}`;
    const taskId = `task-git-fail-1-${Date.now()}`;
    const manager = new SubagentManager(mockModelRuntime);

    const intWt = join(gitRepoDir, ".worktrees", `integration-${parentSessionId}`);
    const intBranch = `runtime/run-${parentSessionId}`;
    nodeExecSync(`git branch "${intBranch}"`, { cwd: gitRepoDir });
    nodeExecSync(`git worktree add "${intWt}" "${intBranch}"`, { cwd: gitRepoDir });

    registerRuntimeResource(parentSessionId, "integration_worktree", intWt, gitRepoDir);
    registerRuntimeResource(parentSessionId, "integration_branch", intBranch, gitRepoDir);

    await manager.getOrCreateIntegration(parentSessionId, gitRepoDir);

    subagentTasks.set(taskId, {
      task: { taskId, parentSessionId, role: "developer", status: "completed", taskTitle: "T" },
      reported: true,
    } as any);

    const registry = new SessionRegistry();
    registry.entries.set(parentSessionId, {
      id: parentSessionId,
      runtime: { dispose: async () => {} } as any,
      session: {} as any,
      activeRole: "coordinator",
      lastActive: Date.now(),
      published: true,
      clients: new Set(),
      cwd: gitRepoDir,
      isGitRepo: true,
    });

    const mockCtx = {
      subagentManager: manager,
      sessionRegistry: registry,
    };

    // Lock intWt so worktree remove fails
    writeFileSync(join(intWt, "locked.txt"), "locked");
    chmodSync(intWt, 0o555);

    try {
      const cleanupRes = await cleanupDeletedSessionResources(parentSessionId, mockCtx as any, { hintCwd: gitRepoDir });
      assert.equal(cleanupRes.success, false, "Cleanup must fail when git cleanup fails");

      // Verify recovery metadata is preserved!
      assert.ok(manager.getIntegration(parentSessionId), "Integration entry must NOT be deleted on failure");
      assert.ok(subagentTasks.has(taskId), "subagentTasks must NOT be wiped out on git failure");
      assert.ok(registry.get(parentSessionId), "SessionRegistry must NOT be wiped out on git failure");
    } finally {
      try { chmodSync(intWt, 0o755); } catch {}
      rmSync(gitRepoDir, { recursive: true, force: true });
      subagentTasks.delete(taskId);
      manager.finishRunDeletion(parentSessionId);
    }
  });

  // -------------------------------------------------------------------------
  // 19. P1: Retry after Git cleanup failure clears leftover ownership
  // -------------------------------------------------------------------------
  it("P1: Retry after Git cleanup failure successfully deletes resources and clears leftover ownership from runtime-resources.json", async () => {
    const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-git-fail-2-"));
    initGitRepo(gitRepoDir);

    const parentSessionId = `parent-git-fail-2-${Date.now()}`;
    const taskId = `task-git-fail-2-${Date.now()}`;
    const manager = new SubagentManager(mockModelRuntime);

    const intWt = join(gitRepoDir, ".worktrees", `integration-${parentSessionId}`);
    const intBranch = `runtime/run-${parentSessionId}`;
    nodeExecSync(`git branch "${intBranch}"`, { cwd: gitRepoDir });
    nodeExecSync(`git worktree add "${intWt}" "${intBranch}"`, { cwd: gitRepoDir });

    registerRuntimeResource(parentSessionId, "integration_worktree", intWt, gitRepoDir);
    registerRuntimeResource(parentSessionId, "integration_branch", intBranch, gitRepoDir);

    await manager.getOrCreateIntegration(parentSessionId, gitRepoDir);

    subagentTasks.set(taskId, {
      task: { taskId, parentSessionId, role: "developer", status: "completed", taskTitle: "T" },
      reported: true,
    } as any);

    const registry = new SessionRegistry();
    registry.entries.set(parentSessionId, {
      id: parentSessionId,
      runtime: { dispose: async () => {} } as any,
      session: {} as any,
      activeRole: "coordinator",
      lastActive: Date.now(),
      published: true,
      clients: new Set(),
      cwd: gitRepoDir,
      isGitRepo: true,
    });

    const mockCtx = {
      subagentManager: manager,
      sessionRegistry: registry,
    };

    // 1. First run with lock on intWt
    writeFileSync(join(intWt, "locked.txt"), "locked");
    chmodSync(intWt, 0o555);

    try {
      const cleanup1 = await cleanupDeletedSessionResources(parentSessionId, mockCtx as any, { hintCwd: gitRepoDir });
      assert.equal(cleanup1.success, false);

      // 2. Unlock intWt and retry cleanup
      chmodSync(intWt, 0o755);
      const cleanup2 = await cleanupDeletedSessionResources(parentSessionId, mockCtx as any, { hintCwd: gitRepoDir });
      assert.equal(cleanup2.success, true, "Retry cleanup must succeed");

      // Verify leftover ownership in runtime-resources.json is completely cleaned up!
      const persisted = loadPersistedRuntimeResources(gitRepoDir);
      const sessionLeftovers = persisted.filter((r) => r.runId === parentSessionId);
      assert.equal(sessionLeftovers.length, 0, "All leftover ownership must be removed after successful retry");

      // Verify all metadata is now cleanly purged
      assert.equal(manager.getIntegration(parentSessionId), undefined);
      assert.equal(subagentTasks.has(taskId), false);
      assert.equal(registry.get(parentSessionId), undefined);
    } finally {
      try { chmodSync(intWt, 0o755); } catch {}
      rmSync(gitRepoDir, { recursive: true, force: true });
      subagentTasks.delete(taskId);
      manager.finishRunDeletion(parentSessionId);
    }
  });
});
