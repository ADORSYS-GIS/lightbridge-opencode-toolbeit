export {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_SYNC_INTERVAL_MINUTES,
  type OAuth2ModelSyncConfig,
  type OAuth2ModelSyncConfigInput,
  type OAuthServerConfig,
  type OAuthServerConfigInput,
  validateConfig
} from "./config.js";

export {
  createJsonConsoleLogger,
  type LogLevel,
  type Logger,
  type TokenSet
} from "@vymalo/opencode-auth-core/lib";

export { buildModelsUrl, fetchModels } from "./model-discovery.js";

export { diffModels, normalizeModelId, normalizeModelList } from "./model-normalization.js";

export { OAuth2ModelSyncPlugin, type PluginOptions } from "./plugin.js";

export { resolveCacheDir, FileCacheStore } from "./cache.js";

export { createOpencodeOauth2Plugin } from "./opencode.js";
export type { OpenCodePluginFactoryOptions } from "./opencode.js";

export type {
  CachedServerState,
  ModelDiff,
  NormalizedModel,
  RawModel,
  ServerSnapshot
} from "./types.js";
