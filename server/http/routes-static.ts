import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

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

/** Content types worth compressing (already-compressed binaries like png/woff2 are excluded). */
const COMPRESSIBLE_MIME = new Set([
  "text/html",
  "text/javascript",
  "text/css",
  "text/plain",
  "application/javascript",
  "application/json",
  "application/manifest+json",
  "image/svg+xml",
]);

/** Vite/Astro-style hashed build artifacts, e.g. `assets/index-CnrhRkCg.js`. */
const HASHED_ASSET = /[-.][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE_CONTROL = "no-cache, must-revalidate";

type Encoding = "br" | "gzip" | "identity";

interface CachedAsset {
  raw: Buffer;
  gzip?: Buffer;
  br?: Buffer;
  etag: string;
  lastModified: Date;
  mime: string;
  cacheControl: string;
}

/**
 * Per-file response cache. Populated lazily on the first request for a file and
 * keyed by size+mtime so a rebuild (dev) transparently invalidates it. Compression
 * runs once per file revision (async, off the event loop) and is reused afterwards,
 * so serving large bundles never re-compresses them per request.
 */
const assetCache = new Map<string, CachedAsset>();
const inflight = new Map<string, Promise<CachedAsset>>();

function makeEtag(size: number, mtimeMs: number): string {
  return `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

function computeCacheControl(distDir: string, filePath: string): string {
  const rel = relative(distDir, filePath).split(sep).join("/");
  if (rel.startsWith("assets/") && HASHED_ASSET.test(basename(filePath))) {
    return IMMUTABLE_CACHE_CONTROL;
  }
  return REVALIDATE_CACHE_CONTROL;
}

/** Parse an Accept-Encoding header and pick the best available representation. */
export function negotiateEncoding(
  header: string | undefined,
  available: { gzip?: Buffer | undefined; br?: Buffer | undefined },
): Encoding {
  if (!header) return "identity";

  const parsed: { token: string; q: number }[] = [];
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [token, ...params] = trimmed.split(";").map((s) => s.trim());
    if (!token) continue;
    let q = 1;
    for (const p of params) {
      const m = /^q=([0-9]*\.?[0-9]+)$/.exec(p);
      if (m) q = Number(m[1]);
    }
    parsed.push({ token: token.toLowerCase(), q });
  }

  const find = (tokens: string[]) => parsed.filter((e) => tokens.includes(e.token) && e.q > 0);
  const star = parsed.find((e) => e.token === "*" && e.q > 0);

  const candidates: { encoding: Encoding; q: number }[] = [];
  if (available.br) {
    const br = find(["br"])[0];
    if (br) candidates.push({ encoding: "br", q: br.q });
    else if (star) candidates.push({ encoding: "br", q: star.q });
  }
  if (available.gzip) {
    const gz = find(["gzip", "x-gzip"])[0];
    if (gz) candidates.push({ encoding: "gzip", q: gz.q });
    else if (!available.br && star) candidates.push({ encoding: "gzip", q: star.q });
  }

  if (candidates.length === 0) return "identity";
  candidates.sort((a, b) => b.q - a.q || (a.encoding === "br" ? -1 : 1));
  return candidates[0]!.encoding;
}

async function loadStableAsset(
  filePath: string,
  distDir: string,
): Promise<CachedAsset> {
  const info = await stat(filePath);
  const etag = makeEtag(info.size, info.mtimeMs);
  const cached = assetCache.get(filePath);
  if (cached && cached.etag === etag) return cached;

  const pending = inflight.get(filePath);
  if (pending) return pending;

  const task = (async (): Promise<CachedAsset> => {
    const raw = await readFile(filePath);
    const ext = extname(filePath);
    const mime = MIME[ext] ?? "application/octet-stream";
    const asset: CachedAsset = {
      raw,
      etag,
      lastModified: info.mtime,
      mime,
      cacheControl: computeCacheControl(distDir, filePath),
    };
    if (COMPRESSIBLE_MIME.has(mime) && raw.length > 0) {
      const [gz, br] = await Promise.all([gzipAsync(raw), brotliAsync(raw)]);
      asset.gzip = gz as Buffer;
      asset.br = br as Buffer;
    }
    assetCache.set(filePath, asset);
    return asset;
  })();

  inflight.set(filePath, task);
  try {
    return await task;
  } finally {
    inflight.delete(filePath);
  }
}

function etagMatches(ifNoneMatch: string, etag: string): boolean {
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === etag || t === `W/${etag}` || `W/${t}` === etag);
}

function isFresh(req: IncomingMessage, asset: CachedAsset): boolean {
  const ifNoneMatch = req.headers["if-none-match"];
  if (typeof ifNoneMatch === "string" && ifNoneMatch.length > 0) {
    return etagMatches(ifNoneMatch, asset.etag);
  }
  const ifModifiedSince = req.headers["if-modified-since"];
  if (typeof ifModifiedSince === "string" && ifModifiedSince.length > 0) {
    const since = Date.parse(ifModifiedSince);
    if (!Number.isNaN(since)) {
      return Math.floor(asset.lastModified.getTime() / 1000) * 1000 <= since;
    }
  }
  return false;
}

/**
 * Serve a file from `distDir`, with gzip/brotli negotiation, immutable caching for
 * hashed assets, conditional requests, and SPA fallback to index.html.
 *
 * Returns `true` when the request was handled. Async I/O is used throughout so a
 * cold cache read / first compression never blocks the event loop.
 */
export async function handleStaticRoutes(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  distDir: string,
): Promise<boolean> {
  if (!existsSync(distDir)) return false;

  const requested = join(distDir, url.pathname === "/" ? "index.html" : url.pathname);
  let asset: CachedAsset;
  try {
    asset = await loadStableAsset(
      requested.startsWith(distDir) ? requested : join(distDir, "index.html"),
      distDir,
    );
  } catch {
    // Missing path, directory, or unreadable request target → SPA fallback.
    try {
      asset = await loadStableAsset(join(distDir, "index.html"), distDir);
    } catch {
      return false;
    }
  }

  const headers: Record<string, string> = {
    "content-type": asset.mime,
    "cache-control": asset.cacheControl,
    "etag": asset.etag,
    "last-modified": asset.lastModified.toUTCString(),
    vary: "Accept-Encoding",
  };

  if (isFresh(req, asset)) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  const encoding = negotiateEncoding(req.headers["accept-encoding"], asset);
  let body = asset.raw;
  if (encoding === "br" && asset.br) {
    body = asset.br;
    headers["content-encoding"] = "br";
  } else if (encoding === "gzip" && asset.gzip) {
    body = asset.gzip;
    headers["content-encoding"] = "gzip";
  }
  headers["content-length"] = String(body.byteLength);

  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}
