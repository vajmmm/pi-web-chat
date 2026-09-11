import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { terminateProcessTree } from "./process-manager.ts";
import {
  AgyStreamParser,
  type AgyStreamEvent,
  type AgyUsage,
} from "./stream-parser.ts";

export interface AgyTaskOptions {
  prompt: string;
  cwd: string;
  model?: string;
  effort?: "low" | "medium" | "high";
  conversationId?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  onEvent?: (event: AgyStreamEvent) => void;
  onTextDelta?: (delta: string) => void;
  onToolStart?: (name: string, params: any) => void;
  onToolEnd?: (name: string, params: any, output: any, duration?: number) => void;
}

export interface AgyRunResult {
  ok: boolean;
  status: "SUCCESS" | "FAILED" | "ABORTED" | "TIMEOUT";
  response: string;
  conversationId?: string;
  durationSeconds: number;
  usage?: AgyUsage;
  error?: string;
  events: AgyStreamEvent[];
}

/**
 * Resolves the path to the `agy` binary.
 */
export function resolveAgyBinary(): string {
  if (process.env.AGY_BIN && fs.existsSync(process.env.AGY_BIN)) {
    return process.env.AGY_BIN;
  }
  const defaultLocal = path.join(
    process.env.HOME || "",
    ".local",
    "bin",
    "agy",
  );
  if (fs.existsSync(defaultLocal)) {
    return defaultLocal;
  }
  return "agy";
}

/**
 * Executes a task using the AGY CLI, streaming output events,
 * managing process isolation, timeouts, and cancellations.
 */
export async function runAgyTask(options: AgyTaskOptions): Promise<AgyRunResult> {
  const binary = resolveAgyBinary();
  const cwd = options.cwd || process.cwd();
  const model = options.model || "gemini-3.8-flash-high";
  const timeoutMs = options.timeoutMs ?? 0;

  const args: string[] = [
    "-p",
    options.prompt,
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--model",
    model,
  ];

  if (options.effort) {
    args.push("--effort", options.effort);
  }

  if (options.conversationId) {
    args.push("--conversation", options.conversationId);
  }

  const collectedEvents: AgyStreamEvent[] = [];
  let finalResponse = "";
  let finalStatus: AgyRunResult["status"] = "SUCCESS";
  let conversationId = options.conversationId;
  let finalUsage: AgyUsage | undefined;
  let exitError: string | undefined;

  const startTime = Date.now();

  return new Promise<AgyRunResult>((resolve) => {
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;

    // Spawn child with detached = true to create its own process group
    const child = spawn(binary, args, {
      cwd,
      detached: true,
      env: {
        ...process.env,
        // Ensure consistent non-interactive behavior
        CI: "1",
      },
    });

    const rootPid = child.pid;

    const cleanupAndResolve = (result: AgyRunResult) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve(result);
    };

    // Timeout handling
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(async () => {
        finalStatus = "TIMEOUT";
        exitError = `Task timed out after ${timeoutMs}ms`;
        if (rootPid) {
          await terminateProcessTree(rootPid);
        }
        cleanupAndResolve({
          ok: false,
          status: "TIMEOUT",
          response: finalResponse,
          conversationId,
          durationSeconds: (Date.now() - startTime) / 1000,
          usage: finalUsage,
          error: exitError,
          events: collectedEvents,
        });
      }, timeoutMs);
    }

    // Abort signal handling
    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        finalStatus = "ABORTED";
        exitError = "Task was aborted prior to execution";
        if (rootPid) terminateProcessTree(rootPid);
        cleanupAndResolve({
          ok: false,
          status: "ABORTED",
          response: finalResponse,
          conversationId,
          durationSeconds: 0,
          error: exitError,
          events: collectedEvents,
        });
        return;
      }

      options.abortSignal.addEventListener("abort", async () => {
        finalStatus = "ABORTED";
        exitError = "Task was aborted by caller";
        if (rootPid) {
          await terminateProcessTree(rootPid);
        }
        cleanupAndResolve({
          ok: false,
          status: "ABORTED",
          response: finalResponse,
          conversationId,
          durationSeconds: (Date.now() - startTime) / 1000,
          usage: finalUsage,
          error: exitError,
          events: collectedEvents,
        });
      });
    }

    const parser = new AgyStreamParser((event) => {
      collectedEvents.push(event);
      options.onEvent?.(event);

      switch (event.type) {
        case "init":
          conversationId = event.conversationId;
          break;
        case "text_delta":
          finalResponse += event.delta;
          options.onTextDelta?.(event.delta);
          break;
        case "tool_start":
          options.onToolStart?.(event.toolName, event.parameters);
          break;
        case "tool_end":
          options.onToolEnd?.(
            event.toolName,
            event.parameters,
            event.output,
            event.durationSeconds,
          );
          break;
        case "response_done":
          if (event.usage) finalUsage = event.usage;
          break;
        case "result":
          finalResponse = event.response || finalResponse;
          conversationId = event.conversationId || conversationId;
          if (event.usage) finalUsage = event.usage;
          if (event.status !== "SUCCESS") {
            finalStatus = "FAILED";
            exitError = `AGY reported status: ${event.status}`;
          }
          break;
      }
    });

    child.stdout.on("data", (chunk) => {
      parser.feed(chunk);
    });

    child.stderr.on("data", (chunk) => {
      const errText = chunk.toString("utf8");
      // agy sometimes logs diagnostics or progress to stderr
      if (!exitError && /error/i.test(errText)) {
        exitError = errText.trim();
      }
    });

    child.on("error", (err) => {
      finalStatus = "FAILED";
      exitError = err.message;
      cleanupAndResolve({
        ok: false,
        status: "FAILED",
        response: finalResponse,
        conversationId,
        durationSeconds: (Date.now() - startTime) / 1000,
        error: exitError,
        events: collectedEvents,
      });
    });

    child.on("close", (code) => {
      parser.flush();
      const durationSeconds = (Date.now() - startTime) / 1000;
      const ok = code === 0 && finalStatus !== "FAILED" && finalStatus !== "ABORTED" && finalStatus !== "TIMEOUT";

      cleanupAndResolve({
        ok,
        status: ok ? "SUCCESS" : finalStatus === "SUCCESS" ? "FAILED" : finalStatus,
        response: finalResponse,
        conversationId,
        durationSeconds,
        usage: finalUsage,
        error: ok ? undefined : exitError || `Process exited with code ${code}`,
        events: collectedEvents,
      });
    });
  });
}
