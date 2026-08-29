import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentRole, UISubagentTask } from "../shared/protocol.ts";
import {
  ConstraintResolver,
  getAllRoleDefinitions,
  isPathContained,
  PromptAssembler,
  RuntimeEnforcer,
  validateTaskResult,
  type SubagentExecutionOptions,
  type TaskContract,
  type TaskResult,
  type VerificationEvidence,
} from "./contracts/index.ts";
import { getRoleConfig } from "./roles.ts";
import { serializeMessages } from "./serialize.ts";
import {
  buildBoundedCompletionReport,
  extractLastAssistantText,
} from "./subagent-report.ts";
import { createWorktree, getWorktreeDiff, resolveGitRepoRoot } from "./worktree.ts";
import { installTurnRecorderOnSession } from "./turn-recorder.ts";

export interface SpawnSubagentOptions {
  parentSessionId: string;
  role: AgentRole;
  taskTitle: string;
  taskPrompt: string;
  preferredBranch?: string;
  targetCwd?: string;
  parentCwd: string;
  parentModel?: { provider: string; id: string } | null;
  taskContract?: TaskContract;
  executionOptions?: SubagentExecutionOptions;
  onUpdate?: (task: UISubagentTask) => void;
  onReport?: (task: UISubagentTask, reportText: string) => void;
}

interface SubagentInstance {
  task: UISubagentTask;
  runtime?: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
  repoRoot?: string | null;
  baseCommit?: string;
  taskContract?: TaskContract;
  timeoutTimer?: NodeJS.Timeout;
  onUpdate?: (task: UISubagentTask) => void;
  onReport?: (task: UISubagentTask, reportText: string) => void;
}

const subagentTasks = new Map<string, SubagentInstance>();

function subagentsDir(): string {
  const dir = join(getAgentDir(), "subagent-tasks");
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  return dir;
}

function taskFilePath(taskId: string): string {
  return join(subagentsDir(), `${taskId}.json`);
}

