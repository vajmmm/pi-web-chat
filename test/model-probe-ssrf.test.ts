import assert from "node:assert/strict";
import { promises as dns } from "node:dns";
import { afterEach, describe, it, mock } from "node:test";

const { probeCustomModels, isPrivateOrReservedAddress } = await import(
  "../server/models-config.ts"
);

afterEach(() => {
  mock.restoreAll();
});

describe("isPrivateOrReservedAddress", () => {
  it("flags loopback/private/link-local/reserved literals", () => {
    for (const ip of [
      "127.0.0.1",
      "127.0.0.2",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "100.64.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      assert.equal(isPrivateOrReservedAddress(ip), true, `expected private: ${ip}`);
    }
  });

  it("allows ordinary public literals", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111"]) {
      assert.equal(isPrivateOrReservedAddress(ip), false, `expected public: ${ip}`);
    }
  });
});

describe("probeCustomModels SSRF guard", () => {
  it("rejects loopback/private IP-literal baseUrls without fetching", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("fetch must not be called for a rejected probe target");
    });
    for (const baseUrl of [
      "http://127.0.0.1:8000",
      "http://localhost:11434",
      "http://192.168.1.1",
      "http://10.0.0.1",
      "http://[::1]:8000",
      "http://169.254.169.254/latest",
      "http://172.16.5.5/v1",
    ]) {
      await assert.rejects(
        () => probeCustomModels(baseUrl, "sk-test"),
        /SSRF|私有|回环|保留|拒绝/,
        `expected reject: ${baseUrl}`,
      );
    }
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it("rejects a domain that resolves to a private address (mock lookup)", async () => {
    mock.method(dns, "lookup", async () => [{ address: "10.1.2.3", family: 4 }]);
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("fetch must not be called");
    });
    await assert.rejects(
      () => probeCustomModels("https://internal.example.com/v1", "sk"),
      /受限地址|SSRF|私有|回环|保留/,
    );
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it("rejects when DNS resolution fails", async () => {
    mock.method(dns, "lookup", async () => {
      throw new Error("ENOTFOUND");
    });
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("fetch must not be called");
    });
    await assert.rejects(
      () => probeCustomModels("https://missing.example.com/v1", "sk"),
      /DNS 解析失败|SSRF/,
    );
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it("rejects a baseUrl that is not a URL", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("fetch must not be called");
    });
    await assert.rejects(() => probeCustomModels("not a url"), /无效的 Base URL/);
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it("allows a public https provider (lookup + fetch mocked, no real network)", async () => {
    mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-4o" }] }),
    }));
    const out = await probeCustomModels("https://api.openai.com/v1", "sk-test");
    assert.equal(out.models[0]?.id, "gpt-4o");
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.match(String(fetchMock.mock.calls[0]!.arguments[0]), /api\.openai\.com\/v1\/models/);
  });
});
