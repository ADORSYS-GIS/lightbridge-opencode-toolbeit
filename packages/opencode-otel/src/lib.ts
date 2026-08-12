export {
  createOtelPlugin,
  OpencodeOtelPlugin,
  type OtelPluginFactoryOptions
} from "./opencode.js";

export {
  type EnvSource,
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
