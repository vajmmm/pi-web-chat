import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Task Memory 根目录: ~/.pi/agent/task-memories/
 */
export function getTaskMemoriesRoot(): string {
  return join(getAgentDir(), "task-memories");
}

/**
 * Task Memory Directory: ~/.pi/agent/task-memories/<taskId>/
 */
export function getTaskMemoryDir(taskId: string): string {
  const dir = join(getTaskMemoriesRoot(), taskId);
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  return dir;
}

export function getWorkingMemoryPath(taskId: string): string {
  return join(getTaskMemoryDir(taskId), "working-memory.md");
}

export function getProcessJournalPath(taskId: string): string {
  return join(getTaskMemoryDir(taskId), "process-journal.md");
}

/**
 * 安全清理指定 Task 的 Working Memory 与 Process Journal 目录 (best-effort)
 *
 * 安全与设计原则：
 * 1. 严格路径边界：只允许删除 TASK_MEMORY_ROOT/<taskId>/ 直接子目录，防御路径穿越与根目录删除
 * 2. 幂等与容错：目标目录不存在视为清理成功 (no-op)
 * 3. Best-effort：删除异常记录明确 warning 日志，不破坏调用方的主业务流程
 */
export function removeTaskMemory(taskId: string): boolean {
  if (!taskId || typeof taskId !== "string" || !taskId.trim()) {
    console.warn(`[TaskMemory] Invalid or empty taskId provided for memory removal: "${taskId}"`);
    return false;
  }

  const trimmed = taskId.trim();
  // 严格防御路径穿越、斜杠及非法控制字符
  if (
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    console.warn(`[TaskMemory] Rejected unsafe taskId for memory removal: "${taskId}"`);
    return false;
  }

  const root = resolve(getTaskMemoriesRoot());
  const targetDir = resolve(root, trimmed);

  // 严格边界校验：必须位于 root 之下且为直接单一子路径，禁止删除 root 本身
  const rel = relative(root, targetDir);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel !== trimmed || targetDir === root) {
    console.warn(
      `[TaskMemory] Path boundary violation for taskId "${taskId}": "${targetDir}" is not within root "${root}"`,
    );
    return false;
  }

  if (!existsSync(targetDir)) {
    return true; // 目录已不存在视为清理成功 / no-op
  }

  try {
    rmSync(targetDir, { recursive: true, force: true });
    return true;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[TaskMemory] Failed to remove task memory for taskId "${taskId}" at "${targetDir}": ${errorMsg}`,
    );
    return false;
  }
}

/**
 * 默认 Working Memory 初始模板
 */
export function createInitialWorkingMemoryContent(goal: string): string {
  return `# Working Memory

## Current Goal
${goal.trim() || "Unspecified goal"}

## Current Phase
Initial investigation and planning

## Progress
- [ ] Initialized task

## Verified Facts
(No verified facts yet)

## Key Decisions
(No key decisions yet)

## Important Files / Artifacts
(No critical files identified yet)

## Rejected / Failed Paths
(No rejected paths yet)

## Open Issues
(No open issues yet)

## Next Actions
- Understand task requirements and inspect relevant files

## Constraints / Invariants
- Follow task scope and instructions
`;
}

/**
 * 初始化 Task 的 Working Memory 与 Process Journal 文件
 */
export function initTaskMemory(
  taskId: string,
  initialGoal?: string,
): { workingMemoryPath: string; processJournalPath: string } {
  const wmPath = getWorkingMemoryPath(taskId);
  const pjPath = getProcessJournalPath(taskId);

  if (!existsSync(wmPath)) {
    try {
      writeFileSync(wmPath, createInitialWorkingMemoryContent(initialGoal || ""), "utf8");
    } catch (err) {
      console.warn(`[TaskMemory] Failed to write initial working-memory for ${taskId}:`, err);
    }
  }

  if (!existsSync(pjPath)) {
    try {
      const header = `# Process Journal\n\nHistorical investigation details and hypotheses log for task \`${taskId}\`.\n`;
      writeFileSync(pjPath, header, "utf8");
    } catch (err) {
      console.warn(`[TaskMemory] Failed to write initial process-journal for ${taskId}:`, err);
    }
  }

  return {
    workingMemoryPath: wmPath,
    processJournalPath: pjPath,
  };
}

/**
 * 读取 Working Memory
 */
