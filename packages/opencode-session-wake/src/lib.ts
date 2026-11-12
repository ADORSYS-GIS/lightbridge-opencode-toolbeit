export {
  createSessionWakePlugin,
  OpencodeSessionWakePlugin,
  PLUGIN_ID,
  type SessionWakePluginFactoryOptions
} from "./opencode.js";

export {
  clampInterval,
  DEFAULT_API_BASE,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_PENDING,
  DEFAULT_MAX_INTERVAL_MS,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_SEEN_LIMIT,
  DEFAULT_TOKEN_COMMAND,
  parseWakeOptions,
  resolveStateRoot,
  resolveWakeStateDir,
  STATE_NAMESPACE,
  type WakeOptions
} from "./config.js";

export {
  createTokenSource,
  execFileRunner,
  TokenError,
  type TokenCommandRunner,
  type TokenSource,
  type TokenSourceOptions
} from "./auth.js";

export {
  createGitHubTransport,
  TransportFailure,
  type CommentPage,
  type CommentPageRequest,
  type GitHubTransport,
  type GitHubTransportOptions,
  type TransportFailureKind
} from "./github.js";

export {
  backoffMs,
  buildNotice,
  createPoller,
  matchesMention,
  type Poller,
  type PollerDeps,
  type PollOutcome,
  type PollStatus
} from "./poller.js";

export {
  initialState,
  isSubscriptionID,
  newSubscriptionID,
  SubscriptionStore,
  type SubscriptionStoreOptions
} from "./state.js";

export {
  createWakeToolInfos,
  DEFAULT_NEXT_LIMIT,
  MAX_BODY_CHARS,
  registerWakeTools,
  WAKE_TOOL_SCHEMAS,
  type WakeToolContext,
  type WakeToolDeps,
  type WakeToolEditor,
  type WakeToolInfo
} from "./tools.js";

export type {
  SubscriptionRecord,
  SubscriptionState,
  WakeCursor,
  WakeETag,
  WakeEvent,
  WakeNotice,
  WakeSourceKind,
  WakeSubscription
} from "./types.js";

export {
  captureHostContext,
  createEffectLogger,
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  type Logger,
  type LogFields,
  type LogLevel,
  resolveLogLevel,
  runInHost
} from "./logging.js";
