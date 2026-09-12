import { Dialog } from "@base-ui-components/react/dialog";
import { useEffect, useMemo, useState } from "react";
import type { AgentRole, RoleConfig, RoleDefinition, UIThinkingLevel } from "../../shared/protocol";
import { saveRolesConfig, useAllTools, useInvalidateRoles, useRoleModels, useRolesConfig, useSkills } from "../lib/api";
import { useChat } from "../lib/chat";
import { useT } from "../lib/i18n";
import {
  PRODUCT_DESIGN_SKILL_NAME,
  syncProductDesignSkillAuthorization,
} from "../lib/role-config";

const inputClass =
  "w-full border-2 border-line bg-canvas px-2.5 py-1.5 font-mono text-xs text-ink outline-none placeholder:text-faint focus:border-accent";

const textareaClass =
  "w-full border-2 border-line bg-canvas p-2.5 font-mono text-xs text-ink outline-none placeholder:text-faint focus:border-accent resize-y leading-relaxed";

const ROLE_ICONS: Record<string, string> = {
  coordinator: "👑",
  developer: "💻",
  verifier: "🛡️",
  researcher: "🔬",
  default: "🤖",
};

const DEFAULT_ROLE_PRESET_TOOLS: Record<string, string[]> = {
  coordinator: [
    "read",
    "bash",
    "edit",
    "write",
    "get_task_summary",
    "list_available_roles",
    "spawn_subagent",
    "continue_subagent",
    "abort_subagent",
    "list_subagents",
  ],
  developer: ["read", "bash", "edit", "write", "report_blocker"],
  verifier: ["read", "bash", "report_blocker"],
  researcher: ["read", "bash", "report_blocker"],
  default: ["read", "bash", "edit", "write"],
};

const DEFAULT_TOOLS_CATALOG: Array<{ name: string; label: string; description: string; category: string }> = [
  { name: "read", label: "读取文件 (read)", description: "读取指定文件的文本或代码内容", category: "core" },
  { name: "bash", label: "终端命令 (bash)", description: "执行系统终端 bash 命令 (支持编译、测试、Git 及任意命令)", category: "core" },
  { name: "edit", label: "精准编辑 (edit)", description: "按文本匹配对文件进行局部精准替换", category: "core" },
  { name: "write", label: "新建/覆写 (write)", description: "创建新文件或完全重写已有文件", category: "core" },
  { name: "grep", label: "内容正则检索 (grep)", description: "Pi 原生结构化代码正则搜索（免启动 Shell，安全防爆）", category: "core" },
  { name: "find", label: "文件路径查找 (find)", description: "Pi 原生按 Glob 模式快速查找文件名与路径", category: "core" },
  { name: "ls", label: "目录清单查看 (ls)", description: "Pi 原生快速列出目录结构与文件大小", category: "core" },
  { name: "list_available_roles", label: "查询可用角色 (list_roles)", description: "查询当前支持的所有子智能体角色列表与能力", category: "subagents" },
  { name: "spawn_subagent", label: "派发子任务 (spawn_subagent)", description: "派发一个独立的异步子智能体任务并在独立工作区运行", category: "subagents" },
  { name: "continue_subagent", label: "复用 Agent (continue_subagent)", description: "复用 idle_reusable Agent 的短知识执行新 TaskContract（新 Worktree/Session）", category: "subagents" },
  { name: "abort_subagent", label: "中断子任务 (abort_subagent)", description: "取消或中断正在后台运行的子任务", category: "subagents" },
  { name: "list_subagents", label: "列出子任务 (list_subagents)", description: "列出子任务状态与可复用 Agent 信息", category: "subagents" },
  { name: "report_blocker", label: "报告阻塞情况 (report_blocker)", description: "向 Coordinator 报告关键阻塞、需求冲突或重大风险", category: "subagents" },
];

