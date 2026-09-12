export type ProductDesignImageSize =
  | "auto"
  | "1024x1024"
  | "1536x1024"
  | "1024x1536";

export type ProductDesignImageQuality = "auto" | "low" | "medium" | "high";
export type ProductDesignImageBackground = "auto" | "opaque" | "transparent";
export type ProductDesignImageOutputFormat = "png" | "webp" | "jpeg";
export type ProductDesignImageThinking = "off" | "minimal" | "low" | "medium" | "high";

export type ProductDesignImageReference =
  | {
      path: string;
      mimeType?: string;
    }
  | {
      artifactRef: string;
      mimeType?: string;
    };

export interface ProductDesignImageGenerationParams {
  prompt: string;
  size?: ProductDesignImageSize;
  quality?: ProductDesignImageQuality;
  background?: ProductDesignImageBackground;
  outputFormat?: ProductDesignImageOutputFormat;
  thinking?: ProductDesignImageThinking;
  referenceImages?: ProductDesignImageReference[];
}

export interface ProductDesignImageGenerationContext {
  cwd: string;
  model?: { provider: string; id: string };
  getApiKeyForProvider: (provider: string) => Promise<string | undefined>;
  resolveArtifactPath?: (artifactRef: string) => string | null;
}

export interface ProductDesignGeneratedImage {
  id: string;
  base64: string;
  revisedPrompt?: string;
}

export interface ProductDesignImageGenerationResult {
  image: ProductDesignGeneratedImage;
  savedPath: string;
  mimeType: string;
  text: string;
  details: Record<string, unknown>;
}

export type ProductDesignImageGenerationUpdate = (result: {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}) => void;

export interface ProductDesignImageBackend {
  readonly id: string;
  generate(
    params: ProductDesignImageGenerationParams,
    signal: AbortSignal | undefined,
    onUpdate: ProductDesignImageGenerationUpdate | undefined,
    ctx: ProductDesignImageGenerationContext,
  ): Promise<ProductDesignImageGenerationResult>;
}
