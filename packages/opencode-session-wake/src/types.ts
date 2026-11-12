/**
 * The durable shape of a watch. Everything here is written under the STATE
 * root (ADR-0022) — it must survive a restart, because a lost cursor is a lost
 * comment. No token is ever part of this shape.
 */

/** The only source kind this spike supports. A union so more can be added later. */
export type WakeSourceKind = "github.thread";

/** This plugin's log tiers. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** A subscription is owned by exactly one session: the one whose tool call created it. */
export interface WakeSubscription {
  readonly id: string;
  readonly sessionID: string;
  readonly kind: WakeSourceKind;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  /** Handles to filter on (`@name`); empty means "every comment". */
  readonly mentions: readonly string[];
  readonly intervalMs: number;
  readonly createdAt: string;
}

/**
 * One comment observed on the thread. `body` is UNTRUSTED external content: it
 * is stored and returned as data, never parsed for instructions.
 */
export interface WakeEvent {
  readonly id: string;
  readonly kind: "comment";
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url: string;
  readonly body: string;
}

/** Where polling stands. Only ever advanced by a poll that fully succeeded. */
export interface WakeCursor {
  /** ISO `updated_at` of the newest comment observed (matching or filtered out). */
  lastSeenAt: string;
  /** GitHub comment id of the newest delivered-or-filtered comment. */
  lastEventID?: string;
}

/** A cached conditional-request validator, tied to the `since` value it was earned for. */
export interface WakeETag {
  readonly value: string;
  readonly since: string;
}

/** Per-subscription mutable state, persisted beside the subscription. */
export interface SubscriptionState {
  cursor: WakeCursor;
  etag?: WakeETag;
  /** Observed but not yet read by the model; survives a restart. */
  pending: WakeEvent[];
  /** Bounded ring of comment ids already accepted, so a replayed page cannot duplicate. */
  seen: string[];
  consecutiveFailures: number;
  lastError?: string;
  lastPollAt?: string;
  nextPollAt: number;
}

/** What is persisted for one subscription: the watch and its state, in one atomic write. */
export interface SubscriptionRecord {
  readonly subscription: WakeSubscription;
  state: SubscriptionState;
}

/** The notice injected into the owning session. Deliberately body-free. */
export interface WakeNotice {
  readonly sessionID: string;
  readonly subscriptionID: string;
  readonly thread: string;
  readonly count: number;
  readonly text: string;
  readonly description: string;
  /**
   * `ctx.session.synthetic({ resume })`. `true` for a live event (run it in this
   * execution); `false` for a backlog recovered at startup (wait for the next
   * wake) — the host documents exactly this split on `experimental.idle`.
   */
  readonly resume: boolean;
}