export function RolesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { data, refetch } = useRolesConfig(open);
  const { data: models = [] } = useRoleModels(open);
  const { snapshot } = useChat();
  const { data: allTools = [] } = useAllTools(snapshot?.sessionId);
  const { data: allSkills = [] } = useSkills(undefined, open, snapshot?.sessionId);
  const invalidateRoles = useInvalidateRoles();

  const [draft, setDraft] = useState<RoleConfig[] | null>(null);
  const [selectedRole, setSelectedRole] = useState<AgentRole>("coordinator");
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  // 合并后端返回的所有工具、内置基础工具清单以及已有角色中已配置的扩展工具（防丢失）
  const effectiveToolsCatalog = useMemo(() => {
    const map = new Map<string, { name: string; label: string; description: string; category: string }>();
    for (const t of DEFAULT_TOOLS_CATALOG) {
      map.set(t.name, t);
    }
    for (const t of allTools) {
      map.set(t.name, {
        name: t.name,
        label: t.label || t.name,
        description: t.description || "",
        category: t.category || "custom",
      });
    }
    // 保护：如果当前已有角色的已授权工具列表中存在自定义/扩展工具（例如冷启动时未被扫描到），也自动纳入 Catalog
    if (draft) {
      for (const r of draft) {
        const tools = r.allowedTools ?? [];
        for (const toolName of tools) {
          if (toolName && !map.has(toolName)) {
            map.set(toolName, {
              name: toolName,
              label: `${toolName} (自定义/扩展工具)`,
              description: "来自角色既有配置的自定义或插件扩展工具",
              category: "custom",
            });
          }
        }
      }
    }
    return Array.from(map.values());
  }, [allTools, draft]);

  useEffect(() => {
    if (open && data?.roles) {
      setDraft(structuredClone(data.roles));
      setStatus("idle");
      setError(null);
    }
  }, [open, data]);

  const activeRoleConfig = draft?.find((r) => r.id === selectedRole) ?? draft?.[0];

  const updateActiveRole = (updates: Partial<RoleConfig>) => {
    if (!activeRoleConfig || !draft) return;
    setDraft((prev) =>
      (prev ?? []).map((r) => {
        if (r.id !== activeRoleConfig.id) return r;
        const nextAllowedTools =
          updates.allowedTools !== undefined ? updates.allowedTools : r.allowedTools;
        const nextAllowedSkills =
          updates.allowedSkills !== undefined ? updates.allowedSkills : r.allowedSkills;
        const updated: RoleConfig = { ...r, ...updates, allowedTools: nextAllowedTools, allowedSkills: nextAllowedSkills };
        if (updated.definition) {
          updated.definition = {
            ...updated.definition,
            id: updated.id,
            name: updated.name || updated.definition.name,
            description: updated.description || updated.definition.description,
            allowedSkills: nextAllowedSkills,
            requiresWorktree:
              updated.requiresWorktree !== undefined
                ? updated.requiresWorktree
                : updated.definition.requiresWorktree,
            defaultModel: updated.model ?? updated.definition.defaultModel,
          };
        }
        return updated;
      }),
    );
  };

  const updateActiveRoleDefinition = (updates: Partial<RoleDefinition>) => {
    if (!activeRoleConfig || !draft || !activeRoleConfig.definition) return;
    setDraft((prev) =>
      (prev ?? []).map((r) => {
        if (r.id !== activeRoleConfig.id || !r.definition) return r;
        const nextDef = { ...r.definition, ...updates };
        return {
          ...r,
          name: nextDef.name || r.name,
          description: nextDef.description || r.description,
          allowedSkills: nextDef.allowedSkills ?? r.allowedSkills,
          requiresWorktree:
            nextDef.requiresWorktree !== undefined
              ? nextDef.requiresWorktree
              : r.requiresWorktree,
          definition: nextDef,
        };
      }),
    );
  };

  const currentAllowedSkills = activeRoleConfig?.allowedSkills ?? [];
  const productDesignAvailable = snapshot?.productDesignAvailable ?? false;
  const visibleSkills = useMemo(
    () => allSkills.filter((skill) => productDesignAvailable || skill.name !== PRODUCT_DESIGN_SKILL_NAME),
    [allSkills, productDesignAvailable],
  );
  const hiddenSkillNames = useMemo(
    () => allSkills
      .filter((skill) => !visibleSkills.some((visible) => visible.name === skill.name))
      .map((skill) => skill.name),
    [allSkills, visibleSkills],
  );
  const currentAllowedTools =
    activeRoleConfig?.allowedTools ??
    ["read", "bash", "edit", "write", "report_blocker"];

  const toggleTool = (toolName: string) => {
    let next: string[];
    if (currentAllowedTools.includes(toolName)) {
      next = currentAllowedTools.filter((t) => t !== toolName);
    } else {
      next = [...currentAllowedTools, toolName];
    }
    updateActiveRole({ allowedTools: next });
  };

  const toggleSkill = (skillName: string) => {
    const enabled = !currentAllowedSkills.includes(skillName);
    if (skillName === PRODUCT_DESIGN_SKILL_NAME) {
      updateActiveRole(
        syncProductDesignSkillAuthorization(currentAllowedSkills, currentAllowedTools, enabled),
      );
      return;
    }
    updateActiveRole({
      allowedSkills: enabled
        ? [...currentAllowedSkills, skillName]
        : currentAllowedSkills.filter((s) => s !== skillName),
    });
  };

  const save = async () => {
    if (!draft) return;
    setStatus("saving");
    setError(null);
    try {
      await saveRolesConfig(draft);
      await invalidateRoles();
      await refetch();
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存角色配置失败");
      setStatus("idle");
    }
  };

  const close = () => {
    onOpenChange(false);
    setStatus("idle");
    setError(null);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm animate-fade-in" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[96vw] max-w-4xl -translate-x-1/2 -translate-y-1/2 flex-col border-2 border-line bg-card shadow-[4px_4px_0_rgba(0,0,0,0.4)] outline-none animate-scale-in">
          {/* Header */}
          <div className="flex items-center justify-between border-b-2 border-line px-4 py-3 bg-canvas/50">
            <div className="flex items-center gap-2">
              <span className="text-base font-bold text-ink">🎭 角色看板与执行契约 (Role Definition V2)</span>
              <span className="text-[10px] px-1.5 py-0.5 border border-accent bg-accent/10 text-accent font-bold">
                单一真源
              </span>
            </div>
            <button
              type="button"
              onClick={close}
              className="text-muted hover:text-ink text-sm p-1 font-mono"
            >
              ✕
            </button>
          </div>

          {/* Main Body */}
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {/* 左侧角色列表 */}
            <div className="w-56 border-r-2 border-line bg-canvas/30 p-2 overflow-y-auto space-y-1 shrink-0">
              {draft?.map((role) => {
                const isSelected = role.id === (activeRoleConfig?.id ?? selectedRole);
                const icon = ROLE_ICONS[role.id] ?? "🤖";
                return (
                  <button
                    key={role.id}
                    type="button"
                    onClick={() => setSelectedRole(role.id)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left border transition-all text-xs font-mono ${
                      isSelected
                        ? "border-accent bg-accent/15 text-accent font-bold shadow-[var(--pixel-shadow-sm)]"
                        : "border-transparent text-muted hover:border-line hover:bg-canvas hover:text-ink"
                    }`}
                  >
                    <span className="text-sm">{icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{role.name}</div>
                      <div className="text-[9px] text-faint truncate font-mono">{role.id}</div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* 右侧角色配置表单 */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {activeRoleConfig ? (
                <>
                  {/* 角色基础信息 */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] font-bold text-muted">角色显示名称</span>
                      <input
                        type="text"
                        className={inputClass}
                        value={activeRoleConfig.name}
                        onChange={(e) => updateActiveRole({ name: e.target.value })}
                      />
                    </label>

                    <label className="flex flex-col gap-1 justify-end pb-1">
                      <span className="text-[11px] font-bold text-muted">Worktree 隔离执行</span>
                      <div className="flex items-center gap-2 pt-1">
                        <input
                          type="checkbox"
                          id="req-wt"
                          className="w-4 h-4 accent-accent cursor-pointer"
                          checked={activeRoleConfig.requiresWorktree ?? activeRoleConfig.definition?.requiresWorktree ?? false}
                          onChange={(e) => {
                            updateActiveRole({ requiresWorktree: e.target.checked });
                            updateActiveRoleDefinition({ requiresWorktree: e.target.checked });
                          }}
                        />
                        <label htmlFor="req-wt" className="text-xs text-ink cursor-pointer select-none">
                          派发此角色时在独立 Git 分支隔离运行
                        </label>
                      </div>
                    </label>
                  </div>

                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] font-bold text-muted">角色定位与职能描述</span>
                    <input
                      type="text"
                      className={inputClass}
                      value={activeRoleConfig.description}
                      onChange={(e) => updateActiveRole({ description: e.target.value })}
                    />
                  </label>

                  {/* 模型与思考深度 (常用配置，置于核心职责上方) */}
                  <div className="p-3 border-2 border-line bg-canvas/30 space-y-2">
                    <div className="text-[11px] font-bold text-ink">🧠 专属模型与思考深度 (Model Configuration)</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] text-faint">指定模型 (默认 inherit 继承主会话)</span>
                        <select
                          className={inputClass}
                          value={
                            activeRoleConfig.model?.modelId
                              ? `${activeRoleConfig.model.provider || ""}:${activeRoleConfig.model.modelId}`
                              : "inherit"
                          }
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val === "inherit") {
                              updateActiveRole({ model: undefined });
                            } else {
                              const [p, id] = val.split(":");
                              updateActiveRole({
                                model: {
                                  provider: p || undefined,
                                  modelId: id,
                                  thinkingLevel: activeRoleConfig.model?.thinkingLevel,
                                },
                              });
                            }
                          }}
                        >
                          <option value="inherit">默认: 继承主会话模型</option>
                          {models.map((m) => (
                            <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>
                              [{m.provider}] {m.name || m.id}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] text-faint">思考强度 (Thinking Level)</span>
                        <select
                          className={inputClass}
                          value={
                            activeRoleConfig.model?.thinkingLevel === ("none" as any)
                              ? "off"
                              : (activeRoleConfig.model?.thinkingLevel ?? "off")
                          }
                          onChange={(e) => {
                            const val = e.target.value as UIThinkingLevel;
                            updateActiveRole({
                              model: {
                                provider: activeRoleConfig.model?.provider,
                                modelId: activeRoleConfig.model?.modelId ?? "inherit",
                                thinkingLevel: val,
                              },
                            });
                          }}
                        >
                          <option value="off">关闭 / 默认 (off)</option>
                          <option value="minimal">极简思考 (minimal)</option>
                          <option value="low">低强度思考 (low)</option>
                          <option value="medium">中强度思考 (medium)</option>
                          <option value="high">深度推理思考 (high)</option>
                          <option value="xhigh">极高推理 (xhigh)</option>
                          <option value="max">满血/最大强度推理 (max)</option>
                        </select>
                      </label>
                    </div>
                  </div>

                  {/* V2 核心职责与严格禁令 */}
                  {activeRoleConfig.definition ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <label className="flex flex-col gap-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold text-emerald-600">
                            ✓ 核心职责 (Responsibilities, 每行一条)
                          </span>
                        </div>
                        <textarea
                          rows={4}
                          className={textareaClass}
                          value={activeRoleConfig.definition.responsibilities.join("\n")}
                          placeholder="每行输入一条核心职责..."
                          onChange={(e) => {
                            const lines = e.target.value.split("\n").filter((l) => l.trim().length > 0);
                            updateActiveRoleDefinition({ responsibilities: lines });
                          }}
                        />
                      </label>

                      <label className="flex flex-col gap-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold text-red-500">
                            ✕ 严格禁令 (Strict Prohibitions, 优先级高于任务)
                          </span>
                        </div>
                        <textarea
                          rows={4}
                          className={textareaClass}
                          value={activeRoleConfig.definition.strictProhibitions.join("\n")}
                          placeholder="每行输入一条严格禁令（如严禁直接修改业务代码）..."
                          onChange={(e) => {
                            const lines = e.target.value.split("\n").filter((l) => l.trim().length > 0);
                            updateActiveRoleDefinition({ strictProhibitions: lines });
                          }}
                        />
                      </label>
                    </div>
                  ) : null}

                  {/* 角色专属工作方法、流程与判断原则 (Instructions) */}
                  {activeRoleConfig.definition ? (
                    <label className="flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-bold text-accent">
                          📖 角色专属工作方法、流程与判断原则 (Role Instructions & Methodologies)
                        </span>
                        <span className="text-[10px] text-faint">
                          承载角色专属的工作方法、流程步骤与判断原则
                        </span>
                      </div>
                      <textarea
                        rows={6}
                        className={textareaClass}
                        value={activeRoleConfig.definition.instructions || ""}
                        placeholder="输入该角色专属的工作方法、流程与判断原则..."
                        onChange={(e) => updateActiveRoleDefinition({ instructions: e.target.value })}
                      />
                    </label>
                  ) : null}

                  {/* 可用工具权限复选框列表 (Allowed Tools) */}
                  <div className="border-2 border-line bg-canvas/30 p-3 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-[11px] font-bold text-ink flex items-center gap-1.5">
                          <span>🛠️ 该角色可用工具权限 (Allowed Tools)</span>
                          <span className="text-[10px] text-accent font-normal">
                            (已选 {currentAllowedTools.length} / {effectiveToolsCatalog.length} 个)
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px]">
                        <button
                          type="button"
                          onClick={() => {
                            const allNames = effectiveToolsCatalog.map((t) => t.name);
                            updateActiveRole({ allowedTools: allNames });
                          }}
                          className="px-2 py-0.5 border border-line bg-card hover:bg-canvas text-ink transition-colors"
                        >
                          全选
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            updateActiveRole({ allowedTools: [] });
                          }}
                          className="px-2 py-0.5 border border-line bg-card hover:bg-canvas text-ink transition-colors"
                        >
                          清空
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const defaultTools =
                              DEFAULT_ROLE_PRESET_TOOLS[activeRoleConfig.id] ?? [
                                "read",
                                "bash",
                                "edit",
                                "write",
                                "report_blocker",
                              ];
                            updateActiveRole({ allowedTools: [...defaultTools] });
                          }}
                          className="px-2 py-0.5 border border-line bg-card hover:bg-canvas text-accent transition-colors"
                          title="恢复为当前角色的默认工具组合"
                        >
                          恢复预设
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1">
                      {effectiveToolsCatalog.map((tool) => {
                        const isChecked = currentAllowedTools.includes(tool.name);
                        return (
                          <label
                            key={tool.name}
                            className={`flex items-start gap-2.5 border p-2.5 cursor-pointer transition-all ${
                              isChecked
                                ? "border-accent/80 bg-accent/10 shadow-[var(--pixel-shadow-sm)]"
                                : "border-line bg-card/60 opacity-75 hover:opacity-100"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleTool(tool.name)}
                              className="size-4 accent-accent mt-0.5 shrink-0"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between text-xs font-bold">
                                <span className={isChecked ? "text-accent font-mono" : "text-ink font-mono"}>
                                  {tool.label || tool.name}
                                </span>
                                <span className="text-[9px] px-1 py-0.5 border border-line bg-canvas text-faint uppercase font-mono">
                                  {tool.category || "tool"}
                                </span>
                              </div>
                              {tool.description && (
                                <div className="text-[11px] text-muted leading-relaxed mt-0.5">
                                  {tool.description}
                                </div>
                              )}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                  {/* 专属业务技能复选框列表 */}
                  <div className="border-2 border-line bg-canvas/30 p-3 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-[11px] font-bold text-ink flex items-center gap-1.5">
                          <span>⚡ 该角色专有业务技能 (Assigned Skills)</span>
                          <span className="text-[10px] text-accent font-normal">
                            (已选 {currentAllowedSkills.filter((name) => visibleSkills.some((skill) => skill.name === name)).length} / {visibleSkills.length} 个)
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px]">
                        <button
                          type="button"
                          onClick={() => updateActiveRole({ allowedSkills: [...new Set([...currentAllowedSkills.filter((name) => hiddenSkillNames.includes(name)), ...visibleSkills.map((s) => s.name)])] })}
                          className="px-2 py-0.5 border border-line bg-card hover:bg-canvas text-ink transition-colors"
                        >
                          全选
                        </button>
                        <button
                          type="button"
                          onClick={() => updateActiveRole({ allowedSkills: currentAllowedSkills.filter((name) => hiddenSkillNames.includes(name)) })}
                          className="px-2 py-0.5 border border-line bg-card hover:bg-canvas text-ink transition-colors"
                        >
                          清空
                        </button>
                      </div>
                    </div>

                    {visibleSkills.length > 0 ? (
                      <div className="grid grid-cols-1 gap-2 pt-1">
                        {visibleSkills.map((skill) => {
                          const isChecked = currentAllowedSkills.includes(skill.name);
                          return (
                            <label
                              key={skill.name}
                              className={`flex items-start gap-2.5 border p-2.5 cursor-pointer transition-all ${
                                isChecked
                                  ? "border-accent/80 bg-accent/10 shadow-[var(--pixel-shadow-sm)]"
                                  : "border-line bg-card/60 opacity-75 hover:opacity-100"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleSkill(skill.name)}
                                className="size-4 accent-accent mt-0.5 shrink-0"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between text-xs font-bold">
                                  <span className={isChecked ? "text-accent" : "text-ink"}>
                                    📦 {skill.name}
                                  </span>
                                  <span className="text-[9px] px-1 py-0.5 border border-line bg-canvas text-accent uppercase font-mono">
                                    {skill.scope === "project" ? "项目级" : "全局"}
                                  </span>
                                </div>
                                <div className="text-[11px] text-muted leading-relaxed mt-1">
                                  {skill.description}
                                </div>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="text-xs text-faint py-3 text-center border border-dashed border-line">
                        暂未在 .agents/skills 或 ~/.pi/agent/skills 中发现可用技能
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="py-12 text-center text-faint text-xs">请选择左侧角色进行配置</div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t-2 border-line px-4 py-3 bg-canvas/30">
            <div className="text-xs">
              {error ? (
                <span className="text-red-500 font-bold">{error}</span>
              ) : status === "saved" ? (
                <span className="text-emerald-600 font-bold">✓ 角色看板配置已成功保存并即时生效</span>
              ) : (
                <span className="text-faint text-[11px]">配置文件路径: {data?.path ?? "~/.pi/agent/roles.json"}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={close}
                className="border-2 border-transparent px-3 py-1.5 font-mono text-xs text-muted hover:border-line hover:bg-hover hover:text-ink"
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={status === "saving" || draft === null}
                className="border-2 border-accent bg-accent px-4 py-1.5 font-mono text-xs font-bold text-accent-ink shadow-[2px_2px_0_rgba(119,68,180,0.3)] transition-all hover:translate-x-[1px] hover:translate-y-[1px] disabled:opacity-40"
              >
                {status === "saving" ? t("saving") : "保存并应用"}
              </button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
