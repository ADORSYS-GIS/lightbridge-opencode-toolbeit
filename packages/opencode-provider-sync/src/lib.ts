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

export {
  ModelCacheStore,
  ServerCredentialStore,
  ServerStateStore,
  resolveCacheDir,
  resolveStateDir,
  type StoredCredential,
  type StoredModels
} from "./cache.js";

export { startScheduler, type SchedulerHandle, type SchedulerOptions } from "./scheduler.js";

export type {
  CachedServerState,
  ModelDiff,
  NormalizedModel,
  RawModel,
  ServerSnapshot
} from "./types.js";

// Provider-editor wiring helpers for an OpenCode v2 plugin composing the
// engine above. Each consumer supplies its own `settings` opt-in key literals
// and passes its `ctx.options` — see opencode-helpers.ts's module doc.
export {
  applyResponsesApiSettings,
  collectManagedProviders,
  discoveredModelPlaceholder,
  mergeDiscoveredModels,
  parseOAuthExtension,
  parsePluginOptionsServers,
  propagateCachedBearer,
  resolveCachedBearer,
  resolveProviderPackage,
  runtimeSignature,
  upsertManagedProvider,
  type CollectManagedProvidersOptions,
  type HasProviderSettings,
  type ManagedProviders,
  type ModelInfo,
  type ProviderEditor,
  type ProviderExtension,
  type ProviderInfo,
  type ProviderServerConfigInput,
  type UpsertManagedProviderInput
} from "./opencode-helpers.js";
