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

  it("rejects raw public/private IP-literal Origins (CSWSH from http://<ip>/)", () => {
    for (const origin of [
      "http://1.2.3.4",
      "http://1.2.3.4:3141",
      "http://192.168.1.5:3141",
      "http://10.0.0.9",
      "http://127.0.0.2:8080",
      "http://[2001:db8::1]:3141",
    ]) {
      assert.equal(isTrustedOrigin(req({ origin })), false, `expected rejected: ${origin}`);
    }
  });

  it("still allows the actual bind-address Origin (HOST env) and allowlisted hosts", () => {
    process.env.HOST = "192.168.1.5";
    process.env.PI_WEB_TRUSTED_HOSTS = "box.lan";
    assert.equal(isTrustedOrigin(req({ origin: "http://192.168.1.5:3141" })), true);
    assert.equal(isTrustedOrigin(req({ origin: "http://box.lan:3141" })), true);
    // A different private IP is still not trusted.
    assert.equal(isTrustedOrigin(req({ origin: "http://192.168.1.6:3141" })), false);
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
