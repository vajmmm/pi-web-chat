import { formatWorkspaceContext, type TaskContract, type WorkspaceContextDetails } from "../contracts/index.ts";

/**
 * 组装发送给 Subagent 的单次 User Message。
 * System Prompt 只承载稳定工作契约；首条 User Message 承载本次任务与工作区。
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

  if (contract) {
    sections.push([
      "## Task Context",
      "The following TaskContract is the authoritative runtime context for this task and remains immutable for its lifetime.",
      JSON.stringify(contract, null, 2),
      "",
      "Task instructions:",
      taskPrompt,
    ].join("\n"));
  } else {
    sections.push(`## Task\n${taskPrompt}`);
  }

  if (options?.workspaceContext) {
    sections.push(formatWorkspaceContext(options.workspaceContext));
  }

  return sections.join("\n\n");
}
