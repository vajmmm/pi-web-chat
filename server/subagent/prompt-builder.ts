import { formatWorkspaceContext, type TaskContract, type WorkspaceContextDetails } from "../contracts/index.ts";

/**
 * 组装发送给 Subagent 的单次 User Message（承载动态任务目标、工作区上下文、范围与验收标准）
 */
export function buildSubagentUserPrompt(
  taskPrompt: string,
  contract?: TaskContract,
  options?: {
    continueBoundary?: string;
    workspaceContext?: WorkspaceContextDetails;
  },
): string {
  if (!contract && !options?.continueBoundary && !options?.workspaceContext) return taskPrompt;
  const sections: string[] = [];

  if (options?.continueBoundary) {
    sections.push(options.continueBoundary);
  }

  if (options?.workspaceContext) {
    sections.push(formatWorkspaceContext(options.workspaceContext));
  }

  if (contract) {
    sections.push("## Task Kickoff\nBegin executing the assigned immutable Task Contract.");
  } else {
    sections.push(`## Task\n${taskPrompt}`);
  }

  return sections.join("\n\n");
}
