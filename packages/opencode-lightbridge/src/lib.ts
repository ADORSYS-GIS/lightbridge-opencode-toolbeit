export {
  createLightbridgePlugin,
  LightbridgePlugin,
  PLUGIN_ID,
  type LightbridgePluginFactoryOptions,
  type LightbridgeRegisterHandle
} from "./opencode.js";

export {
  LightbridgeRuntime,
  LIGHTBRIDGE_IDENTITY,
  EXCHANGE_STATE_NAMESPACE,
  DEFAULT_PROJECT_KEY,
  ROOT_CACHE_NAMESPACE,
  ROOT_CACHE_SEGMENT,
  lightbridgeStateDir,
  rootCacheDir,
  rootStateDir,
  type LightbridgeRuntimeFactory,
  type LightbridgeRuntimeLike,
  type LightbridgeRuntimeOptions
} from "./plugin.js";

export {
  hasOAuth2Conflict,
  needsProjectToken,
  parseLightbridgeOptions,
  type LightbridgeGatewayOptions,
  type LightbridgeOptions,
  type LightbridgeRegisterOptions,
  type ParsedLightbridgeOptions,
  type ProviderLookup
} from "./config.js";
