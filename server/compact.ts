import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";

const SUMMARIZATION_PROMPT = `You are a context compaction assistant.
Your goal is to summarize the preceding conversation history while preserving all critical context, project architecture, key technical decisions, modified files, completed milestones, and pending tasks so that the development can seamlessly continue.

Please generate a structured, concise Markdown summary covering:
## 1. 核心需求与目标 (Core Goal & Requirements)
## 2. 关键架构与技术决策 (Architecture Decisions & Constraints)
## 3. 文件修改与已完成工作 (Changed Files & Completed Work)
## 4. 当前上下文与待办事项 (Current Context & Next Steps)

Keep the summary clear, accurate, and concise. Preserve exact file paths, function/class names, and error details.`;

export async function performSessionCompaction(
  session: AgentSession,
  modelRuntime: ModelRuntime,
  customInstructions?: string,
): Promise<{ summary: string; firstKeptEntryId: string; messagesCountAfter: number }> {
  const model = session.model;
  if (!model) {
    throw new Error("当前会话未选择可用模型，无法执行压缩");
  }

  const sessionManager = session.sessionManager;
  const pathEntries = sessionManager.getBranch();

  // 过滤出消息与压缩条目
  const contentEntries = pathEntries.filter(
    (e) => e.type === "message" || e.type === "compaction" || e.type === "custom_message",
  );

  if (contentEntries.length < 2) {
    throw new Error("当前会话历史较短，无需压缩");
  }

  // 寻找切割点：默认保留最后 1 轮完整的用户+助手交互，把之前所有漫长的调研与操作日志全部压缩
  let firstKeptIndex = -1;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    const entry = pathEntries[i];
    if (entry.type === "message" && (entry as any).message?.role === "user") {
      firstKeptIndex = i;
      break;
    }
  }

  if (firstKeptIndex <= 0) {
    firstKeptIndex = Math.max(1, pathEntries.length - 2);
  }

  const firstKeptEntry = pathEntries[firstKeptIndex];
  if (!firstKeptEntry || !firstKeptEntry.id) {
    throw new Error("无法定位有效切割点");
  }

  const entriesToSummarize = pathEntries.slice(0, firstKeptIndex);
  if (entriesToSummarize.length === 0) {
    throw new Error("无可压缩的历史条目");
  }

  // 提取历史对话内容与文件操作
  const conversationLines: string[] = [];
  const readFiles = new Set<string>();
  const modifiedFiles = new Set<string>();

  for (const entry of entriesToSummarize) {
    if (entry.type === "compaction") {
      conversationLines.push(`[Previous Summary]:\n${(entry as any).summary}\n`);
    } else if (entry.type === "message" || entry.type === "custom_message") {
      const msg = (entry as any).message;
      if (!msg) continue;
      if (msg.role === "user") {
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        conversationLines.push(`[User]: ${text}`);
      } else if (msg.role === "assistant") {
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              conversationLines.push(`[Assistant]: ${block.text}`);
            } else if (block.type === "toolCall") {
              const name = block.name || block.toolName;
              const args = block.arguments || block.input || {};
              conversationLines.push(`[Tool Call: ${name}] args: ${JSON.stringify(args)}`);
              if (name === "read" && args.path) readFiles.add(String(args.path));
              if ((name === "edit" || name === "write") && args.path) modifiedFiles.add(String(args.path));
            }
          }
        } else if (typeof msg.content === "string") {
          conversationLines.push(`[Assistant]: ${msg.content}`);
        }
      } else if (msg.role === "toolResult") {
        const rawContent = (msg as any).content;
        let resText = "";
        if (typeof rawContent === "string") {
          resText = rawContent;
        } else if (Array.isArray(rawContent)) {
          resText = rawContent
            .map((b) => (typeof b === "string" ? b : b.text || JSON.stringify(b)))
            .join("\n");
        } else {
          resText = JSON.stringify(rawContent || "");
        }
        // 限制单个 toolResult 长度，防止压缩提示词自身超限
        const preview = resText.length > 600 ? `${resText.slice(0, 600)}... [truncated]` : resText;
        conversationLines.push(`[Tool Result]: ${preview}`);
      }
    }
  }

  const conversationText = conversationLines.join("\n\n");
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${SUMMARIZATION_PROMPT}`;
  if (customInstructions?.trim()) {
    promptText += `\n\n特别补充要求：\n${customInstructions.trim()}`;
  }

  // 获取模型认证
  const authResult = await modelRuntime.getAuth(model);
  const apiKey = authResult?.auth?.apiKey;
  const headers = authResult?.auth?.headers;
  const env = authResult?.env;

  // 使用 session.agent.streamFn 直接流式调用大模型
  const stream = await session.agent.streamFn(
    model,
    {
      systemPrompt: "You are a professional software engineering AI context compaction system.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: promptText }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: apiKey ?? "",
      headers: headers ?? {},
      env,
      maxTokens: 4096,
    },
  );

  const response = await stream.result();

  if (response.stopReason === "error") {
    throw new Error(`压缩模型返回错误: ${response.errorMessage || "未知错误"}`);
  }

  let summary = (response.content || [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n")
    .trim();

  if (!summary) {
    summary = "会话历史上下文已压缩提炼。";
  }

  // 附加文件操作统计
  if (readFiles.size > 0 || modifiedFiles.size > 0) {
    summary += "\n\n### 历史涉及文件\n";
    if (readFiles.size > 0) summary += `- 读取: ${Array.from(readFiles).slice(0, 20).join(", ")}\n`;
    if (modifiedFiles.size > 0) summary += `- 修改: ${Array.from(modifiedFiles).slice(0, 20).join(", ")}\n`;
  }

  const details = {
    readFiles: Array.from(readFiles),
    modifiedFiles: Array.from(modifiedFiles),
  };

  // 写入 sessionManager compaction 实体
  sessionManager.appendCompaction(summary, firstKeptEntry.id, 0, details, false);

  // 刷新当前 session 的活跃 messages
  const sessionContext = sessionManager.buildSessionContext();
  session.agent.state.messages = sessionContext.messages;

  return {
    summary,
    firstKeptEntryId: firstKeptEntry.id,
    messagesCountAfter: sessionContext.messages.length,
  };
}
