import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "./context.ts";

export async function handleSystemRoutes(
  url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<boolean> {
  // Lightweight readiness probe (used by `pi --web` before opening the browser).
  if (url.pathname === "/api/health") {
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ ok: true, version: ctx.packageVersion }));
    return true;
  }
  return false;
}
