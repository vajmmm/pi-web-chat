import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, it } from "node:test";
import {
  getTrustedHostnames,
  isTrustedHost,
  isTrustedOrigin,
} from "../server/http/origin-guard.ts";

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const savedHost = process.env.HOST;
const savedExtra = process.env.PI_WEB_TRUSTED_HOSTS;

afterEach(() => {
  if (savedHost === undefined) delete process.env.HOST;
  else process.env.HOST = savedHost;
  if (savedExtra === undefined) delete process.env.PI_WEB_TRUSTED_HOSTS;
  else process.env.PI_WEB_TRUSTED_HOSTS = savedExtra;
});

describe("isTrustedOrigin (CSWSH guard)", () => {
  it("allows requests with no Origin header (CLI/curl/non-browser)", () => {
    assert.equal(isTrustedOrigin(req({})), true);
  });

  it("allows loopback Origins on any port (vite dev proxy :5173)", () => {
    for (const origin of [
      "http://localhost:5173",
      "http://localhost:3141",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:3141",
      "http://[::1]:4173",
      "https://localhost",
    ]) {
      assert.equal(isTrustedOrigin(req({ origin })), true, `expected trusted: ${origin}`);
    }
  });

  it("rejects external Origins", () => {
    for (const origin of [
      "https://evil.com",
      "http://attacker.example.com:3141",
      "https://localhost.evil.com",
      "http://not-localhost",
    ]) {
      assert.equal(isTrustedOrigin(req({ origin })), false, `expected rejected: ${origin}`);
    }
  });

  it("rejects a malformed Origin header", () => {
    assert.equal(isTrustedOrigin(req({ origin: "://///" })), false);
  });

  it("allows raw IP-literal Origins (direct/LAN access, not a rebinding vector)", () => {
    assert.equal(isTrustedOrigin(req({ origin: "http://192.168.1.5:3141" })), true);
  });
});

describe("isTrustedHost (DNS-rebinding guard)", () => {
  it("treats a missing Host header as trusted", () => {
    assert.equal(isTrustedHost(req({})), true);
  });

  it("allows loopback Hosts on any port", () => {
    for (const host of ["localhost:3141", "127.0.0.1:3141", "localhost:5173", "[::1]:3141"]) {
      assert.equal(isTrustedHost(req({ host })), true, `expected trusted: ${host}`);
    }
  });

  it("rejects untrusted Hosts (rebinding target domains)", () => {
    for (const host of ["attacker.com", "evil.example.com:3141", "localhost.evil.com"]) {
      assert.equal(isTrustedHost(req({ host })), false, `expected rejected: ${host}`);
    }
  });

  it("allows raw IP-literal Hosts", () => {
    assert.equal(isTrustedHost(req({ host: "192.168.1.5:3141" })), true);
  });

  it("honors the bound HOST env and PI_WEB_TRUSTED_HOSTS", () => {
    process.env.HOST = "my-box.lan";
    process.env.PI_WEB_TRUSTED_HOSTS = "extra.internal, another.host";
    assert.equal(getTrustedHostnames().has("my-box.lan"), true);
    assert.equal(isTrustedHost(req({ host: "my-box.lan:3141" })), true);
    assert.equal(isTrustedHost(req({ host: "extra.internal:3141" })), true);
    assert.equal(isTrustedHost(req({ host: "another.host" })), true);
    assert.equal(isTrustedHost(req({ host: "unlisted.lan" })), false);
  });
});
