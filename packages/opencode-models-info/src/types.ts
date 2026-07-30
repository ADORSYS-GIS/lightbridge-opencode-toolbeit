export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface OpenRouterPricing {
  prompt?: string;
  completion?: string;
  request?: string;
  image?: string;
  input_cache_read?: string;
  input_cache_write?: string;
}

export type OpenRouterModality = "text" | "image" | "audio" | "video" | "pdf" | "file";

export interface OpenRouterArchitecture {
  input_modalities?: OpenRouterModality[];
  output_modalities?: OpenRouterModality[];
  modality?: string;
  tokenizer?: string;
}

export interface OpenRouterTopProvider {
  max_completion_tokens?: number;
  context_length?: number;
}

export interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: OpenRouterPricing;
  architecture?: OpenRouterArchitecture;
  top_provider?: OpenRouterTopProvider;
  supported_parameters?: string[];
  /**
   * Non-standard extension: not part of OpenRouter's own `/models` shape, but
   * the field mapping is deliberately partial (see the package README), so a
   * catalog is free to add fields the plugin knows how to use. Lets a
   * catalog flag a model as internal/restricted independent of its
   * modalities — see `modelsInfoHideInternal`. Absent means "the catalog
   * doesn't know," same as every other capability flag here: never inferred,
   * never defaulted to `false`.
   */
  internal?: boolean;
}

export interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

export interface MetaProviderOptions {
  modelsInfoUrl: string;
  modelsInfoTtlSeconds: number;
  modelsInfoTimeoutMs: number;
  modelsInfoHeaders?: Record<string, string>;
  modelsInfoOverwrite?: string[];
  modelsInfoHideTextOnly: boolean;
  /**
   * Deletes a matched model from `provider.models` when the catalog reports
   * `internal: true` for it. Independent of `modelsInfoHideTextOnly` — a
   * model's modality says nothing about whether it's internal, and
   * conflating the two hides legitimate text-only external models. Does
   * NOT affect the unmatched-model deletion path, which stays governed
   * solely by `modelsInfoHideTextOnly`.
   */
  modelsInfoHideInternal: boolean;
  modelsInfoFormat: "openrouter";
}

export interface CachedModelsRecord {
  fetchedAt: number;
  ttlSeconds: number;
  etag?: string;
  models: OpenRouterModel[];
}

export interface FetchModelsResult {
  status: "ok" | "not-modified" | "error";
  etag?: string;
  models?: OpenRouterModel[];
  error?: string;
}
