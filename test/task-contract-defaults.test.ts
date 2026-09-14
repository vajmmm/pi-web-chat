import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getDefaultTaskContractFields } from "../server/contracts/index.ts";

describe("role-aware default TaskContract fields", () => {
  it("Researcher defaults to read-only analysis evidence semantics", () => {
    assert.deepEqual(getDefaultTaskContractFields("researcher"), {
      expectedEffects: ["analysis"],
      scope: { include: [], exclude: [] },
      acceptanceCriteria: ["返回请求的事实结论、关键证据与出处"],
    });
  });

  it("Developer and Verifier keep the existing implementation-oriented fallback", () => {
    assert.deepEqual(getDefaultTaskContractFields("developer", ["实现对应需求并通过自测"]), {
      scope: { include: ["*"], exclude: [] },
      acceptanceCriteria: ["实现对应需求并通过自测"],
    });
    assert.deepEqual(getDefaultTaskContractFields("verifier"), {
      scope: { include: ["*"], exclude: [] },
      acceptanceCriteria: ["完成指定实现并自测通过"],
    });
  });
});
