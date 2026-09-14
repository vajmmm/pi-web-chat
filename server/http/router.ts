import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "./context.ts";
import { isTrustedHost, isTrustedOrigin } from "./origin-guard.ts";
import { handleSystemRoutes } from "./routes-system.ts";
import { handleProjectsRoutes } from "./routes-projects.ts";
import { handleSessionsRoutes } from "./routes-sessions.ts";
import { handleDiagnosticsRoutes } from "./routes-diagnostics.ts";
import { handleExtensionsRoutes } from "./routes-extensions.ts";
import { handleFsRoutes } from "./routes-fs.ts";
import { handleModelsRoutes } from "./routes-models.ts";
import { handleRolesRoutes } from "./routes-roles.ts";
import { handleStaticRoutes } from "./routes-static.ts";

function isStateChangingMethod(method: string | undefined): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m === "POST" || m === "PUT" || m === "DELETE" || m === "PATCH";
}

export async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // DNS-rebinding guard (all methods): reject requests whose Host header is not
  // a trusted local hostname. Normal page/static loads use Host: localhost or
  // 127.0.0.1 and are unaffected; the vite dev proxy forwards a localhost Host.
  if (!isTrustedHost(req)) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden host" }));
    return;
  }

  // CSWSH guard (state-changing / outbound requests only): reject cross-site
  // Origins. GET page/static loads are not required to carry an Origin, so this
  // never breaks first-page load; non-browser clients (CLI/curl) send no Origin
  // and are allowed; same-host Origins on any port (vite:5173) are allowed.
  if (isStateChangingMethod(req.method) && !isTrustedOrigin(req)) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden origin" }));
    return;
  }

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
