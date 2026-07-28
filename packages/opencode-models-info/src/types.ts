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
