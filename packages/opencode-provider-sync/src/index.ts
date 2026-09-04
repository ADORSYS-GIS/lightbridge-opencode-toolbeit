// Slim public entry. Consumers that need the full surface (host-config
// wiring helpers, cache, scheduler) import from
// `@vymalo/opencode-provider-sync/lib`. This package registers no OpenCode
// `Plugin` of its own, so unlike a plugin package's `index.ts` it is not
// discovered/loaded by the OpenCode host — it exists purely so the common
// "." import shape used across this workspace's packages still resolves.
export {
  ProviderModelSyncEngine,
  type ProviderModelSyncEngineOptions,
  type ProviderServerConfig,
  type ProviderSyncEngineConfigInput
} from "./engine.js";
export { FileCacheStore, resolveCacheDir } from "./cache.js";
export { buildModelsUrl, fetchModels } from "./model-discovery.js";
export { diffModels, normalizeModelId, normalizeModelList } from "./model-normalization.js";
export type { TokenSet } from "@vymalo/opencode-auth-core/lib";
