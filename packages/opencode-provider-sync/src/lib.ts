export {
  ProviderModelSyncEngine,
  type ProviderModelSyncEngineOptions,
  type ProviderServerConfig,
  type ProviderSyncEngineConfigInput
} from "./engine.js";

export {
  createJsonConsoleLogger,
  type LogLevel,
  type Logger,
  type TokenSet
} from "@vymalo/opencode-auth-core/lib";

export { buildModelsUrl, fetchModels, type ModelDiscoveryOptions } from "./model-discovery.js";

export { diffModels, normalizeModelId, normalizeModelList } from "./model-normalization.js";

export { resolveCacheDir, FileCacheStore } from "./cache.js";

export { startScheduler, type SchedulerHandle, type SchedulerOptions } from "./scheduler.js";

export type {
  CachedServerState,
  ModelDiff,
  NormalizedModel,
  RawModel,
  ServerSnapshot
} from "./types.js";

// Host-config wiring helpers for an OpenCode plugin composing the engine
// above. Each consumer supplies its own config-key literals and (optionally)
// a Responses-API SSE repair hook — see opencode-helpers.ts's module doc.
export {
  applyResponsesApiOptions,
  collectManagedProviders,
  mergeDiscoveredModels,
  parseOAuthExtension,
  parsePluginConfigServers,
  propagateCachedBearer,
  resolveProviderNpm,
  runtimeSignature,
  type ApplyResponsesApiOptionsHooks,
  type CollectManagedProvidersOptions,
  type ManagedProviders,
  type OpenCodeConfig,
  type OpenCodeModelConfig,
  type OpenCodeProviderConfig,
  type OpenCodeProviderMap,
  type ProviderExtension,
  type ProviderServerConfigInput
} from "./opencode-helpers.js";
