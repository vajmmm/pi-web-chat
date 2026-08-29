import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { UILLMToolDefinition, UILLMTurnRecord } from "../shared/protocol.ts";

const memoryTurns = new Map<string, UILLMTurnRecord[]>();

function turnsDir(): string {
  const dir = join(getAgentDir(), "session-turns");
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  return dir;
}

function turnFilePath(sessionId: string): string {
  // Sanitize sessionId for filename safety
  const safeId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(turnsDir(), `${safeId}.json`);
}

function loadPersistedTurns(sessionId: string): UILLMTurnRecord[] {
  try {
    const file = turnFilePath(sessionId);
    if (!existsSync(file)) return [];
    const content = readFileSync(file, "utf8");
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function persistTurns(sessionId: string, turns: UILLMTurnRecord[]): void {
  try {
    const file = turnFilePath(sessionId);
    writeFileSync(file, JSON.stringify(turns, null, 2), "utf8");
  } catch (err) {
    console.warn(`[TurnRecorder] Failed to persist turns for session ${sessionId}:`, err);
  }
}

function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 3.6);
}

function calculateTurnTokenEstimate(
  systemPrompt: string | Record<string, unknown>,
  messages: unknown[],
  tools?: unknown[],
): {
  systemPromptTokens: number;
  messagesTokens: number;
  toolsTokens: number;
  totalTokens: number;
} {
  const sysText = typeof systemPrompt === "string" ? systemPrompt : JSON.stringify(systemPrompt);
  const systemPromptTokens = estimateTokens(sysText);
  const messagesTokens = estimateTokens(JSON.stringify(messages || []));
  const toolsTokens = estimateTokens(JSON.stringify(tools || []));
  const totalTokens = systemPromptTokens + messagesTokens + toolsTokens;
  return { systemPromptTokens, messagesTokens, toolsTokens, totalTokens };
}

export function getSessionTurns(sessionId: string): UILLMTurnRecord[] {
  let list = memoryTurns.get(sessionId);
  if (!list) {
    list = loadPersistedTurns(sessionId);
    memoryTurns.set(sessionId, list);
  }
  return list;
}

export function recordSessionTurn(
  sessionId: string,
  record: Omit<UILLMTurnRecord, "turnIndex" | "timeStr" | "tokenEstimate">,
): UILLMTurnRecord {
  const list = getSessionTurns(sessionId);
  const turnIndex = list.length + 1;
  const fullRecord: UILLMTurnRecord = {
    ...record,
    turnIndex,
    timeStr: new Date(record.timestamp).toLocaleTimeString(),
    tokenEstimate: calculateTurnTokenEstimate(
      record.systemPrompt,
      record.messages,
      record.tools,
    ),
  };

  list.push(fullRecord);
  memoryTurns.set(sessionId, list);
  persistTurns(sessionId, list);
  return fullRecord;
}

export function updateSessionTurnVendorPayload(
  sessionId: string,
  turnIndex: number,
  vendorPayload: Record<string, unknown>,
): void {
  const list = getSessionTurns(sessionId);
  const target = list.find((t) => t.turnIndex === turnIndex);
  if (target) {
    try {
      target.vendorPayload = JSON.parse(JSON.stringify(vendorPayload));
    } catch {
      target.vendorPayload = vendorPayload;
    }
    persistTurns(sessionId, list);
  }
}

export function clearSessionTurns(sessionId: string): void {
  memoryTurns.delete(sessionId);
  try {
    const file = turnFilePath(sessionId);
    if (existsSync(file)) {
      writeFileSync(file, "[]", "utf8");
    }
  } catch {
    /* ignore */
  }
}

/**
 * 将 AgentSession 的底层 agent.streamFn 进行安全包装，
 * 在每一次真实向大模型发起调用（LLM Turn）时，完整捕获并记录：
 * 1. Pi 内部统一格式 (context, systemPrompt, messages, tools)
 * 2. 实际发往厂商的原始 Payload (vendorPayload, 通过 onPayload 钩子精准拦截)
 */
export function installTurnRecorderOnSession(
  session: any,
  sessionIdGetter: () => string,
): void {
  if (!session?.agent || (session.agent as any).__turnRecorderInstalled) {
    return;
  }

  const originalStreamFn = session.agent.streamFn;
  if (typeof originalStreamFn !== "function") {
    return;
  }

  (session.agent as any).__turnRecorderInstalled = true;

  session.agent.streamFn = async (model: any, context: any, options: any) => {
    let recordedTurnIndex: number | null = null;
    let sessionId: string = "";

    try {
      sessionId = sessionIdGetter();
      if (sessionId) {
        // 深拷贝 context 与 options，记录统一内部格式
        const clonedMessages = JSON.parse(JSON.stringify(context?.messages || []));
        const clonedTools = JSON.parse(JSON.stringify(context?.tools || options?.tools || []));
        const thinkingLevel = options?.reasoning ?? session.thinkingLevel ?? "off";

        let systemPromptValue: string | Record<string, unknown> = context?.systemPrompt || "";
        if (typeof systemPromptValue === "string") {
          const trimmed = systemPromptValue.trim();
          if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed && typeof parsed === "object") {
                systemPromptValue = parsed;
              }
            } catch {
              /* keep string */
            }
          }
        }

        const rec = recordSessionTurn(sessionId, {
          timestamp: Date.now(),
          model: {
            provider: model?.provider ?? "unknown",
            id: model?.id ?? "unknown",
            name: model?.name,
          },
          thinkingLevel: String(thinkingLevel),
          systemPrompt: systemPromptValue,
          messages: clonedMessages,
          tools: clonedTools,
        });
        recordedTurnIndex = rec.turnIndex;
      }
    } catch (err) {
      console.warn("[TurnRecorder] Error capturing unified turn payload:", err);
    }

    // 拦截 onPayload 捕获厂商真实请求体
    const originalOnPayload = options?.onPayload;
    const interceptedOptions = {
      ...options,
      onPayload: async (params: any, m: any) => {
        try {
          if (sessionId && recordedTurnIndex !== null && params) {
            updateSessionTurnVendorPayload(sessionId, recordedTurnIndex, params);
          }
        } catch (err) {
          console.warn("[TurnRecorder] Error capturing vendor payload:", err);
        }
        if (typeof originalOnPayload === "function") {
          return originalOnPayload(params, m);
        }
        return undefined;
      },
    };

    return originalStreamFn.call(session.agent, model, context, interceptedOptions);
  };
}
