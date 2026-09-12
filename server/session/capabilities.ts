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

/** 中央 capability registry。Product Design 不读取模型身份。 */
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

// 当前唯一 backend registration。未来 Grok 只需新增另一条 binding/backend。
registerMainModelCapabilityBinding({
  id: CODEX_IMAGEGEN_BACKEND_ID,
  selector: { provider: CODEX_PROVIDER },
  capabilities: {
    productDesign: true,
    imageInput: true,
    imageGeneration: true,
  },
  nativeImageGenerationTool: "codex_imagegen",
  imageGeneration: codexImageBackend,
});
