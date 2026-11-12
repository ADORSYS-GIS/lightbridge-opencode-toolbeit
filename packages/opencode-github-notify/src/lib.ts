export {
  createOpencodeGithubNotifyPlugin,
  OpencodeGithubNotifyPlugin,
  type OpenCodePluginFactoryOptions,
  PLUGIN_ID,
  toEpochMs
} from "./opencode.js";

export {
  ConfigError,
  DEFAULT_API_BASE_URL,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_TOKEN_COMMAND,
  MIN_POLL_INTERVAL_SECONDS,
  parseWatchRef,
  resolveOptions
} from "./config.js";

export {
  classifyFailure,
  type Comment,
  createGitHubClient,
  createTokenProvider,
  type GitHubClient,
  GitHubError,
  type GitHubErrorKind,
  type PageResult,
  parseComment,
  parseNextLink,
  type TokenProvider
} from "./github.js";

export {
  BusyError,
  CursorError,
  createInbox,
  type Inbox,
  initialCursor,
  type WatchBatch,
  type WatchStatus
} from "./inbox.js";

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

export { createNotifier, NEXT_TOOL_NAME, type Notifier, type SendNotice } from "./plugin.js";

export {
  escapeUntrusted,
  renderBatches,
  renderEvent,
  renderNotice,
  UNTRUSTED_PREAMBLE,
  UNTRUSTED_TAG
} from "./render.js";

export { resolveStateDir, resolveStateRoot } from "./store.js";

export {
  diffListing,
  matchesFilter,
  type PollOutcome,
  pollWatch,
  type WatchState
} from "./thread.js";

export { createToolInfos, registerTools, TOOL_NAMESPACE } from "./tools.js";

export type {
  AuthConfig,
  EventKind,
  FilterConfig,
  NotifyMode,
  ResolvedOptions,
  ThreadEvent,
  WatchConfig
} from "./types.js";
