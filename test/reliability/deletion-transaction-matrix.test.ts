import assert from "node:assert/strict";
import { execSync as nodeExecSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  registerRuntimeResource,
  unregisterRuntimeResource,
  hasRuntimeOwnership,
  loadPersistedRuntimeResources,
  recoverRuntimeResources,
  clearRuntimeResourceRegistry,
  setPersistenceFailureInjector,
  setRollbackWorktreeRemoveFailureInjector,
  loadPendingGitRecovery,
} from "../../server/git/runtime-resources.ts";
import { createWorktree } from "../../server/git/worktree.ts";
import { getOrCreateIntegrationWorkspace } from "../../server/git/integration-workspace.ts";
import { cleanupRunResources } from "../../server/git/cleanup.ts";
import { probeGitBranch } from "../../server/git/git.ts";
import {
  deleteTaskFile,
  loadPersistedTasks,
  persistTask,
  subagentTasks,
  taskFilePath,
} from "../../server/subagent/task-store.ts";
import { SubagentManager } from "../../server/subagent-manager.ts";
import { cleanupDeletedSessionResources } from "../../server/session/session-cleanup.ts";
import { SessionRegistry, type SessionEntry } from "../../server/session/session-registry.ts";
import {
  clearPendingDeletionsCache,
  getPendingDeletionsFilePath,
  isPendingDeletion,
  loadPendingDeletions,
  recordPendingDeletion,
  removePendingDeletion,
} from "../../server/session/deletion-tombstone.ts";
import { deleteSessionTurns } from "../../server/turn-recorder.ts";
import { getTaskMemoryDir, removeTaskMemory } from "../../server/legacy-task-memory-cleanup.ts";
import { getTaskRuntimeDir } from "../../server/runtime-artifacts.ts";
import { handleCommand } from "../../server/ws/command-handler.ts";
import { handleRolesRoutes } from "../../server/http/routes-roles.ts";
import { getAllRoleConfigs } from "../../server/roles.ts";
import type { UISubagentTask } from "../../shared/protocol.ts";

function initGitRepo(dir: string) {
  nodeExecSync("git init", { cwd: dir, stdio: "ignore" });
  nodeExecSync("git config user.name 'Test Runner'", { cwd: dir, stdio: "ignore" });
  nodeExecSync("git config user.email 'test@runner.local'", { cwd: dir, stdio: "ignore" });
  nodeExecSync("git commit --allow-empty -m 'initial commit'", { cwd: dir, stdio: "ignore" });
}

