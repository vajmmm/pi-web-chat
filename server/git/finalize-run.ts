import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CleanupResult, FinalizeMode, FinalizeResult } from "../contracts/task.ts";
import { cleanupRunResources } from "./cleanup.ts";
import { runGit } from "./git.ts";
import {
  getIntegrationFileChanges,
  type GitFileChange,
  type IntegrationWorkspace,
} from "./integration-workspace.ts";

export interface PathSnapshot {
  path: string;
  existed: boolean;
  kind?: "file" | "symlink";
  content?: Buffer;
  symlinkTarget?: string;
  mode?: number;
}

/**
 * 在 working_tree mutation 前采集本 Run 涉及的所有 Agent 路径的快照（Fail-Closed 保证）
 */
export function captureWorkingTreePathSnapshots(
  repoRoot: string,
  changedFiles: string[],
  options?: { _injectSnapshotError?: boolean },
): Map<string, PathSnapshot> {
  if (options?._injectSnapshotError) {
    throw new Error("Simulated snapshot capture failure");
  }

  const snapshots = new Map<string, PathSnapshot>();
  for (const relPath of changedFiles) {
    const fullPath = resolve(join(repoRoot, relPath));
    let stat: ReturnType<typeof lstatSync> | undefined;
    try {
      stat = lstatSync(fullPath);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        stat = undefined;
      } else {
        throw new Error(`Failed to stat path ${relPath} during snapshot: ${err.message}`);
      }
    }

    if (stat) {
      if (stat.isSymbolicLink()) {
        const symlinkTarget = readlinkSync(fullPath);
        snapshots.set(relPath, {
          path: relPath,
          existed: true,
          kind: "symlink",
          symlinkTarget,
          mode: stat.mode,
        });
      } else if (stat.isFile()) {
        const content = readFileSync(fullPath);
        snapshots.set(relPath, {
          path: relPath,
          existed: true,
          kind: "file",
          content,
          mode: stat.mode,
        });
      } else if (stat.isDirectory()) {
        throw new Error(`Unsupported directory path ${relPath} in snapshot capture`);
      } else {
        // 特殊文件类型 (socket, FIFO, device 等) 直接 Fail-Closed
        throw new Error(`Unsupported special file type for path ${relPath} in snapshot capture`);
      }
    } else {
      snapshots.set(relPath, {
        path: relPath,
        existed: false,
      });
    }
  }
  return snapshots;
}

/**
 * working_tree 回滚：将 Agent 相关路径精确恢复至 finalize 开始前的快照状态（支持内容、类型与 mode 恢复）
 */
