import { Dialog } from "@base-ui-components/react/dialog";
import { useMemo, useState } from "react";
import type { UIPromptInspection, UIToolSchema } from "../../shared/protocol";
import { usePromptInspection } from "../lib/api";
import { useChat } from "../lib/chat";

type InspectorTab = "payload" | "system" | "messages" | "tools" | "roles";

export function PromptInspectorModal({
  open,
  onOpenChange,
  sessionId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId?: string | null;
}) {
  const { data, isLoading, refetch } = usePromptInspection(sessionId, open);
  const { snapshot } = useChat();
  const [activeTab, setActiveTab] = useState<InspectorTab>("payload");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [selectedSubagentRole, setSelectedSubagentRole] = useState<string>("coordinator");
  const [rawMessagesMode, setRawMessagesMode] = useState<boolean>(false);
  const [selectedTurnIndex, setSelectedTurnIndex] = useState<number>(-1); // -1 = latest all messages

  const copyText = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const tokens = data?.estimatedTokens ?? {
    systemPrompt: 0,
    messages: 0,
    tools: 0,
    total: 0,
  };

  // 计算会话中的所有用户请求轮次 (Turn)
  const userTurns = useMemo(() => {
    const msgs = data?.messages ?? [];
    const turns: { index: number; msgIndex: number; preview: string }[] = [];
    let count = 0;
    msgs.forEach((m, idx) => {
      if (m.role === "user") {
        count++;
        const textBlock = m.content.find((c) => c.type === "text");
        const preview = textBlock?.text ? textBlock.text.slice(0, 32).replace(/\n/g, " ") : `提问 #${count}`;
        turns.push({
          index: count,
          msgIndex: idx,
          preview: preview.length >= 32 ? `${preview}...` : preview,
        });
      }
    });
    return turns;
  }, [data?.messages]);

  // 根据选中的轮次计算会话上下文消息切片
  const effectiveMessages = useMemo(() => {
    const msgs = data?.messages ?? [];
    if (selectedTurnIndex === -1 || userTurns.length === 0) {
      return msgs;
    }
    const targetTurn = userTurns[selectedTurnIndex];
    if (!targetTurn) return msgs;
    return msgs.slice(0, targetTurn.msgIndex + 1);
  }, [data?.messages, selectedTurnIndex, userTurns]);

  // 构造会话上下文估算 JSON（非 Provider 最终 Request）
  const fullLlmPayload = useMemo(() => {
    if (!data) return null;
    return {
      request_info: {
        model: data.model ? `${data.model.provider}/${data.model.id}` : "default",
        thinking_level: data.thinkingLevel ?? "none",
        active_role: data.activeRole,
        cwd: data.cwd,
        git_branch: data.gitBranch ?? null,
      },
      system_prompt: data.systemPrompt,
      messages: effectiveMessages.map((m) => ({
        role: m.role,
        content: m.content.map((c) => {
          if (c.type === "text") return { type: "text", text: c.text };
          if (c.type === "thinking") return { type: "thinking", text: c.text };
          if (c.type === "toolCall") {
            return {
              type: "tool_call",
              id: c.id,
              name: c.name,
              arguments: c.args,
              result: c.result,
            };
          }
          return c;
        }),
      })),
      tools: data.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    };
  }, [data, effectiveMessages]);

  const fullPayloadJson = useMemo(() => {
    if (!fullLlmPayload) return "";
    return JSON.stringify(fullLlmPayload, null, 2);
  }, [fullLlmPayload]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-xs transition-opacity z-50" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 flex h-[90vh] w-[95vw] max-w-5xl -translate-x-1/2 -translate-y-1/2 flex-col border-2 border-line-bright bg-card font-mono shadow-[var(--pixel-shadow)] outline-none z-50">
          {/* 顶栏 */}
          <div className="border-b-2 border-line px-4 py-3 flex items-center justify-between bg-card shrink-0">
            <div className="flex items-center gap-3">
              <div className="flex size-7 shrink-0 items-center justify-center border border-accent bg-purple-dark text-sm text-accent">
                👁️
              </div>
              <div>
                <Dialog.Title className="text-sm font-black tracking-wide text-ink flex items-center gap-2">
                  <span>SESSION CONTEXT VIEW</span>
                  <span className="text-[10px] font-normal text-amber-500 bg-amber-500/10 px-1.5 py-0.5 border border-amber-500/30 rounded">
                    估算的 Provider 上下文
                  </span>
                </Dialog.Title>
                <Dialog.Description className="text-[11px] text-faint mt-0.5">
                  基于当前会话状态估算，不是真正发往 Provider 之前拦截到的最终 Request Payload
                </Dialog.Description>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void refetch()}
                title="重新获取最新会话上下文"
                className="flex items-center gap-1 border border-line bg-canvas px-2 py-1 text-xs text-muted hover:border-accent hover:text-ink transition-colors"
              >
                <span>🔄 刷新</span>
              </button>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="flex size-7 items-center justify-center border border-line text-faint hover:border-line-bright hover:bg-hover hover:text-ink text-sm font-bold"
              >
                ✕
              </button>
            </div>
          </div>

          {/* 统计指标与当前模型概览 */}
          <div className="border-b border-line bg-canvas-subtle px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-faint">当前环境:</span>
              <span className="bg-canvas px-1.5 py-0.5 border border-line text-ink font-semibold">
                📁 {data?.cwdName || snapshot?.cwdName || "workspace"}
              </span>
              {data?.gitBranch && (
                <span className="bg-canvas px-1.5 py-0.5 border border-line text-accent">
                  🌿 {data.gitBranch}
                </span>
              )}
              <span className="bg-purple-dark px-1.5 py-0.5 border border-accent/40 text-accent font-bold">
                🎭 {data?.activeRole || snapshot?.activeRole || "coordinator"}
              </span>
              {data?.model && (
                <span className="bg-canvas px-1.5 py-0.5 border border-line text-muted">
                  🤖 {data.model.provider}/{data.model.id} ({data.thinkingLevel})
                </span>
              )}
            </div>

            {/* Token 预估 */}
            <div className="flex items-center gap-3 font-mono text-[11px]">
              <span className="text-faint">
                系统词: <strong className="text-ink">~{tokens.systemPrompt}</strong> tok
              </span>
              <span className="text-faint">
                上下文: <strong className="text-ink">~{tokens.messages}</strong> tok
              </span>
              <span className="text-faint">
                工具: <strong className="text-ink">~{tokens.tools}</strong> tok
              </span>
              <span className="border-l border-line pl-2 font-bold text-accent">
                总计: ~{tokens.total} tokens
              </span>
            </div>
          </div>

          {/* 选项卡导航 */}
          <div className="flex items-center gap-1 border-b-2 border-line bg-canvas px-3 pt-2 shrink-0">
            <TabButton
              active={activeTab === "payload"}
              onClick={() => setActiveTab("payload")}
              icon="📦"
              label="估算上下文 JSON (Estimated Context)"
              badge="非最终请求"
            />
            <TabButton
              active={activeTab === "system"}
              onClick={() => setActiveTab("system")}
              icon="🌟"
              label="系统提示词 (System Prompt)"
              badge={`~${tokens.systemPrompt} tok`}
            />
            <TabButton
              active={activeTab === "messages"}
              onClick={() => setActiveTab("messages")}
              icon="💬"
              label="上下文消息 (Messages)"
              badge={`${data?.messages.length ?? 0} 条`}
            />
            <TabButton
              active={activeTab === "tools"}
              onClick={() => setActiveTab("tools")}
              icon="🛠️"
              label="工具 Schema (Tools)"
              badge={`${data?.tools.length ?? 0} 个`}
            />
            <TabButton
              active={activeTab === "roles"}
              onClick={() => setActiveTab("roles")}
              icon="👥"
              label="全角色预置库 (Roles)"
              badge={`${data?.subagentRoles?.length ?? 0} 个`}
            />
          </div>

          {/* 选项卡内容区 */}
          <div className="thin-scroll flex-1 overflow-y-auto p-4 bg-canvas">
            {isLoading ? (
              <div className="flex h-64 items-center justify-center text-xs text-faint">
                <span className="animate-pulse">正在提取会话上下文估算...</span>
              </div>
            ) : !data ? (
              <div className="flex h-64 items-center justify-center text-xs text-faint">
                暂无活动会话提示词数据
              </div>
            ) : (
              <>
                {/* 选项卡 0: 发送给大模型的全量 Request Payload JSON */}
                {activeTab === "payload" && (
                  <div className="space-y-3">
                    {/* 轮次选择与操作栏 */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2.5">
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="text-faint">查看轮次:</span>
                        <button
                          type="button"
                          onClick={() => setSelectedTurnIndex(-1)}
                          className={`px-2 py-0.5 border text-xs font-bold transition-colors ${
                            selectedTurnIndex === -1
                              ? "border-accent bg-purple-dark text-accent"
                              : "border-line bg-card text-muted hover:text-ink"
                          }`}
                        >
                          最新估算上下文 (Latest)
                        </button>
                        {userTurns.map((turn, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => setSelectedTurnIndex(i)}
                            className={`px-2 py-0.5 border text-xs font-bold transition-colors ${
                              selectedTurnIndex === i
                                ? "border-accent bg-purple-dark text-accent"
                                : "border-line bg-card text-muted hover:text-ink"
                            }`}
                            title={`第 ${turn.index} 轮提问: ${turn.preview}`}
                          >
                            第 {turn.index} 轮提问
                          </button>
                        ))}
                      </div>

                      <button
                        type="button"
                        onClick={() => copyText("fullPayload", fullPayloadJson)}
                        className="flex items-center gap-1.5 border-2 border-line bg-card px-3 py-1 text-xs font-bold text-ink hover:border-accent hover:text-accent transition-colors shadow-[var(--pixel-shadow-sm)]"
                      >
                        <span>{copiedKey === "fullPayload" ? "✓ 已复制估算上下文 JSON" : "📋 复制估算上下文 JSON"}</span>
                      </button>
                    </div>

                    <div className="text-[11px] text-faint flex items-center justify-between">
                      <span>
                        以下为当前会话的<strong>估算 Provider 上下文</strong>（System / Messages / Tools）。Tool Result 来自会话记录，不等于 adapter 发出的最终 HTTP body：
                      </span>
                      <span>共 {effectiveMessages.length} 条消息 · {data.tools.length} 个工具</span>
                    </div>

                    {/* 完整 JSON 展示 */}
                    <pre className="thin-scroll max-h-[580px] overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-ink bg-card p-4 border-2 border-line selection:bg-accent selection:text-white">
                      {fullPayloadJson}
                    </pre>
                  </div>
                )}

                {/* 选项卡 1: 系统提示词 */}
                {activeTab === "system" && (
                  <div className="space-y-4">
                    {/* 操作栏 */}
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-muted">
                        包含：<strong>基础运行环境</strong> + <strong>角色约束</strong> + <strong>工作区路径</strong>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyText("systemPrompt", data.systemPrompt)}
                        className="flex items-center gap-1.5 border-2 border-line bg-card px-2.5 py-1 text-xs font-bold text-ink hover:border-accent hover:text-accent transition-colors"
                      >
                        <span>{copiedKey === "systemPrompt" ? "✓ 已复制到剪贴板" : "📋 复制完整 System Prompt"}</span>
                      </button>
                    </div>

                    {/* 模块分解卡片 */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {/* 角色专项约束 */}
                      {data.rolePrompt && (
                        <div className="border border-line bg-card p-3 space-y-1.5">
                          <div className="flex items-center justify-between text-xs font-bold text-accent">
                            <span>🎭 当前角色约束 ({data.activeRole})</span>
                            <button
                              type="button"
                              onClick={() => copyText("rolePrompt", data.rolePrompt!)}
                              className="text-[11px] text-faint hover:text-ink"
                            >
                              {copiedKey === "rolePrompt" ? "✓ 已复制" : "复制"}
                            </button>
                          </div>
                          <pre className="thin-scroll max-h-48 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted bg-canvas p-2 border border-line">
                            {data.rolePrompt}
                          </pre>
                        </div>
                      )}

                      {/* 工作区环境注入 */}
                      {data.workspacePrompt && (
                        <div className="border border-line bg-card p-3 space-y-1.5">
                          <div className="flex items-center justify-between text-xs font-bold text-accent">
                            <span>📁 工作区环境上下文注入</span>
                            <button
                              type="button"
                              onClick={() => copyText("workspacePrompt", data.workspacePrompt!)}
                              className="text-[11px] text-faint hover:text-ink"
                            >
                              {copiedKey === "workspacePrompt" ? "✓ 已复制" : "复制"}
                            </button>
                          </div>
                          <pre className="thin-scroll max-h-48 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted bg-canvas p-2 border border-line">
                            {data.workspacePrompt}
                          </pre>
                        </div>
                      )}
                    </div>

                    {/* 完整合并 System Prompt 文本 */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-ink">
                          📄 会话当前 System Prompt 原文:
                        </span>
                        <span className="text-[11px] text-faint">
                          共 {data.systemPrompt.length} 字符 (~{tokens.systemPrompt} tokens)
                        </span>
                      </div>
                      <pre className="thin-scroll max-h-[460px] overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-ink bg-card p-3.5 border-2 border-line selection:bg-accent selection:text-white">
                        {data.systemPrompt}
                      </pre>
                    </div>
                  </div>
                )}

                {/* 选项卡 2: 上下文消息列表 */}
                {activeTab === "messages" && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted">
                          当前会话共有 <strong>{data.messages.length}</strong> 条上下文消息
                        </span>
                        <button
                          type="button"
                          onClick={() => setRawMessagesMode(!rawMessagesMode)}
                          className="border border-line px-2 py-0.5 text-[11px] text-faint hover:text-ink hover:border-accent"
                        >
                          {rawMessagesMode ? "切换为可视视图" : "切换为 Raw JSON"}
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyText("messagesJson", JSON.stringify(data.messages, null, 2))}
                        className="flex items-center gap-1.5 border-2 border-line bg-card px-2.5 py-1 text-xs font-bold text-ink hover:border-accent hover:text-accent transition-colors"
                      >
                        <span>{copiedKey === "messagesJson" ? "✓ 已复制 JSON" : "📋 复制完整消息 JSON"}</span>
                      </button>
                    </div>

                    {rawMessagesMode ? (
                      <pre className="thin-scroll max-h-[500px] overflow-y-auto font-mono text-xs text-ink bg-card p-3.5 border-2 border-line">
                        {JSON.stringify(data.messages, null, 2)}
                      </pre>
                    ) : (
                      <div className="space-y-2">
                        {data.messages.map((m, idx) => (
                          <div
                            key={idx}
                            className={`border-2 p-3 space-y-1.5 font-mono text-xs ${
                              m.role === "user"
                                ? "border-accent/40 bg-accent/5"
                                : m.role === "assistant"
                                ? "border-line bg-card"
                                : "border-line/60 bg-canvas-subtle"
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span
                                className={`px-1.5 py-0.5 text-[10px] font-bold uppercase rounded ${
                                  m.role === "user"
                                    ? "bg-accent text-white"
                                    : m.role === "assistant"
                                    ? "bg-purple-dark text-accent border border-accent/30"
                                    : "bg-canvas text-muted border border-line"
                                }`}
                              >
                                #{idx + 1} {m.role}
                              </span>
                              <button
                                type="button"
                                onClick={() => copyText(`msg_${idx}`, JSON.stringify(m.content, null, 2))}
                                className="text-[11px] text-faint hover:text-ink"
                              >
                                {copiedKey === `msg_${idx}` ? "✓ 已复制" : "复制"}
                              </button>
                            </div>

                            <div className="space-y-1 pt-1">
                              {m.content.map((b, bIdx) => (
                                <div key={bIdx} className="text-xs">
                                  {b.type === "text" && (
                                    <div className="whitespace-pre-wrap text-ink leading-relaxed">
                                      {b.text}
                                    </div>
                                  )}
                                  {b.type === "thinking" && (
                                    <div className="rounded bg-canvas p-2 text-faint italic border border-line/60">
                                      <span className="text-[10px] font-bold not-italic text-accent">
                                        💭 思考过程 (Thinking):
                                      </span>
                                      <div className="whitespace-pre-wrap mt-0.5 text-[11px]">
                                        {b.text}
                                      </div>
                                    </div>
                                  )}
                                  {b.type === "toolCall" && (
                                    <div className="rounded bg-canvas p-2 border border-line text-[11px]">
                                      <div className="font-bold text-accent">
                                        ⚡ Tool Call: <code>{b.name}</code> (id: {b.id})
                                      </div>
                                      <pre className="mt-1 max-h-36 overflow-y-auto text-[10px] text-muted">
                                        {JSON.stringify(b.args, null, 2)}
                                      </pre>
                                      {b.result && (
                                        <div className="mt-1.5 border-t border-line/60 pt-1 text-[10px] text-faint">
                                          <span className="font-semibold text-ink">Result: </span>
                                          <pre className="max-h-36 overflow-y-auto whitespace-pre-wrap">
                                            {b.result.text}
                                          </pre>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* 选项卡 3: 可用工具定义 Schema */}
                {activeTab === "tools" && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted">
                        共向大模型注入了 <strong>{data.tools.length}</strong> 个可调用的工具 Schema
                      </span>
                      <button
                        type="button"
                        onClick={() => copyText("toolsJson", JSON.stringify(data.tools, null, 2))}
                        className="flex items-center gap-1.5 border-2 border-line bg-card px-2.5 py-1 text-xs font-bold text-ink hover:border-accent hover:text-accent transition-colors"
                      >
                        <span>{copiedKey === "toolsJson" ? "✓ 已复制 Tools" : "📋 复制完整 Tools Schema"}</span>
                      </button>
                    </div>

                    <div className="grid grid-cols-1 gap-3">
                      {data.tools.map((tool) => (
                        <ToolSchemaCard
                          key={tool.name}
                          tool={tool}
                          onCopy={(text) => copyText(`tool_${tool.name}`, text)}
                          copied={copiedKey === `tool_${tool.name}`}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* 选项卡 4: 全角色预置提示词库 */}
                {activeTab === "roles" && (
                  <div className="space-y-4">
                    <div className="text-xs text-muted">
                      查看各子任务角色（前端、后端、全栈、统筹者等）所使用的独立提示词规范与模型配置：
                    </div>

                    {/* 角色切换按钮组 */}
                    <div className="flex flex-wrap gap-1.5">
                      {data.subagentRoles?.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => setSelectedSubagentRole(r.id)}
                          className={`px-2.5 py-1 text-xs font-bold border transition-colors ${
                            selectedSubagentRole === r.id
                              ? "border-accent bg-purple-dark text-accent shadow-[var(--pixel-shadow-sm)]"
                              : "border-line bg-card text-muted hover:border-line-bright hover:text-ink"
                          }`}
                        >
                          {r.name}
                        </button>
                      ))}
                    </div>

                    {/* 选中角色的提示词详情 */}
                    {(() => {
                      const cur = data.subagentRoles?.find((r) => r.id === selectedSubagentRole);
                      if (!cur) return null;
                      return (
                        <div className="border-2 border-line bg-card p-4 space-y-3">
                          <div className="flex items-center justify-between border-b border-line pb-2">
                            <div>
                              <div className="text-sm font-bold text-ink flex items-center gap-2">
                                <span>{cur.name}</span>
                                <code className="text-xs text-accent">({cur.id})</code>
                              </div>
                              <div className="text-xs text-faint mt-0.5">{cur.description}</div>
                              {cur.model && (
                                <div className="text-[11px] text-accent mt-1">
                                  ⚡ 默认绑定模型: <code>{cur.model.provider ? `${cur.model.provider}/` : ""}{cur.model.modelId}</code> ({cur.model.thinkingLevel ?? "default"})
                                </div>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => copyText(`role_${cur.id}`, cur.systemPrompt)}
                              className="border border-line bg-canvas px-2.5 py-1 text-xs font-semibold text-muted hover:border-accent hover:text-ink"
                            >
                              {copiedKey === `role_${cur.id}` ? "✓ 已复制" : "📋 复制该角色 Prompt"}
                            </button>
                          </div>

                          <div>
                            <span className="text-xs font-bold text-ink">System Prompt 提示词内容:</span>
                            <pre className="thin-scroll max-h-96 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-ink bg-canvas p-3 border border-line mt-1 leading-relaxed">
                              {cur.systemPrompt || "（此角色无特定额外系统提示词，使用基础开发提示词）"}
                            </pre>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </>
            )}
          </div>

          {/* 底栏 */}
          <div className="border-t-2 border-line bg-card px-4 py-2.5 flex items-center justify-between shrink-0 font-mono text-xs">
            <span className="text-[11px] text-faint">
              💡 提示：此面板展示实际组装发往大语言模型的全量请求内容，支持分轮次追溯与一键复制。
            </span>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="border-2 border-line bg-canvas px-4 py-1 font-bold text-ink hover:border-accent hover:text-accent"
            >
              关闭
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  label: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 border-t-2 border-x-2 px-3 py-1.5 text-xs font-bold transition-colors ${
        active
          ? "border-accent bg-card text-accent -mb-[2px] z-10"
          : "border-transparent text-muted hover:text-ink hover:bg-hover"
      }`}
    >
      <span>{icon}</span>
      <span>{label}</span>
      {badge && (
        <span
          className={`rounded px-1.5 py-0.2 text-[10px] ${
            active ? "bg-accent/15 text-accent" : "bg-canvas-subtle text-faint"
          }`}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function ToolSchemaCard({
  tool,
  onCopy,
  copied,
}: {
  tool: UIToolSchema;
  onCopy: (json: string) => void;
  copied: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const jsonStr = JSON.stringify(tool.parameters, null, 2);

  return (
    <div className="border border-line bg-card p-3 space-y-2 font-mono">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-accent">⚡ {tool.name}</span>
          <span className="text-xs text-faint">— {tool.description}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onCopy(jsonStr)}
            className="text-[11px] text-faint hover:text-ink"
          >
            {copied ? "✓ 已复制 Schema" : "复制 Schema"}
          </button>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="text-[11px] text-accent hover:underline"
          >
            {expanded ? "收起" : "展开 Schema"}
          </button>
        </div>
      </div>

      {tool.promptGuidelines && tool.promptGuidelines.length > 0 && (
        <div className="text-[11px] text-muted bg-canvas-subtle p-2 border border-line/60">
          <div className="font-semibold text-ink text-[10px]">Guidelines:</div>
          <ul className="list-disc list-inside space-y-0.5 mt-0.5">
            {tool.promptGuidelines.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </div>
      )}

      {expanded && (
        <pre className="thin-scroll max-h-48 overflow-y-auto text-[11px] text-muted bg-canvas p-2.5 border border-line">
          {jsonStr}
        </pre>
      )}
    </div>
  );
}
