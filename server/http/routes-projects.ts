import { existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import {
  deleteFolderSessions,
  deleteProjectSessions,
  listAllProjects,
  registerKnownProjectPath,
} from "../projects.ts";
import { resolveProjectRoot } from "../worktree.ts";
import { readBody, type ServerContext } from "./context.ts";

export async function handleProjectsRoutes(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<boolean> {
  const { sessionRegistry, homeDir: HOME } = ctx;
  const entries = sessionRegistry.entries;

  // 获取或管理全部项目及其下属会话列表 (/api/projects)
  if (url.pathname === "/api/projects") {
    if (req.method === "DELETE") {
      const targetFolder = url.searchParams.get("folder");
      const targetCwd = url.searchParams.get("cwd");

      if (targetFolder) {
        const resDel = await deleteFolderSessions(targetFolder);
        for (const [id, entry] of entries.entries()) {
          if (entry.cwd === resolve(targetFolder)) {
            sessionRegistry.remove(id);
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(resDel));
        return true;
      }

      if (!targetCwd) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing cwd or folder parameter" }));
        return true;
      }
      const resDel = await deleteProjectSessions(targetCwd);
      const resolvedTarget = resolve(targetCwd);
      for (const [id, entry] of entries.entries()) {
        const entryRoot = (await resolveProjectRoot(entry.cwd)).projectRoot;
        if (entry.cwd === resolvedTarget || entryRoot === resolvedTarget) {
          sessionRegistry.remove(id);
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(resDel));
      return true;
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      try {
        const { cwd } = JSON.parse(body) as { cwd: string };
        const rawPath = cwd?.trim() || "";
        const targetPath = rawPath.startsWith("~") ? join(HOME, rawPath.slice(1)) : rawPath;
        const resolved = resolve(targetPath);
        if (existsSync(resolved) && statSync(resolved).isDirectory()) {
          registerKnownProjectPath(resolved);
        }
        const activeCwds = Array.from(entries.values()).map((e) => e.cwd);
        const projects = await listAllProjects(activeCwds);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(projects));
        return true;
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
        return true;
      }
    }

    const activeCwds = Array.from(entries.values()).map((e) => e.cwd);
    const projects = await listAllProjects(activeCwds);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(projects));
    return true;
  }

  return false;
}
