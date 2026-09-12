export const PRODUCT_DESIGN_SKILL_NAME = "product-design";

export const PRODUCT_DESIGN_REQUIRED_TOOLS = [
  "product_design_imagegen",
  "product_design_screenshot",
] as const;

export function syncProductDesignSkillAuthorization(
  allowedSkills: readonly string[],
  allowedTools: readonly string[],
  enabled: boolean,
): { allowedSkills: string[]; allowedTools: string[] } {
  const requiredTools = new Set<string>(PRODUCT_DESIGN_REQUIRED_TOOLS);
  const nextAllowedSkills = enabled
    ? [...new Set([...allowedSkills, PRODUCT_DESIGN_SKILL_NAME])]
    : allowedSkills.filter((skillName) => skillName !== PRODUCT_DESIGN_SKILL_NAME);
  const nextAllowedTools = enabled
    ? [...new Set([...allowedTools, ...PRODUCT_DESIGN_REQUIRED_TOOLS])]
    : allowedTools.filter((toolName) => !requiredTools.has(toolName));

  return {
    allowedSkills: nextAllowedSkills,
    allowedTools: nextAllowedTools,
  };
}
