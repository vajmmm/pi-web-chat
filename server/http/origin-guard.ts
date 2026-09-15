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
 *     a trusted local host. A page hosted at `http://1.2.3.4/` therefore sends
 *     `Origin: http://1.2.3.4`, so raw public/private IP literals must NOT be
 *     trusted unconditionally; only the server's actual bind address (or an
 *     operator allowlisted host) qualifies.
 *
 *   - DNS rebinding: `attacker.com` first resolves to the attacker, then rebinds
 *     to 127.0.0.1 so the page can reach the local server. The browser sends
 *     `Host: attacker.com`, so we reject any Host header that is not a trusted
 *     local hostname.
 *
 * The two guards therefore use different trust rules:
 *   - `isTrustedHost` (rebinding) also trusts raw IP literals: a raw IP Host is a
 *     direct connection, and rebinding requires a *hostname*.
 *   - `isTrustedOrigin` (CSWSH) trusts only hostnames in the trusted set. A raw
 *     public/private IP Origin is rejected unless it is the server's bind address
 *     or an allowlisted host — otherwise any page on `http://<ip>/` could hijack
 *     a locally-bound session.
 *
 * Design constraints (must not break existing integrations):
 *   - Missing Origin ⇒ trusted. Non-browser clients (pi CLI, curl) never send
 *     Origin; browsers always do for cross-origin/WS requests.
 *   - Port is never checked, only the hostname. `npm run dev` serves the UI from
 *     vite on :5173 and proxies to :3141, so its Origin is `localhost:5173`.
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

/**
 * Strict hostname check used for Origins: only hostnames in the trusted set
 * (loopback names, bound HOST, PI_WEB_TRUSTED_HOSTS) are accepted. Unlike the
 * Host check it does NOT blanket-trust raw IP literals, so `http://1.2.3.4/`
 * cannot cross-site-hijack a loopback-bound server.
 */
function isTrustedName(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  const h = stripBrackets(hostname.trim().toLowerCase());
  if (!h) return false;
  return getTrustedHostnames().has(h);
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
  const hostname = hostnameFromHostHeader(host);
  if (!hostname) return false;
  if (isTrustedName(hostname)) return true;
  // Raw IP literals are not a DNS-rebinding vector (see module docblock), so a
  // direct-IP Host (loopback or LAN) is still accepted here.
  return isIP(stripBrackets(hostname.trim().toLowerCase())) !== 0;
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
  // CSWSH guard: only the trusted-name set is accepted here. A raw public or
  // private IP Origin is rejected unless it is exactly the bind address or an
  // allowlisted host (see module docblock).
  return isTrustedName(hostname);
}