export async function rollbackWorkingTreeFinalize(
  repoRoot: string,
  snapshots: Map<string, PathSnapshot>,
  options?: { _injectRollbackError?: boolean },
): Promise<{ success: boolean; error?: string; unrecoveredPaths?: string[] }> {
  if (options?._injectRollbackError) {
    return {
      success: false,
      error: "Simulated rollback failure",
      unrecoveredPaths: Array.from(snapshots.keys()),
    };
  }

  const unrecoveredPaths: string[] = [];

  for (const [relPath, snapshot] of snapshots.entries()) {
    const fullPath = resolve(join(repoRoot, relPath));
    try {
      if (snapshot.existed) {
        const dir = dirname(fullPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }

        if (snapshot.kind === "symlink" && snapshot.symlinkTarget !== undefined) {
          try {
            const currentStat = lstatSync(fullPath);
            if (currentStat) unlinkSync(fullPath);
          } catch {}
          symlinkSync(snapshot.symlinkTarget, fullPath);
        } else if (snapshot.kind === "file" && snapshot.content !== undefined) {
          try {
            const currentStat = lstatSync(fullPath);
            if (currentStat.isSymbolicLink()) unlinkSync(fullPath);
          } catch {}
          writeFileSync(fullPath, snapshot.content);
          if (snapshot.mode !== undefined) {
            chmodSync(fullPath, snapshot.mode);
          }
        }
        try {
          await runGit(repoRoot, ["reset", "HEAD", "--", relPath]);
        } catch {}
      } else {
        try {
          const currentStat = lstatSync(fullPath);
          if (currentStat) {
            unlinkSync(fullPath);
          }
        } catch {}
        try {
          await runGit(repoRoot, ["reset", "HEAD", "--", relPath]);
        } catch {}
      }
    } catch (err) {
      console.error(`[worktree] Rollback failed for path ${relPath}:`, err);
      unrecoveredPaths.push(relPath);
    }
  }

  // 回滚一致性检查 (Rollback Consistency Check: 存在性, 类型, 目标/内容, mode)
  for (const [relPath, snapshot] of snapshots.entries()) {
    const fullPath = resolve(join(repoRoot, relPath));
    try {
      const stat = lstatSync(fullPath);
      if (snapshot.existed) {
        if (snapshot.kind === "symlink") {
          if (!stat.isSymbolicLink() || readlinkSync(fullPath) !== snapshot.symlinkTarget) {
            unrecoveredPaths.push(relPath);
          }
        } else if (snapshot.kind === "file") {
          if (!stat.isFile()) {
            unrecoveredPaths.push(relPath);
          } else {
            const currentContent = readFileSync(fullPath);
            if (snapshot.content && !currentContent.equals(snapshot.content)) {
              unrecoveredPaths.push(relPath);
            }
            if (snapshot.mode !== undefined && (stat.mode & 0o777) !== (snapshot.mode & 0o777)) {
              unrecoveredPaths.push(relPath);
            }
          }
        }
      } else {
        // 之前不存在，但现在仍然存在
        unrecoveredPaths.push(relPath);
      }
    } catch {
      if (snapshot.existed) {
        unrecoveredPaths.push(relPath);
      }
    }
  }

  const uniqueUnrecovered = Array.from(new Set(unrecoveredPaths));
  if (uniqueUnrecovered.length > 0) {
    return {
      success: false,
      error: `FINALIZE_ROLLBACK_FAILED: Failed to fully restore paths: ${uniqueUnrecovered.join(", ")}`,
      unrecoveredPaths: uniqueUnrecovered,
    };
  }

  return { success: true };
}

/**
 * 最终将整个 Run 的集成改动安全写回用户工作区或正式 Commit - Fail-Closed 保证
 */
