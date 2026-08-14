export {
  createOtelPlugin,
  OpencodeOtelPlugin,
  type OtelPluginFactoryOptions
} from "./opencode.js";

export {
  type EnvSource,
  parseCommand,
  parseKeyValueList,
  resolveOtelConfig,
  signalUrl,
  SIGNALS
} from "./config.js";

export {
  buildResource,
  createProviders,
  type ExporterFactories,
  type TelemetryProviders
} from "./providers.js";

export { createInstruments, detectLanguage, type Instruments } from "./instruments.js";

export { type RecorderDeps, TelemetryRecorder } from "./recorder.js";

export {
  createTokenSource,
  DEFAULT_REFRESH_MS,
  EXPIRY_SKEW_MS,
  readJwtExpiry,
  type CommandRunner,
  type TokenSource,
  type TokenSourceOptions
} from "./token-source.js";

export { type ExporterLike, withFailureLogging } from "./export-logging.js";

export {
  DEFAULT_DEFERRED_TIMEOUT_MS,
  deferredAttribute,
  type DeferredAttribute
} from "./deferred.js";

export {
  installTracePropagation,
  type PropagationConfigInput,
  type ProviderConfigLike
} from "./propagation.js";

export {
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  fromOpenCodeLogLevel,
  type LogFields,
  type Logger,
  type LogLevel
} from "./logging.js";

export type {
  ExporterKind,
  MetricTemporality,
  OtelPluginOptions,
  ResolvedOtelConfig,
  SignalName
} from "./types.js";
