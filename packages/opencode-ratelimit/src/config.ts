import type { RateLimitAction, RateLimitOptions, RateLimitScope, RateLimitTier } from "./types.js";

export const DEFAULT_MAX_WAIT_MS = 0; // 0 = unlimited (wait the full reset window)
export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_HEADER_PREFIX = "x-ratelimit";
export const DEFAULT_SCOPE: RateLimitScope = "model";

const RATE_LIMIT_KEY = "rateLimit";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

/** Like {@link asPositiveInt} but accepts `0` — used for `maxWaitMs` where 0 means unlimited. */
function asNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return fallback;
}

function asScope(value: unknown): RateLimitScope {
  return value === "provider" || value === "model" ? value : DEFAULT_SCOPE;
}

function asAction(value: unknown): RateLimitAction {
  return value === "error" ? "error" : "wait";
}

/** A positive int, or `null` (the catch-all sentinel) when absent/non-positive. */
function asMaxResetSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return null;
}

function parseTier(raw: Record<string, unknown>): RateLimitTier {
  return {
    maxResetSeconds: asMaxResetSeconds(raw.maxResetSeconds),
    action: asAction(raw.action),
    maxWaitMs: asNonNegativeInt(raw.maxWaitMs, DEFAULT_MAX_WAIT_MS),
    maxRetries: asPositiveInt(raw.maxRetries, DEFAULT_MAX_RETRIES)
  };
}

/**
 * Sort ascending by `maxResetSeconds` (catch-all `null` last) and guarantee a
 * trailing catch-all so every reset magnitude matches some tier. Without an
 * explicit catch-all the ultimate fallback is "wait the full window" — the safe
 * direction (never hammer the gateway).
 */
function normalizeTiers(tiers: RateLimitTier[]): RateLimitTier[] {
  const sorted = [...tiers].sort((a, b) => {
    if (a.maxResetSeconds === b.maxResetSeconds) return 0; // equal (incl. both null)
    if (a.maxResetSeconds === null) return 1;
    if (b.maxResetSeconds === null) return -1;
    return a.maxResetSeconds - b.maxResetSeconds;
  });
  if (!sorted.some((t) => t.maxResetSeconds === null)) {
    sorted.push({
      maxResetSeconds: null,
      action: "wait",
      maxWaitMs: DEFAULT_MAX_WAIT_MS,
      maxRetries: DEFAULT_MAX_RETRIES
    });
  }
  return sorted;
}

/**
 * Parse a provider's `options.meta.rateLimit` block into resolved
 * {@link RateLimitOptions}. Returns `null` when the provider has NOT opted in
 * (no `meta.rateLimit`) or has explicitly disabled it (`enabled: false`).
 *
 * Two config styles, both supported:
 *  - **Flat**: `maxWaitMs` / `maxRetries` → normalized into a single catch-all
 *    `"wait"` tier (the 0.5.0 behavior).
 *  - **Tiered**: a `tiers` array, each entry `{ maxResetSeconds?, action?,
 *    maxWaitMs?, maxRetries? }`, matched by reset magnitude.
 */
export function parseRateLimitOptions(
  providerSettings: Record<string, unknown> | undefined
): RateLimitOptions | null {
  if (!providerSettings) {
    return null;
  }

  // v2 providers have no free-form `options.meta`; `Provider.Settings` is an
  // open struct, so the opt-in lives directly at `settings.rateLimit`.
  const rateLimit = asRecord(providerSettings[RATE_LIMIT_KEY]);
  if (!rateLimit) {
    return null;
  }

  const enabled = asBoolean(rateLimit.enabled, true);
  if (!enabled) {
    return null;
  }

  const rawTiers = Array.isArray(rateLimit.tiers) ? rateLimit.tiers : undefined;
  let tiers: RateLimitTier[];
  if (rawTiers && rawTiers.length > 0) {
    tiers = normalizeTiers(rawTiers.map((t) => parseTier(asRecord(t) ?? {})));
  } else {
    // Flat config → one catch-all "wait" tier (backward compatible with 0.5.0).
    tiers = [
      {
        maxResetSeconds: null,
        action: "wait",
        maxWaitMs: asNonNegativeInt(rateLimit.maxWaitMs, DEFAULT_MAX_WAIT_MS),
        maxRetries: asPositiveInt(rateLimit.maxRetries, DEFAULT_MAX_RETRIES)
      }
    ];
  }

  return {
    enabled: true,
    scope: asScope(rateLimit.scope),
    headerPrefix: (asString(rateLimit.headerPrefix) ?? DEFAULT_HEADER_PREFIX).toLowerCase(),
    tiers
  };
}

/**
 * Select the policy tier for an observed reset. `tiers` is pre-sorted ascending
 * with a catch-all last, so the first tier whose bound covers `resetSeconds`
 * wins. An unknown reset is treated as the smallest band (wait a default backoff).
 */
export function selectTier(
  tiers: RateLimitTier[],
  resetSeconds: number | undefined
): RateLimitTier {
  const reset = resetSeconds ?? 0;
  for (const tier of tiers) {
    if (tier.maxResetSeconds === null || reset <= tier.maxResetSeconds) {
      return tier;
    }
  }
  return tiers[tiers.length - 1];
}