export function readWorkingMemory(taskId: string): string | null {
  try {
    const file = getWorkingMemoryPath(taskId);
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * 读取 Process Journal
 */
export function readProcessJournal(taskId: string): string | null {
  try {
    const file = getProcessJournalPath(taskId);
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * 估算文本的 Token 消耗（区分 CJK 字符与 Western 字符）
 * - CJK 字符（中日韩统一表意文字）：通常每个字符对应约 1.2~1.5 tokens
 * - Western / 代码字符：通常约 3.6 字符对应 1 token
 */
export function estimateMemoryTokens(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  let nonCjkCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjkCount++;
    } else {
      nonCjkCount++;
    }
  }
  return Math.ceil(cjkCount * 1.3 + nonCjkCount / 3.6);
}

/** Working Memory 最大 Token 预算（约 5,000 tokens）与字符安全上限（16,000 chars） */
export const MAX_WORKING_MEMORY_TOKENS = 5000;
export const MAX_WORKING_MEMORY_CHARS = 16000;

/**
 * 滚动更新 Working Memory（覆盖写，严格保持当前最小充分状态）
 */
export function writeWorkingMemory(
  taskId: string,
  content: string,
): { success: boolean; error?: string; characterCount: number; tokenEstimate: number } {
  try {
    if (!content || typeof content !== "string") {
      return { success: false, error: "Content must be a non-empty string", characterCount: 0, tokenEstimate: 0 };
    }

    const estimatedTokens = estimateMemoryTokens(content);
    if (estimatedTokens > MAX_WORKING_MEMORY_TOKENS || content.length > MAX_WORKING_MEMORY_CHARS) {
      return {
        success: false,
        error: `Working memory exceeds limit (estimated ${estimatedTokens} tokens / ${content.length} chars > max ${MAX_WORKING_MEMORY_TOKENS} tokens). Please condense your rolling state.`,
        characterCount: content.length,
        tokenEstimate: estimatedTokens,
      };
    }

    const file = getWorkingMemoryPath(taskId);
    writeFileSync(file, content.trim() + "\n", "utf8");
    return { success: true, characterCount: content.length, tokenEstimate: estimatedTokens };
  } catch (err) {
    return {
      success: false,
      error: `Failed to write working memory: ${String(err instanceof Error ? err.message : err)}`,
      characterCount: content?.length ?? 0,
      tokenEstimate: estimateMemoryTokens(content || ""),
    };
  }
}

/**
 * 追加 Process Journal（按需记录关键事实、被推翻假设、诊断结论）
 */
export function appendProcessJournal(
  taskId: string,
  entry: string,
  title?: string,
): { success: boolean; error?: string } {
  try {
    if (!entry || typeof entry !== "string") {
      return { success: false, error: "Entry must be a non-empty string" };
    }

    const file = getProcessJournalPath(taskId);
    if (!existsSync(file)) {
      initTaskMemory(taskId);
    }

    const nowStr = new Date().toISOString().replace("T", " ").slice(0, 16);
    const heading = title ? `\n\n## ${nowStr} - ${title.trim()}\n\n` : `\n\n## ${nowStr}\n\n`;
    appendFileSync(file, heading + entry.trim() + "\n", "utf8");
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: `Failed to append process journal: ${String(err instanceof Error ? err.message : err)}`,
    };
  }
}

/**
 * 构造 Compaction 后重新注入的权威 Working Memory 结构块
 */
export function buildCompactionMemoryBlock(taskId: string): string | null {
  const wm = readWorkingMemory(taskId);
  if (!wm || !wm.trim()) return null;

  const pjPath = getProcessJournalPath(taskId);

  return `===== AUTHORITATIVE TASK WORKING MEMORY =====

${wm.trim()}

This file is a rolling task-state checkpoint maintained across context compactions.

Use it to recover:
- current goal
- progress
- verified facts
- key decisions
- unresolved issues
- next actions

If this memory conflicts with the current filesystem, tool results, or runtime state, current real evidence is authoritative.
Update the memory dynamically based on evidence.

Detailed historical process is available at:
${pjPath}

Do not load the entire journal by default.
Search/read only relevant sections when historical details are needed.
=============================================`;
}

/**
 * 将 Working Memory 注入到 Compaction Summary 前部
 */
export function injectMemoryIntoCompactionSummary(
  taskId: string,
  originalSummary: string,
): string {
  const memoryBlock = buildCompactionMemoryBlock(taskId);
  if (!memoryBlock) return originalSummary;

  return `${memoryBlock}\n\n${originalSummary}`;
}

/**
 * 创建符合 Pi 官方扩展标准的 Task Memory 扩展
 */
export function createTaskMemoryExtension(taskId: string, sessionGetter?: () => any) {
  return {
    name: `task-memory-${taskId}`,
    factory: (pi: any) => {
      pi.on("session_compact", async (event: any) => {
        const memoryBlock = buildCompactionMemoryBlock(taskId);
        if (memoryBlock && event.compactionEntry && typeof event.compactionEntry.summary === "string") {
          if (!event.compactionEntry.summary.includes("AUTHORITATIVE TASK WORKING MEMORY")) {
            event.compactionEntry.summary = `${memoryBlock}\n\n${event.compactionEntry.summary}`;
          }
        }
        const session = sessionGetter ? sessionGetter() : undefined;
        if (session?.sessionManager && session?.agent?.state) {
          const sessionContext = session.sessionManager.buildSessionContext();
          session.agent.state.messages = sessionContext.messages;
        }
      });
    },
  };
}
