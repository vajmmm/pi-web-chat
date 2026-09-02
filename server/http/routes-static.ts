import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";

export const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

export function handleStaticRoutes(
  url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
  distDir: string,
): boolean {
  if (existsSync(distDir)) {
    let filePath = join(distDir, url.pathname === "/" ? "index.html" : url.pathname);
    if (!filePath.startsWith(distDir) || !existsSync(filePath)) {
      filePath = join(distDir, "index.html"); // SPA fallback
    }
    const ext = extname(filePath);
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
    res.end(readFileSync(filePath));
    return true;
  }
  return false;
}
