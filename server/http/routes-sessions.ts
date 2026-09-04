import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  UISessionFileResponse,
  UISessionInfo,
} from "../../shared/protocol.ts";
import {
  deleteSessionFile,
  formatRelativeTime,
} from "../projects.ts";
import { resolveSessionPath, sessionIdOf } from "../session/session-registry.ts";
import { cleanupDeletedSessionResources } from "../session/index.ts";
import { getSessionTurns } from "../turn-recorder.ts";
import type { ServerContext } from "./context.ts";

export async function handleSessionsRoutes(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<boolean> {
  const { sessionRegistry, subagentManager, agentCwd: AGENT_CWD } = ctx;
  const entries = sessionRegistry.entries;

  // 删除单个会话 (/api/sessions/:id)
  if (url.pathname.startsWith("/api/sessions/") && req.method === "DELETE") {
    const sessionId = url.pathname.slice("/api/sessions/".length);
    const targetCwd = url.searchParams.get("cwd") || undefined;

    const cleanupResult = await cleanupDeletedSessionResources(sessionId, ctx, targetCwd, { deleteFile: true });
    if (!cleanupResult.quiescence?.success) {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: `Quiescence failure: session ${sessionId} could not be safely stopped. Deletion aborted to prevent orphaned runtimes.`,
          details: cleanupResult.errors,
        }),
      );
      return true;
    }

    if (!cleanupResult.success) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: `Deletion failure: session ${sessionId} encountered errors during resource cleanup.`,
          details: cleanupResult.errors,
        }),
      );
      return true;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (url.pathname === "/api/sessions") {
    const targetCwd = url.searchParams.get("cwd") || AGENT_CWD;
    const effectiveCwd = existsSync(targetCwd) ? resolve(targetCwd) : AGENT_CWD;
    const sessions = await SessionManager.list(effectiveCwd);
    const list: UISessionInfo[] = sessions
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .slice(0, 100)
      .map((s) => ({
        id: sessionIdOf(s.path),
        path: s.path,
        name: s.name,
        firstMessage: s.firstMessage.slice(0, 200),
        modified: s.modified.toISOString(),
        relativeTime: formatRelativeTime(s.modified),
        messageCount: s.messageCount,
        cwd: effectiveCwd,
      }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(list));
    return true;
  }

  if (url.pathname === "/api/fork-points") {
    const entry = entries.get(url.searchParams.get("session") ?? "");
    if (!entry) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return true;
    }
    const points = entry.runtime.session.getUserMessagesForForking();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(points.map((p) => ({ entryId: p.entryId, text: p.text.slice(0, 200) }))),
    );
    return true;
  }

  // 查询指定会话的全部真实历史 LLM Turn 完整请求 Payload
  if (url.pathname === "/api/llm-turns") {
    const sessionId = url.searchParams.get("session") ?? "";
    const taskId = url.searchParams.get("task") ?? "";
    const targetId = taskId || sessionId;

    let targetEntry = sessionId ? entries.get(sessionId) : undefined;
    if (!targetEntry && !taskId && entries.size > 0) {
      targetEntry = entries.values().next().value;
    }
    const effectiveId = taskId || (targetEntry ? targetEntry.id : sessionId);

    const turns = getSessionTurns(effectiveId);
    const response = {
      sessionId: effectiveId,
      sessionFile: targetEntry?.runtime.session.sessionFile,
      totalTurns: turns.length,
      turns,
    };

    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(response));
    return true;
  }

  // 实时读取当前会话对应的 session .jsonl 物理文件内容
  if (url.pathname === "/api/session-file") {
    const sessionId = url.searchParams.get("session") ?? "";
    let sessionFilePath: string | undefined;
    let targetEntry = entries.get(sessionId);
    if (!targetEntry && entries.size > 0) {
      targetEntry = entries.values().next().value;
    }
    if (targetEntry) {
      sessionFilePath = targetEntry.runtime.session.sessionFile;
    } else if (sessionId) {
      const customCwd = url.searchParams.get("cwd") || undefined;
      sessionFilePath = await resolveSessionPath(sessionId, customCwd, AGENT_CWD);
    }

    if (!sessionFilePath || !existsSync(sessionFilePath)) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          sessionId,
          sessionFile: sessionFilePath ?? "",
          exists: false,
          size: 0,
          modified: "",
          lineCount: 0,
          lines: [],
          rawContent: "",
        }),
      );
      return true;
    }

    try {
      const stats = statSync(sessionFilePath);
      const rawContent = readFileSync(sessionFilePath, "utf8");
      const rawLines = rawContent.split("\n").filter((l) => l.trim().length > 0);
      const parsedLines = rawLines.map((raw, idx) => {
        let parsed: Record<string, unknown> | undefined;
        let type = "unknown";
        try {
          parsed = JSON.parse(raw);
          if (parsed && typeof parsed.type === "string") {
            type = parsed.type;
          }
        } catch {
          /* ignore JSON parse error for malformed lines */
        }
        return {
          lineNumber: idx + 1,
          type,
          raw,
          parsed,
        };
      });

      const response: UISessionFileResponse = {
        sessionId,
        sessionFile: sessionFilePath,
        exists: true,
        size: stats.size,
        modified: stats.mtime.toISOString(),
        relativeTime: formatRelativeTime(stats.mtime),
        lineCount: parsedLines.length,
        lines: parsedLines,
        rawContent,
      };

      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(response));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `读取会话文件失败: ${String(err)}` }));
    }
    return true;
  }

  return false;
}
