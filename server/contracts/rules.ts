/**
 * Shared Invariants & Shared Defaults
 *
 * 架构分层：
 * System Prompt:
 * - Shared Invariants (全局底线)
 * - Role Behavior & Instructions (角色身份与职责)
 * - Project Rules (AGENTS.md / 仓库规范)
 * - Shared Defaults (通用工程规范默认指引)
 *
 * User Prompt:
 * - Task Context (权威 TaskContract 与具体执行指令)
 * - Workspace Context (任务级权威环境上下文)
 */

/**
 * Shared Invariants: 真正全局不可覆盖的硬约束。
 * 任何角色、任何项目规则、任何 Task Contract 都绝对无权覆盖。
 */
export const CHINESE_LANGUAGE_GUIDANCE =
  "语言要求：除非用户明确要求使用其他语言，尽可能使用中文回答；thinking 内容也尽可能使用中文。代码、命令、标识符和必须保留的专有名词按原样保留。";

export const SHARED_INVARIANTS: readonly string[] = [
  CHINESE_LANGUAGE_GUIDANCE,
  "不得伪造文件内容、命令输出、工具执行结果或测试结果；所有结论必须基于真实工具执行与真实文件内容。",
  "不得声称完成了实际未执行或未验证的操作与验证。",
  "不得破坏、静默覆盖或删除与当前任务无关的用户已有修改及文件。",
  "不得在代码、提交信息、日志或回复中泄露 Secret、API Key、Token 或敏感认证凭据。",
];

/** 确保绕过 PromptAssembler 的标准模式提示词也带有统一语言约束。 */
export function ensureChineseLanguageGuidance(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.includes(CHINESE_LANGUAGE_GUIDANCE)) return trimmed;
  return trimmed ? `${CHINESE_LANGUAGE_GUIDANCE}\n\n${trimmed}` : CHINESE_LANGUAGE_GUIDANCE;
}

/**
 * Shared Defaults: 通用工程规范默认指引。
 * 允许被具体的 Project Rules (如 AGENTS.md) 或任务需求调整覆盖。
 */
export const SHARED_DEFAULTS: readonly string[] = [
  "输出保持简洁直接，使用技术语言，避免冗长寒暄与过渡性客套话。",
  "优先进行最小化修改，优先复用项目中已有的模式、类型与工具函数，避免过度设计。",
  "源码证据与分析优先使用文件路径、类名、方法/函数名及符号 (file + class + method/symbol) 作为稳定定位信息；除非任务或验收标准明确要求精确行号，行号仅作辅助参考；源码在执行中未变更时，已确认的符号无需反复重新读取，严禁为了核实微小行号反复 grep/sed/read 或阻塞交付。",
  "Pi 压缩摘要只是 continuation hint；需要恢复证据时，仅在当前任务范围内使用 recovery_manifest 与恢复工具做定向查询，不创建额外记忆文件。",
  "针对修复型任务（Bug / 回归 / 行为变更 / 性能 / 并发）：修改代码前优先验证或复现当前行为（Baseline）；无法复现时如实说明现象与可能原因，禁止仅凭推测修改；修改后尽量使用相同或等价方法复测，对比确认问题已解决。",
  "修改代码后默认运行相关测试、类型检查或 Lint，并在交付物中附带验证证据。",
  "严格遵循项目既有的代码风格、命名规范与类型完备性要求（避免无故绕过类型检查）。",
  "单次任务完成后，提供适合当前角色职责的简明交付报告，明确说明实际验证结果与重要遗留问题。",
];

export interface WorkspaceContextDetails {
  cwd: string;
  projectRoot?: string | null;
  workspaceType?: string;
  gitBranch?: string | null;
  targetCwd?: string | null;
  isWorktree?: boolean;
}

/**
 * 格式化输出权威 Workspace Context 动态上下文块
 */
export function formatWorkspaceContext(ws: WorkspaceContextDetails): string {
  const wsLines: string[] = [
    `- cwd: ${ws.cwd}`,
    `- project_root: ${ws.projectRoot ?? ws.cwd}`,
    `- workspace_type: ${ws.workspaceType ?? (ws.isWorktree ? "isolated_worktree" : "main_project")}`,
  ];
  if (ws.gitBranch) {
    wsLines.push(`- git_branch: ${ws.gitBranch}`);
  }
  if (ws.isWorktree !== undefined) {
    wsLines.push(`- is_worktree: ${ws.isWorktree}`);
  }
  if (ws.targetCwd && ws.targetCwd !== ws.cwd) {
    wsLines.push(`- target_cwd: ${ws.targetCwd}`);
  }
  return `## Workspace Context\n${wsLines.join("\n")}\n\nThe workspace information above is authoritative for this task.`;
}
