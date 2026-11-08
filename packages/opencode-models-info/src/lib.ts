export {
  createOpencodeModelsInfoPlugin,
  OpencodeModelsInfoPlugin,
  type OpenCodePluginFactoryOptions,
  PLUGIN_ID
} from "./opencode.js";

export {
  cacheKey,
  type CacheStore,
  FileCacheStore,
  isExpired,
  resolveCacheDir
} from "./cache.js";

export {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TTL_SECONDS,
  OVERWRITABLE_FIELDS,
  parseModelsInfoSettings
} from "./config.js";

export { fetchOpenRouterModels, type FetchOptions } from "./fetcher.js";

export {
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  type LogFields,
  type Logger,
  type LogLevel,
  resolveLogLevel
} from "./logging.js";

export {
  type ApplyResult,
  applyMetadata,
  type EnrichableModel,
  isAbsent,
  mapOpenRouterEntry,
  type ModelCost,
  type ModelMetadata
} from "./mapping.js";

export {
  createModelsInfoEngine,
  type EnrichDeps,
  type ListedModel,
  type ModelEditorLike,
  type ModelsInfoEngine,
  type ProviderEntry
} from "./plugin.js";

export type {
  CachedModelsRecord,
  FetchModelsResult,
  ModelsInfoSettings,
  OpenRouterArchitecture,
  OpenRouterModality,
  OpenRouterModel,
  OpenRouterModelsResponse,
  OpenRouterPricing,
  OpenRouterTopProvider
} from "./types.js";
