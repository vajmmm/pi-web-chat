export interface AgyUsage {
  input_tokens: number;
  output_tokens: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens: number;
}

export type AgyStreamEvent =
  | {
      type: "init";
      conversationId: string;
      model: string;
      cwd: string;
      tools: string[];
    }
  | {
      type: "user_input";
      stepIndex: number;
      state: "ACTIVE" | "DONE";
    }
  | {
      type: "tool_start";
      stepIndex: number;
      toolName: string;
      parameters: Record<string, any>;
    }
  | {
      type: "tool_end";
      stepIndex: number;
      toolName: string;
      parameters: Record<string, any>;
      output?: any;
      durationSeconds?: number;
    }
  | {
      type: "text_delta";
      stepIndex: number;
      delta: string;
    }
  | {
      type: "response_done";
      stepIndex: number;
      durationSeconds?: number;
      usage?: AgyUsage;
    }
  | {
      type: "result";
      conversationId: string;
      status: "SUCCESS" | "ERROR" | string;
      response: string;
      durationSeconds: number;
      numTurns: number;
      usage?: AgyUsage;
    }
  | {
      type: "raw";
      data: Record<string, any>;
    };

export class AgyStreamParser {
  private buffer = "";
  private onEvent: (event: AgyStreamEvent) => void;

  constructor(onEvent: (event: AgyStreamEvent) => void) {
    this.onEvent = onEvent;
  }

  /**
   * Feed a raw chunk (from child process stdout) into the parser.
   */
  public feed(chunk: string | Buffer): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    // Keep the last partial line in the buffer
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.parseLine(trimmed);
    }
  }

  /**
   * Flush any remaining line in buffer.
   */
  public flush(): void {
    if (this.buffer.trim()) {
      this.parseLine(this.buffer.trim());
      this.buffer = "";
    }
  }

  private parseLine(line: string): void {
    try {
      const raw = JSON.parse(line);
      this.dispatchRaw(raw);
    } catch {
      // Not valid JSON (e.g. non-NDJSON warning message from CLI)
      this.onEvent({
        type: "raw",
        data: { text: line },
      });
    }
  }

  private dispatchRaw(raw: any): void {
    if (!raw || typeof raw !== "object") return;

    if (raw.event === "init" && raw.init) {
      this.onEvent({
        type: "init",
        conversationId: raw.conversation_id ?? raw.init.conversation_id ?? "",
        model: raw.init.model ?? "",
        cwd: raw.init.cwd ?? "",
        tools: Array.isArray(raw.init.tools) ? raw.init.tools : [],
      });
      return;
    }

    if (raw.event === "step_update" && raw.step_update) {
      const update = raw.step_update;
      const stepIndex = Number(update.step_index ?? 0);
      const stepType = update.step_type;

      if (stepType === "user_input") {
        this.onEvent({
          type: "user_input",
          stepIndex,
          state: update.state ?? "DONE",
        });
        return;
      }

      if (stepType === "tool") {
        const toolInfo = update.tool_info || {};
        if (update.state === "ACTIVE") {
          this.onEvent({
            type: "tool_start",
            stepIndex,
            toolName: update.tool_name || toolInfo.name || "unknown",
            parameters: toolInfo.parameters || {},
          });
        } else {
          this.onEvent({
            type: "tool_end",
            stepIndex,
            toolName: update.tool_name || toolInfo.name || "unknown",
            parameters: toolInfo.parameters || {},
            output: toolInfo.output,
            durationSeconds: update.duration_seconds,
          });
        }
        return;
      }

      if (stepType === "agent_response") {
        if (update.text_delta) {
          this.onEvent({
            type: "text_delta",
            stepIndex,
            delta: update.text_delta,
          });
        }
        if (update.state === "DONE") {
          this.onEvent({
            type: "response_done",
            stepIndex,
            durationSeconds: update.duration_seconds,
            usage: update.usage,
          });
        }
        return;
      }
    }

    if (raw.event === "result" && raw.result) {
      const res = raw.result;
      this.onEvent({
        type: "result",
        conversationId: res.conversation_id || raw.conversation_id || "",
        status: res.status || "SUCCESS",
        response: res.response || "",
        durationSeconds: Number(res.duration_seconds ?? 0),
        numTurns: Number(res.num_turns ?? 1),
        usage: res.usage,
      });
      return;
    }

    // Fallback: emit generic raw event
    this.onEvent({
      type: "raw",
      data: raw,
    });
  }
}
