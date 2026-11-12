import { Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";

import { createTokenSource, type TokenSource } from "./auth.js";
import {
  parseWakeOptions,
  resolveStateRoot,
  resolveWakeStateDir,
  wakeSubscriptionsDir,
  wakeWatchesDir,
  type WakeOptions
} from "./config.js";
import { createGitHubTransport, type GitHubTransport } from "./github.js";
import {
  captureHostContext,
  createEffectLogger,
  DEFAULT_LOG_LEVEL,
  type Logger,
  type LogLevel,
  resolveLogLevel,
  runInHost
} from "./logging.js";
import { createPoller, type Poller } from "./poller.js";
import { resolveWakeProject } from "./project.js";
import { SubscriptionStore, WatchStore } from "./state.js";
import { registerWakeTools } from "./tools.js";
import type { WakeNotice, WakeProject } from "./types.js";

/** Stable plugin id. v2 requires one and keys storage/registrations by it. */
export const PLUGIN_ID = "vymalo.session-wake";

/** The exact shape `ctx.session.synthetic` accepts, brands included. */
type SyntheticInput = Parameters<Plugin.Context["session"]["synthetic"]>[0];

export interface SessionWakePluginFactoryOptions {
  /** Override the logger (tests). Defaults to the host's Effect logger. */
  readonly logger?: Logger;
  /** Replace the GitHub transport (tests). */
  readonly transport?: GitHubTransport;
  /** Replace the wake seam (tests). Defaults to `ctx.session.synthetic`. */
  readonly deliver?: (notice: WakeNotice) => Promise<void>;
  /** Replace the token source (tests). Defaults to `gh auth token`. */
  readonly tokenSource?: TokenSource;
  readonly fetchImpl?: typeof fetch;
  /** Override the STATE directory (tests, or a caller with its own state). */
  readonly stateDir?: string;
  /** Override the project identity recorded on new subscriptions (tests). */
  readonly project?: WakeProject;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  /** Observe the poller (tests). */
  readonly onPoller?: (poller: Poller) => void;
}

/**
 * Build the OpenCode v2 plugin.
 *
 * Two registrations plus one background fiber:
 *
 *  - `tool.transform` adds `wake_subscribe` / `wake_unsubscribe` / `wake_list` /
 *    `wake_next`. Each handler reads the calling `Tool.Context.sessionID`, so a
 *    watch is owned by the session that created it and no other session can
 *    list, drain or remove it.
 *  - A poller started in the plugin scope (stopped by the release action) walks
 *    the durable subscriptions, fetches only what changed, and on a new comment
 *    calls `ctx.session.synthetic({ resume: true })` for the owning session.
 *    That call is the only way a plugin can put input into a session that is
 *    already running — `experimental.idle` documents that synthetic input
 *    admitted in the hook runs in the same execution instead of going idle, and
 *    `resume: true` is what asks for that wake.
 *
 * Nothing here writes to GitHub: the transport exposes a single GET.
 */
export function createSessionWakePlugin(
  factoryOptions: SessionWakePluginFactoryOptions = {}
): Plugin.Plugin {
  return Plugin.define({
    id: PLUGIN_ID,
    effect: Effect.fn(function* (ctx) {
      const logLevel: LogLevel =
        resolveLogLevel(ctx.options.logLevel) ??
        resolveLogLevel(process.env.OPENCODE_LOG_LEVEL) ??
        DEFAULT_LOG_LEVEL;

      // Captured once, inside the plugin's own fiber: it is what both the logger
      // and the poller's wake seam need to reach the host runtime.
      const hostContext = yield* captureHostContext;

      let logger = factoryOptions.logger;
      if (!logger) {
        logger = createEffectLogger(hostContext, () => logLevel);
      }
      const log = logger;

      if (ctx.options.enabled === false) {
        log.info("session_wake_disabled", {});
        return;
      }

      const options: WakeOptions = parseWakeOptions({
        ...(ctx.options as Record<string, unknown>),
        ...(factoryOptions.stateDir !== undefined ? { stateDir: factoryOptions.stateDir } : {})
      });

      // Captured once: every subscription this instance creates records it, so
      // a later session in the same project can adopt the watch after a restart.
      const project =
        factoryOptions.project ??
        resolveWakeProject((ctx as unknown as { location?: unknown }).location);

      const stateDir = options.stateDir ?? resolveWakeStateDir(resolveStateRoot());
      const store = new SubscriptionStore({
        dir: wakeSubscriptionsDir(stateDir),
        logger: log,
        now: factoryOptions.now
      });
      const watches = new WatchStore({
        dir: wakeWatchesDir(stateDir),
        logger: log,
        now: factoryOptions.now
      });

      const tokenSource =
        factoryOptions.tokenSource ??
        createTokenSource({
          command: options.tokenCommand,
          ...(factoryOptions.now !== undefined ? { now: factoryOptions.now } : {})
        });
      const transport =
        factoryOptions.transport ??
        createGitHubTransport({
          token: tokenSource,
          apiBase: options.apiBase,
          ...(factoryOptions.fetchImpl !== undefined
            ? { fetchImpl: factoryOptions.fetchImpl }
            : {}),
          ...(factoryOptions.now !== undefined ? { now: factoryOptions.now } : {})
        });

      // The wake seam. `synthetic` is a host client operation: it needs the
      // host's Effect context, which is why the poller (plain async) reaches it
      // through `runInHost` rather than calling it directly.
      const deliver =
        factoryOptions.deliver ??
        (async (notice: WakeNotice): Promise<void> => {
          const input: SyntheticInput = {
            sessionID: notice.sessionID as SyntheticInput["sessionID"],
            text: notice.text,
            description: notice.description,
            metadata: {
              source: PLUGIN_ID,
              subscriptionID: notice.subscriptionID,
              watchSource: notice.source,
              thread: notice.thread,
              count: notice.count,
              untrusted: true
            },
            delivery: "queue",
            resume: notice.resume
          };
          await runInHost(hostContext, ctx.session.synthetic(input));
        });

      const poller = createPoller({
        store,
        watches,
        transport,
        deliver,
        logger: log,
        options,
        ...(factoryOptions.now !== undefined ? { now: factoryOptions.now } : {}),
        ...(factoryOptions.sleep !== undefined ? { sleep: factoryOptions.sleep } : {}),
        ...(factoryOptions.random !== undefined ? { random: factoryOptions.random } : {})
      });
      factoryOptions.onPoller?.(poller);

      yield* ctx.tool.transform((editor) => {
        registerWakeTools(editor, { store, poller, options, logger: log, project });
      });

      // Started in the plugin scope and stopped when the scope closes, so the
      // timer can never outlive the host that owns it.
      yield* Effect.acquireRelease(
        Effect.promise(() => poller.start()),
        () => Effect.sync(() => poller.stop())
      );

      log.info("session_wake_started", {
        stateDir,
        projectID: project.id,
        projectDirectory: project.directory,
        intervalMs: options.intervalMs,
        minIntervalMs: options.minIntervalMs,
        maxIntervalMs: options.maxIntervalMs,
        tokenCommand: tokenSource.describe()
      });
    })
  });
}

export const OpencodeSessionWakePlugin: Plugin.Plugin = createSessionWakePlugin();

export default OpencodeSessionWakePlugin;
