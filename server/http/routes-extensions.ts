import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, relative } from "node:path";
import type { UIExtensionInfo } from "../../shared/protocol.ts";
import type { SessionEntry } from "../session/session-registry.ts";
import {
  canUseProductDesign,
  getMainSessionCapabilities,
  PRODUCT_DESIGN_IMAGEGEN_TOOL_NAME,
  PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME,
} from "../session/capabilities.ts";
import type { ServerContext } from "./context.ts";

export async function handleExtensionsRoutes(
  url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<boolean> {
  const { sessionRegistry, homeDir: HOME } = ctx;
  const entries = sessionRegistry.entries;

  if (url.pathname === "/api/extensions") {
    const anyEntry = entries.values().next().value as SessionEntry | undefined;
    if (!anyEntry) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ extensions: [], errors: [] }));
      return true;
    }
    const { extensions, errors } = anyEntry.runtime.session.resourceLoader.getExtensions();
    const productDesignAvailable = canUseProductDesign(
      getMainSessionCapabilities(anyEntry.runtime.session.model),
    );
    const shorten = (p: string) => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);
    const list: UIExtensionInfo[] = extensions.map((ext) => {
      const { sourceInfo } = ext;
      let name: string;
      let packageName: string | undefined;
      if (sourceInfo.origin === "package") {
        packageName = sourceInfo.source.replace(/^npm:/, "");
        const rel = relative(sourceInfo.baseDir ?? dirname(ext.path), ext.path)
          .replace(/\.(ts|js|mjs|cjs)$/, "")
          .replace(/\/index$/, "")
          .replace(/^index$/, "")
          .replace(/^(src\/)?(extensions\/)?/, "");
        name = rel && rel !== "src" ? rel : packageName;
      } else {
        name = basename(ext.path).replace(/\.(ts|js|mjs|cjs)$/, "");
      }
      const tools = [...ext.tools.keys()].filter(
        (tool) =>
          productDesignAvailable ||
          (tool !== PRODUCT_DESIGN_IMAGEGEN_TOOL_NAME && tool !== PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME),
      );
      return {
        name,
        packageName,
        path: shorten(ext.path),
        scope: sourceInfo.scope,
        tools,
        commands: [...ext.commands.keys()],
        flags: [...ext.flags.keys()],
        events: [...ext.handlers.keys()],
      };
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        extensions: list,
        errors: errors.map((e) => ({ path: shorten(e.path), error: e.error })),
      }),
    );
    return true;
  }

  return false;
}
