import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { negotiateEncoding } from "../server/http/routes-static.ts";

describe("negotiateEncoding", () => {
  const available = { gzip: Buffer.from("g"), br: Buffer.from("b") };

  it("defaults to identity without Accept-Encoding", () => {
    assert.equal(negotiateEncoding(undefined, available), "identity");
    assert.equal(negotiateEncoding("", available), "identity");
  });

  it("selects gzip and brotli when offered", () => {
    assert.equal(negotiateEncoding("gzip", available), "gzip");
    assert.equal(negotiateEncoding("br", available), "br");
    assert.equal(negotiateEncoding("x-gzip", available), "gzip");
  });

  it("prefers brotli on equal weight and honors q-values", () => {
    assert.equal(negotiateEncoding("gzip, br", available), "br");
    assert.equal(negotiateEncoding("gzip;q=0.5, br;q=0.9", available), "br");
    assert.equal(negotiateEncoding("gzip;q=0.9, br;q=0.5", available), "gzip");
  });

  it("ignores encodings with q=0 and unsupported tokens", () => {
    assert.equal(negotiateEncoding("br;q=0, gzip", available), "gzip");
    assert.equal(negotiateEncoding("deflate", available), "identity");
    assert.equal(negotiateEncoding("identity", available), "identity");
  });

  it("honors wildcard and per-encoding availability", () => {
    assert.equal(negotiateEncoding("*", available), "br");
    assert.equal(negotiateEncoding("*", { gzip: Buffer.from("g") }), "gzip");
    assert.equal(negotiateEncoding("br", { gzip: Buffer.from("g") }), "identity");
    assert.equal(negotiateEncoding("*;q=0", available), "identity");
  });
});
