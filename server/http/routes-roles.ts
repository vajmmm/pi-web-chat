import type { IncomingMessage, ServerResponse } from "node:http";
import type { RoleConfig } from "../../shared/protocol.ts";
import { isCanonicalRole } from "../contracts/roles.ts";
import { loadRolesConfig, saveRolesConfig } from "../roles.ts";
import { applyRoleToSession } from "../session/role-binding.ts";
import { isPendingDeletion } from "../session/deletion-tombstone.ts";
import { readBody, type ServerContext } from "./context.ts";

export async function handleRolesRoutes(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<boolean> {
  if (url.pathname === "/api/roles") {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(loadRolesConfig()));
      return true;
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      try {
        const { roles } = JSON.parse(body) as { roles: RoleConfig[] };
        if (Array.isArray(roles)) {
          for (const r of roles) {
            if (!r || !isCanonicalRole(r.id)) {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  error: `Unsupported or invalid role: "${r?.id}". Only canonical roles are supported.`,
                }),
              );
              return true;
            }
          }
          saveRolesConfig(roles);
          // 同步热更新所有活跃会话的工具集与角色约束（跳过 pending deletion，纳入 in-flight op gate）
          for (const entry of ctx.sessionRegistry.entries.values()) {
            if (isPendingDeletion(entry.id) || ctx.subagentManager.isDeleting(entry.id)) continue;
            await ctx.sessionRegistry.trackInFlightOp(entry.id, async () => {
              applyRoleToSession(entry, entry.activeRole);
            });
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(loadRolesConfig()));
        return true;
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `invalid request: ${String(err)}` }));
        return true;
      }
    }
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return true;
  }

  return false;
}
