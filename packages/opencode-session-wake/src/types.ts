/**
 * The durable shape of a watch. Everything here is written under the STATE
 * root (ADR-0022) — it must survive a restart, because a lost cursor is a lost
 * event. No token is ever part of this shape.
 */

/**
 * What a watch reads from GitHub.
 *
 * - `github.thread` — issue/PR **comments only** (the original source, kept
 *   unchanged so existing watches and their cursors keep working).
 * - `github.timeline` — the issue/PR **timeline**: comments, reviews, review
 *   comments, state changes (closed/reopened/merged), label and assignee
 *   changes, review requests, commits and force-pushes. A superset of
 *   `github.thread`; do not watch the same thread with both.
 * - `github.checks` — the PR's **head commit and check runs** (status +
 *   conclusion + URL). Requires a pull-request number.
 */
export type WakeSourceKind = "github.thread" | "github.timeline" | "github.checks";

export const WAKE_SOURCE_KINDS: readonly WakeSourceKind[] = [
  "github.thread",
  "github.timeline",
  "github.checks"
];

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
  /** Handles to filter on (`@name`); empty means "everything". */
  readonly mentions: readonly string[];
  readonly intervalMs: number;
  readonly createdAt: string;
}

/**
 * What kind of thing happened. Only `comment`, `review` and `review_comment`
 * carry a body; the rest carry a plugin-generated `title`.
 */
export type WakeEventKind =
  | "comment"
  | "review"
  | "review_comment"
  | "review_request"
  | "state"
  | "label"
  | "assignee"
  | "commit"
  | "check";

/**
 * One observed event. `body` and `title` are UNTRUSTED external content: they
 * are stored and returned as data, never parsed for instructions.
 */
export interface WakeEvent {
  /** Source-stable id: the same GitHub event observed twice produces the same id. */
  readonly id: string;
  readonly kind: WakeEventKind;
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url: string;
  /** Comment / review body. Empty for state, label, commit and check events. */
  readonly body: string;
  /** Single-line summary for events without a body (e.g. `build: completed / failure`). */
  readonly title?: string;
}

/** Where polling stands. Only ever advanced by a poll that fully succeeded. */
export interface WakeCursor {
  /** ISO timestamp of the newest event observed (matching or filtered out). */
  lastSeenAt: string;
  /** Stable id of the newest event, used as the timeline's boundary marker. */
  lastEventID?: string;
  /** `github.checks` only: the head commit the stored check state belongs to. */
  headSHA?: string;
}

/**
 * A cached conditional-request validator. Keyed by the exact request URL it was
 * earned for: a changed `since`, page or head sha makes the URL different, so a
 * stale validator can never be sent.
 */
export interface WakeETag {
  readonly url: string;
  readonly value: string;
}

/** Per-subscription mutable state, persisted beside the subscription. */
export interface SubscriptionState {
  cursor: WakeCursor;
  /** Validators by request URL. A source replaces this map wholesale on success. */
  etags?: Record<string, string>;
  /** Observed but not yet read by the model; survives a restart. */
  pending: WakeEvent[];
  /** Bounded ring of event ids already accepted, so a replayed page cannot duplicate. */
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
  readonly source: WakeSourceKind;
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
