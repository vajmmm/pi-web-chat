import { randomUUID } from "node:crypto";
import type { AgentRole } from "../../../shared/protocol.ts";
import type { CreateSubagentRuntimeOptions } from "../agent-runtime.ts";
import { runAgyTask } from "./agy-runner.ts";

export interface AgySessionRuntimeResult {
  runtime: {
    session: AgySession;
    dispose: () => Promise<void>;
  };
  session: AgySession;
  resolvedModelDetails: {
    provider: string;
    id: string;
    name?: string;
  };
}

export class AgySession {
  public messages: any[] = [];
  public isStreaming = false;
  private subscribers: Array<(event: any) => void> = [];
  private abortController: AbortController | null = null;
  private options: CreateSubagentRuntimeOptions;
  private modelId: string;
  private activeToolCalls = new Map<string, string>(); // toolName -> toolCallId

  constructor(options: CreateSubagentRuntimeOptions, modelId: string) {
    this.options = options;
    this.modelId = modelId;
  }

  public subscribe(fn: (event: any) => void): () => void {
    this.subscribers.push(fn);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== fn);
    };
  }

  private emit(event: any): void {
    for (const sub of [...this.subscribers]) {
      try {
        sub(event);
      } catch (err) {
        console.error("[AgySession] Error in event subscriber:", err);
      }
    }
  }

  public async abort(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  public async prompt(userPrompt: string): Promise<void> {
    this.abortController = new AbortController();
    this.isStreaming = true;

    // Record user message
    this.messages.push({
      role: "user",
      content: userPrompt,
      timestamp: Date.now(),
    });

    this.emit({ type: "turn_start" });

    let assistantText = "";

    try {
      const res = await runAgyTask({
        prompt: userPrompt,
        cwd: this.options.effectiveCwd,
        model: this.modelId,
        timeoutMs: this.options.executionOptions?.timeoutMs,
        abortSignal: this.abortController.signal,
        onTextDelta: (delta) => {
          assistantText += delta;
        },
        onToolStart: (toolName, params) => {
          const toolCallId = `agy_${randomUUID().slice(0, 8)}`;
          this.activeToolCalls.set(toolName, toolCallId);

          this.emit({
            type: "tool_execution_start",
            toolName,
            toolCallId,
            args: params,
          });
        },
        onToolEnd: (toolName, params, output, duration) => {
          const toolCallId = this.activeToolCalls.get(toolName) || `agy_${randomUUID().slice(0, 8)}`;
          this.activeToolCalls.delete(toolName);

          const outputStr =
            typeof output === "string" ? output : output ? JSON.stringify(output) : "";

          // Record assistant toolCall message
          this.messages.push({
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: toolCallId,
                name: toolName,
                args: params,
              },
            ],
            timestamp: Date.now(),
          });

          // Record toolResult message
          this.messages.push({
            role: "toolResult",
            toolCallId,
            toolName,
            content: [{ type: "text", text: outputStr }],
            details: { durationSeconds: duration },
            isError: false,
            timestamp: Date.now(),
          });

          this.emit({
            type: "tool_execution_end",
            toolName,
            toolCallId,
            isError: false,
            result: {
              content: [{ type: "text", text: outputStr }],
              details: { durationSeconds: duration },
            },
          });
        },
      });

      this.isStreaming = false;

      if (!res.ok) {
        const errorMsg = res.error || `AGY subagent failed with status: ${res.status}`;
        this.messages.push({
          role: "assistant",
          content: [{ type: "text", text: assistantText || `[Error: ${errorMsg}]` }],
          stopReason: res.status === "ABORTED" ? "aborted" : "error",
          rawStopReason: res.status === "ABORTED" ? "aborted" : "error",
          errorMessage: errorMsg,
          timestamp: Date.now(),
        });
        if (res.status === "ABORTED") {
          throw new Error("Subagent execution was aborted");
        }
        throw new Error(errorMsg);
      }

      const finalText = res.response || assistantText;
      if (finalText) {
        this.messages.push({
          role: "assistant",
          content: [{ type: "text", text: finalText }],
          stopReason: "stop",
          rawStopReason: "stop",
          usage: res.usage,
          timestamp: Date.now(),
        });
      }

      this.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
          stopReason: "stop",
          rawStopReason: "stop",
          usage: res.usage,
        },
      });

      this.emit({ type: "turn_end" });
      this.emit({ type: "agent_end" });
    } catch (err) {
      this.isStreaming = false;
      this.emit({ type: "agent_end" });
      throw err;
    }
  }
}

/**
 * Creates an AGY subagent session runtime conforming to createSubagentSessionRuntime.
 */
export async function createAgySessionRuntime(
  options: CreateSubagentRuntimeOptions,
): Promise<AgySessionRuntimeResult> {
  const model = options.effectiveContext.runtime.model;
  const modelId = model?.modelId || "gemini-3.8-flash-high";

  const session = new AgySession(options, modelId);
  const runtime = {
    session,
    dispose: async () => {
      await session.abort();
    },
  };

  return {
    runtime,
    session,
    resolvedModelDetails: {
      provider: "agy",
      id: modelId,
      name: `AGY ${modelId}`,
    },
  };
}