export async function finalizeRun(
  repoRoot: string,
  integration: IntegrationWorkspace,
  options?: {
    mode?: "working_tree" | "squash_commit" | "keep_commits";
    commitMessage?: string;
    cleanup?: boolean;
    _injectSnapshotError?: boolean;
    _injectMutationError?: boolean;
    _injectMutationErrorAtStep?: number;
    _injectRollbackError?: boolean;
    _injectCleanupError?: boolean;
    _injectWorktreeRemoveError?: boolean;
    _injectBranchDeleteError?: boolean;
  },
  taskInstances?: { worktreePath?: string; branchName?: string }[],
): Promise<FinalizeResult> {
  const mode = options?.mode || "working_tree";
  const baseCommit = integration.baseCommit;

  // 1. 读取 integration HEAD 必须 Fail-Closed
  let finalIntegrationCommit = "";
  try {
    finalIntegrationCommit = (await runGit(integration.worktreePath, ["rev-parse", "HEAD"])).trim();
  } catch (err: unknown) {
    return {
      success: false,
      status: "ERROR",
      mode,
      changedFiles: [],
      error: `Failed to read integration HEAD: ${String(err instanceof Error ? err.message : err)}`,
    };
  }

  // 2. 获取 integration 差异 (A/M/D/R/C) 必须 Fail-Closed
  let changes: GitFileChange[] = [];
  try {
    changes = await getIntegrationFileChanges(repoRoot, baseCommit, finalIntegrationCommit);
  } catch (err: unknown) {
    return {
      success: false,
      status: "ERROR",
      mode,
      changedFiles: [],
      error: `Failed to read integration diff: ${String(err instanceof Error ? err.message : err)}`,
    };
  }

  const changedFiles = Array.from(
    new Set(changes.flatMap((c) => (c.oldPath ? [c.path, c.oldPath] : [c.path]))),
  );

  if (changes.length === 0 || changedFiles.length === 0) {
    let cleanupResult: CleanupResult | undefined;
    if (options?.cleanup !== false) {
      cleanupResult = await cleanupRunResources(repoRoot, integration, taskInstances, {
        _injectCleanupError: options?._injectCleanupError,
        _injectWorktreeRemoveError: options?._injectWorktreeRemoveError,
        _injectBranchDeleteError: options?._injectBranchDeleteError,
      });
    }
    return { success: true, status: "NO_CHANGES", mode, changedFiles: [], cleanupResult };
  }

  // 3. 读取用户环境当前分支与 HEAD 必须 Fail-Closed
  let currentBranch = "";
  let currentHead = "";
  try {
    currentBranch = (await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    currentHead = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
  } catch (err: unknown) {
    return {
      success: false,
      status: "ERROR",
      mode,
      changedFiles,
      error: `Failed to read repo HEAD/branch: ${String(err instanceof Error ? err.message : err)}`,
    };
  }

  // 4. 分支切换检测
  if (integration.originalBranch && currentBranch !== integration.originalBranch) {
    return {
      success: false,
      status: "FINALIZE_CONFLICT",
      mode,
      changedFiles,
      error: `FINALIZE_CONFLICT: Current branch (${currentBranch}) is different from original run branch (${integration.originalBranch}). Refusing to finalize.`,
    };
  }

  // 5. 祖先关系检查 (Ancestry Check) 与 用户新提交 / 重命名冲突检测
  if (baseCommit && currentHead && currentHead !== baseCommit) {
    // 5.1 检查 baseCommit 是否仍然是 currentHead 的祖先 (防止 rebase, reset, force move 等历史改写)
    try {
      await runGit(repoRoot, ["merge-base", "--is-ancestor", baseCommit, currentHead]);
    } catch {
      return {
        success: false,
        status: "FINALIZE_CONFLICT",
        mode,
        changedFiles,
        error: `FINALIZE_CONFLICT: Run base commit (${baseCommit}) is no longer an ancestor of current HEAD (${currentHead}). Branch history may have been rewritten or reset. Refusing to finalize.`,
      };
    }

    // 5.2 检查用户在 baseCommit..currentHead 期间提交的文件及状态（包括 rename）
    let userChanges: GitFileChange[] = [];
    try {
      userChanges = await getIntegrationFileChanges(repoRoot, baseCommit, currentHead);
    } catch (err: unknown) {
      return {
        success: false,
        status: "ERROR",
        mode,
        changedFiles,
        error: `Failed to read user commit changes: ${String(err instanceof Error ? err.message : err)}`,
      };
    }

    const userCommittedPaths = Array.from(
      new Set(userChanges.flatMap((c) => (c.oldPath ? [c.path, c.oldPath] : [c.path]))),
    );

    const overlappingCommits = changedFiles.filter((f) => userCommittedPaths.includes(f));
    if (overlappingCommits.length > 0) {
      return {
        success: false,
        status: "FINALIZE_CONFLICT",
        mode,
        changedFiles,
        conflictFiles: overlappingCommits,
        error: `FINALIZE_CONFLICT: User created new commit(s) during the run affecting the same/renamed files (${overlappingCommits.join(", ")}). Refusing to overwrite.`,
      };
    }
  }

  // 6. 保护用户未提交修改：检查工作区状态（必须 Fail-Closed）
  let userStatus = "";
  try {
    userStatus = (await runGit(repoRoot, ["status", "--porcelain"])).trim();
  } catch (err: unknown) {
    return {
      success: false,
      status: "ERROR",
      mode,
      changedFiles,
      error: `Failed to check user workspace status: ${String(err instanceof Error ? err.message : err)}`,
    };
  }

  if (userStatus.length > 0) {
    const userModifiedFiles: string[] = [];
    for (const rawLine of userStatus.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = /^([MADRCU?!]+)\s+(.+)$/.exec(line);
      if (match && match[2]) {
        const parts = match[2].split(" -> ");
        for (const p of parts) {
          userModifiedFiles.push(p.trim().replace(/^"|"$/g, ""));
        }
      } else {
        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
          userModifiedFiles.push(parts.slice(1).join(" ").trim().replace(/^"|"$/g, ""));
        }
      }
    }

    const overlapping = changedFiles.filter((f) =>
      userModifiedFiles.some((u) => u === f || u.endsWith(`/${f}`) || f.endsWith(`/${u}`)),
    );

    if (overlapping.length > 0) {
      return {
        success: false,
        status: "FINALIZE_CONFLICT",
        mode,
        changedFiles,
        conflictFiles: overlapping,
        error: `FINALIZE_CONFLICT: User has uncommitted modifications that conflict with run changes in: ${overlapping.join(", ")}. Refusing to overwrite.`,
      };
    }
  }

  // 7. 按指定的 finalizeMode 写回用户环境（具备 Fail-Closed 保证与失败原子回滚能力）
  let commitSha: string | undefined;
  const originalHead = currentHead;
  let refUpdated = false;

  try {
    if (mode === "working_tree") {
      // 1. 采集 Agent 涉及路径在 mutation 前的原始状态快照 (Fail-Closed)
      let snapshots: Map<string, PathSnapshot>;
      try {
        snapshots = captureWorkingTreePathSnapshots(repoRoot, changedFiles, {
          _injectSnapshotError: options?._injectSnapshotError,
        });
      } catch (snapErr: unknown) {
        const snapErrorMsg = String(snapErr instanceof Error ? snapErr.message : snapErr);
        return {
          success: false,
          status: "ERROR",
          mode,
          changedFiles,
          error: `Failed to capture working tree snapshots before mutation: ${snapErrorMsg}`,
        };
      }

      try {
        if (options?._injectMutationError) {
          throw new Error("Simulated mutation failure during working_tree sync");
        }

        // 2. 依次执行各个文件的精确 mutation
        for (let i = 0; i < changes.length; i++) {
          const change = changes[i];

          if (options?._injectMutationErrorAtStep === i) {
            throw new Error(`Simulated mutation failure at step ${i} for ${change.path}`);
          }

          if (change.status === "D") {
            // 删除文件 (Fail-Closed)
            const fullPath = resolve(join(repoRoot, change.path));
            if (existsSync(fullPath)) {
              unlinkSync(fullPath);
            }
          } else if (change.status === "R") {
            // 重命名：清理旧文件，写入新文件 (Fail-Closed)
            if (change.oldPath) {
              const oldFullPath = resolve(join(repoRoot, change.oldPath));
              if (existsSync(oldFullPath)) {
                unlinkSync(oldFullPath);
              }
            }
            await runGit(repoRoot, ["checkout", finalIntegrationCommit, "--", change.path]);
            await runGit(repoRoot, ["reset", "HEAD", "--", change.path]);
          } else {
            // Added / Modified / Copied (Fail-Closed)
            await runGit(repoRoot, ["checkout", finalIntegrationCommit, "--", change.path]);
            await runGit(repoRoot, ["reset", "HEAD", "--", change.path]);
          }
        }

        // 3. working_tree 最终一致性校验
        for (const change of changes) {
          if (change.status === "D") {
            const fullPath = resolve(join(repoRoot, change.path));
            if (existsSync(fullPath)) {
              throw new Error(`Consistency check failed: deleted file ${change.path} still exists in working tree`);
            }
          } else if (change.status === "R") {
            if (change.oldPath) {
              const oldFullPath = resolve(join(repoRoot, change.oldPath));
              if (existsSync(oldFullPath)) {
                throw new Error(`Consistency check failed: renamed old file ${change.oldPath} still exists in working tree`);
              }
            }
            const newFullPath = resolve(join(repoRoot, change.path));
            if (!existsSync(newFullPath)) {
              throw new Error(`Consistency check failed: renamed new file ${change.path} does not exist in working tree`);
            }
          } else {
            const fullPath = resolve(join(repoRoot, change.path));
            if (!existsSync(fullPath)) {
              throw new Error(`Consistency check failed: modified/added file ${change.path} does not exist in working tree`);
            }
          }
        }
      } catch (wtErr: unknown) {
        // === working_tree 失败路径级回滚 ===
        const rbResult = await rollbackWorkingTreeFinalize(repoRoot, snapshots, {
          _injectRollbackError: options?._injectRollbackError,
        });

        const origErrorMsg = String(wtErr instanceof Error ? wtErr.message : wtErr);

        if (!rbResult.success) {
          return {
            success: false,
            status: "ERROR",
            mode,
            changedFiles,
            conflictFiles: rbResult.unrecoveredPaths,
            error: `FINALIZE_ROLLBACK_FAILED: Mutation error: ${origErrorMsg}. Rollback error: ${rbResult.error}. Unrecovered paths: ${rbResult.unrecoveredPaths?.join(", ")}`,
          };
        }

        return {
          success: false,
          status: "ERROR",
          mode,
          changedFiles,
          error: `Failed to finalize run in mode ${mode}: ${origErrorMsg}. Working tree rolled back cleanly.`,
        };
      }
    } else if (mode === "squash_commit") {
      // squash 模式：使用 commit-tree 独立构造 commit，绝对不吸收用户已有的 staged 修改
      const commitMsg = options?.commitMessage?.trim() || "feat: apply multi-agent run changes";

      let targetTree = "";
      if (currentHead === baseCommit) {
        targetTree = (await runGit(repoRoot, ["rev-parse", `${finalIntegrationCommit}^{tree}`])).trim();
      } else {
        // 用户在 Run 期间产生了不冲突的新 commit，进行三方树合并
        const mergeTreeOut = await runGit(repoRoot, [
          "merge-tree",
          "--write-tree",
          currentHead,
          finalIntegrationCommit,
        ]);
        targetTree = mergeTreeOut.trim();
      }

      commitSha = (
        await runGit(repoRoot, ["commit-tree", targetTree, "-p", currentHead, "-m", commitMsg])
      ).trim();

      // 前移当前分支 ref
      await runGit(repoRoot, ["update-ref", `refs/heads/${currentBranch}`, commitSha]);
      refUpdated = true;

      if (options?._injectMutationError) {
        throw new Error("Simulated mutation failure during squash sync after update-ref");
      }

      // 精准同步 Agent 文件的 Index 与 WorkingTree，使其与 commitSha 完全对齐 (git status clean)
      // 绝对不执行 git reset --hard 或 git reset --mixed，绝对不破坏用户的 staged/unstaged 文件
      for (const change of changes) {
        if (change.status === "D") {
          await runGit(repoRoot, ["rm", "--cached", "--ignore-unmatch", "--", change.path]);
          const fullPath = resolve(join(repoRoot, change.path));
          if (existsSync(fullPath)) {
            unlinkSync(fullPath);
          }
        } else if (change.status === "R") {
          if (change.oldPath) {
            await runGit(repoRoot, ["rm", "--cached", "--ignore-unmatch", "--", change.oldPath]);
            const oldFullPath = resolve(join(repoRoot, change.oldPath));
            if (existsSync(oldFullPath)) {
              unlinkSync(oldFullPath);
            }
          }
          await runGit(repoRoot, ["checkout", commitSha, "--", change.path]);
        } else {
          // A / M / C
          await runGit(repoRoot, ["checkout", commitSha, "--", change.path]);
        }
      }

      // squash_commit 最终一致性校验
      const verifiedHead = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
      if (verifiedHead !== commitSha) {
        throw new Error(`Consistency check failed: HEAD (${verifiedHead}) does not match commitSha (${commitSha})`);
      }

      for (const change of changes) {
        const checkPaths = change.oldPath ? [change.path, change.oldPath] : [change.path];
        for (const p of checkPaths) {
          const statusForPath = (await runGit(repoRoot, ["status", "--porcelain", "--", p])).trim();
          if (statusForPath.length > 0) {
            throw new Error(`Consistency check failed: agent path ${p} is not clean relative to HEAD: ${statusForPath}`);
          }
        }
      }
    } else if (mode === "keep_commits") {
      // keep_commits 模式：保留 internal task commits (供调试)
      const commitMsg = options?.commitMessage?.trim() || `Merge integration run ${integration.runId}`;
      await runGit(repoRoot, ["merge", "--no-ff", integration.branch, "-m", commitMsg]);
      commitSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
    }
  } catch (err: unknown) {
    // 失败原子回滚保护：如果 squash 已经移动了分支指针，必须回滚分支并恢复 Agent 路径 (Fail-Closed)
    if (refUpdated && originalHead) {
      let headRestored = false;
      const unrecoveredPaths: string[] = [];
      const rollbackErrors: string[] = [];

      try {
        if (options?._injectRollbackError) {
          throw new Error("Simulated squash rollback failure on update-ref");
        }
        await runGit(repoRoot, ["update-ref", `refs/heads/${currentBranch}`, originalHead]);
        headRestored = true;
      } catch (rbErr) {
        rollbackErrors.push(
          `Failed to restore branch ref to ${originalHead}: ${String(rbErr instanceof Error ? rbErr.message : rbErr)}`,
        );
      }

      for (const change of changes) {
        const checkPaths = change.oldPath ? [change.path, change.oldPath] : [change.path];
        for (const p of checkPaths) {
          try {
            await runGit(repoRoot, ["checkout", originalHead, "--", p]);
          } catch {
            const fullPath = resolve(join(repoRoot, p));
            if (existsSync(fullPath)) {
              try {
                unlinkSync(fullPath);
              } catch (ulErr) {
                unrecoveredPaths.push(p);
                rollbackErrors.push(`Failed to unlink added path ${p}: ${ulErr}`);
              }
            }
            try {
              await runGit(repoRoot, ["rm", "--cached", "--ignore-unmatch", "--", p]);
            } catch (rmErr) {
              unrecoveredPaths.push(p);
              rollbackErrors.push(`Failed to unstage path ${p}: ${rmErr}`);
            }
          }
        }
      }

      const origErrorMsg = String(err instanceof Error ? err.message : err);

      if (!headRestored || rollbackErrors.length > 0 || unrecoveredPaths.length > 0) {
        return {
          success: false,
          status: "ERROR",
          mode,
          changedFiles,
          conflictFiles: Array.from(new Set(unrecoveredPaths)),
          error: `FINALIZE_ROLLBACK_FAILED: Mutation error: ${origErrorMsg}. Rollback errors: ${rollbackErrors.join("; ")}. Head restored: ${headRestored}. Unrecovered paths: ${unrecoveredPaths.join(", ")}`,
        };
      }

      return {
        success: false,
        status: "ERROR",
        mode,
        changedFiles,
        error: `Failed to finalize run in mode ${mode}: ${origErrorMsg}. Squash commit rolled back cleanly.`,
      };
    }

    const errorMsg = String(err instanceof Error ? err.message : err);
    return {
      success: false,
      status: "ERROR",
      mode,
      changedFiles,
      error: `Failed to finalize run in mode ${mode}: ${errorMsg}`,
    };
  }

  // 8. 成功后清理临时资源 (Fail-Safe: 清理失败不破坏已成功的 Finalize 交付)
  let cleanupResult: CleanupResult | undefined;
  if (options?.cleanup !== false) {
    cleanupResult = await cleanupRunResources(repoRoot, integration, taskInstances, {
      _injectCleanupError: options?._injectCleanupError,
      _injectWorktreeRemoveError: options?._injectWorktreeRemoveError,
      _injectBranchDeleteError: options?._injectBranchDeleteError,
    });
  }

  return {
    success: true,
    status: "FINALIZED",
    mode,
    changedFiles,
    commitSha,
    cleanupResult,
  };
}
