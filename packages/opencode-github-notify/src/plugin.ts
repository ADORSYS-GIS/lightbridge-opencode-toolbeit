import {
  createGitHubClient,
  createTokenProvider,
  type GitHubClient,
  type TokenProvider
} from "./github.js";
import { createInbox, type Inbox, type InboxDeps } from "./inbox.js";
import type { Logger } from "./logging.js";
import { renderNotice } from "./render.js";
import { resolveStateDir } from "./store.js";
import { type PollOutcome, pollWatch, readWatchState } from "./thread.js";
import type { ResolvedOptions } from "./types.js";

/** The model-facing name of the delivery tool (namespace `github_messages`, tool `next`). */
export const NEXT_TOOL_NAME = "github_messages_next";

const MIN_TICK_MS = 1_000;

/** Queue a notice into a session. `resume` wakes an idle session. Rejects if refused. */
export type SendNotice = (sessionID: string, text: string, resume: boolean) => Promise<void>;

export interface NotifierDeps {
  readonly options: ResolvedOptions;
  readonly logger: Logger;
  readonly client?: GitHubClient;
  readonly token?: TokenProvider;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sendNotice?: SendNotice;
  readonly sessionStartedAt?: InboxDeps["sessionStartedAt"];
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface Notifier {
  readonly inbox: Inbox;
  readonly stateDir: string;
  /** Start the background poll loop (idempotent). */
  start(): void;
  /** Stop scheduling. An in-flight poll finishes; nothing new starts. */
  stop(): void;
  /** Poll every watch once now, then send notices. Exposed for tests and the first tick. */
  tick(force?: boolean): Promise<PollOutcome[]>;
  /** Record that a session uses this plugin, so it receives notices. */
  touch(sessionID: string): void;
}

/**
 * The plugin's engine, independent of the OpenCode API (`opencode.ts` adapts it): one
 * timer drives `pollWatch` for every watch, then queues a notice into each session this
 * process has seen that has unread, un-notified events.
 *
 * Sessions are learned from tool calls rather than from every session the host creates:
 * notices go to the sessions that actually work with these threads, never to unrelated
 * sessions or subagents.
 */
export function createNotifier(deps: NotifierDeps): Notifier {
  const { options, logger } = deps;
  const now = deps.now ?? Date.now;
  const stateDir = options.stateDir ?? resolveStateDir();
  const token = deps.token ?? createTokenProvider(options.auth);
  const client =
    deps.client ??
    createGitHubClient({
      apiBaseUrl: options.apiBaseUrl,
      token,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      now
    });
  const inbox = createInbox({
    stateDir,
    watches: options.watches,
    now,
    ...(deps.sessionStartedAt ? { sessionStartedAt: deps.sessionStartedAt } : {})
  });
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number) => {
      const handle = setTimeout(callback, ms);
      // Never keep the host process alive just to poll GitHub.
      handle.unref?.();
      return handle;
    });
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never));

  const sessions = new Set<string>();
  let timer: unknown;
  let running = false;
  let stopped = true;
  let inFlight: Promise<PollOutcome[]> | undefined;

  const notifySessions = async (): Promise<void> => {
    if (options.notify === "off" || !deps.sendNotice) {
      return;
    }
    for (const sessionID of [...sessions]) {
      try {
        const pending = await inbox.unnotified(sessionID);
        if (pending.total === 0) {
          continue;
        }
        await deps.sendNotice(
          sessionID,
          renderNotice(pending.counts, NEXT_TOOL_NAME),
          options.notify === "wake"
        );
        await pending.commit();
        logger.info("github_notify_notice_sent", { sessionID, events: pending.total });
      } catch (error) {
        // A deleted or foreign session refuses the notice; stop targeting it. Its cursor
        // is untouched, so the tool still delivers everything if it comes back.
        sessions.delete(sessionID);
        logger.warn("github_notify_notice_failed", {
          sessionID,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  const pollDeps = {
    stateDir,
    client,
    filter: options.filter,
    logger,
    pollIntervalMs: options.pollIntervalMs,
    maxBackoffMs: options.maxBackoffMs,
    maxLogEvents: options.maxLogEvents,
    maxPages: options.maxPages,
    now
  };

  const runTick = async (force: boolean): Promise<PollOutcome[]> => {
    const outcomes: PollOutcome[] = [];
    // Sequential: one thread at a time keeps request bursts small.
    for (const watch of options.watches) {
      try {
        const outcome = await pollWatch(watch, pollDeps, { force });
        if (outcome.status === "busy") {
          logger.debug("github_notify_poll_busy", { watch: watch.key });
        }
        outcomes.push(outcome);
      } catch (error) {
        // Filesystem trouble (not a GitHub error, which pollWatch records itself).
        logger.error("github_notify_poll_crashed", {
          watch: watch.key,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    // Also covers events another process recorded for a session this process serves.
    await notifySessions();
    return outcomes;
  };

  const nextDelay = async (): Promise<number> => {
    let soonest = now() + options.pollIntervalMs;
    for (const watch of options.watches) {
      const state = await readWatchState(stateDir, watch).catch(() => undefined);
      if (state?.nextPollAt) {
        soonest = Math.min(soonest, state.nextPollAt);
      }
    }
    return Math.min(Math.max(soonest - now(), MIN_TICK_MS), options.pollIntervalMs);
  };

  const schedule = (ms: number) => {
    if (stopped) {
      return;
    }
    timer = setTimer(() => {
      void loop();
    }, ms);
  };

  const loop = async () => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      inFlight = runTick(false);
      await inFlight;
    } finally {
      running = false;
      inFlight = undefined;
    }
    schedule(await nextDelay());
  };

  return {
    inbox,
    stateDir,
    start() {
      if (!stopped) {
        return;
      }
      stopped = false;
      logger.info("github_notify_started", {
        watches: options.watches.map((watch) => watch.key),
        pollIntervalMs: options.pollIntervalMs,
        notify: options.notify,
        auth: options.auth.kind === "env" ? `env:${options.auth.env}` : options.auth.command[0]
      });
      schedule(0);
    },
    stop() {
      stopped = true;
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
    },
    tick(force = false) {
      return inFlight ?? runTick(force);
    },
    touch(sessionID) {
      sessions.add(sessionID);
    }
  };
}
