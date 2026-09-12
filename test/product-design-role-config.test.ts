import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PRODUCT_DESIGN_REQUIRED_TOOLS,
  PRODUCT_DESIGN_SKILL_NAME,
  syncProductDesignSkillAuthorization,
} from "../src/lib/role-config.ts";

describe("Product Design RoleConfig UI authorization", () => {
  it("启用 Skill 时在同一次更新中补齐 Skill 和两个 required tools", () => {
    const next = syncProductDesignSkillAuthorization(
      ["existing-skill"],
      ["read", PRODUCT_DESIGN_REQUIRED_TOOLS[0]],
      true,
    );

    assert.deepEqual(next.allowedSkills, ["existing-skill", PRODUCT_DESIGN_SKILL_NAME]);
    assert.deepEqual(next.allowedTools, [
      "read",
      PRODUCT_DESIGN_REQUIRED_TOOLS[0],
      PRODUCT_DESIGN_REQUIRED_TOOLS[1],
    ]);
  });

  it("关闭 Skill 时移除 Product Design 专属工具并保留其他授权", () => {
    const next = syncProductDesignSkillAuthorization(
      [PRODUCT_DESIGN_SKILL_NAME, "existing-skill"],
      ["read", ...PRODUCT_DESIGN_REQUIRED_TOOLS, "custom_tool"],
      false,
    );

    assert.deepEqual(next.allowedSkills, ["existing-skill"]);
    assert.deepEqual(next.allowedTools, ["read", "custom_tool"]);
  });

  it("重复启用保持授权列表去重且不改变其他工具顺序", () => {
    const next = syncProductDesignSkillAuthorization(
      [PRODUCT_DESIGN_SKILL_NAME],
      ["read", PRODUCT_DESIGN_REQUIRED_TOOLS[1], PRODUCT_DESIGN_REQUIRED_TOOLS[0]],
      true,
    );

    assert.deepEqual(next.allowedSkills, [PRODUCT_DESIGN_SKILL_NAME]);
    assert.deepEqual(next.allowedTools, [
      "read",
      PRODUCT_DESIGN_REQUIRED_TOOLS[1],
      PRODUCT_DESIGN_REQUIRED_TOOLS[0],
    ]);
  });
});