function persistTask(task: UISubagentTask): void {
  try {
    const file = taskFilePath(task.taskId);
    const tmpFile = `${file}.${Date.now()}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(task, null, 2), "utf8");
    renameSync(tmpFile, file);
  } catch (err) {
    console.warn(`[SubagentManager] Failed to persist task ${task.taskId}:`, err);
  }
}

function loadPersistedTasks(): Map<string, UISubagentTask> {
  const map = new Map<string, UISubagentTask>();
  const dir = subagentsDir();
  if (!existsSync(dir)) return map;

  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const content = readFileSync(join(dir, f), "utf8");
        const task = JSON.parse(content) as UISubagentTask;
        if (task && task.taskId) {
          if (task.status === "running") {
            task.status = "interrupted";
            task.error = "服务重启已终止";
            task.completedAt = task.completedAt || new Date().toISOString();
            persistTask(task);
          }
          map.set(task.taskId, task);
        }
      } catch (err) {
        console.warn(`[SubagentManager] Failed to read task file ${f}:`, err);
      }
    }
  } catch (err) {
    console.warn("[SubagentManager] Failed to scan subagents dir:", err);
  }

  return map;
}

/**
 * 从 Assistant 文本中提取 <task_result> JSON 块并做基础反序列化
 */
export function parseTaskResultFromText(
  text: string,
  taskId: string,
  role: string,
  changedFiles?: string[],
  lastCommit?: string,
): Partial<TaskResult> | null {
  const match = text.match(/<task_result>\s*([\s\S]*?)\s*<\/task_result>/i);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      return {
        taskId,
        role,
        status: parsed.status,
        summary:
          parsed.summary ||
          text.replace(/<task_result>[\s\S]*?<\/task_result>/gi, "").trim(),
        changedFiles: parsed.changedFiles || changedFiles,
        commit: parsed.commit || lastCommit,
        verification: parsed.verification,
        reviewReport: parsed.reviewReport,
        deployEvidence: parsed.deployEvidence,
        unresolvedItems: parsed.unresolvedItems,
      };
    } catch {
      /* parse failed */
    }
  }
  return null;
}

export class SubagentManager {
  private modelRuntime: ModelRuntime;

  constructor(modelRuntime: ModelRuntime) {
    this.modelRuntime = modelRuntime;
    const persisted = loadPersistedTasks();
    for (const [id, task] of persisted) {
      if (!subagentTasks.has(id)) {
        subagentTasks.set(id, { task });
      }
    }
  }

  public updateModelRuntime(modelRuntime: ModelRuntime) {
    this.modelRuntime = modelRuntime;
  }

  /**
   * 派发并异步启动一个 Subagent 子任务 (Fail-closed 严格隔离)
   */
  public async spawn(options: SpawnSubagentOptions): Promise<UISubagentTask> {
    // 1. 角色有效性严格校验 (Fail-closed，禁止静默回退)
    const validRoleIds = getAllRoleDefinitions().map((r) => r.id);
    if (!validRoleIds.includes(options.role)) {
      throw new Error(
        `[SubagentManager] Unknown or invalid role "${options.role}". Available roles: ${validRoleIds.join(", ")}. Fail-closed: refusing execution.`,
      );
    }

    const taskId = options.taskContract?.taskId || `task-${randomUUID()}`;
    const roleConfig = getRoleConfig(options.role);
    const repoRoot = await resolveGitRepoRoot(options.parentCwd);

    // 2. 确定初始 TaskContract
    const contract: TaskContract = options.taskContract ?? {
      taskId,
      parentSessionId: options.parentSessionId,
      role: options.role,
      goal: options.taskTitle || options.taskPrompt,
      scope: { include: ["*"], exclude: [] },
      contextFiles: [],
      acceptanceCriteria: ["实现对应需求并通过自测"],
      expectedDeliverables:
        options.role === "reviewer"
          ? ["summary", "review_verdict"]
          : options.role === "deployer"
            ? ["summary", "deploy_evidence"]
            : ["summary", "changed_files", "test_report"],
    };

    // 3. 基于 Effective Permission 判断是否必须启用 Worktree 隔离
    const preCheckContext = ConstraintResolver.resolve({
      role: options.role,
      cwd: options.parentCwd,
      projectRoot: repoRoot || undefined,
      isGitRepo: !!repoRoot,
      taskContract: contract,
      executionOptions: options.executionOptions,
      parentModel: options.parentModel
        ? { provider: options.parentModel.provider, modelId: options.parentModel.id }
        : null,
    });

    let worktreePath: string | undefined;
    let branchName: string | undefined;
    let baseCommit: string | undefined;

    if (preCheckContext.permission.requiresWorktree) {
      if (!repoRoot) {
        throw new Error(
          `[SubagentManager] Role "${options.role}" requires worktree isolation (requiresWorktree=true), but parent directory "${options.parentCwd}" is not inside a Git repository. Fail-closed: refusing execution in unisolated workspace.`,
        );
      }
      try {
        const wt = await createWorktree(repoRoot, taskId, options.preferredBranch);
        worktreePath = wt.worktreePath;
        branchName = wt.branch;
        baseCommit = wt.baseCommit;
      } catch (err) {
        throw new Error(
          `[SubagentManager] Role "${options.role}" requires worktree isolation, but worktree creation failed for ${taskId}: ${String(err instanceof Error ? err.message : err)}. Fail-closed: refusing fallback to parent cwd.`,
        );
      }
    }

    const baseDir = worktreePath && existsSync(worktreePath) ? worktreePath : options.parentCwd;
    let effectiveCwd = baseDir;

    // 4. targetCwd 规范化边界检查 (Fail-closed，只读角色禁止自动 mkdir)
    if (options.targetCwd) {
      const resolved = isAbsolute(options.targetCwd)
        ? options.targetCwd
        : resolve(baseDir, options.targetCwd);

      if (!isPathContained(baseDir, resolved)) {
        throw new Error(
          `[SubagentManager] targetCwd "${options.targetCwd}" escapes the assigned worktree/repo boundary "${baseDir}". Fail-closed.`,
        );
      }

      if (existsSync(resolved)) {
        effectiveCwd = resolved;
      } else {
        if (preCheckContext.permission.writableScope === "none") {
          throw new Error(
            `[SubagentManager] targetCwd "${options.targetCwd}" does not exist, and role "${options.role}" is read-only (writableScope: none). Refusing automatic directory creation. Fail-closed.`,
          );
        }
        try {
          mkdirSync(resolved, { recursive: true });
          effectiveCwd = resolved;
        } catch (err) {
          throw new Error(
            `[SubagentManager] Failed to create targetCwd "${options.targetCwd}": ${String(err instanceof Error ? err.message : err)}`,
          );
        }
      }
    }

    // 5. 重新计算包含完整工作区与路径范围的最终 EffectiveContext
    const effectiveContext = ConstraintResolver.resolve({
      role: options.role,
      cwd: effectiveCwd,
      projectRoot: repoRoot || undefined,
      isGitRepo: !!repoRoot,
      branchName,
      worktreePath,
      targetCwd: options.targetCwd,
      taskContract: contract,
      executionOptions: options.executionOptions,
      parentModel: options.parentModel
        ? { provider: options.parentModel.provider, modelId: options.parentModel.id }
        : null,
    });

    // 6. 初始化独立 AgentSessionRuntime (注入分层组装系统提示词)
    const runtime = await createAgentSessionRuntime(
      async ({ cwd, sessionManager, sessionStartEvent }) => {
        const services = await createAgentSessionServices({
          cwd,
          resourceLoaderOptions: {
            systemPromptOverride: () => {
              const assembled = PromptAssembler.assemble(effectiveContext, options.taskPrompt);
              return assembled.systemPrompt;
            },
            appendSystemPromptOverride: () => [],
          },
        });
        return {
          ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
          services,
          diagnostics: services.diagnostics,
        };
      },
      {
        cwd: effectiveCwd,
        agentDir: getAgentDir(),
        sessionManager: SessionManager.inMemory(effectiveCwd),
      },
    );

    const session = runtime.session;

    // 7. 配置模型与思考深度
    const resolvedModel = effectiveContext.permission.model;
    if (resolvedModel?.modelId && resolvedModel.modelId !== "inherit") {
      const provider = resolvedModel.provider ?? options.parentModel?.provider ?? "anthropic";
      const model = this.modelRuntime.getModel(provider, resolvedModel.modelId);
      if (model) {
        await session.setModel(model);
      } else {
        console.warn(
          `[SubagentManager] Model not found: ${provider}/${resolvedModel.modelId} for role ${options.role}; using session default`,
        );
      }
    }
    if (resolvedModel?.thinkingLevel) {
      session.setThinkingLevel(resolvedModel.thinkingLevel);
    }

    // 8. 挂载单一 RuntimeEnforcer
    RuntimeEnforcer.applyPermissionsToSession(session, effectiveContext.permission);

    // 安装每轮 LLM 请求记录器
    installTurnRecorderOnSession(session, () => taskId);

    const modelInfo = session.model
      ? {
          provider: session.model.provider,
          id: session.model.id,
          name: (session.model as { name?: string }).name,
        }
      : undefined;

    const task: UISubagentTask = {
      taskId,
      parentSessionId: options.parentSessionId,
      role: options.role,
      taskTitle: options.taskTitle || `${roleConfig.name} - ${taskId}`,
      taskPrompt: options.taskPrompt,
      branchName,
      worktreePath,
      targetCwd: options.targetCwd,
      status: "running",
      createdAt: new Date().toISOString(),
      logs: [],
      model: modelInfo,
      taskContract: contract,
      messages: serializeMessages(session.messages),
    };

    let timeoutTimer: NodeJS.Timeout | undefined;
    if (options.executionOptions?.timeoutMs && options.executionOptions.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        console.warn(`[SubagentManager] Task ${taskId} timed out after ${options.executionOptions!.timeoutMs}ms`);
        void this.abort(taskId);
      }, options.executionOptions.timeoutMs);
    }

    const instance: SubagentInstance = {
      task,
      runtime,
      repoRoot,
      baseCommit,
      taskContract: contract,
      timeoutTimer,
      onUpdate: options.onUpdate,
      onReport: options.onReport,
    };

    subagentTasks.set(taskId, instance);
    persistTask(task);
    options.onUpdate?.(task);

    // 9. 监听事件与收集日志
    session.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        const logLine = `[Tool] ${event.toolName} -> ${event.isError ? "Error" : "Success"}`;
        task.logs?.push(logLine);
        task.messages = serializeMessages(session.messages);
        persistTask(task);
        options.onUpdate?.(task);
      } else if (event.type === "message_end" || event.type === "turn_end") {
        task.messages = serializeMessages(session.messages);
        persistTask(task);
        options.onUpdate?.(task);
      } else if (event.type === "agent_end") {
        task.messages = serializeMessages(session.messages);
        persistTask(task);
        void this.handleSubagentCompletion(taskId);
      }
    });

    // 10. 异步启动 prompt
    session.prompt(options.taskPrompt).catch((err) => {
      console.error(`[SubagentManager] Subagent ${taskId} error:`, err);
      task.status = "failed";
      task.error = String(err instanceof Error ? err.message : err);
      task.completedAt = new Date().toISOString();
      task.messages = serializeMessages(session.messages);
      persistTask(task);
      options.onUpdate?.(task);
    });

    return task;
  }

  /**
   * 子智能体运行结束后的处理：通过严格的 validateTaskResult Schema 校验产出与交付契约
   */
  private async handleSubagentCompletion(taskId: string) {
    const instance = subagentTasks.get(taskId);
    if (!instance) return;

    if (instance.timeoutTimer) {
      clearTimeout(instance.timeoutTimer);
      instance.timeoutTimer = undefined;
    }

    if (instance.task.status === "cancelled" || instance.task.status === "aborted" || instance.task.status === "failed") {
      persistTask(instance.task);
      return;
    }

    const task = instance.task;
    task.completedAt = new Date().toISOString();
    const rawMessages = instance.runtime?.session.messages ?? [];
    task.messages = serializeMessages(rawMessages);

    // 1. Harness 权威观测 Git 状态与变更（绝不让 LLM 幻觉覆盖真实事实）
    let lastCommit: string | undefined;
    if (task.worktreePath) {
      try {
        const diffInfo = await getWorktreeDiff(task.worktreePath, instance.baseCommit);
        task.changedFiles = diffInfo.changedFiles;
        lastCommit = diffInfo.lastCommit;
      } catch {
        /* ignore */
      }
    }

    const roleConfig = getRoleConfig(task.role);
    const lastAssistantText = extractLastAssistantText(rawMessages);

    // 2. 从模型输出提取结构化 <task_result> 块
    const parsedResult = parseTaskResultFromText(
      lastAssistantText,
      task.taskId,
      task.role,
      task.changedFiles,
      lastCommit,
    );

    // 3. 构造待校验的真实 TaskResult（Harness 观测的 changedFiles 与 commit 为唯一事实源）
    const rawPayload = {
      taskId: task.taskId,
      role: task.role,
      status: parsedResult?.status || "completed",
      summary: parsedResult?.summary || lastAssistantText || "（子任务未输出文字总结）",
      changedFiles: task.changedFiles,
      commit: lastCommit,
      verification: parsedResult?.verification,
      reviewReport: parsedResult?.reviewReport,
      deployEvidence: parsedResult?.deployEvidence,
      unresolvedItems: parsedResult?.unresolvedItems,
    };

    // 4. 执行严格的 Runtime Schema Validation 与 expectedDeliverables 契约校验
    const validation = validateTaskResult(rawPayload, instance.taskContract);
    const finalTaskResult = validation.result || {
      taskId: task.taskId,
      role: task.role,
      status: "failed",
      summary: lastAssistantText || "（子任务交付结果格式校验失败）",
      changedFiles: task.changedFiles,
      commit: lastCommit,
      unresolvedItems: validation.errors,
      completedAt: task.completedAt,
    };

    // 5. 保留完整的任务状态 (completed, blocked, failed, rejected, cancelled)，不盲目扁平化为 failed
    task.status = finalTaskResult.status;
    task.taskResult = finalTaskResult;
    task.summary = finalTaskResult.summary;

    const report = buildBoundedCompletionReport({
      taskId: task.taskId,
      taskTitle: task.taskTitle,
      role: task.role,
      roleName: roleConfig.name,
      branch: task.branchName,
      status: task.status,
      changedFiles: task.changedFiles,
      lastCommit,
      completedAt: task.completedAt,
      lastAssistantText: finalTaskResult.summary,
      taskResult: finalTaskResult,
      verification: finalTaskResult.verification,
      reviewReport: finalTaskResult.reviewReport,
      deployEvidence: finalTaskResult.deployEvidence,
    });

    persistTask(task);
    instance.onUpdate?.(task);
    instance.onReport?.(task, report.parentReport);
  }

  /**
   * 中断指定的 Subagent (形成规范的 cancelled TaskResult)
   */
  public async abort(taskId: string): Promise<boolean> {
    const instance = subagentTasks.get(taskId);
    if (!instance) return false;
    if (instance.timeoutTimer) {
      clearTimeout(instance.timeoutTimer);
      instance.timeoutTimer = undefined;
    }
    try {
      if (instance.runtime) {
        await instance.runtime.session.abort();
      }
      instance.task.status = "cancelled";
      instance.task.completedAt = new Date().toISOString();
      instance.task.taskResult = {
        taskId: instance.task.taskId,
        role: instance.task.role,
        status: "cancelled",
        summary: "任务已被用户或父 Agent 主动终止 (cancelled)",
        completedAt: instance.task.completedAt,
      };
      persistTask(instance.task);
      instance.onUpdate?.(instance.task);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 删除指定的 Subagent 任务及其磁盘持久化文件
   */
  public async deleteTask(taskId: string): Promise<boolean> {
    const instance = subagentTasks.get(taskId);
    if (instance) {
      if (instance.timeoutTimer) {
        clearTimeout(instance.timeoutTimer);
      }
      if (instance.task.status === "running" && instance.runtime) {
        try {
          await instance.runtime.session.abort();
        } catch {
          /* ignore */
        }
      }
      subagentTasks.delete(taskId);
    }
    try {
      const file = taskFilePath(taskId);
      if (existsSync(file)) {
        unlinkSync(file);
      }
      return true;
    } catch (err) {
      console.warn(`[SubagentManager] Failed to delete task file for ${taskId}:`, err);
      return false;
    }
  }

  /**
   * 清空某主会话下的所有历史 Subagent 任务
   */
  public async clearTasksForParent(parentSessionId: string): Promise<number> {
    let count = 0;
    const taskIds: string[] = [];
    for (const [id, inst] of subagentTasks.entries()) {
      if (inst.task.parentSessionId === parentSessionId) {
        taskIds.push(id);
      }
    }
    for (const id of taskIds) {
      const ok = await this.deleteTask(id);
      if (ok) count++;
    }
    return count;
  }

  /**
   * 获取某主会话下的所有 Subagent 任务列表
   */
  public getTasksForParent(parentSessionId: string): UISubagentTask[] {
    const list: UISubagentTask[] = [];
    for (const inst of subagentTasks.values()) {
      if (inst.task.parentSessionId === parentSessionId) {
        list.push(inst.task);
      }
    }
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
