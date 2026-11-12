import type { LoopState, WakeEvent } from "./types.js";

/**
 * Wake-rate policy for one `(session, watch)` pair.
 *
 * A watched thread can be written to by the very agent watching it (or by a bot
 * echoing that agent), and a wake that produces a comment that produces a wake
 * is a feedback loop. This budget is the always-on guardrail: it never drops an
 * event (they stay in `pending`, readable through `wake_next`), it only stops
 * the *notice* from being injected again and again.
 */
export interface LoopPolicy {
  /** Wakes allowed inside one window before the guard trips. */
  readonly maxWakes: number;
  /** Sliding window, in milliseconds. */
  readonly windowMs: number;
  /** How long to stay quiet once the budget is exhausted. */
  readonly cooldownMs: number;
}

/**
 * Safe defaults: at most 5 wakes a minute, then 5 minutes of quiet. With the
 * default 60 s poll interval a healthy thread never reaches the budget; a loop
 * (comment → wake → comment) reaches it in seconds.
 */
export const DEFAULT_LOOP_POLICY: LoopPolicy = {
  maxWakes: 5,
  windowMs: 60_000,
  cooldownMs: 300_000
};

/** Short-lived window in which an event we ourselves produced is suppressed. */
export const ORIGINATED_TTL_MS: number = 10 * 60_000;

export function initialLoopState(): LoopState {
  return { wakes: [], suppressed: 0, loopSuspected: false };
}

export type WakeSuppressionReason = "cooldown" | "rate";

export interface WakeDecision {
  readonly next: LoopState;
  readonly deliver: boolean;
  readonly reason?: WakeSuppressionReason;
}

/**
 * Decide whether this subscriber may be woken now.
 *
 * - Under budget: deliver, record the wake, clear `loopSuspected`.
 * - Over budget: start a cooldown, mark `loopSuspected`, coalesce (the events
 *   are already durable and will be read on the next `wake_next`).
 * - Inside a cooldown: keep coalescing.
 *
 * Pure: the caller supplies `now`, so tests are deterministic.
 */
export function decideWake(state: LoopState, policy: LoopPolicy, now: number): WakeDecision {
  const maxWakes = Math.max(1, policy.maxWakes);
  const windowMs = Math.max(1, policy.windowMs);
  const inCooldown = state.cooldownUntil !== undefined && now < state.cooldownUntil;

  if (inCooldown) {
    const wakes = state.wakes.filter((at) => now - at < windowMs);
    return {
      next: { ...state, wakes, suppressed: state.suppressed + 1, loopSuspected: true },
      deliver: false,
      reason: "cooldown"
    };
  }

  // An expired cooldown is a fresh start: the quiet period *is* the reset, so a
  // short cooldown inside a long window cannot immediately re-trip the guard.
  const wakes =
    state.cooldownUntil !== undefined ? [] : state.wakes.filter((at) => now - at < windowMs);

  if (wakes.length >= maxWakes) {
    return {
      next: {
        wakes,
        suppressed: state.suppressed + 1,
        loopSuspected: true,
        cooldownUntil: now + Math.max(0, policy.cooldownMs)
      },
      deliver: false,
      reason: "rate"
    };
  }

  return {
    next: { wakes: [...wakes, now], suppressed: 0, loopSuspected: false },
    deliver: true
  };
}

/** Lowercase, strip a leading `@`, drop empties and duplicates. */
export function normalizeAuthors(list: readonly string[] | undefined): string[] {
  if (!list) {
    return [];
  }
  const seen = new Set<string>();
  for (const entry of list) {
    const login = entry.trim().replace(/^@/, "").toLowerCase();
    if (login.length > 0) {
      seen.add(login);
    }
  }
  return [...seen];
}

/**
 * Author filter, applied at fan-out. GitHub logins are case-insensitive, so the
 * comparison is too. Applies to bots as well (`github-actions[bot]`).
 */
export function isIgnoredAuthor(event: WakeEvent, ignored: readonly string[]): boolean {
  if (ignored.length === 0) {
    return false;
  }
  return ignored.includes(event.author.trim().toLowerCase());
}

/**
 * Short-lived "we produced this event" set.
 *
 * The plugin has **no GitHub write path today**, so nothing calls `mark` yet.
 * It exists as the exact seam a future write path must use: record the returned
 * comment/event id here and the next fan-out suppresses the wake that our own
 * write would otherwise cause. Parsing a marker out of a body is deliberately
 * *not* implemented — that is a heuristic, not a security boundary.
 */
export class OriginatedSet {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = ORIGINATED_TTL_MS
  ) {}

  mark(eventID: string): void {
    this.entries.set(eventID, this.now() + this.ttlMs);
  }

  has(eventID: string): boolean {
    const expiresAt = this.entries.get(eventID);
    if (expiresAt === undefined) {
      return false;
    }
    if (this.now() >= expiresAt) {
      this.entries.delete(eventID);
      return false;
    }
    return true;
  }

  /** Drop expired ids; called by the poller so the set cannot grow without bound. */
  prune(): void {
    const at = this.now();
    for (const [id, expiresAt] of this.entries) {
      if (at >= expiresAt) {
        this.entries.delete(id);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
