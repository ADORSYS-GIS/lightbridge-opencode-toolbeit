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

export {
  buildModelsUrl,
  fetchModels
} from "@vymalo/opencode-provider-sync/lib";

export {
  diffModels,
  normalizeModelId,
  normalizeModelList
} from "@vymalo/opencode-provider-sync/lib";

export { OAuth2ModelSyncPlugin, type PluginOptions } from "./plugin.js";

export { resolveCacheDir, resolveStateDir, ServerStateStore } from "./cache.js";

export { createOpencodeOauth2Plugin, PLUGIN_ID } from "./opencode.js";
export type { OAuth2RuntimeHandle, OpenCodePluginFactoryOptions } from "./opencode.js";

export { resolveLogLevel } from "./logging.js";

export { repairResponsesResponse } from "./responses-repair.js";

export type {
  CachedServerState,
  ModelDiff,
  NormalizedModel,
  RawModel,
  ServerSnapshot
} from "@vymalo/opencode-provider-sync/lib";
