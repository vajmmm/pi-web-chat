import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "../git/git.ts";

export interface FileBaselineEntry {
  path: string;
  status: string;
  hash?: string;
  exists: boolean;
}

export interface WorkspaceBaseline {
  ok: boolean;
  cwd: string;
  files: Map<string, FileBaselineEntry>;
  error?: string;
}

export interface WorkspaceMutationResult {
  ok: boolean;
  mutatedFiles: string[];
  error?: string;
}

export interface FileHashResult {
  ok: boolean;
  exists: boolean;
  hash?: string;
  error?: string;
}

export function computeFileContentHash(absPath: string): FileHashResult {
  try {
    if (!existsSync(absPath)) {
      return { ok: true, exists: false };
    }
    const buf = readFileSync(absPath);
    const hash = createHash("sha256").update(buf).digest("hex");
    return { ok: true, exists: true, hash };
  } catch (err) {
    return {
      ok: false,
      exists: true,
      error: `Failed to read file for hash computation: ${String(err instanceof Error ? err.message : err)}`,
    };
  }
}

export function parsePorcelainLine(rawLine: string): { status: string; filePath: string } | null {
  const line = rawLine.trimEnd();
  if (!line) return null;
  let status: string;
  let filePath: string;
  if (line.length >= 3 && line[2] === " ") {
    status = line.slice(0, 2);
    filePath = line.slice(3).trim();
  } else if (line.length >= 2 && line[1] === " ") {
    // 兼容首行被 stdout.trim() 剥离前导空格的情况（例如 " M path" 变为 "M path"）
    status = " " + line[0];
    filePath = line.slice(2).trim();
  } else {
    return null;
  }
  return { status, filePath };
}

export async function captureWorkspaceBaseline(cwd: string): Promise<WorkspaceBaseline> {
  try {
    const statusOut = await runGit(cwd, ["status", "--porcelain=v1", "-uall"]);
    const files = new Map<string, FileBaselineEntry>();
    if (statusOut) {
      for (const rawLine of statusOut.split("\n")) {
        const parsed = parsePorcelainLine(rawLine);
        if (!parsed) continue;
        const { status, filePath } = parsed;
        const absPath = join(cwd, filePath);
        const hashRes = computeFileContentHash(absPath);
        if (!hashRes.ok) {
          return {
            ok: false,
            cwd,
            files: new Map(),
            error: `Failed to compute hash for ${filePath}: ${hashRes.error}`,
          };
        }
        files.set(filePath, {
          path: filePath,
          status,
          hash: hashRes.hash,
          exists: hashRes.exists,
        });
      }
    }
    return { ok: true, cwd, files };
  } catch (err) {
    return {
      ok: false,
      cwd,
      files: new Map(),
      error: `Failed to capture workspace baseline: ${String(err instanceof Error ? err.message : err)}`,
    };
  }
}

export async function detectWorkspaceMutations(
  cwd: string,
  baseline: WorkspaceBaseline,
): Promise<WorkspaceMutationResult> {
  // Fail-closed: 若 baseline 采集失败，严禁 fail-open
  if (!baseline.ok) {
    return {
      ok: false,
      mutatedFiles: [],
      error: baseline.error || "Baseline capture failed or was unavailable",
    };
  }

  try {
    const currentStatusOut = await runGit(cwd, ["status", "--porcelain=v1", "-uall"]);
    const currentFiles = new Map<string, FileBaselineEntry>();
    if (currentStatusOut) {
      for (const rawLine of currentStatusOut.split("\n")) {
        const parsed = parsePorcelainLine(rawLine);
        if (!parsed) continue;
        const { status, filePath } = parsed;
        const absPath = join(cwd, filePath);
        const hashRes = computeFileContentHash(absPath);
        if (!hashRes.ok) {
          return {
            ok: false,
            mutatedFiles: [],
            error: `Failed to compute hash for ${filePath}: ${hashRes.error}`,
          };
        }
        currentFiles.set(filePath, {
          path: filePath,
          status,
          hash: hashRes.hash,
          exists: hashRes.exists,
        });
      }
    }

    const mutatedFiles: string[] = [];

    // 1. 对比当前 status 中新增或状态变更的文件
    for (const [file, currentEntry] of currentFiles.entries()) {
      const baseEntry = baseline.files.get(file);
      if (!baseEntry) {
        // 新增的未跟踪或已修改文件
        mutatedFiles.push(file);
      } else if (baseEntry.status !== currentEntry.status) {
        // 状态码发生变更 (例如未暂存变为已暂存，或未跟踪变为已跟踪)
        mutatedFiles.push(file);
      } else {
        // 状态码完全一致 (例如都为 " M" 或都为 "??" )：基于内容 SHA-256 判断内容是否被进一步修改
        if (baseEntry.hash !== currentEntry.hash) {
          mutatedFiles.push(file);
        }
      }
    }

    // 2. 对比 baseline 中原本修改但在当前 status 中消失的文件 (例如被恢复、删除或提交)
    for (const [file] of baseline.files.entries()) {
      if (!currentFiles.has(file)) {
        mutatedFiles.push(file);
      }
    }

    return {
      ok: true,
      mutatedFiles: Array.from(new Set(mutatedFiles)),
    };
  } catch (err) {
    // Fail-closed: git 异常绝不返回空数组 []
    return {
      ok: false,
      mutatedFiles: [],
      error: `Failed to detect workspace mutations: ${String(err instanceof Error ? err.message : err)}`,
    };
  }
}
