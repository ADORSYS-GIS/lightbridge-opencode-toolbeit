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
  wakeSubscriptionsDir,
  wakeWatchesDir,
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
  GITHUB_PAGE_SIZE,
  summarize,
  TransportFailure,
  type CheckRunsPage,
  type CheckRunsRequest,
  type CommentPage,
  type CommentPageRequest,
  type GitHubTransport,
  type GitHubTransportOptions,
  type PullRequestRequest,
  type PullRequestSnapshot,
  type TimelinePage,
  type TimelineRequest,
  type TransportFailureKind,
  type WorkflowRunsPage,
  type WorkflowRunsRequest
} from "./github.js";

export {
  DEFAULT_LOOP_POLICY,
  decideWake,
  initialLoopState,
  isIgnoredAuthor,
  normalizeAuthors,
  ORIGINATED_TTL_MS,
  OriginatedSet,
  type LoopPolicy,
  type WakeDecision,
  type WakeSuppressionReason
} from "./loop.js";

export { pollSource, type SourceContext, type SourceResult } from "./sources.js";

export {
  backoffMs,
  buildNotice,
  createPoller,
  matchesMention,
  negotiatedIntervalMs,
  WATCH_TTL_MS,
  type Poller,
  type PollerDeps,
  type PollOutcome,
  type PollStatus
} from "./poller.js";

export {
  initialSubscriberState,
  initialWatchState,
  isSubscriptionID,
  newSubscriptionID,
  SubscriptionStore,
  subscriptionLabel,
  targetLabel,
  targetOf,
  watchFileFor,
  watchKey,
  WatchStore,
  type LegacyWatchSeed,
  type StoreOptions
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

export {
  WAKE_SOURCE_KINDS,
  type LoopState,
  type SourceState,
  type SubscriberState,
  type SubscriptionRecord,
  type WakeCursor,
  type WakeEvent,
  type WakeEventKind,
  type WakeNotice,
  type WakeSourceKind,
  type WakeSubscription,
  type WatchRecord,
  type WatchState,
  type WatchTarget
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
