import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

describe("Product Design Skill packaging", () => {
  it("源码 skill、package files 和 build 复制边界均已声明", () => {
    const root = process.cwd();
    const sourceSkill = join(root, ".pi", "skills", "product-design", "SKILL.md");
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      files?: string[];
    };
    const buildScript = readFileSync(join(root, "scripts", "build.mjs"), "utf8");
    const skill = readFileSync(sourceSkill, "utf8");

    assert.equal(existsSync(sourceSkill), true);
    assert.match(skill, /get-context[\s\S]*ideate[\s\S]*image-to-code[\s\S]*design-qa/);
    assert.match(skill, /visual reference != source visual truth/);
    assert.match(skill, /Faithful implementation \/ clone[\s\S]*不调用 `ideate`/);
    assert.match(skill, /Redesign \/ improve \/ explore[\s\S]*`referenceImages`/);
    assert.match(skill, /已选择的生成设计[\s\S]*source visual truth/);
    assert.ok(packageJson.files?.includes(".pi"));
    assert.ok(packageJson.files?.includes("dist"));
    assert.ok(buildScript.includes('cpSync(join(root, ".pi", "skills"), join(dist, ".pi", "skills")'));
    assert.ok(buildScript.includes('join(dist, ".pi", "skills", "product-design", "SKILL.md")'));
  });
});
