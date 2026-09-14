import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

/**
 * Trust boundary for the local web-chat server.
 *
 * This server has no authentication and can drive a coding agent, so it must
 * defend against two browser-driven attacks even while bound to loopback:
 *
 *   - CSWSH (Cross-Site WebSocket Hijacking): a malicious page a user visits
 *     opens `ws://localhost:3141/ws`. The browser attaches an `Origin` header
 *     identifying the attacker site — we reject any Origin whose hostname is not
 *     a trusted local host.
 *
 *   - DNS rebinding: `attacker.com` first resolves to the attacker, then rebinds
 *     to 127.0.0.1 so the page can reach the local server. The browser sends
 *     `Host: attacker.com`, so we reject any Host header that is not a trusted
 *     local hostname.
 *
 * Design constraints (must not break existing integrations):
 *   - Missing Origin ⇒ trusted. Non-browser clients (pi CLI, curl) never send
 *     Origin; browsers always do for cross-origin/WS requests.
 *   - Port is never checked, only the hostname. `npm run dev` serves the UI from
 *     vite on :5173 and proxies to :3141, so its Origin is `localhost:5173`.
 *   - Raw IP literals are trusted. DNS rebinding requires a *hostname*; a raw IP
 *     in Host/Origin means a direct connection (loopback or LAN when the
 *     operator opted into HOST=0.0.0.0), which is not a rebinding vector.
 */

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"]);

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * The set of hostnames considered "local" to this server: fixed loopback names,
 * the address the server is actually bound to (process.env.HOST), and any
 * operator-supplied extras via PI_WEB_TRUSTED_HOSTS (comma separated).
 *
 * Recomputed per call so tests can adjust process.env.HOST; the work is a few
 * string ops and negligible next to request handling.
 */
export function getTrustedHostnames(): Set<string> {
  const set = new Set(LOOPBACK_HOSTNAMES);
  const bound = (process.env.HOST ?? "").trim().toLowerCase();
  if (bound) set.add(stripBrackets(bound));
  const extra = process.env.PI_WEB_TRUSTED_HOSTS;
  if (extra) {
    for (const raw of extra.split(",")) {
      const h = stripBrackets(raw.trim().toLowerCase());
      if (h) set.add(h);
    }
  }
  return set;
}

function isTrustedHostname(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  const h = stripBrackets(hostname.trim().toLowerCase());
  if (!h) return false;
  if (getTrustedHostnames().has(h)) return true;
  // Raw IP literals are not a DNS-rebinding vector (see module docblock).
  return isIP(h) !== 0;
}

/** Extract the hostname (no port) from a `Host:` header value. */
function hostnameFromHostHeader(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

/**
 * DNS-rebinding guard. Returns true when the request's Host header targets a
 * trusted local hostname (loopback name, bound HOST, extra, or raw IP). A
 * missing Host header is treated as trusted so non-HTTP/1.1 or synthetic
 * requests are not spuriously rejected.
 */
export function isTrustedHost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return true;
  return isTrustedHostname(hostnameFromHostHeader(host));
}

/**
 * CSWSH guard. Returns true when there is no Origin header (non-browser client)
 * or when the Origin's hostname is a trusted local host. A malformed Origin is
 * rejected. Port is intentionally ignored (vite dev proxy uses :5173).
 */
export function isTrustedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  return isTrustedHostname(hostname);
}
