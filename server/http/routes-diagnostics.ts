import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import type {
  UIPromptInspection,
  UIThinkingLevel,
  UIToolItem,
  UIToolSchema,
} from "../../shared/protocol.ts";
import { buildWorkspaceContextPrompt, getAllRoleConfigs, getRoleConfig } from "../roles.ts";
import { serializeMessages } from "../serialize.ts";
import type { SessionEntry } from "../session/session-registry.ts";
import { buildSnapshot } from "../session/snapshot.ts";
import { discoverAllSkills } from "../skills.ts";
import {
  canUseProductDesign,
  getMainSessionCapabilities,
  PRODUCT_DESIGN_IMAGEGEN_TOOL_NAME,
  PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME,
  PRODUCT_DESIGN_SKILL_NAME,
} from "../session/capabilities.ts";
import { resolveProjectRoot } from "../worktree.ts";
import type { ServerContext } from "./context.ts";

export async function handleDiagnosticsRoutes(
  url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<boolean> {
  const { sessionRegistry, subagentManager } = ctx;
  const entries = sessionRegistry.entries;

  if (url.pathname === "/api/tools") {
    const anyEntry = entries.values().next().value as SessionEntry | undefined;
    const toolsMap = new Map<string, UIToolItem>();

    // 核心基础工具 (Pi 官方内置)
    toolsMap.set("read", { name: "read", label: "读取文件 (read)", description: "读取指定文件的文本或代码内容", category: "core" });
    toolsMap.set("bash", { name: "bash", label: "终端命令 (bash)", description: "执行系统终端 bash 命令 (支持编译、测试、Git 及任意命令)", category: "core" });
    toolsMap.set("edit", { name: "edit", label: "精准编辑 (edit)", description: "按文本匹配对文件进行局部精准替换", category: "core" });
    toolsMap.set("write", { name: "write", label: "新建/覆写 (write)", description: "创建新文件或完全重写已有文件", category: "core" });
    toolsMap.set("grep", { name: "grep", label: "内容正则检索 (grep)", description: "Pi 原生结构化代码正则搜索（免启动 Shell，安全防爆）", category: "core" });
    toolsMap.set("find", { name: "find", label: "文件路径查找 (find)", description: "Pi 原生按 Glob 模式快速查找文件名与路径", category: "core" });
    toolsMap.set("ls", { name: "ls", label: "目录清单查看 (ls)", description: "Pi 原生快速列出目录结构与文件大小", category: "core" });

    // 统筹者与子智能体协作工具
    toolsMap.set("list_available_roles", { name: "list_available_roles", label: "查询可用角色 (list_roles)", description: "查询当前支持的所有子智能体角色列表与能力", category: "subagents" });
    toolsMap.set("spawn_subagent", { name: "spawn_subagent", label: "派发子任务 (spawn_subagent)", description: "派发一个独立的异步子智能体任务并在独立工作区运行", category: "subagents" });
    toolsMap.set("continue_subagent", { name: "continue_subagent", label: "复用 Agent (continue_subagent)", description: "复用 idle_reusable Agent 的短知识执行新 TaskContract（新 Worktree/Session）", category: "subagents" });
    toolsMap.set("abort_subagent", { name: "abort_subagent", label: "中断子任务 (abort_subagent)", description: "取消或中断正在后台运行的子任务", category: "subagents" });
    toolsMap.set("list_subagents", { name: "list_subagents", label: "列出子任务 (list_subagents)", description: "列出子任务状态与可复用 Agent 信息", category: "subagents" });
    toolsMap.set("report_blocker", { name: "report_blocker", label: "报告阻塞情况 (report_blocker)", description: "向 Coordinator 报告关键阻塞、需求冲突或重大风险", category: "subagents" });

    // 测试与发布专属工具
    toolsMap.set("apit_send_api_event", {
      name: "apit_send_api_event",
      label: "API测试事件 (apit_event)",
      description: "发送或预览接口测试事件到 Kafka (来自 apiautotest 扩展)",
      category: "custom",
    });
    toolsMap.set("apit_send_performance_events", {
      name: "apit_send_performance_events",
      label: "性能压测 (apit_perf)",
      description: "执行自动化性能/负载测试场景 (来自 apiautotest 扩展)",
      category: "custom",
    });
    toolsMap.set("release_apiv3_monitor", {
      name: "release_apiv3_monitor",
      label: "发布流水线 (release_apiv3)",
      description: "执行 monitor-refactor 项目的发布流水线步骤 (来自 release-apiv3 扩展)",
      category: "custom",
    });

    // 如果有运行中的 session，收集所有动态注册的扩展工具
    if (anyEntry) {
      const productDesignAvailable = canUseProductDesign(
        getMainSessionCapabilities(anyEntry.runtime.session.model),
      );
      for (const t of anyEntry.runtime.session.getAllTools()) {
        if (
          !productDesignAvailable &&
          (t.name === PRODUCT_DESIGN_IMAGEGEN_TOOL_NAME || t.name === PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME)
        ) {
          continue;
        }
        if (!toolsMap.has(t.name)) {
          toolsMap.set(t.name, {
            name: t.name,
            label: (t as { label?: string }).label || t.name,
            description: t.description || "",
            category: "custom",
          });
        }
      }
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.from(toolsMap.values())));
    return true;
  }

  if (url.pathname === "/api/skills") {
    const anyEntry = entries.values().next().value as SessionEntry | undefined;
    const cwd = url.searchParams.get("cwd") || anyEntry?.cwd;
    const productDesignAvailable = anyEntry
      ? canUseProductDesign(getMainSessionCapabilities(anyEntry.runtime.session.model))
      : false;
    const skills = discoverAllSkills(cwd).filter(
      (skill) => productDesignAvailable || skill.name !== PRODUCT_DESIGN_SKILL_NAME,
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ skills }));
    return true;
  }

  if (url.pathname === "/api/prompt-inspector") {
    const sessionId = url.searchParams.get("session");
    let entry = sessionId ? entries.get(sessionId) : undefined;
    if (!entry && entries.size > 0) {
      entry = entries.values().next().value;
    }
    if (!entry) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no active session" }));
      return true;
    }

    const session = entry.runtime.session;
    const role = entry.activeRole;
    const roleConfig = getRoleConfig(role);
    const projectInfo = await resolveProjectRoot(entry.cwd);
    const workspacePrompt = buildWorkspaceContextPrompt({
      cwd: entry.cwd,
      projectRoot: projectInfo.projectRoot,
      isCoordinator: role === "coordinator",
      branchName: entry.gitBranch ?? projectInfo.branch ?? undefined,
      isWorktree: projectInfo.isWorktree,
    });

    const activeToolNames = new Set(session.getActiveToolNames());
    const allTools = session.getAllTools();
    const tools: UIToolSchema[] = allTools
      .filter((t) => activeToolNames.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: (t.parameters ?? {}) as Record<string, unknown>,
        promptGuidelines: t.promptGuidelines,
      }));

    const systemPrompt = session.systemPrompt;
    const messages = serializeMessages(session.messages);

    const sysChars = systemPrompt.length;
    const msgChars = JSON.stringify(messages).length;
    const toolsChars = JSON.stringify(tools).length;
    const estimatedTokens = {
      systemPrompt: Math.round(sysChars / 3.5),
      messages: Math.round(msgChars / 3.5),
      tools: Math.round(toolsChars / 3.5),
      total: Math.round((sysChars + msgChars + toolsChars) / 3.5),
    };

    const roles = getAllRoleConfigs();

    const resp: UIPromptInspection = {
      systemPrompt,
      rolePrompt: roleConfig.systemPrompt,
      workspacePrompt,
      activeRole: role,
      cwd: entry.cwd,
      cwdName: basename(entry.cwd),
      gitBranch: entry.gitBranch,
      model: session.model
        ? {
            provider: session.model.provider,
            id: session.model.id,
            name: (session.model as { name?: string }).name,
            reasoning: (session.model as { reasoning?: boolean }).reasoning,
          }
        : null,
      thinkingLevel: session.thinkingLevel as UIThinkingLevel,
      messages,
      rawMessagesCount: session.messages.length,
      tools,
      estimatedTokens,
      subagentRoles: roles.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        systemPrompt: r.systemPrompt,
        model: r.model,
      })),
    };

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(resp));
    return true;
  }

  if (url.pathname === "/api/state") {
    const requested = url.searchParams.get("session");
    const entry = requested ? entries.get(requested) : undefined;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        entry
          ? buildSnapshot(entry, subagentManager)
          : {
              activeSessions: [...entries.values()].map((e) => ({
                id: e.id,
                clients: e.clients.size,
                isStreaming: e.runtime.session.isStreaming,
              })),
            },
      ),
    );
    return true;
  }

  return false;
}
