import { existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import {
  cleanupEmptyProjectDirs,
  findFolderSessionIds,
  findProjectSessionIds,
  listAllProjects,
  registerKnownProjectPath,
  removeKnownProjectPath,
} from "../projects.ts";
import { resolveProjectRoot } from "../worktree.ts";
import { cleanupDeletedSessionResources } from "../session/index.ts";
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
        const resolvedFolder = resolve(targetFolder);
        const sids = new Set<string>(findFolderSessionIds(targetFolder));
        for (const [id, entry] of entries.entries()) {
          if (entry.cwd === resolvedFolder) {
            sids.add(id);
          }
        }

        const deletedSessionIds: string[] = [];
        const failedSessionIds: string[] = [];
        const allErrors: string[] = [];

        for (const sid of sids) {
          const resClean = await cleanupDeletedSessionResources(sid, ctx, targetFolder, { deleteFile: true });
          if (resClean.success) {
            deletedSessionIds.push(sid);
          } else {
            failedSessionIds.push(sid);
            if (resClean.errors) allErrors.push(...resClean.errors);
          }
        }

        if (failedSessionIds.length === 0) {
          cleanupEmptyProjectDirs();
          removeKnownProjectPath(resolvedFolder);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, deletedCount: deletedSessionIds.length }));
          return true;
        } else {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              deletedCount: deletedSessionIds.length,
              deletedSessionIds,
              failedSessionIds,
              error: `Deletion failure: ${failedSessionIds.length} session(s) could not be safely stopped or deleted.`,
              details: allErrors,
            }),
          );
          return true;
        }
      }

      if (!targetCwd) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing cwd or folder parameter" }));
        return true;
      }

      const resolvedTarget = resolve(targetCwd);
      const { projectRoot } = await resolveProjectRoot(targetCwd);
      const diskSids = await findProjectSessionIds(targetCwd);
      const sids = new Set<string>(diskSids);

      for (const [id, entry] of entries.entries()) {
        const entryRoot = (await resolveProjectRoot(entry.cwd)).projectRoot;
        if (entry.cwd === resolvedTarget || entryRoot === resolvedTarget || entryRoot === projectRoot) {
          sids.add(id);
        }
      }

      const deletedSessionIds: string[] = [];
      const failedSessionIds: string[] = [];
      const allErrors: string[] = [];

      for (const sid of sids) {
        const resClean = await cleanupDeletedSessionResources(sid, ctx, targetCwd, { deleteFile: true });
        if (resClean.success) {
          deletedSessionIds.push(sid);
        } else {
          failedSessionIds.push(sid);
          if (resClean.errors) allErrors.push(...resClean.errors);
        }
      }

      if (failedSessionIds.length === 0) {
        cleanupEmptyProjectDirs();
        removeKnownProjectPath(projectRoot);
        removeKnownProjectPath(resolvedTarget);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, deletedCount: deletedSessionIds.length }));
        return true;
      } else {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            deletedCount: deletedSessionIds.length,
            deletedSessionIds,
            failedSessionIds,
            error: `Deletion failure: ${failedSessionIds.length} session(s) could not be safely stopped or deleted.`,
            details: allErrors,
          }),
        );
        return true;
      }
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
