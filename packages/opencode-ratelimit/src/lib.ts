export {
  createOpencodeRatelimitPlugin,
  OpencodeRatelimitPlugin,
  type OpenCodePluginFactoryOptions,
  PLUGIN_ID
} from "./opencode.js";

export {
  DEFAULT_HEADER_PREFIX,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_SCOPE,
  parseRateLimitOptions,
  selectTier
} from "./config.js";

export { parseRateLimit } from "./headers.js";

export {
  captureHostContext,
  createEffectLogger,
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  type LogFields,
  type Logger,
  type LogLevel,
  resolveLogLevel
} from "./logging.js";

export {
  type BucketRef,
  collectOptIns,
  createProviderState,
  createRateLimiter,
  DEFAULT_BACKOFF_MS,
  type ProviderRateState,
  type RateLimitDeps,
  type RateLimiter,
  type RateStateStore,
  type RetryDecision
} from "./plugin.js";

export type {
  RateLimitAction,
  RateLimitOptions,
  RateLimitScope,
  RateLimitSnapshot,
  RateLimitTier
} from "./types.js";
