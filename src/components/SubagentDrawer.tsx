import { Dialog } from "@base-ui-components/react/dialog";
import { useState } from "react";
import type { UISubagentTask } from "../../shared/protocol";
import { chatClient, useChat } from "../lib/chat";
import { Markdown } from "./Markdown";
import { Message } from "./MessageList";

const roleNameMap: Record<string, string> = {
  fullstack: "全栈开发 (Fullstack)",
  junior_fe: "初级前端 (Junior Frontend)",
  junior_be: "初级后端 (Junior Backend)",
  reviewer: "审查者 (Reviewer)",
  tester: "测试者 (Tester)",
  deployer: "实施者 (Deployer)",
  coordinator: "统筹者 (Coordinator)",
  default: "普通智能体",
};

/**
 * 完整子任务会话详情弹窗
 */
function SubagentConversationDialog({
  task,
  open,
  onOpenChange,
}: {
  task: UISubagentTask | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!task) return null;

  const isRunning = task.status === "running";
  const isCompleted = task.status === "completed";
  const isFailed = task.status === "failed";
  const isAborted = task.status === "aborted" || task.status === "cancelled";
  const isInterrupted = task.status === "interrupted";
  const isBlocked = task.status === "blocked";
  const isRejected = task.status === "rejected";

  const messages = task.messages ?? [];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 transition-opacity z-50" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 flex h-[90vh] max-h-[90vh] w-[96vw] max-w-4xl -translate-x-1/2 -translate-y-1/2 flex-col border-2 border-accent bg-card font-mono shadow-[var(--pixel-shadow)] outline-none z-50">
          {/* 顶栏 */}
          <div className="flex shrink-0 items-center justify-between border-b-2 border-line bg-sidebar/80 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="border border-accent bg-bubble px-1.5 py-0.5 text-[10px] font-bold text-accent">
                {roleNameMap[task.role] ?? task.role}
              </span>
              <Dialog.Title className="text-sm font-bold text-ink truncate max-w-sm sm:max-w-md">
                {task.taskTitle}
              </Dialog.Title>

              {isRunning && (
                <span className="flex items-center gap-1.5 border border-emerald-600 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                  <span className="size-2 animate-ping bg-emerald-500" />
                  RUNNING
                </span>
              )}
              {isCompleted && (
                <span className="border border-mint bg-mint/10 px-2 py-0.5 text-[10px] font-bold text-mint">
                  ✓ COMPLETED
                </span>
              )}
              {isFailed && (
                <span className="border border-red-500 bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-600 dark:bg-red-950/40 dark:text-red-400">
                  ✗ FAILED
                </span>
              )}
              {isBlocked && (
                <span className="border border-amber-500 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                  ⛔ BLOCKED
                </span>
              )}
              {isRejected && (
                <span className="border border-rose-600 bg-rose-50 px-2 py-0.5 text-[10px] font-bold text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                  ✕ REJECTED
                </span>
              )}
              {isAborted && (
                <span className="border border-line px-2 py-0.5 text-[10px] font-bold text-muted">
                  CANCELLED
                </span>
              )}
              {isInterrupted && (
                <span className="border border-amber-500 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                  ⚠️ INTERRUPTED
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {isRunning && (
                <button
                  type="button"
                  onClick={() => chatClient.abortSubagent(task.taskId)}
                  className="border border-red-400 bg-card px-2.5 py-1 text-xs font-bold text-red-500 hover:bg-red-500 hover:text-white"
                >
                  🛑 中断任务
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (confirm(`确定要删除子任务记录【${task.taskTitle}】吗？`)) {
                    chatClient.deleteSubagentTask(task.taskId);
                    onOpenChange(false);
                  }
                }}
                className="border border-red-300 dark:border-red-800 bg-card px-2.5 py-1 text-xs text-red-500 hover:bg-red-500 hover:text-white transition-colors"
                title="彻底删除此子任务记录"
              >
                🗑️ 删除记录
              </button>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="border-2 border-line px-2.5 py-1 text-xs text-muted hover:border-accent hover:text-ink"
              >
                ✕ 关闭
              </button>
            </div>
          </div>

          {/* 元信息条 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-canvas/60 px-4 py-2 text-[11px] text-faint shrink-0">
            <div>
              任务ID: <span className="font-bold text-ink">{task.taskId}</span>
            </div>
            {task.model && (
              <div>
                模型: <span className="border border-line bg-card px-1 text-accent">🤖 {task.model.provider}/{task.model.id}</span>
              </div>
            )}
            {task.targetCwd && (
              <div>
                目录: <span className="border border-line bg-card px-1 text-ink">📁 {task.targetCwd}</span>
              </div>
            )}
            {task.branchName && (
              <div>
                分支: <span className="border border-line bg-card px-1 text-accent">🌿 {task.branchName}</span>
              </div>
            )}
          </div>

          {/* 完整会话内容流 */}
          <div className="thin-scroll flex flex-1 flex-col gap-4 overflow-y-auto p-4 bg-canvas">
            {/* 1. 派发提示词卡片 */}
            <div className="border-2 border-[#c2a9df] bg-bubble p-3 font-mono shadow-[var(--pixel-shadow-sm)] dark:border-[#674b88]">
              <div className="flex items-center justify-between border-b border-accent/30 pb-1.5 mb-2 text-xs font-bold text-accent">
                <span>📥 统筹者派发任务提示词 (Task Prompt)</span>
                <span className="text-[10px] text-muted">{task.createdAt}</span>
              </div>
              <div className="text-[13px] whitespace-pre-wrap leading-relaxed text-ink">
                {task.taskPrompt}
              </div>
            </div>

            {/* 2. 消息与工具调用流 */}
            {messages.length > 0 ? (
              <div className="flex flex-col gap-4">
                {messages.map((msg, i) => (
                  <Message key={i} message={msg} />
                ))}
              </div>
            ) : (
              <div className="border border-dashed border-line p-4 text-center text-xs text-muted">
                {isRunning ? (
                  <div className="flex items-center justify-center gap-2 text-accent animate-pulse">
                    <span className="size-2 bg-accent" />
                    子智能体正在执行初始思考与工具准备……
                  </div>
                ) : (
                  "暂无详细对话消息记录"
                )}
              </div>
            )}

            {/* 3. 改动文件列表 */}
            {task.changedFiles && task.changedFiles.length > 0 && (
              <div className="border-2 border-line-bright bg-card p-3 font-mono shadow-[var(--pixel-shadow-sm)] mt-2">
                <div className="flex items-center justify-between border-b border-line pb-1.5 mb-2">
                  <span className="text-xs font-bold text-ink">
                    📝 产生的代码变更文件 ({task.changedFiles.length})
                  </span>
                  {task.branchName && (
                    <span className="text-[10px] text-accent">分支: {task.branchName}</span>
                  )}
                </div>
                <ul className="space-y-1 pl-2 text-xs">
                  {task.changedFiles.map((file, i) => (
                    <li key={i} className="flex items-center gap-1.5">
                      <span className="text-mint font-bold">▸</span>
                      <code className="bg-canvas border border-line px-1.5 py-0.5 text-accent">{file}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* 4. 最终完成总结 */}
            {task.summary && (
              <div className="border-2 border-mint/60 bg-card p-3 font-mono shadow-[var(--pixel-shadow-sm)] mt-2">
                <div className="flex items-center justify-between border-b border-mint/30 pb-1.5 mb-2 text-xs font-bold text-mint">
                  <span>🏁 子智能体上报总结报告 (Final Report)</span>
                  {task.completedAt && (
                    <span className="text-[10px] text-muted">{task.completedAt}</span>
                  )}
                </div>
                <div className="text-[13px] text-ink leading-relaxed">
                  <Markdown text={task.summary} />
                </div>
              </div>
            )}

            {/* 错误展示 */}
            {task.error && (
              <div className="border-2 border-red-500 bg-red-50 p-3 text-xs text-red-600 dark:bg-red-950/50 dark:text-red-400 font-mono">
                <div className="font-bold mb-1">执行错误:</div>
                <pre className="whitespace-pre-wrap">{task.error}</pre>
              </div>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SubagentCard({
  task,
  onOpenConversation,
}: {
  task: UISubagentTask;
  onOpenConversation: (task: UISubagentTask) => void;
}) {
  const [logsExpanded, setLogsExpanded] = useState(false);

  const isRunning = task.status === "running";
  const isCompleted = task.status === "completed";
  const isFailed = task.status === "failed";
  const isAborted = task.status === "aborted" || task.status === "cancelled";
  const isInterrupted = task.status === "interrupted";
  const isBlocked = task.status === "blocked";
  const isRejected = task.status === "rejected";

  const messageCount = task.messages?.length ?? 0;

  return (
    <div className="border-2 border-line-bright bg-card p-3.5 font-mono shadow-[var(--pixel-shadow-sm)]">
      {/* 头部信息 */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2">
        <div className="flex items-center gap-2">
          <span className="border border-accent bg-bubble px-1.5 py-0.5 text-[10px] font-bold text-accent">
            {roleNameMap[task.role] ?? task.role}
          </span>
          <span className="text-xs font-bold text-ink">{task.taskTitle}</span>
        </div>

        <div className="flex items-center gap-2">
          {isRunning && (
            <span className="flex items-center gap-1.5 border border-emerald-600 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              <span className="size-2 animate-ping bg-emerald-500" />
              RUNNING
            </span>
          )}
          {isCompleted && (
            <span className="border border-mint bg-mint/10 px-2 py-0.5 text-[10px] font-bold text-mint">
              ✓ COMPLETED
            </span>
          )}
          {isFailed && (
            <span className="border border-red-500 bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-600 dark:bg-red-950/40 dark:text-red-400">
              ✗ FAILED
            </span>
          )}
          {isBlocked && (
            <span className="border border-amber-500 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              ⛔ BLOCKED
            </span>
          )}
          {isRejected && (
            <span className="border border-rose-600 bg-rose-50 px-2 py-0.5 text-[10px] font-bold text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
              ✕ REJECTED
            </span>
          )}
          {isAborted && (
            <span className="border border-line px-2 py-0.5 text-[10px] font-bold text-muted">
              CANCELLED
            </span>
          )}
          {isInterrupted && (
            <span className="border border-amber-500 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              ⚠️ INTERRUPTED
            </span>
          )}

          <button
            type="button"
            onClick={() => onOpenConversation(task)}
            className="flex items-center gap-1 border-2 border-accent bg-bubble px-2.5 py-0.5 text-[11px] font-bold text-accent shadow-[var(--pixel-shadow-sm)] transition-all hover:translate-x-[1px] hover:translate-y-[1px] hover:bg-accent hover:text-white"
            title="查看子智能体完整会话过程与全部工具调用"
          >
            <span>💬 查看完整会话</span>
            {messageCount > 0 && <span className="opacity-75">({messageCount})</span>}
          </button>

          {isRunning ? (
            <button
              type="button"
              onClick={() => chatClient.abortSubagent(task.taskId)}
              className="border border-red-400 bg-card px-2 py-0.5 text-[10px] font-bold text-red-500 hover:bg-red-500 hover:text-white"
            >
              中断
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (confirm(`确定要删除子任务【${task.taskTitle}】的记录吗？`)) {
                  chatClient.deleteSubagentTask(task.taskId);
                }
              }}
              className="border border-line px-1.5 py-0.5 text-[10px] text-muted hover:border-red-400 hover:text-red-500 transition-colors"
              title="删除此任务记录"
            >
              🗑️
            </button>
          )}
        </div>
      </div>

      {/* 详情与分支 */}
      <div className="mt-2.5 space-y-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-2 text-faint">
          <span>任务ID:</span>
          <span className="font-bold text-ink">{task.taskId}</span>
          {task.model && (
            <>
              <span className="text-line">•</span>
              <span>模型:</span>
              <span className="border border-line bg-canvas px-1 text-accent">🤖 {task.model.provider}/{task.model.id}</span>
            </>
          )}
          {task.targetCwd && (
            <>
              <span className="text-line">•</span>
              <span>目录:</span>
              <span className="border border-line bg-canvas px-1 text-accent">📁 {task.targetCwd}</span>
            </>
          )}
          {task.branchName && (
            <>
              <span className="text-line">•</span>
              <span>分支:</span>
              <span className="border border-line bg-canvas px-1 text-accent">🌿 {task.branchName}</span>
            </>
          )}
        </div>

        {/* 改动文件清单 */}
        {task.changedFiles && task.changedFiles.length > 0 && (
          <div className="mt-2 border-t border-dashed border-line pt-2">
            <span className="text-[11px] font-bold text-muted">
              改动文件 ({task.changedFiles.length}):
            </span>
            <ul className="mt-1 space-y-0.5 pl-2 text-[11px] text-ink">
              {task.changedFiles.map((file, i) => (
                <li key={i} className="flex items-center gap-1.5">
                  <span className="text-mint">▸</span>
                  <code className="bg-canvas px-1 text-accent">{file}</code>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 执行总结 */}
        {task.summary && (
          <div className="mt-2.5 border-t border-dashed border-line pt-2">
            <span className="text-[11px] font-bold text-muted">执行产出摘要:</span>
            <div className="mt-1 whitespace-pre-wrap border border-line bg-canvas p-2 text-[11px] text-ink max-h-28 overflow-y-auto thin-scroll">
              {task.summary}
            </div>
          </div>
        )}

        {/* 错误信息 */}
        {task.error && (
          <div className="mt-2 border border-red-400 bg-red-50 p-2 text-[11px] text-red-600 dark:bg-red-950/40 dark:text-red-400">
            错误: {task.error}
          </div>
        )}

        {/* 运行日志 */}
        {task.logs && task.logs.length > 0 && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setLogsExpanded(!logsExpanded)}
              className="flex items-center gap-1 text-[11px] text-muted hover:text-accent"
            >
              <span>{logsExpanded ? "▼ 收起工具调用简报" : `▶ 展开工具调用简报 (${task.logs.length})`}</span>
            </button>
            {logsExpanded && (
              <div className="mt-1 border border-line bg-canvas p-2 text-[10px] text-faint max-h-28 overflow-y-auto thin-scroll">
                {task.logs.map((log, i) => (
                  <div key={i}>{log}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function SubagentDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { snapshot } = useChat();
  const subagents = snapshot?.subagents ?? [];
  const runningCount = subagents.filter((s) => s.status === "running").length;

  const [selectedTask, setSelectedTask] = useState<UISubagentTask | null>(null);
  const [conversationOpen, setConversationOpen] = useState(false);

  const handleOpenConversation = (task: UISubagentTask) => {
    setSelectedTask(task);
    setConversationOpen(true);
  };

  // If selected task updates in real-time, keep active
  const activeTask = selectedTask
    ? (subagents.find((s) => s.taskId === selectedTask.taskId) ?? selectedTask)
    : null;

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 bg-black/50 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 z-40" />
          <Dialog.Popup className="fixed top-1/2 left-1/2 flex max-h-[86vh] w-[94vw] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col border-2 border-accent bg-card font-mono shadow-[var(--pixel-shadow)] outline-none z-50">
            {/* 顶栏 */}
            <div className="flex items-center justify-between border-b-2 border-line px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="flex size-5 items-center justify-center border border-accent bg-bubble text-xs font-bold text-accent">
                  ⚡
                </span>
                <Dialog.Title className="text-sm font-bold text-ink">
                  子任务协同看板 (Subagents Dashboard)
                </Dialog.Title>
                {runningCount > 0 && (
                  <span className="border border-emerald-600 bg-emerald-50 px-2 py-0.2 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                    {runningCount} 运行中
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {subagents.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm("确定要清空本会话下的所有历史子任务记录吗？")) {
                        chatClient.clearSubagentTasks();
                      }
                    }}
                    className="border border-line px-2 py-0.5 text-xs text-muted hover:border-red-400 hover:text-red-500 transition-colors"
                    title="清空当前所有子任务记录"
                  >
                    🗑️ 清空历史
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="border-2 border-line px-2 py-0.5 text-xs text-muted hover:border-accent hover:text-ink"
                >
                  ✕ 关闭
                </button>
              </div>
            </div>

            {/* 列表内容 */}
            <div className="thin-scroll flex flex-1 flex-col gap-3 overflow-y-auto p-4">
              {subagents.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center text-muted">
                  <span className="text-2xl mb-2">📦</span>
                  <span className="text-xs font-bold">暂无运行或历史子任务</span>
                  <span className="mt-1 text-[11px] text-faint max-w-md">
                    在统筹者模式下输入需求，系统将自动拆解并调用 <code>spawn_subagent</code> 启动独立的并行子任务与 Git Worktree。
                  </span>
                </div>
              ) : (
                subagents.map((task) => (
                  <SubagentCard
                    key={task.taskId}
                    task={task}
                    onOpenConversation={handleOpenConversation}
                  />
                ))
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {/* 完整会话弹窗 */}
      <SubagentConversationDialog
        task={activeTask}
        open={conversationOpen}
        onOpenChange={setConversationOpen}
      />
    </>
  );
}
