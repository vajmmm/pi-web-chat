import type { MainModelCapabilities } from "../../shared/protocol.ts";
import {
  CODEX_IMAGEGEN_BACKEND_ID,
  CODEX_PROVIDER,
  codexImageBackend,
} from "../codex-imagegen-extension.ts";
import type { ProductDesignImageBackend } from "../product-design-image-backend.ts";

export const PRODUCT_DESIGN_SKILL_NAME = "product-design";
export const PRODUCT_DESIGN_IMAGEGEN_TOOL_NAME = "product_design_imagegen";
export const PRODUCT_DESIGN_SCREENSHOT_TOOL_NAME = "product_design_screenshot";
export const WEB_SEARCH_TOOL_NAME = "web_search";

export type MainModelIdentity = {
  provider?: string;
  id: string;
};


export interface MainModelCapabilityBinding {
  id: string;
  selector: {
    provider: string;
    modelIds?: readonly string[];
  };
  capabilities: MainModelCapabilities;
  nativeImageGenerationTool?: string;
  imageGeneration?: ProductDesignImageBackend;
}

const bindings: MainModelCapabilityBinding[] = [];

/** 中央模型 capability registry；工具门控通过解析结果工作，不读取模型身份。 */
export function registerMainModelCapabilityBinding(binding: MainModelCapabilityBinding): void {
  const existing = bindings.findIndex((candidate) => candidate.id === binding.id);
  if (existing >= 0) bindings.splice(existing, 1);
  bindings.push(binding);
}

export function unregisterMainModelCapabilityBinding(id: string): void {
  const index = bindings.findIndex((binding) => binding.id === id);
  if (index >= 0) bindings.splice(index, 1);
}

export function resolveMainModelCapabilityBinding(
  model: MainModelIdentity | null | undefined,
): MainModelCapabilityBinding | undefined {
  if (!model?.provider) return undefined;
  return [...bindings].reverse().find((binding) => {
    if (binding.selector.provider !== model.provider) return false;
    return !binding.selector.modelIds || binding.selector.modelIds.includes(model.id);
  });
}

const DISABLED_CAPABILITIES: MainModelCapabilities = Object.freeze({
  productDesign: false,
  imageInput: false,
  imageGeneration: false,
  webSearch: false,
});

export function getMainSessionCapabilities(
  model: MainModelIdentity | null | undefined,
): MainModelCapabilities {
  return resolveMainModelCapabilityBinding(model)?.capabilities ?? DISABLED_CAPABILITIES;
}

/** 当前 Product Design gate policy，不约束 capability 数据模型本身。 */
export function canUseProductDesign(capabilities: MainModelCapabilities): boolean {
  return capabilities.productDesign && capabilities.imageInput && capabilities.imageGeneration;
}

export function filterProductDesignSkills(
  skillNames: readonly string[] | undefined,
  productDesignAvailable: boolean,
): string[] {
  return (skillNames ?? []).filter(
    (skillName) => productDesignAvailable || skillName !== PRODUCT_DESIGN_SKILL_NAME,
  );
}

export function hasProductDesignSkill(skillNames: readonly string[] | undefined): boolean {
  return (skillNames ?? []).includes(PRODUCT_DESIGN_SKILL_NAME);
}

/** 最终 active tools 的 capability gate；RoleConfig.allowedTools 本身不被修改。 */
export function filterCapabilityGatedTools(
  toolNames: readonly string[],
  capabilities: MainModelCapabilities,
): string[] {
  return toolNames.filter(
    (toolName) => toolName !== WEB_SEARCH_TOOL_NAME || capabilities.webSearch,
  );
}

// Product Design backend 与 web_search capability 复用同一套模型 binding。
registerMainModelCapabilityBinding({
  id: CODEX_IMAGEGEN_BACKEND_ID,
  selector: { provider: CODEX_PROVIDER },
  capabilities: {
    productDesign: true,
    imageInput: true,
    imageGeneration: true,
    webSearch: true,
  },
  nativeImageGenerationTool: "codex_imagegen",
  imageGeneration: codexImageBackend,
});

registerMainModelCapabilityBinding({
  id: "xai-web-search",
  selector: { provider: "xai" },
  capabilities: {
    productDesign: false,
    imageInput: false,
    imageGeneration: false,
    webSearch: true,
  },
});
