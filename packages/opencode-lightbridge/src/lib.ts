export {
  createLightbridgePlugin,
  LightbridgePlugin,
  type LightbridgePluginFactoryOptions
} from "./opencode.js";

export {
  LightbridgeRuntime,
  LIGHTBRIDGE_IDENTITY,
  DEFAULT_CACHE_NAMESPACE,
  DEFAULT_PROJECT_KEY,
  ROOT_CACHE_NAMESPACE,
  ROOT_CACHE_SEGMENT,
  lightbridgeCacheDir,
  rootCacheDir,
  type LightbridgeRuntimeFactory,
  type LightbridgeRuntimeLike,
  type LightbridgeRuntimeOptions
} from "./plugin.js";

export {
  hasOAuth2Conflict,
  needsProjectToken,
  oauth2ManagedProviderIds,
  parseLightbridgeOptions,
  type LightbridgeGatewayOptions,
  type LightbridgeOptions,
  type LightbridgeRegisterOptions,
  type OpenCodeConfigLike,
  type ParsedLightbridgeOptions
} from "./config.js";

export { migrateRootTokenIfNeeded } from "./migration.js";
