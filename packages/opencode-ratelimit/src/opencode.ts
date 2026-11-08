import { Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";

import {
  captureHostContext,
  createEffectLogger,
  DEFAULT_LOG_LEVEL,
  type Logger,
  type LogLevel,
  resolveLogLevel
} from "./logging.js";
import { collectOptIns, createRateLimiter, type RateLimiter } from "./plugin.js";

/** Stable plugin id. v2 requires one and keys storage/registrations by it. */
export const PLUGIN_ID = "vymalo.ratelimit";

export interface OpenCodePluginFactoryOptions {
  /** Override the logger (tests). Defaults to the host's Effect logger. */
  logger?: Logger;
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to a real `setTimeout`-based, abort-aware sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Observe the limiter the plugin built (tests). */
  onLimiter?: (limiter: RateLimiter) => void;
}

/**
 * Build the OpenCode v2 plugin.
 *
 * Three registrations, one per lifecycle seam:
 *
 *  - `provider.transform` reads the `settings.rateLimit` opt-in set. It only
 *    *reads* — the limiter needs to know which providers it manages, and a
 *    transform is the seam that reruns on every provider reload. Transform
 *    callbacks must stay synchronous and cheap, which this is.
 *  - `session.hook("http.request")` is the pre-request gate.
 *  - `session.hook("http.response")` reads the `x-ratelimit-*` triple.
 *  - `session.hook("retry")` decides whether a 429 waits or surfaces.
 *
 * v1 had to do all of this inside one injected `provider.options.fetch`,
 * because OpenCode exposed no post-response hook. v2's native HTTP seams make
 * the fetch wrapper unnecessary — and the `retry` hook hands the backoff sleep
 * to the host, so the plugin no longer blocks a request thread on a 429.
 */
export function createOpencodeRatelimitPlugin(
  factoryOptions: OpenCodePluginFactoryOptions = {}
): Plugin.Plugin {
  return Plugin.define({
    id: PLUGIN_ID,
    effect: Effect.fn(function* (ctx) {
      // v2 gives plugins no `config` object, so the v1 `config.logLevel`
      // channel is gone: take this plugin's own `logLevel` option first, then
      // the host's `OPENCODE_LOG_LEVEL`.
      const logLevel: LogLevel =
        resolveLogLevel(ctx.options.logLevel) ??
        resolveLogLevel(process.env.OPENCODE_LOG_LEVEL) ??
        DEFAULT_LOG_LEVEL;

      let logger = factoryOptions.logger;
      if (!logger) {
        const hostContext = yield* captureHostContext;
        logger = createEffectLogger(hostContext, () => logLevel);
      }

      const limiter = createRateLimiter({
        logger,
        now: factoryOptions.now,
        sleep: factoryOptions.sleep
      });
      factoryOptions.onLimiter?.(limiter);

      const log = logger;

      yield* ctx.provider.transform((editor) => {
        limiter.configure(
          collectOptIns(
            editor.list().map((record) => ({
              id: record.provider.id,
              settings: record.provider.settings as Record<string, unknown> | undefined
            })),
            log
          )
        );
      });

      yield* ctx.session.hook("http.request", (event) =>
        Effect.promise(() =>
          limiter.acquire(
            { providerId: event.model.providerID, modelID: event.model.id },
            event.request.signal
          )
        )
      );

      yield* ctx.session.hook("http.response", (event) =>
        Effect.sync(() => {
          limiter.observe(
            { providerId: event.model.providerID, modelID: event.model.id },
            { status: event.response.status, headers: event.response.headers }
          );
        })
      );

      yield* ctx.session.hook("retry", (event) =>
        Effect.sync(() => {
          const decision = limiter.decideRetry(
            { providerId: event.model.providerID, modelID: event.model.id },
            { status: event.error.status, retryAfterMs: event.error.retryAfterMs },
            event.attempt
          );
          // Only speak up about a 429 we manage; leave every other failure to
          // the host's own retry policy.
          if (decision.retry) {
            event.decision = decision;
          }
        })
      );
    })
  });
}

export const OpencodeRatelimitPlugin: Plugin.Plugin = createOpencodeRatelimitPlugin();

export default OpencodeRatelimitPlugin;
