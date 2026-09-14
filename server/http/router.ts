import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "./context.ts";
import { handleSystemRoutes } from "./routes-system.ts";
import { handleProjectsRoutes } from "./routes-projects.ts";
import { handleSessionsRoutes } from "./routes-sessions.ts";
import { handleDiagnosticsRoutes } from "./routes-diagnostics.ts";
import { handleExtensionsRoutes } from "./routes-extensions.ts";
import { handleFsRoutes } from "./routes-fs.ts";
import { handleModelsRoutes } from "./routes-models.ts";
import { handleRolesRoutes } from "./routes-roles.ts";
import { handleStaticRoutes } from "./routes-static.ts";

export async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  try {
    if (await handleSystemRoutes(url, req, res, ctx)) return;
    if (await handleProjectsRoutes(url, req, res, ctx)) return;
    if (await handleSessionsRoutes(url, req, res, ctx)) return;
    if (await handleDiagnosticsRoutes(url, req, res, ctx)) return;
    if (await handleExtensionsRoutes(url, req, res, ctx)) return;
    if (await handleFsRoutes(url, req, res, ctx)) return;
    if (await handleRolesRoutes(url, req, res, ctx)) return;
    if (await handleModelsRoutes(url, req, res, ctx)) return;
    if (await handleStaticRoutes(url, req, res, ctx.distDir)) return;

    res.writeHead(404);
    res.end("Not found. Run `npm run build` first, or use `npm run dev`.");
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
  }
}
