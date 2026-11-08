import { parseRateLimitOptions, selectTier } from "./config.js";
import { parseRateLimit } from "./headers.js";
import type { Logger } from "./logging.js";
import type { RateLimitOptions, RateLimitSnapshot } from "./types.js";

/** Fallback backoff when a 429 carries no `x-ratelimit-reset` and no `Retry-After`. */
export const DEFAULT_BACKOFF_MS = 1000;

/**
 * Mutable, in-memory rate-limit state for a single bucket (a provider, or a
 * `(provider, model)` pair when `scope: "model"`). Lives for the process
 * lifetime in the limiter's state store. Never persisted — a reset window is
 * measured in seconds, so survival across process boots is pointless.
 */
export interface ProviderRateState {
  /**
   * Epoch ms until which new requests should be held back. 0 = no cooldown.
   * The sole gate driver — set from a response's `x-ratelimit-reset` (when
   * `remaining` hits 0, and the matched tier is `"wait"`) or from a 429 backoff.
   */
  cooldownUntilMs: number;
  /** The `maxWaitMs` of the tier that armed the current cooldown (0 = unlimited). */
  cooldownMaxWaitMs: number;
  /** A single in-flight wait shared by every caller during a cooldown window. */
  cooldownPromise?: Promise<void>;
  /**
   * Epoch ms at which {@link cooldownPromise} is scheduled to resolve. Lets a
   * caller that needs a shorter wait detect a too-long shared timer and fall
   * back to its own sleep, so it never waits past its required time / `maxWaitMs`.
   */
  cooldownPromiseUntilMs?: number;
  /**
   * Last snapshot read from this bucket's responses. The v2 `retry` hook sees a
   * `SessionError` (status + `retryAfterMs`) but no response headers, so the
   * reset window it needs for tier selection and backoff is carried here from
   * the `http.response` hook that observed it.
   */
  lastSnapshot?: RateLimitSnapshot;
}

export function createProviderState(): ProviderRateState {
  return { cooldownUntilMs: 0, cooldownMaxWaitMs: 0 };
}