describe("Session Deletion Transaction & Fail-Closed Matrix (22 Scenarios)", () => {
  let tmpRoot: string;
  let tmpHome: string;
  let repoRoot: string;
  let oldHome: string | undefined;
  let oldAgentDir: string | undefined;
  let sessionRegistry: SessionRegistry;
  let subagentManager: SubagentManager;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pi-del-matrix-"));
    tmpHome = join(tmpRoot, "home");
    repoRoot = join(tmpRoot, "repo");
    mkdirSync(tmpHome, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    initGitRepo(repoRoot);

    oldHome = process.env.HOME;
    oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = tmpHome;
    process.env.PI_CODING_AGENT_DIR = tmpHome;
    clearPendingDeletionsCache();
    clearRuntimeResourceRegistry();

    subagentTasks.clear();
    sessionRegistry = new SessionRegistry();
    subagentManager = new SubagentManager({} as any);
    sessionRegistry.isDeleting = (id) => subagentManager.isDeleting(id) || isPendingDeletion(id);
  });

  afterEach(() => {
    subagentTasks.clear();
    clearPendingDeletionsCache();
    if (oldHome !== undefined) {
      process.env.HOME = oldHome;
    }
    if (oldAgentDir !== undefined) {
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function cleanupCtx() {
    return { sessionRegistry, subagentManager };
  }

  function createMockParentEntry(sessionId: string, isStreaming = false): SessionEntry {
    const entry: SessionEntry = {
      id: sessionId,
      cwd: repoRoot,
      activeRole: "coordinator",
      lastActive: Date.now(),
      runtime: {
        session: {
          isStreaming,
          abort: async () => {},
          prompt: async () => {},
        },
        dispose: async () => {},
      } as any,
      clients: new Set(),
    };
    sessionRegistry.entries.set(sessionId, entry);
    return entry;
  }

  function createMockTask(
    parentSessionId: string,
    taskId: string,
    role = "developer",
    status: any = "completed",
  ): UISubagentTask {
    const task: UISubagentTask = {
      taskId,
      parentSessionId,
      taskTitle: `Task ${taskId}`,
      role: role as any,
      status,
      goal: "do something",
    };
    subagentTasks.set(taskId, {
      task,
      spawnOptions: { parentCwd: repoRoot },
      reported: status === "completed",
      runtime: {
        session: { isStreaming: false, abort: async () => {} },
        dispose: async () => {},
      } as any,
    });
    persistTask(task);
    return task;
  }

  // =========================================================================
  // M01: Concurrent DELETE - Single Flight Transaction Mutex
  // =========================================================================
  it("M01: concurrent DELETE executes single-flight transaction and does not release gates prematurely", async () => {
    const sessionId = "m01-concurrent";
    createMockParentEntry(sessionId);
    createMockTask(sessionId, "t-m01");

    // Launch two concurrent cleanup calls
    const p1 = cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });

    const p2 = cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });

    // Both should refer to the same in-flight transaction
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.success, true);
    assert.equal(r2.success, true);
    assert.equal(isPendingDeletion(sessionId), false);
    assert.equal(subagentManager.isDeleting(sessionId), false);
  });

  // =========================================================================
  // M02: Parent streaming abort fail -> Fail-closed, 409, no tombstone
  // =========================================================================
  it("M02: parent streaming abort failure returns failure without creating persistent tombstone", async () => {
    const sessionId = "m02-parent-abort-fail";
    const entry = createMockParentEntry(sessionId, true);
    entry.runtime.session.abort = async () => {
      throw new Error("Parent abort crashed");
    };

    const res = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });

    assert.equal(res.success, false);
    assert.equal(res.quiescence?.success, false);
    // Destructive cleanup not entered -> no tombstone left
    assert.equal(isPendingDeletion(sessionId), false);
    assert.equal(subagentManager.isDeleting(sessionId), false);
  });

  // =========================================================================
  // M03: Parent in-flight prompt settles before deletion proceeds
  // =========================================================================
  it("M03: deletion waits for in-flight parent prompt to settle", async () => {
    const sessionId = "m03-parent-inflight";
    createMockParentEntry(sessionId);

    let promptSettled = false;
    const promptPromise = sessionRegistry.trackInFlightOp(sessionId, async () => {
      await new Promise((r) => setTimeout(r, 50));
      promptSettled = true;
    });

    const delPromise = cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });

    await Promise.all([promptPromise, delPromise]);
    assert.equal(promptSettled, true);
  });

  // =========================================================================
  // M04: Parent in-flight guidance prompt settles before deletion
  // =========================================================================
  it("M04: deletion waits for in-flight coordinator guidance op to settle", async () => {
    const sessionId = "m04-guidance-inflight";
    createMockParentEntry(sessionId);

    let guidanceSettled = false;
    const guidancePromise = sessionRegistry.trackInFlightOp(sessionId, async () => {
      await new Promise((r) => setTimeout(r, 50));
      guidanceSettled = true;
    });

    const res = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });

    await guidancePromise;
    assert.equal(guidanceSettled, true);
    assert.equal(res.success, true);
  });

  // =========================================================================
  // M05: Subagent in-flight start settles before Phase A
  // =========================================================================
  it("M05: deletion waits for subagent in-flight start to settle", async () => {
    const sessionId = "m05-subagent-start";
    createMockParentEntry(sessionId);

    let startSettled = false;
    const startPromise = subagentManager.trackInFlightStart(sessionId, async () => {
      await new Promise((r) => setTimeout(r, 50));
      startSettled = true;
    });

    const res = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });

    await startPromise;
    assert.equal(startSettled, true);
    assert.equal(res.success, true);
  });

  // =========================================================================
  // M06: Subagent in-flight completion settles before Phase A
  // =========================================================================
  it("M06: deletion waits for in-flight subagent completion to settle", async () => {
    const sessionId = "m06-subagent-completion";
    createMockParentEntry(sessionId);
    const task = createMockTask(sessionId, "t-m06", "developer", "running");

    let compSettled = false;
    const compPromise = subagentManager.handleSubagentCompletion("t-m06").then(() => {
      compSettled = true;
    });

    const res = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });

    await compPromise;
    assert.equal(compSettled, true);
    assert.equal(res.success, true);
  });

  // =========================================================================
  // M07: Subagent abort fail -> Quiescence failure, fail-closed
  // =========================================================================
  it("M07: subagent abort failure prevents destructive cleanup and releases gate", async () => {
    const sessionId = "m07-subagent-abort-fail";
    createMockParentEntry(sessionId);
    const task = createMockTask(sessionId, "t-m07", "developer", "running");
    const inst = subagentTasks.get("t-m07")!;
    inst.runtime = {
      session: {
        isStreaming: true,
        abort: async () => {
          throw new Error("Subagent abort died");
        },
      },
      dispose: async () => {},
    } as any;

    const res = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });

    assert.equal(res.success, false);
    assert.equal(res.quiescence?.success, false);
    // Did not enter destructive cleanup
    assert.equal(isPendingDeletion(sessionId), false);
  });

  // =========================================================================
  // M08: Phase A: Subagent runtime dispose throws -> Fail-closed, tombstone preserved
  // =========================================================================
  it("M08: subagent runtime.dispose failure preserves tombstone at disposing_subagents", async () => {
    const sessionId = "m08-subagent-dispose-fail";
    createMockParentEntry(sessionId);
    createMockTask(sessionId, "t-m08");
    const inst = subagentTasks.get("t-m08")!;
    inst.runtime = {
      session: { isStreaming: false, abort: async () => {} },
      dispose: async () => {
        throw new Error("Subagent dispose disk EIO");
      },
    } as any;

    const res = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });

    assert.equal(res.success, false);
    // Tombstone must be preserved with stage 'disposing_subagents'
    assert.equal(isPendingDeletion(sessionId), true);
    const pending = loadPendingDeletions().get(sessionId);
    assert.equal(pending?.stage, "disposing_subagents");
    // Subagent tasks map must retain the handle
    assert.ok(subagentTasks.has("t-m08"));
  });

  // =========================================================================
  // M09: Phase B: Worktree exists on disk without verified ownership -> Fail-closed
  // =========================================================================
  it("M09: worktree on disk without verified ownership fails closed and is NOT deleted", async () => {
    const sessionId = "m09-unverified-worktree";
    createMockParentEntry(sessionId);
    const unverifiedPath = join(repoRoot, ".worktrees", "unverified-wt");
    mkdirSync(unverifiedPath, { recursive: true });

    // Task points to worktree, but NO runtime-resources.json ownership registered
    const task = createMockTask(sessionId, "t-m09");
    task.worktreePath = unverifiedPath;
    const inst = subagentTasks.get("t-m09")!;
    inst.task.worktreePath = unverifiedPath;

    const res = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });

    assert.equal(res.success, false);
    assert.equal(res.gitCleanup?.success, false);
    // Unverified worktree must still exist on disk!
    assert.equal(existsSync(unverifiedPath), true);
    // Tombstone preserved
    assert.equal(isPendingDeletion(sessionId), true);
  });

  // =========================================================================
  // M10: Phase B: Branch exists in git refs without verified ownership -> Fail-closed
  // =========================================================================
  it("M10: branch in git refs without verified ownership fails closed and is NOT deleted", async () => {
    const sessionId = "m10-unverified-branch";
    createMockParentEntry(sessionId);
    const branchName = "subagent/unverified-branch";
    nodeExecSync(`git branch ${branchName}`, { cwd: repoRoot, stdio: "ignore" });

    const task = createMockTask(sessionId, "t-m10");
    task.branchName = branchName;
    const inst = subagentTasks.get("t-m10")!;
    inst.task.branchName = branchName;

    const res = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });

    assert.equal(res.success, false);
    assert.equal(res.gitCleanup?.success, false);
    // Branch must still exist!
    const branchExists = (() => {
      try {
        nodeExecSync(`git show-ref --verify refs/heads/${branchName}`, { cwd: repoRoot, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();
    assert.equal(branchExists, true);
    assert.equal(isPendingDeletion(sessionId), true);
  });

  // =========================================================================
  // M11: Phase B: Worktree remove error -> Fail-closed, tombstone preserved
  // =========================================================================
  it("M11: worktree remove error preserves tombstone and task metadata", async () => {
    const sessionId = "m11-wt-remove-err";
    createMockParentEntry(sessionId);
    const wtPath = join(repoRoot, ".worktrees", "task-m11");
    mkdirSync(join(repoRoot, ".worktrees"), { recursive: true });
    nodeExecSync(`git worktree add -b runtime/task-m11 "${wtPath}"`, { cwd: repoRoot, stdio: "ignore" });
    registerRuntimeResource(sessionId, "task_worktree", wtPath, repoRoot);

    const task = createMockTask(sessionId, "t-m11");
    task.worktreePath = wtPath;
    subagentTasks.get("t-m11")!.task.worktreePath = wtPath;

    chmodSync(join(repoRoot, ".worktrees"), 0o555);
    try {
      const res = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });
      assert.equal(res.success, false);
      assert.equal(res.gitCleanup?.success, false);
      assert.equal(existsSync(wtPath), true);
      assert.equal(isPendingDeletion(sessionId), true);
      assert.equal(loadPendingDeletions().get(sessionId)?.stage, "git_cleanup");
      assert.ok(subagentTasks.has("t-m11"), "task metadata must remain as retry anchor");
    } finally {
      chmodSync(join(repoRoot, ".worktrees"), 0o755);
    }
  });

  // =========================================================================
  // M12: Phase B: Branch delete error -> Fail-closed, tombstone preserved
  // =========================================================================
  it("M12: branch delete error preserves tombstone and task metadata", async () => {
    const sessionId = "m12-branch-del-err";
    createMockParentEntry(sessionId);
    const branchName = "runtime/task-m12";
    const originalBranch = nodeExecSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    nodeExecSync(`git branch ${branchName}`, { cwd: repoRoot, stdio: "ignore" });
    nodeExecSync(`git checkout ${branchName}`, { cwd: repoRoot, stdio: "ignore" });
    registerRuntimeResource(sessionId, "task_branch", branchName, repoRoot);

    const task = createMockTask(sessionId, "t-m12");
    task.branchName = branchName;
    subagentTasks.get("t-m12")!.task.branchName = branchName;

    const res = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });
    assert.equal(res.success, false);
    assert.equal(res.gitCleanup?.success, false);
    const branchExists = (() => {
      try {
        nodeExecSync(`git show-ref --verify refs/heads/${branchName}`, { cwd: repoRoot, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();
    assert.equal(branchExists, true, "checked-out branch must not be deleted");
    assert.equal(isPendingDeletion(sessionId), true);
    assert.equal(loadPendingDeletions().get(sessionId)?.stage, "git_cleanup");
    assert.ok(subagentTasks.has("t-m12"));
    nodeExecSync(`git checkout ${originalBranch}`, { cwd: repoRoot, stdio: "ignore" });
  });

  // =========================================================================
  // M13: Phase C: Subagent task file unlink fails -> Fail-closed
  // =========================================================================
  it("M13: deleteTaskFile unlink failure preserves task in memory and fails closed", async () => {
    const sessionId = "m13-parent";
    createMockParentEntry(sessionId);
    createMockTask(sessionId, "t-m13");
    const tasksDir = join(tmpHome, "subagent-tasks");
    assert.equal(existsSync(taskFilePath("t-m13")), true);

    chmodSync(tasksDir, 0o555);
    try {
      const res = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });
      assert.equal(res.success, false);
      assert.equal(isPendingDeletion(sessionId), true);
      assert.equal(loadPendingDeletions().get(sessionId)?.stage, "metadata_cleanup");
      assert.ok(subagentTasks.has("t-m13"));
      assert.equal(existsSync(taskFilePath("t-m13")), true);
    } finally {
      chmodSync(tasksDir, 0o755);
    }
  });

  // =========================================================================
  // M14: Legacy data remains part of explicit user deletion and must be retriable.
  // =========================================================================
  it("M14: legacy task-memory cleanup failure preserves deletion retry metadata", async () => {
    const sessionId = "m14-parent";
    createMockParentEntry(sessionId);
    createMockTask(sessionId, "t-m14");
    const memDir = getTaskMemoryDir("t-m14");
    writeFileSync(join(memDir, "memory.json"), "{}", "utf8");
    const memoriesRoot = join(tmpHome, "task-memories");

    chmodSync(memoriesRoot, 0o555);
    try {
      const res = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });
      assert.equal(res.success, false);
      assert.equal(isPendingDeletion(sessionId), true);
      assert.equal(subagentTasks.has("t-m14"), true);
      assert.equal(existsSync(taskFilePath("t-m14")), true);
      assert.equal(existsSync(memDir), true);
    } finally {
      chmodSync(memoriesRoot, 0o755);
    }
  });

  it("artifact cleanup failure retains task metadata and retry removes task and coordinator evidence", async () => {
    const sessionId = "artifacts-parent";
    createMockParentEntry(sessionId);
    createMockTask(sessionId, "artifacts-task");
    const artifactDir = getTaskRuntimeDir(sessionId, "artifacts-task");
    const coordinatorDir = getTaskRuntimeDir(sessionId, "coordinator");
    writeFileSync(join(artifactDir, "transcript.jsonl"), "private evidence");
    writeFileSync(join(coordinatorDir, "raw.log"), "coordinator evidence");
    const tasksDir = join(artifactDir, "..");
    chmodSync(tasksDir, 0o555);
    try {
      const failed = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });
      assert.equal(failed.success, false);
      assert.equal(existsSync(taskFilePath("artifacts-task")), true);
      assert.equal(subagentTasks.has("artifacts-task"), true);
      assert.equal(isPendingDeletion(sessionId), true);
    } finally { chmodSync(tasksDir, 0o755); }
    const retried = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });
    assert.equal(retried.success, true);
    assert.equal(existsSync(artifactDir), false);
    assert.equal(existsSync(coordinatorDir), false);
    assert.equal(existsSync(taskFilePath("artifacts-task")), false);
  });

  // =========================================================================
  // M15: Phase C: Session turns deletion failure
  // =========================================================================
  it("M15: deleteSessionTurns unlink failure fails closed and preserves tombstone", async () => {
    const sessionId = "m15-turns";
    createMockParentEntry(sessionId);
    const turnsDir = join(tmpHome, "session-turns");
    mkdirSync(turnsDir, { recursive: true });
    const turnsFile = join(turnsDir, `${sessionId}.json`);
    writeFileSync(turnsFile, "[]", "utf8");

    chmodSync(turnsDir, 0o555);
    try {
      const res = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });
      assert.equal(res.success, false);
      assert.equal(isPendingDeletion(sessionId), true);
      assert.equal(loadPendingDeletions().get(sessionId)?.stage, "metadata_cleanup");
      assert.equal(existsSync(turnsFile), true);
    } finally {
      chmodSync(turnsDir, 0o755);
    }
  });

  // =========================================================================
  // M16: Phase C: Coordinator state cleanup failure fails closed
  // =========================================================================
  it("M16: clearCoordinatorState failure fails closed and preserves tombstone", async () => {
    const parentSessionId = "m16-coord-state";
    createMockParentEntry(parentSessionId);
    subagentManager.clearCoordinatorState = () => {
      throw new Error("clearCoordinatorState failed");
    };

    const res = await cleanupDeletedSessionResources(parentSessionId, cleanupCtx(), repoRoot, { deleteFile: false });
    assert.equal(res.success, false);
    assert.equal(isPendingDeletion(parentSessionId), true);
    assert.equal(loadPendingDeletions().get(parentSessionId)?.stage, "metadata_cleanup");
  });

  // =========================================================================
  // M17: Phase D: Parent runtime.dispose throws -> Fail-closed, tombstone preserved
  // =========================================================================
  it("M17: parent runtime.dispose failure preserves tombstone at disposing_parent", async () => {
    const sessionId = "m17-parent-dispose-fail";
    const entry = createMockParentEntry(sessionId);
    entry.runtime.dispose = async () => {
      throw new Error("Parent runtime dispose crash");
    };

    const res = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });

    assert.equal(res.success, false);
    assert.equal(isPendingDeletion(sessionId), true);
    const pending = loadPendingDeletions().get(sessionId);
    assert.equal(pending?.stage, "disposing_parent");
  });

  // =========================================================================
  // M18: Phase E: Session JSONL deletion failure preserves tombstone
  // =========================================================================
  it("M18: session file deletion failure preserves tombstone at session_file_delete", async () => {
    const sessionId = "m18-file-del-fail";
    createMockParentEntry(sessionId);
    const projDir = join(tmpHome, "sessions", "test-project");
    mkdirSync(projDir, { recursive: true });
    const sessionFilePath = join(projDir, `session_${sessionId}.jsonl`);
    writeFileSync(sessionFilePath, "test session jsonl\n");

    chmodSync(projDir, 0o555);
    try {
      const res = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: true });
      assert.equal(res.success, false);
      assert.equal(isPendingDeletion(sessionId), true);
      assert.equal(loadPendingDeletions().get(sessionId)?.stage, "session_file_delete");
      assert.equal(existsSync(sessionFilePath), true);
    } finally {
      chmodSync(projDir, 0o755);
    }
  });

  // =========================================================================
  // M19: Persistent Tombstone blocks SessionRegistry acquire
  // =========================================================================
  it("M19: in-flight acquire is rejected and disposed when DELETE marks deletion concurrently", async () => {
    const sessionId = "m19-concurrent-acquire-del";
    let creatorDisposed = false;
    let releaseCreator!: () => void;
    const creatorGate = new Promise<void>((resolve) => {
      releaseCreator = resolve;
    });

    // 1. acquire(sessionId) 已开始，creator 卡在 deferred Promise
    const acquirePromise = sessionRegistry.acquire(sessionId, async () => {
      await creatorGate;
      const entry: SessionEntry = {
        id: sessionId,
        cwd: repoRoot,
        activeRole: "coordinator",
        lastActive: Date.now(),
        runtime: {
          session: {
            isStreaming: false,
            abort: async () => {},
            prompt: async () => {},
          },
          dispose: async () => {
            creatorDisposed = true;
          },
        } as any,
        clients: new Set(),
      };
      return entry;
    });

    assert.equal(sessionRegistry.pending.has(sessionId), true, "pending acquire must be tracked in sessionRegistry");

    // 2. DELETE X starts, marks deletion
    const delPromise = cleanupDeletedSessionResources(
      sessionId,
      cleanupCtx(),
      repoRoot,
      { deleteFile: false },
    );

    // Allow microtasks to run and mark deletion
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(subagentManager.isDeleting(sessionId), true, "DELETE must mark session deleting");

    // 3. release creator
    releaseCreator();

    // 4. Assert acquire rejected
    await assert.rejects(
      acquirePromise,
      /Cannot acquire session.*pending deletion/,
      "in-flight acquire must be rejected once creator finishes during deletion",
    );

    // 5. Deletion transaction completes safely
    const delRes = await delPromise;
    assert.equal(delRes.success, true, "deletion transaction must complete safely");

    // 6. Invariants
    assert.equal(creatorDisposed, true, "creator runtime must have been disposed");
    assert.equal(sessionRegistry.get(sessionId), undefined, "Registry must not have restored deleted session");
    assert.equal(sessionRegistry.pending.has(sessionId), false, "pending acquire must be cleared");
    assert.equal(isPendingDeletion(sessionId), false, "tombstone must be cleared on successful deletion");
  });

  // =========================================================================
  // M19-retry: in-flight acquire dispose failure preserves runtime handle and tombstone, succeeds on second DELETE
  // =========================================================================
  it("M19-retry: in-flight acquire dispose failure preserves runtime handle and tombstone, succeeds on second DELETE", async () => {
    const sessionId = "m19-dispose-fail-retry";
    let disposeAttempts = 0;
    let releaseCreator!: () => void;
    const creatorGate = new Promise<void>((resolve) => {
      releaseCreator = resolve;
    });

    const acquirePromise = sessionRegistry.acquire(sessionId, async () => {
      await creatorGate;
      const entry: SessionEntry = {
        id: sessionId,
        cwd: repoRoot,
        activeRole: "coordinator",
        lastActive: Date.now(),
        runtime: {
          session: {
            isStreaming: false,
            abort: async () => {},
            prompt: async () => {},
          },
          dispose: async () => {
            disposeAttempts++;
            if (disposeAttempts === 1) {
              throw new Error("Injected first dispose failure in acquire cleanup");
            }
          },
        } as any,
        clients: new Set(),
      };
      return entry;
    });

    // 1. acquire enters creator
    assert.equal(sessionRegistry.pending.has(sessionId), true);

    // 2. DELETE starts concurrently, marks deletion
    const delPromise1 = cleanupDeletedSessionResources(
      sessionId,
      cleanupCtx(),
      repoRoot,
      { deleteFile: false },
    );

    await new Promise((r) => setTimeout(r, 15));
    assert.equal(subagentManager.isDeleting(sessionId), true);

    // 3. Creator finishes, returning Runtime, first dispose fails
    releaseCreator();

    await assert.rejects(
      acquirePromise,
      /Cannot acquire session.*runtime cleanup dispose failed/,
      "acquire must be rejected with aggregate error when dispose fails",
    );

    // 4. First DELETE must fail due to quiescence failure
    const delRes1 = await delPromise1;
    assert.equal(delRes1.success, false, "first DELETE must not succeed");
    assert.equal(delRes1.quiescence?.success, false, "quiescence must fail-closed");

    // 5. Invariants after failed DELETE:
    // - Runtime handle is tracked in pendingAcquireCleanup
    assert.ok(sessionRegistry.pendingAcquireCleanup.has(sessionId), "Runtime handle must remain tracked");
    // - Registry must not have restored session
    assert.equal(sessionRegistry.get(sessionId), undefined, "Registry must not restore session");
    // - Tombstone / deletion gate preserved
    assert.equal(isPendingDeletion(sessionId), true, "Tombstone must be preserved");
    assert.equal(subagentManager.isDeleting(sessionId), true, "Deletion gate must be preserved");

    // 6. Second DELETE succeeds
    const delRes2 = await cleanupDeletedSessionResources(
      sessionId,
      cleanupCtx(),
      repoRoot,
      { deleteFile: false },
    );

    assert.equal(delRes2.success, true, "second DELETE must succeed");
    assert.equal(disposeAttempts, 2, "dispose must have been retried");
    assert.equal(sessionRegistry.pendingAcquireCleanup.has(sessionId), false, "pending cleanup handle must be cleared");
    assert.equal(isPendingDeletion(sessionId), false, "tombstone must be cleared");
    assert.equal(subagentManager.isDeleting(sessionId), false, "deletion gate must be released");
  });

  // =========================================================================
  // M20: Persistent Tombstone blocks in-flight WS commands
  // =========================================================================
  it("M20: session with pending deletion rejects subsequent lifecycle operations", async () => {
    const sessionId = "m20-command-blocked";
    const entry = createMockParentEntry(sessionId);
    recordPendingDeletion({
      sessionId,
      stage: "git_cleanup",
      startedAt: new Date().toISOString(),
    });

    const sent: any[] = [];
    const mockWs: any = {
      OPEN: 1,
      readyState: 1,
      send: (data: string) => sent.push(JSON.parse(data)),
    };
    sessionRegistry.bindWs(mockWs, entry);

    await handleCommand(
      { type: "prompt", text: "hello" },
      mockWs,
      {
        sessionRegistry,
        subagentManager,
        getModelRuntime: () => ({ getModel: () => null }) as any,
        homeDir: tmpHome,
        agentCwd: repoRoot,
        createRuntime: async () => {
          throw new Error("should not create");
        },
      } as any,
    );

    assert.ok(
      sent.some((m) => m.type === "error" && /正在删除/.test(m.message)),
      "WS command must be rejected while pending deletion",
    );
  });

  // =========================================================================
  // M21: Simulated Server Restart Retry of Failed Deletion
  // =========================================================================
  it("M21: simulated server restart preserves tombstone & ownership and idempotent retry completes successfully", async () => {
    const sessionId = "m21-restart-retry";

    // Setup initial state: session entry, task, git ownership, session file
    createMockParentEntry(sessionId);
    createMockTask(sessionId, "t-m21-task");
    const branchName = "runtime/task-m21-branch";
    nodeExecSync(`git branch ${branchName}`, { cwd: repoRoot, stdio: "ignore" });
    registerRuntimeResource(sessionId, "task_branch", branchName, repoRoot);

    const projDir = join(tmpHome, "sessions", "test-project");
    mkdirSync(projDir, { recursive: true });
    const sessionFilePath = join(projDir, `session_${sessionId}.jsonl`);
    writeFileSync(sessionFilePath, JSON.stringify({ type: "session_header", cwd: repoRoot }) + "\n");

    // Phase C failure injection: make subagent tasks dir read-only so metadata cleanup fails
    const tasksDir = join(tmpHome, "subagent-tasks");
    chmodSync(tasksDir, 0o555);
    try {
      const firstDelRes = await cleanupDeletedSessionResources(
        sessionId,
        cleanupCtx(),
        repoRoot,
        { deleteFile: true },
      );
      assert.equal(firstDelRes.success, false, "first DELETE must fail closed");
      assert.equal(isPendingDeletion(sessionId), true, "tombstone must be persisted");
      assert.equal(loadPendingDeletions().get(sessionId)?.stage, "metadata_cleanup");
    } finally {
      chmodSync(tasksDir, 0o755);
    }

    // 模拟 restart:
    // 1) clear 内存 Registry/cache
    sessionRegistry = new SessionRegistry();
    clearPendingDeletionsCache();
    clearRuntimeResourceRegistry();
    subagentTasks.clear();

    // 2) reload persisted tombstone
    const reloadedTombstones = loadPendingDeletions();
    assert.equal(reloadedTombstones.has(sessionId), true, "reloaded tombstones must contain sessionId");
    assert.equal(reloadedTombstones.get(sessionId)?.stage, "metadata_cleanup");

    // 3) reload persisted Tasks
    const persistedTasks = loadPersistedTasks();
    assert.ok(persistedTasks.has("t-m21-task"), "persisted tasks must be reloaded from disk");
    subagentManager = new SubagentManager({} as any);
    await subagentManager.persistedTasksReady;
    assert.ok(subagentTasks.has("t-m21-task"), "tasks must be loaded in subagentManager");

    // 4) reload Git ownership
    await recoverRuntimeResources(repoRoot);
    sessionRegistry.isDeleting = (id) => subagentManager.isDeleting(id) || isPendingDeletion(id);

    // 第二次 DELETE: 幂等继续 -> success
    const retryRes = await cleanupDeletedSessionResources(
      sessionId,
      cleanupCtx(),
      repoRoot,
      { deleteFile: true },
    );

    assert.equal(retryRes.success, true, "retry after restart must complete successfully");
    assert.equal(isPendingDeletion(sessionId), false, "tombstone must be removed from cache");
    assert.equal(loadPendingDeletions().has(sessionId), false, "tombstone must be removed from disk");
    assert.equal(subagentManager.isDeleting(sessionId), false);
    assert.equal(existsSync(taskFilePath("t-m21-task")), false, "task file must be deleted");
    assert.equal(existsSync(sessionFilePath), false, "session file must be deleted");
  });

  // =========================================================================
  // M22: Full success pipeline cleans all 5 phases with 0 residual references
  // =========================================================================
  it("M22: full successful deletion executes all 5 phases and leaves zero residual references", async () => {
    const sessionId = "m22-full-success";

    // 1. Setup session JSONL file before deletion
    const projDir = join(tmpHome, "sessions", "test-project");
    mkdirSync(projDir, { recursive: true });
    const sessionFilePath = join(projDir, `session_${sessionId}.jsonl`);
    writeFileSync(sessionFilePath, JSON.stringify({ type: "session_header", cwd: repoRoot }) + "\n");

    // 2. Setup parent SessionEntry with client WebSocket
    const parentEntry = createMockParentEntry(sessionId);
    const mockWs: any = { OPEN: 1, readyState: 1, send: () => {} };
    sessionRegistry.bindWs(mockWs, parentEntry);
    assert.equal(sessionRegistry.getByWs(mockWs), parentEntry);

    // 3. Setup subagent tasks
    createMockTask(sessionId, "t-m22-1");
    createMockTask(sessionId, "t-m22-2");

    // 4. Setup task memory
    const memDir1 = getTaskMemoryDir("t-m22-1");
    mkdirSync(memDir1, { recursive: true });
    writeFileSync(join(memDir1, "notes.md"), "task 1 notes");

    const memDir2 = getTaskMemoryDir("t-m22-2");
    mkdirSync(memDir2, { recursive: true });
    writeFileSync(join(memDir2, "notes.md"), "task 2 notes");

    // 5. Setup turns
    const turnsDir = join(tmpHome, "session-turns");
    mkdirSync(turnsDir, { recursive: true });
    writeFileSync(join(turnsDir, "t-m22-1.json"), JSON.stringify([{ id: "turn-1" }]));
    writeFileSync(join(turnsDir, `${sessionId}.json`), JSON.stringify([{ id: "turn-parent" }]));

    // 6. Setup git task worktrees & branches
    const branch1 = "runtime/task-m22-b1";
    nodeExecSync(`git branch ${branch1}`, { cwd: repoRoot, stdio: "ignore" });
    const wtDir1 = join(repoRoot, ".worktrees", "m22-wt1");
    nodeExecSync(`git worktree add ${wtDir1} ${branch1}`, { cwd: repoRoot, stdio: "ignore" });
    registerRuntimeResource(sessionId, "task_branch", branch1, repoRoot);
    registerRuntimeResource(sessionId, "task_worktree", wtDir1, repoRoot);
    const inst1 = subagentTasks.get("t-m22-1")!;
    inst1.task.worktreePath = wtDir1;
    inst1.task.branchName = branch1;

    // 8. Setup git integration branch & worktree
    const intBranch = `runtime/run-${sessionId}`;
    nodeExecSync(`git branch ${intBranch}`, { cwd: repoRoot, stdio: "ignore" });
    const intWt = join(repoRoot, ".worktrees", `integration-${sessionId}`);
    nodeExecSync(`git worktree add ${intWt} ${intBranch}`, { cwd: repoRoot, stdio: "ignore" });
    registerRuntimeResource(sessionId, "integration_branch", intBranch, repoRoot);
    registerRuntimeResource(sessionId, "integration_worktree", intWt, repoRoot);

    // Run deletion with { deleteFile: true }
    const res = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: true });

    assert.equal(res.success, true);
    assert.equal(res.quiescence?.success, true);

    // Assert all 16 zero-residual items:
    // 1. Session JSONL = absent
    assert.equal(existsSync(sessionFilePath), false, "Session JSONL = absent");
    // 2. SessionRegistry = absent
    assert.equal(sessionRegistry.get(sessionId), undefined, "SessionRegistry = absent");
    // 3. wsEntry = absent
    assert.equal(sessionRegistry.getByWs(mockWs), undefined, "wsEntry = absent");
    // 4. Subagent Tasks = absent
    assert.equal(subagentManager.getTasksForParent(sessionId).length, 0, "Subagent Tasks for parent = absent");
    for (const inst of subagentTasks.values()) {
      assert.notEqual(inst.task.parentSessionId, sessionId, "Subagent Tasks = absent");
    }
    // 5. Task JSON = absent
    assert.equal(existsSync(taskFilePath("t-m22-1")), false, "Task JSON 1 = absent");
    assert.equal(existsSync(taskFilePath("t-m22-2")), false, "Task JSON 2 = absent");
    // 6. Task Memory = absent
    assert.equal(existsSync(memDir1), false, "Task Memory 1 = absent");
    assert.equal(existsSync(memDir2), false, "Task Memory 2 = absent");
    // 7. Task Turns = absent
    assert.equal(existsSync(join(turnsDir, "t-m22-1.json")), false, "Task Turns = absent");
    // 8. Parent Turns = absent
    assert.equal(existsSync(join(turnsDir, `${sessionId}.json`)), false, "Parent Turns = absent");
    // 9. TaskGraph = absent
    assert.equal(subagentManager.taskGraph.getDependencies("t-m22-1").length, 0, "TaskGraph 1 = absent");
    assert.equal(subagentManager.taskGraph.getDependencies("t-m22-2").length, 0, "TaskGraph 2 = absent");
    // 10. Integration = absent
    assert.equal((await probeGitBranch(repoRoot, intBranch)).status, "missing", "Integration branch = absent");
    assert.equal(existsSync(intWt), false, "Integration worktree = absent");
    // 12. Git Worktrees = absent
    assert.equal(existsSync(wtDir1), false, "Git Worktrees = absent");
    // 13. Git Branches = absent
    assert.equal((await probeGitBranch(repoRoot, branch1)).status, "missing", "Git Branches = absent");
    // 14. runtime ownership = absent
    const persisted = existsSync(join(repoRoot, ".runtime", "git-resources.json"))
      ? loadPersistedRuntimeResources(repoRoot)
      : [];
    assert.equal(persisted.filter((r) => r.runId === sessionId).length, 0, "runtime ownership = absent");
    assert.equal(hasRuntimeOwnership(sessionId, "task_branch", branch1, repoRoot), false);
    assert.equal(hasRuntimeOwnership(sessionId, "task_worktree", wtDir1, repoRoot), false);
    assert.equal(hasRuntimeOwnership(sessionId, "integration_branch", intBranch, repoRoot), false);
    assert.equal(hasRuntimeOwnership(sessionId, "integration_worktree", intWt, repoRoot), false);
    // 15. Tombstone = absent
    assert.equal(isPendingDeletion(sessionId), false, "Tombstone = absent (cache)");
    assert.equal(loadPendingDeletions().has(sessionId), false, "Tombstone = absent (disk)");
    // 16. deletingRuns = false
    assert.equal(subagentManager.isDeleting(sessionId), false, "deletingRuns = false");
  });

  // =========================================================================
  // Remaining review items 1-10
  // =========================================================================
  it("R1: Phase B git cleanup throw immediately fail-closes and skips metadata purge", async () => {
    const sessionId = "r1-git-throw";
    createMockParentEntry(sessionId);
    createMockTask(sessionId, "t-r1");
    mkdirSync(join(repoRoot, ".runtime"), { recursive: true });
    writeFileSync(join(repoRoot, ".runtime", "git-resources.json"), "{not-json", "utf8");

    const res = await cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false });
    assert.equal(res.success, false);
    assert.equal(isPendingDeletion(sessionId), true);
    assert.equal(loadPendingDeletions().get(sessionId)?.stage, "git_cleanup");
    assert.ok(subagentTasks.has("t-r1"), "Phase C must not run after git throw");
    assert.equal(existsSync(taskFilePath("t-r1")), true);
  });

  it("R3: inFlightCompletions timeout fails quiescence when promises remain", async () => {
    const sessionId = "r3-comp-timeout";
    createMockParentEntry(sessionId);
    let resolveHang!: () => void;
    const hang = new Promise<void>((resolve) => {
      resolveHang = resolve;
    });
    const comps = new Set<Promise<void>>([hang]);
    (subagentManager as any).inFlightCompletions.set(sessionId, comps);

    try {
      const res = await subagentManager.prepareRunForDeletion(sessionId, 30);
      assert.equal(res.success, false);
      assert.ok(res.failedTaskIds?.some((id) => id.includes("in-flight-completion")));
    } finally {
      resolveHang();
      await hang;
      subagentManager.finishRunDeletion(sessionId);
    }
  });

  it("R4: pending-deletion tombstone read fails closed on corrupt or schema-invalid file (#4)", () => {
    const filePath = getPendingDeletionsFilePath();
    mkdirSync(tmpHome, { recursive: true });

    // 1. Corrupt JSON syntax
    writeFileSync(filePath, "{not-json", "utf8");
    clearPendingDeletionsCache();
    assert.throws(() => loadPendingDeletions(), /Failed to parse pending deletions/);

    // 2. Invalid stage type (number instead of string)
    writeFileSync(
      filePath,
      JSON.stringify([{ sessionId: "s1", stage: 123, startedAt: new Date().toISOString() }]),
      "utf8",
    );
    clearPendingDeletionsCache();
    assert.throws(() => loadPendingDeletions(), /Malformed record.*fail-closed/);

    // 3. Unknown stage value
    writeFileSync(
      filePath,
      JSON.stringify([{ sessionId: "s2", stage: "unknown_stage_value", startedAt: new Date().toISOString() }]),
      "utf8",
    );
    clearPendingDeletionsCache();
    assert.throws(() => loadPendingDeletions(), /Malformed record.*fail-closed/);

    // 4. Missing sessionId
    writeFileSync(
      filePath,
      JSON.stringify([{ stage: "git_cleanup", startedAt: new Date().toISOString() }]),
      "utf8",
    );
    clearPendingDeletionsCache();
    assert.throws(() => loadPendingDeletions(), /Malformed record.*fail-closed/);

    // 5. Missing startedAt
    writeFileSync(
      filePath,
      JSON.stringify([{ sessionId: "s4", stage: "git_cleanup" }]),
      "utf8",
    );
    clearPendingDeletionsCache();
    assert.throws(() => loadPendingDeletions(), /Malformed record.*fail-closed/);

    // 6. Mixed valid + invalid records (must fail whole load closed, no partial load or skipping)
    writeFileSync(
      filePath,
      JSON.stringify([
        { sessionId: "valid-session", stage: "quiescing", startedAt: new Date().toISOString() },
        { sessionId: "invalid-session", stage: "bad_stage", startedAt: new Date().toISOString() },
      ]),
      "utf8",
    );
    clearPendingDeletionsCache();
    assert.throws(() => loadPendingDeletions(), /Malformed record.*fail-closed/);
  });

  it("R5: set_session_cwd is transactional and keeps old runtime when create fails", async () => {
    const sessionId = "r5-cwd-swap";
    let oldDisposed = false;
    const oldRuntime = {
      session: { isStreaming: false, abort: async () => {}, subscribe: () => () => {} },
      dispose: async () => {
        oldDisposed = true;
      },
    };
    const entry: SessionEntry = {
      id: sessionId,
      cwd: repoRoot,
      activeRole: "coordinator",
      lastActive: Date.now(),
      runtime: oldRuntime as any,
      clients: new Set(),
      published: true,
      isGitRepo: true,
    };
    sessionRegistry.set(sessionId, entry);
    const mockWs: any = { OPEN: 1, readyState: 1, send: () => {} };
    sessionRegistry.bindWs(mockWs, entry);
    const newCwd = join(tmpRoot, "other-cwd");
    mkdirSync(newCwd, { recursive: true });

    await assert.rejects(
      async () => {
        await handleCommand(
          { type: "set_session_cwd", cwd: newCwd },
          mockWs,
          {
            sessionRegistry,
            subagentManager,
            getModelRuntime: () => ({ getModel: () => null }) as any,
            homeDir: tmpHome,
            agentCwd: repoRoot,
            createRuntime: async () => {
              throw new Error("createRuntime boom");
            },
          } as any,
        );
      },
      /createRuntime boom/,
    );

    assert.equal(oldDisposed, false, "old runtime must not be disposed if new runtime create fails");
    assert.equal(entry.cwd, repoRoot);
    assert.equal(entry.runtime, oldRuntime);
  });

  it("R5-B: set_session_cwd Case B keeps old runtime and avoids orphan when old dispose fails and rollback succeeds (#5)", async () => {
    const sessionId = "r5-case-b";
    let oldDisposeAttempted = false;
    let newDisposeAttempted = false;

    const oldRuntime = {
      session: { isStreaming: false, abort: async () => {}, subscribe: () => () => {} },
      dispose: async () => {
        oldDisposeAttempted = true;
        throw new Error("old runtime dispose crash");
      },
    };

    const entry: SessionEntry = {
      id: sessionId,
      cwd: repoRoot,
      activeRole: "coordinator",
      lastActive: Date.now(),
      runtime: oldRuntime as any,
      clients: new Set(),
      published: true,
      isGitRepo: true,
    };
    sessionRegistry.set(sessionId, entry);
    const mockWs: any = { OPEN: 1, readyState: 1, send: () => {} };
    sessionRegistry.bindWs(mockWs, entry);

    const newCwd = join(tmpRoot, "cwd-b");
    mkdirSync(newCwd, { recursive: true });

    const newSession = {
      isStreaming: false,
      abort: async () => {},
      subscribe: () => () => {},
      extensionRunner: { hasHandlers: () => false },
      dispose: () => {
        newDisposeAttempted = true;
      },
    };

    await assert.rejects(
      async () => {
        await handleCommand(
          { type: "set_session_cwd", cwd: newCwd },
          mockWs,
          {
            sessionRegistry,
            subagentManager,
            getModelRuntime: () => ({ getModel: () => null }) as any,
            homeDir: tmpHome,
            agentCwd: repoRoot,
            createRuntime: async () => ({ session: newSession, services: {} }) as any,
          } as any,
        );
      },
      /old runtime dispose crash/,
    );

    assert.equal(oldDisposeAttempted, true);
    assert.equal(newDisposeAttempted, true, "newRuntime must be disposed on rollback");
    assert.equal(entry.cwd, repoRoot, "cwd must remain untouched");
    assert.equal(entry.runtime, oldRuntime, "entry must still point to old runtime");
    assert.equal(entry.pendingReplacementRuntime, undefined, "no pending replacement runtime if rollback succeeded");
  });

  it("R5-C: set_session_cwd Case C retains new Runtime handle and throws AggregateError when rollback also fails (#5)", async () => {
    const sessionId = "r5-case-c";
    let oldDisposeAttempted = false;
    let newDisposeAttempted = false;

    const oldRuntime = {
      session: { isStreaming: false, abort: async () => {}, subscribe: () => () => {} },
      dispose: async () => {
        oldDisposeAttempted = true;
        throw new Error("old runtime dispose error");
      },
    };

    const entry: SessionEntry = {
      id: sessionId,
      cwd: repoRoot,
      activeRole: "coordinator",
      lastActive: Date.now(),
      runtime: oldRuntime as any,
      clients: new Set(),
      published: true,
      isGitRepo: true,
    };
    sessionRegistry.set(sessionId, entry);
    const mockWs: any = { OPEN: 1, readyState: 1, send: () => {} };
    sessionRegistry.bindWs(mockWs, entry);

    const newCwd = join(tmpRoot, "cwd-c");
    mkdirSync(newCwd, { recursive: true });

    const newSession = {
      isStreaming: false,
      abort: async () => {},
      subscribe: () => () => {},
      extensionRunner: { hasHandlers: () => false },
      dispose: () => {
        newDisposeAttempted = true;
        throw new Error("new runtime rollback dispose error");
      },
    };

    let thrownError: unknown;
    try {
      await handleCommand(
        { type: "set_session_cwd", cwd: newCwd },
        mockWs,
        {
          sessionRegistry,
          subagentManager,
          getModelRuntime: () => ({ getModel: () => null }) as any,
          homeDir: tmpHome,
          agentCwd: repoRoot,
          createRuntime: async () => ({ session: newSession, services: {} }) as any,
        } as any,
      );
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError instanceof AggregateError, "must throw AggregateError containing both errors");
    assert.equal((thrownError as AggregateError).errors.length, 2);
    assert.equal(oldDisposeAttempted, true);
    assert.equal(newDisposeAttempted, true);

    // Old runtime untouched, cwd/id unchanged
    assert.equal(entry.cwd, repoRoot);
    assert.equal(entry.runtime, oldRuntime);

    // New runtime handle preserved on entry
    assert.ok(entry.pendingReplacementRuntime, "system must preserve pending replacement runtime handle");
    assert.equal(entry.pendingReplacementRuntime.session, newSession as any);

    // Later when session is strictly disposed, both are cleaned up
    let replacementCleaned = false;
    newSession.dispose = () => {
      replacementCleaned = true;
    };
    (oldRuntime as any).dispose = async () => {};
    await sessionRegistry.disposeAndRemoveStrict(sessionId);
    assert.equal(replacementCleaned, true, "subsequent strict dispose cleans up pending replacement runtime");
  });

  it("R6: git resource probe treats operational error as fail-closed not missing", async () => {
    const sessionId = "r6-probe-error";
    const branchName = "runtime/task-r6";
    nodeExecSync(`git branch ${branchName}`, { cwd: repoRoot, stdio: "ignore" });
    registerRuntimeResource(sessionId, "task_branch", branchName, repoRoot);
    assert.equal((await probeGitBranch(repoRoot, branchName)).status, "exists");

    chmodSync(join(repoRoot, ".git"), 0o000);
    try {
      const probe = await probeGitBranch(repoRoot, branchName);
      assert.equal(probe.status, "error");
      const res = await cleanupRunResources(
        repoRoot,
        { runId: sessionId, baseCommit: "", originalBranch: "" },
        [{ branchName }],
      );
      assert.equal(res.success, false);
      assert.ok(res.errors?.some((e) => /operational error/i.test(e)));
    } finally {
      chmodSync(join(repoRoot, ".git"), 0o755);
    }
    assert.equal(hasRuntimeOwnership(sessionId, "task_branch", branchName, repoRoot), true);
    await assert.rejects(async () => {
      chmodSync(join(repoRoot, ".git"), 0o000);
      try {
        await recoverRuntimeResources(repoRoot);
      } finally {
        chmodSync(join(repoRoot, ".git"), 0o755);
      }
    }, /operational error/);
    assert.ok(loadPersistedRuntimeResources(repoRoot).some((r) => r.nameOrPath === branchName));
  });

  it("R7: runtime resource registration is transactional (disk first)", () => {
    const runId = "r7-reg";
    const branchName = "runtime/task-r7";
    const runtimeDir = join(repoRoot, ".runtime");
    mkdirSync(runtimeDir, { recursive: true });
    chmodSync(runtimeDir, 0o555);
    try {
      assert.throws(() => registerRuntimeResource(runId, "task_branch", branchName, repoRoot));
      assert.equal(hasRuntimeOwnership(runId, "task_branch", branchName, repoRoot), false);
    } finally {
      chmodSync(runtimeDir, 0o755);
    }

    registerRuntimeResource(runId, "task_branch", branchName, repoRoot);
    assert.equal(hasRuntimeOwnership(runId, "task_branch", branchName, repoRoot), true);
    chmodSync(runtimeDir, 0o555);
    try {
      assert.throws(() => unregisterRuntimeResource(runId, "task_branch", branchName, repoRoot));
      assert.equal(hasRuntimeOwnership(runId, "task_branch", branchName, repoRoot), true);
    } finally {
      chmodSync(runtimeDir, 0o755);
    }
  });

  it("R7-B: task worktree registration failure rolls back physical worktree, branch, and registered ownership (#7)", async () => {
    const runId = "r7b-task-rollback";
    const taskId = "task-r7b-fail";

    // Inject persistence failure specifically on task_worktree
    setPersistenceFailureInjector((resource) => resource.type === "task_worktree");

    let thrown: unknown;
    try {
      await createWorktree(repoRoot, taskId, undefined, undefined, runId);
    } catch (err) {
      thrown = err;
    } finally {
      clearRuntimeResourceRegistry();
    }

    assert.ok(thrown, "createWorktree must throw when task_worktree registration fails");

    // 1. Git worktree 不存在
    const worktreesDir = join(repoRoot, ".worktrees");
    const candidateWts = existsSync(worktreesDir)
      ? readdirSync(worktreesDir).filter((d) => d.includes(taskId))
      : [];
    assert.equal(candidateWts.length, 0, "Git worktree must not exist");

    // 2. Git branch 不存在
    const branchName = `runtime/task-${runId}-${taskId}`;
    const branchProbe = await probeGitBranch(repoRoot, branchName);
    assert.equal(branchProbe.status, "missing", "Git branch must not exist");

    // 3. git-resources.json 没有该 Run 残留
    const persisted = existsSync(join(repoRoot, ".runtime", "git-resources.json"))
      ? loadPersistedRuntimeResources(repoRoot)
      : [];
    assert.equal(persisted.filter((r) => r.runId === runId).length, 0, "git-resources.json must have no residual for runId");
    assert.equal(hasRuntimeOwnership(runId, "task_branch", branchName, repoRoot), false);
    assert.equal(hasRuntimeOwnership(runId, "task_worktree", join(worktreesDir, taskId), repoRoot), false);
  });

  it("R7-C: integration workspace registration failure rolls back physical worktree, branch, and registered ownership (#7)", async () => {
    const runId = "r7c-integration-rollback";

    // Inject persistence failure specifically on integration_worktree
    setPersistenceFailureInjector((resource) => resource.type === "integration_worktree");

    let thrown: unknown;
    try {
      await getOrCreateIntegrationWorkspace(repoRoot, runId);
    } catch (err) {
      thrown = err;
    } finally {
      clearRuntimeResourceRegistry();
    }

    assert.ok(thrown, "getOrCreateIntegrationWorkspace must throw when integration_worktree registration fails");

    // 1. Git worktree 不存在
    const worktreesDir = join(repoRoot, ".worktrees");
    const safeId = runId.replace(/[^a-zA-Z0-9._-]/g, "-");
    const intWtPath = join(worktreesDir, `integration-${safeId}`);
    assert.equal(existsSync(intWtPath), false, "Integration worktree must not exist");

    // 2. Git branch 不存在
    const intBranch = `runtime/run-${safeId}`;
    const branchProbe = await probeGitBranch(repoRoot, intBranch);
    assert.equal(branchProbe.status, "missing", "Integration branch must not exist");

    // 3. git-resources.json 没有该 Run 残留
    const persisted = existsSync(join(repoRoot, ".runtime", "git-resources.json"))
      ? loadPersistedRuntimeResources(repoRoot)
      : [];
    assert.equal(persisted.filter((r) => r.runId === runId).length, 0, "git-resources.json must have no residual for runId");
    assert.equal(hasRuntimeOwnership(runId, "integration_branch", intBranch, repoRoot), false);
    assert.equal(hasRuntimeOwnership(runId, "integration_worktree", intWtPath, repoRoot), false);
  });

  it("R7-D: task worktree registration failure + rollback failure preserves persistent recovery anchor and recovers on retry (#7)", async () => {
    const runId = "r7d-task-rollback-fail";
    const taskId = "task-r7d-fail";

    // 1. task_worktree ownership persistence failure + removeWorktree rollback failure
    setPersistenceFailureInjector((resource) => resource.type === "task_worktree");
    setRollbackWorktreeRemoveFailureInjector((path) => path.includes(taskId));

    let thrown: unknown;
    try {
      await createWorktree(repoRoot, taskId, undefined, undefined, runId);
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, "createWorktree must throw AggregateError");

    // 2. Physical resources still exist
    const worktreesDir = join(repoRoot, ".worktrees");
    const targetWtPath = join(worktreesDir, taskId);
    assert.equal(existsSync(targetWtPath), true, "Physical worktree must still exist on disk");

    const branchName = `runtime/task-${runId}-${taskId}`;
    const branchProbe1 = await probeGitBranch(repoRoot, branchName);
    assert.equal(branchProbe1.status, "exists", "Physical branch must still exist");

    // 3. Recovery metadata persisted on disk
    const recoveryBefore = loadPendingGitRecovery(repoRoot);
    assert.ok(
      recoveryBefore.some((r) => r.runId === runId && r.type === "task_worktree"),
      "recovery anchor for task_worktree must be persisted",
    );
    assert.ok(
      recoveryBefore.some((r) => r.runId === runId && r.type === "task_branch"),
      "recovery anchor for task_branch must be persisted",
    );

    // 4. Simulate restart: clear in-memory failure injectors & registry, reload from disk
    clearRuntimeResourceRegistry();
    const { recovered } = await recoverRuntimeResources(repoRoot);
    assert.ok(recovered.some((r) => r.runId === runId && r.type === "task_worktree"), "restart must recover task_worktree");

    // 5. Retry cleanup
    const cleanupRes = await cleanupRunResources(repoRoot, {
      runId,
      baseCommit: "",
      originalBranch: "",
    });
    assert.equal(cleanupRes.success, true, "cleanup retry must succeed");

    // 6. Worktree & Branch deleted, recovery metadata cleared to 0
    assert.equal(existsSync(targetWtPath), false, "Physical worktree must be deleted");
    const branchProbe2 = await probeGitBranch(repoRoot, branchName);
    assert.equal(branchProbe2.status, "missing", "Physical branch must be deleted");

    const recoveryAfter = loadPendingGitRecovery(repoRoot);
    assert.equal(
      recoveryAfter.filter((r) => r.runId === runId).length,
      0,
      "recovery metadata must be cleared (zero residual)",
    );
  });

  it("R7-E: integration workspace registration failure + rollback failure preserves persistent recovery anchor and recovers on retry (#7)", async () => {
    const runId = "r7e-int-rollback-fail";
    const safeId = runId.replace(/[^a-zA-Z0-9._-]/g, "-");

    // 1. integration_worktree persistence failure + removeWorktree rollback failure
    setPersistenceFailureInjector((resource) => resource.type === "integration_worktree");
    setRollbackWorktreeRemoveFailureInjector((path) => path.includes("integration-"));

    let thrown: unknown;
    try {
      await getOrCreateIntegrationWorkspace(repoRoot, runId);
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, "getOrCreateIntegrationWorkspace must throw AggregateError");

    // 2. Physical resources still exist
    const worktreesDir = join(repoRoot, ".worktrees");
    const targetWtPath = join(worktreesDir, `integration-${safeId}`);
    assert.equal(existsSync(targetWtPath), true, "Integration worktree must still exist on disk");

    const intBranch = `runtime/run-${safeId}`;
    const branchProbe1 = await probeGitBranch(repoRoot, intBranch);
    assert.equal(branchProbe1.status, "exists", "Integration branch must still exist");

    // 3. Recovery metadata persisted on disk
    const recoveryBefore = loadPendingGitRecovery(repoRoot);
    assert.ok(
      recoveryBefore.some((r) => r.runId === runId && r.type === "integration_worktree"),
      "recovery anchor for integration_worktree must be persisted",
    );
    assert.ok(
      recoveryBefore.some((r) => r.runId === runId && r.type === "integration_branch"),
      "recovery anchor for integration_branch must be persisted",
    );

    // 4. Simulate restart: clear in-memory failure injectors & registry, reload from disk
    clearRuntimeResourceRegistry();
    const { recovered } = await recoverRuntimeResources(repoRoot);
    assert.ok(recovered.some((r) => r.runId === runId && r.type === "integration_worktree"), "restart must recover integration_worktree");

    // 5. Retry cleanup
    const cleanupRes = await cleanupRunResources(repoRoot, {
      runId,
      baseCommit: "",
      originalBranch: "",
    });
    assert.equal(cleanupRes.success, true, "cleanup retry must succeed");

    // 6. Worktree & Branch deleted, recovery metadata cleared to 0
    assert.equal(existsSync(targetWtPath), false, "Integration worktree must be deleted");
    const branchProbe2 = await probeGitBranch(repoRoot, intBranch);
    assert.equal(branchProbe2.status, "missing", "Integration branch must be deleted");

    const recoveryAfter = loadPendingGitRecovery(repoRoot);
    assert.equal(
      recoveryAfter.filter((r) => r.runId === runId).length,
      0,
      "recovery metadata must be cleared (zero residual)",
    );
  });

  it("R8: set_model is tracked as in-flight parent op and role hot reload skips tombstoned sessions", async () => {
    const sessionId = "r8-set-model";
    let resolveModel!: () => void;
    const modelPromise = new Promise<void>((resolve) => {
      resolveModel = resolve;
    });
    let setModelStarted = false;
    const entry = createMockParentEntry(sessionId);
    entry.runtime.session.setModel = async () => {
      setModelStarted = true;
      await modelPromise;
    };
    const mockWs: any = { OPEN: 1, readyState: 1, send: () => {} };
    sessionRegistry.bindWs(mockWs, entry);

    const cmdPromise = handleCommand(
      { type: "set_model", provider: "mock", id: "m1" },
      mockWs,
      {
        sessionRegistry,
        subagentManager,
        getModelRuntime: () => ({
          getModel: () => ({ provider: "mock", id: "m1" }),
        }) as any,
        homeDir: tmpHome,
        agentCwd: repoRoot,
        createRuntime: async () => ({}),
      } as any,
    );

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(setModelStarted, true);
    let deletionFinished = false;
    const delPromise = cleanupDeletedSessionResources(sessionId, cleanupCtx(), repoRoot, { deleteFile: false }).then(
      (r) => {
        deletionFinished = true;
        return r;
      },
    );
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(deletionFinished, false, "deletion must wait for in-flight set_model");
    resolveModel();
    const [, delRes] = await Promise.allSettled([cmdPromise, delPromise]);
    assert.equal(deletionFinished, true);
    assert.equal(delRes.status, "fulfilled");
    if (delRes.status === "fulfilled") {
      assert.equal(delRes.value.success, true);
    }

    const blockedId = "r8-role-hot-reload";
    const blocked = createMockParentEntry(blockedId);
    let toolsApplied = 0;
    blocked.runtime.session.setActiveToolsByName = () => {
      toolsApplied++;
    };
    blocked.runtime.session.agent = { state: { systemPrompt: "orig" } };
    recordPendingDeletion({
      sessionId: blockedId,
      stage: "git_cleanup",
      startedAt: new Date().toISOString(),
    });

    const body = JSON.stringify({ roles: getAllRoleConfigs() });
    const req: any = {
      method: "PUT",
      on(event: string, cb: (arg?: Buffer) => void) {
        if (event === "data") cb(Buffer.from(body));
        if (event === "end") cb();
        return req;
      },
    };
    const httpRes: any = {
      writeHead() {
        return this;
      },
      end() {},
    };
    await handleRolesRoutes(new URL("http://localhost/api/roles"), req, httpRes, {
      sessionRegistry,
      subagentManager,
    } as any);
    assert.equal(toolsApplied, 0, "pending deletion session must not receive role hot reload");
  });

  it("R9: tombstone cache is not updated when disk write fails", () => {
    const sessionId = "r9-tombstone-tx";
    chmodSync(tmpHome, 0o555);
    try {
      assert.throws(() =>
        recordPendingDeletion({
          sessionId,
          stage: "git_cleanup",
          startedAt: new Date().toISOString(),
        }),
      );
    } finally {
      chmodSync(tmpHome, 0o755);
    }
    clearPendingDeletionsCache();
    assert.equal(isPendingDeletion(sessionId), false);
  });

  it("R10: idle prune is dispose-first and keeps entry when dispose throws", async () => {
    const sessionId = "r10-idle-prune";
    let disposeAttempted = false;
    const entry: SessionEntry = {
      id: sessionId,
      cwd: repoRoot,
      activeRole: "coordinator",
      lastActive: 0,
      published: true,
      isGitRepo: false,
      runtime: {
        session: { isStreaming: false, abort: async () => {} },
        dispose: async () => {
          disposeAttempted = true;
          throw new Error("idle dispose fail");
        },
      } as any,
      clients: new Set(),
    };
    sessionRegistry.set(sessionId, entry);
    const timer = sessionRegistry.startIdlePruning(() => true, 0, 20);
    await new Promise((r) => setTimeout(r, 80));
    clearInterval(timer);
    assert.equal(disposeAttempted, true);
    assert.ok(sessionRegistry.get(sessionId), "entry must remain when idle dispose fails");
  });
});
