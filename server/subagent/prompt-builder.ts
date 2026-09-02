import { formatWorkspaceContext, type TaskContract, type WorkspaceContextDetails } from "../contracts/index.ts";

/**
 * 组装发送给 Subagent 的单次 User Message（承载动态任务目标、工作区上下文、范围与验收标准）
 */
export function buildSubagentUserPrompt(
  taskPrompt: string,
  contract?: TaskContract,
  options?: {
    continueBoundary?: string;
    memoryPaths?: { workingMemoryPath: string; processJournalPath: string };
    workspaceContext?: WorkspaceContextDetails;
  },
): string {
  if (!contract && !options?.continueBoundary && !options?.memoryPaths && !options?.workspaceContext) return taskPrompt;
  const sections: string[] = [];

  if (options?.continueBoundary) {
    sections.push(options.continueBoundary);
  }

  if (options?.workspaceContext) {
    sections.push(formatWorkspaceContext(options.workspaceContext));
  }

  if (contract?.goal) {
    sections.push(`## Goal\n${contract.goal}`);
  }

  sections.push(`## Task\n${taskPrompt}`);

  if (contract?.scope && (contract.scope.include?.length || contract.scope.exclude?.length)) {
    const scopeLines: string[] = [];
    if (contract.scope.include?.length) {
      scopeLines.push(`- Allowed paths / include: ${contract.scope.include.join(", ")}`);
    }
    if (contract.scope.exclude?.length) {
      scopeLines.push(`- Excluded paths / do not touch: ${contract.scope.exclude.join(", ")}`);
    }
    sections.push(`## Scope\n${scopeLines.join("\n")}`);
  }

  if (contract?.acceptanceCriteria && contract.acceptanceCriteria.length > 0) {
    sections.push(`## Acceptance Criteria\n${contract.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`);
  }

  if (contract?.contextFiles && contract.contextFiles.length > 0) {
    sections.push(`## Context Files\n${contract.contextFiles.map((f) => `- ${f}`).join("\n")}`);
  }

  if (contract?.constraints && contract.constraints.length > 0) {
    sections.push(`## Constraints\n${contract.constraints.map((c) => `- ${c}`).join("\n")}`);
  }

  if (options?.memoryPaths) {
    sections.push(
      `## Working Memory & Process Journal\n` +
      `- Working Memory (current task rolling state): \`${options.memoryPaths.workingMemoryPath}\`\n` +
      `- Process Journal (historical log): \`${options.memoryPaths.processJournalPath}\`\n\n` +
      `Guidelines:\n` +
      `1. Use \`update_working_memory\` (or edit/write) to keep your rolling state checkpoint updated as you make progress. Distinguish Verified Facts from Hypotheses/Open Issues. Keep it concise (under 5000 tokens).\n` +
      `2. When completing an investigation phase or subsystem analysis within this task, record key Verified Facts (files, symbols/classes, config mappings, call chains, confirmed findings, rejected paths) into Working Memory. Subsequent document writing and analysis should directly reuse these facts instead of unconditionally re-reading source code.\n` +
      `3. If memory conflicts with current filesystem, tool results, or runtime output, current real evidence is authoritative.\n` +
      `4. Use \`append_process_journal\` to record meaningful investigation details, diagnostic evidence, and rejected hypotheses. Do NOT log routine tool calls.\n` +
      `5. Working Memory is maintained for this task and automatically re-injected after context compactions. Historical details in Process Journal remain on disk and can be searched/read on demand.`
    );
  }

  return sections.join("\n\n");
}