export interface RateLimitDeps {
  logger: Logger;
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to a real `setTimeout`-based, abort-aware sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** A per-bucket state store (key = provider id, or `${providerId}\0${model}`). */
export type RateStateStore = Map<string, ProviderRateState>;

/** What the `retry` hook should do with a failed request. */
export type RetryDecision = { retry: false } | { retry: true; delay: number };

/** Identifies the bucket a hook event belongs to. */
export interface BucketRef {
  providerId: string;
  modelID?: string;
}

/**
 * The rate-limit engine, shaped for OpenCode v2's three request-lifecycle
 * seams rather than v1's single `fetch` wrapper:
 *
 *  - {@link RateLimiter.acquire} is the pre-request gate (`http.request`): it
 *    waits out a cooldown a previous `"wait"` tier armed.
 *  - {@link RateLimiter.observe} reads the rate-limit headers off a response
 *    (`http.response`) and arms or clears the gate for the *next* callers.
 *  - {@link RateLimiter.decideRetry} answers the `retry` hook: a `"wait"` tier
 *    returns a delay for the host to sleep, an `"error"` tier declines the retry
 *    so the 429 surfaces immediately.
 *
 * The host owns the retry loop in v2, so the plugin never sleeps on a 429 — it
 * returns a delay and OpenCode waits (cancellably). The plugin still sleeps in
 * `acquire`, because there is no host hook for "hold this request back".
 */
export interface RateLimiter {
  /** Replace the opted-in provider set. Called from the provider transform. */
  configure(entries: ReadonlyMap<string, RateLimitOptions>): void;
  /** Resolved options for a provider, or `undefined` when it has not opted in. */
  options(providerId: string): RateLimitOptions | undefined;
  acquire(ref: BucketRef, signal?: AbortSignal): Promise<void>;
  observe(ref: BucketRef, response: { status: number; headers: Headers }): void;
  decideRetry(
    ref: BucketRef,
    error: { status?: number; retryAfterMs?: number },
    attempt: number
  ): RetryDecision;
}

/**
 * Read each provider's `settings.rateLimit` opt-in. v2 has no free-form
 * `options.meta` on a provider — `Provider.Settings` is an open struct, so the
 * opt-in moves from v1's `options.meta.rateLimit` to `settings.rateLimit`.
 */
export function collectOptIns(
  providers: readonly { id: string; settings?: Record<string, unknown> }[],
  logger: Logger
): Map<string, RateLimitOptions> {
  const out = new Map<string, RateLimitOptions>();
  for (const provider of providers) {
    const opts = parseRateLimitOptions(provider.settings);
    if (!opts) {
      logger.debug("ratelimit_provider_skipped", {
        providerId: provider.id,
        reason: "not_opted_in"
      });
      continue;
    }
    out.set(provider.id, opts);
    logger.info("ratelimit_provider_enabled", {
      providerId: provider.id,
      scope: opts.scope,
      tiers: opts.tiers.length,
      headerPrefix: opts.headerPrefix
    });
  }
  logger.info("ratelimit_plugin_initialized", { providerCount: out.size });
  return out;
}

export function createRateLimiter(deps: RateLimitDeps): RateLimiter {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const { logger } = deps;

  let configured = new Map<string, RateLimitOptions>();
  const store: RateStateStore = new Map();

  const optionsFor = (providerId: string) => configured.get(providerId);

  const bucket = (ref: BucketRef, opts: RateLimitOptions) => {
    const model = opts.scope === "model" ? ref.modelID : undefined;
    const key = model ? `${ref.providerId}\u0000${model}` : ref.providerId;
    let state = store.get(key);
    const existed = state !== undefined;
    if (!state) {
      state = createProviderState();
      store.set(key, state);
    }
    return { state, key, model, existed };
  };

  return {
    configure(entries) {
      configured = new Map(entries);
      // Drop state for providers that are no longer opted in so a reload does
      // not leave an orphaned cooldown gating a provider nobody manages.
      for (const key of [...store.keys()]) {
        const providerId = key.split("\u0000", 1)[0] ?? key;
        if (!configured.has(providerId)) {
          store.delete(key);
        }
      }
    },

    options: optionsFor,

    async acquire(ref, signal) {
      const opts = optionsFor(ref.providerId);
      if (!opts) {
        return;
      }
      const { state, key, model, existed } = bucket(ref, opts);
      logger.trace("ratelimit_acquire", {
        providerId: ref.providerId,
        scope: opts.scope,
        model,
        bucketKey: key,
        bucketExisted: existed,
        cooldownUntilMs: state.cooldownUntilMs
      });

      if (state.cooldownUntilMs <= now()) {
        return;
      }

      const waitMs = clampWait(state.cooldownUntilMs - now(), state.cooldownMaxWaitMs);
      logger.trace("ratelimit_cooldown_gate_armed", {
        providerId: ref.providerId,
        model,
        cooldownUntilMs: state.cooldownUntilMs,
        remainingMs: state.cooldownUntilMs - now(),
        clampedWaitMs: waitMs,
        maxWaitMs: state.cooldownMaxWaitMs
      });
      if (waitMs <= 0) {
        return;
      }
      logger.info("ratelimit_throttle_wait", { providerId: ref.providerId, model, waitMs });
      await waitGate(
        state,
        sleep,
        now,
        state.cooldownMaxWaitMs,
        signal,
        logger,
        ref.providerId,
        model,
        "pre_request"
      );
    },

    observe(ref, response) {
      const opts = optionsFor(ref.providerId);
      if (!opts) {
        return;
      }
      const { state, model } = bucket(ref, opts);
      const snapshot = readSnapshot(response.headers, opts, now(), logger, ref.providerId);
      state.lastSnapshot = snapshot;
      logger.trace("ratelimit_snapshot_parsed", {
        providerId: ref.providerId,
        model,
        status: response.status,
        limit: snapshot.limit,
        remaining: snapshot.remaining,
        resetSeconds: snapshot.resetSeconds,
        resetAtMs: snapshot.resetAtMs,
        retryAfterMs: snapshot.retryAfterMs
      });
      logger.debug("ratelimit_quota", {
        providerId: ref.providerId,
        model,
        remaining: snapshot.remaining,
        limit: snapshot.limit,
        resetSeconds: snapshot.resetSeconds
      });

      const resetForTier = effectiveResetSeconds(snapshot);
      const tier = selectTier(opts.tiers, resetForTier);

      if (response.status === 429) {
        // The host will ask `decideRetry` what THIS caller does. Arm the gate so
        // every OTHER concurrent caller throttles too (v1 got this from the
        // shared wrapper state); an "error" tier clears it so the fail-fast is
        // actually fast.
        if (tier.action === "wait") {
          const waitMs = clampWait(computeBackoff(snapshot, now()), tier.maxWaitMs);
          state.cooldownUntilMs = now() + waitMs;
          state.cooldownMaxWaitMs = tier.maxWaitMs;
          logger.trace("ratelimit_cooldown_set", {
            providerId: ref.providerId,
            model,
            cooldownUntilMs: state.cooldownUntilMs,
            maxWaitMs: tier.maxWaitMs,
            source: "429_backoff"
          });
        } else {
          state.cooldownUntilMs = 0;
          state.cooldownMaxWaitMs = 0;
          logger.trace("ratelimit_cooldown_cleared", {
            providerId: ref.providerId,
            model,
            source: "429_error_tier"
          });
        }
        return;
      }

      // Arm the gate for the NEXT callers when the window is exhausted — but
      // only under a "wait" tier. An "error" tier wants the next request to hit
      // a real 429 and be surfaced, so we leave the gate unarmed.
      if (
        snapshot.remaining === undefined ||
        snapshot.remaining > 0 ||
        snapshot.resetAtMs === undefined
      ) {
        return;
      }
      logger.trace("ratelimit_exhausted_tier_selected", {
        providerId: ref.providerId,
        model,
        resetSeconds: resetForTier,
        maxResetSeconds: tier.maxResetSeconds,
        action: tier.action,
        maxWaitMs: tier.maxWaitMs,
        maxRetries: tier.maxRetries
      });
      if (tier.action === "wait") {
        state.cooldownUntilMs = snapshot.resetAtMs;
        state.cooldownMaxWaitMs = tier.maxWaitMs;
        logger.trace("ratelimit_cooldown_set", {
          providerId: ref.providerId,
          model,
          cooldownUntilMs: state.cooldownUntilMs,
          maxWaitMs: tier.maxWaitMs,
          source: "exhausted"
        });
        return;
      }
      state.cooldownUntilMs = 0;
      state.cooldownMaxWaitMs = 0;
      logger.trace("ratelimit_cooldown_cleared", {
        providerId: ref.providerId,
        model,
        source: "exhausted_error_tier"
      });
    },

    decideRetry(ref, error, attempt) {
      const opts = optionsFor(ref.providerId);
      if (!opts || error.status !== 429) {
        return { retry: false };
      }
      const { state, model } = bucket(ref, opts);

      // Prefer what the response hook saw; fall back to the error's own
      // `retryAfterMs` when this failure never produced an observed response.
      const snapshot: RateLimitSnapshot =
        state.lastSnapshot ??
        (error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {});
      const resetForTier = effectiveResetSeconds(snapshot);
      const tier = selectTier(opts.tiers, resetForTier);
      logger.trace("ratelimit_429_tier_selected", {
        providerId: ref.providerId,
        model,
        attempt,
        resetSeconds: resetForTier,
        maxResetSeconds: tier.maxResetSeconds,
        action: tier.action,
        maxWaitMs: tier.maxWaitMs,
        maxRetries: tier.maxRetries
      });

      if (tier.action === "error") {
        logger.warn("ratelimit_failfast", {
          providerId: ref.providerId,
          model,
          resetSeconds: snapshot.resetSeconds
        });
        return { retry: false };
      }

      if (attempt >= tier.maxRetries) {
        logger.trace("ratelimit_retries_exhausted", {
          providerId: ref.providerId,
          model,
          attempt,
          maxRetries: tier.maxRetries
        });
        logger.error("ratelimit_giveup", { providerId: ref.providerId, model, attempts: attempt });
        return { retry: false };
      }

      const backoffMs = computeBackoff(snapshot, now());
      const waitMs = clampWait(backoffMs, tier.maxWaitMs);
      logger.trace("ratelimit_429_backoff_computed", {
        providerId: ref.providerId,
        model,
        attempt: attempt + 1,
        rawBackoffMs: backoffMs,
        clampedWaitMs: waitMs,
        maxWaitMs: tier.maxWaitMs
      });
      logger.warn("ratelimit_429_backoff", {
        providerId: ref.providerId,
        model,
        attempt: attempt + 1,
        waitMs,
        resetSeconds: snapshot.resetSeconds
      });
      return { retry: true, delay: waitMs };
    }
  };
}

/**
 * Reset magnitude (seconds) used for tier selection: prefer `x-ratelimit-reset`,
 * else derive from a `Retry-After` fallback — so a `Retry-After`-only 429 with a
 * multi-day delay still lands in a long-reset (`error`) tier instead of the
 * smallest band.
 */
function effectiveResetSeconds(snapshot: RateLimitSnapshot): number | undefined {
  if (snapshot.resetSeconds !== undefined) {
    return snapshot.resetSeconds;
  }
  if (snapshot.retryAfterMs !== undefined) {
    return Math.ceil(snapshot.retryAfterMs / 1000);
  }
  return undefined;
}

function readSnapshot(
  headers: Headers,
  opts: RateLimitOptions,
  nowMs: number,
  logger: Logger,
  providerId: string
): RateLimitSnapshot {
  try {
    return parseRateLimit(headers, opts.headerPrefix, nowMs);
  } catch (error) {
    logger.debug("ratelimit_header_parse_failed", {
      providerId,
      error: error instanceof Error ? error.message : String(error)
    });
    return {};
  }
}

function computeBackoff(snapshot: RateLimitSnapshot, nowMs: number): number {
  if (snapshot.resetAtMs !== undefined) {
    return Math.max(0, snapshot.resetAtMs - nowMs);
  }
  if (snapshot.retryAfterMs !== undefined) {
    return snapshot.retryAfterMs;
  }
  return DEFAULT_BACKOFF_MS;
}

/** `maxWaitMs` of 0 means unlimited (wait the full reset window). */
function clampWait(ms: number, maxWaitMs: number): number {
  const nonNegative = Math.max(0, ms);
  return maxWaitMs > 0 ? Math.min(nonNegative, maxWaitMs) : nonNegative;
}

/**
 * Wait until `state.cooldownUntilMs` has elapsed. Two concurrency properties:
 *
 *  - **One shared timer.** The first caller to hit the gate creates the timer on
 *    `state.cooldownPromise`; concurrent callers await that same timer rather
 *    than each starting their own, so a burst during cooldown produces ONE wait,
 *    not N. The shared timer is not tied to any single caller's `signal` — each
 *    caller races it against its own signal (see `raceWithAbort`), so one
 *    request's cancellation never aborts the others.
 *  - **Honors the longest window.** After the shared timer resolves we re-check
 *    `cooldownUntilMs`. If another caller extended the window (e.g. a 429 landed
 *    with a further-out reset) while we were waiting we wait again for the
 *    remainder instead of returning early and hammering the gateway.
 *
 * `maxWaitMs` (when > 0) bounds the TOTAL wait of a single call: once a caller
 * has waited that long it proceeds even if the window hasn't fully elapsed. A
 * caller that needs LESS than the in-flight shared timer (the window shrank, or
 * the timer was created by a caller with a later deadline) falls back to its own
 * private sleep so it is never held past its own required time.
 */
async function waitGate(
  state: ProviderRateState,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  now: () => number,
  maxWaitMs: number,
  signal: AbortSignal | undefined,
  logger: Logger,
  providerId: string,
  model: string | undefined,
  phase: "pre_request" | "backoff"
): Promise<void> {
  const deadlineMs = maxWaitMs > 0 ? now() + maxWaitMs : Number.POSITIVE_INFINITY;
  logger.trace("ratelimit_wait_start", {
    providerId,
    model,
    phase,
    cooldownUntilMs: state.cooldownUntilMs,
    maxWaitMs
  });
  for (;;) {
    const target = Math.min(state.cooldownUntilMs, deadlineMs);
    const remainingMs = target - now();
    if (remainingMs <= 0) {
      logger.trace("ratelimit_wait_end", { providerId, model, phase });
      return;
    }
    logger.trace("ratelimit_wait_tick", {
      providerId,
      model,
      phase,
      remainingMs,
      sharedTimer: state.cooldownPromise !== undefined
    });

    // Reuse the shared timer only if it won't make us wait longer than we need.
    let pending = state.cooldownPromise;
    if (
      pending &&
      state.cooldownPromiseUntilMs !== undefined &&
      state.cooldownPromiseUntilMs - now() > remainingMs
    ) {
      pending = undefined;
    }
    if (!pending) {
      const created = sleep(remainingMs).finally(() => {
        if (state.cooldownPromise === created) {
          state.cooldownPromise = undefined;
          state.cooldownPromiseUntilMs = undefined;
        }
      });
      // Publish as the shared timer only when there isn't already a (shorter)
      // one in flight — never clobber it with our longer/private wait.
      if (!state.cooldownPromise) {
        state.cooldownPromise = created;
        state.cooldownPromiseUntilMs = now() + remainingMs;
      }
      pending = created;
    }

    try {
      await raceWithAbort(pending, signal);
    } catch (error) {
      if (isAbortError(error)) {
        logger.warn("ratelimit_wait_aborted", { providerId, model, phase });
      }
      throw error;
    }
    // Loop: re-check in case the window was extended while we waited.
  }
}

function raceWithAbort(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(toAbortError(signal));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(toAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(toAbortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(toAbortError(signal as AbortSignal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function toAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new DOMException("The operation was aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
