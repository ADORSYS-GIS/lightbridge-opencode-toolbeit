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
 * - `github.actions` — **workflow runs** for a repository (new run, status and
 *   conclusion transitions, reruns), optionally narrowed to one workflow file
 *   or id and one branch. Run-level only: jobs are out of scope. Takes no
 *   issue/PR number; the target is `owner`/`repo` plus the optional filters.
 */
export type WakeSourceKind =
  | "github.thread"
  | "github.timeline"
  | "github.checks"
  | "github.actions";

export const WAKE_SOURCE_KINDS: readonly WakeSourceKind[] = [
  "github.thread",
  "github.timeline",
  "github.checks",
  "github.actions"
];

/** This plugin's log tiers. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/**
 * What one shared fetcher polls. This — not the subscription — is the unit of
 * work: two sessions watching the same target share one poller, one cursor and
 * one set of ETags.
 */
export interface WatchTarget {
  readonly apiBase: string;
  readonly kind: WakeSourceKind;
  readonly owner: string;
  readonly repo: string;
  /**
   * Issue/PR number for the three thread sources. Absent for `github.actions`,
   * which watches a repository's workflow runs rather than one issue.
   */
  readonly number?: number;
  /** `github.actions` only: workflow id or file name (e.g. `ci.yml`). */
  readonly workflow?: string;
  /** `github.actions` only: branch name filter. */
  readonly branch?: string;
}

/** A subscription is owned by exactly one session: the one whose tool call created it. */
export interface WakeSubscription {
  readonly id: string;
  readonly sessionID: string;
  readonly kind: WakeSourceKind;
  readonly owner: string;
  readonly repo: string;
  /** Absent for `github.actions`. */
  readonly number?: number;
  /** `github.actions` only: workflow id or file name. */
  readonly workflow?: string;
  /** `github.actions` only: branch filter. */
  readonly branch?: string;
  /** Handles to filter on (`@name`); empty means "everything". */
  readonly mentions: readonly string[];
  /** Authors whose events are dropped at fan-out (lowercase logins, no `@`). */
  readonly ignoreAuthors: readonly string[];
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
  | "check"
  | "run";

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
  /**
   * `github.actions` only: `created_at` of the oldest run inside the tracked
   * window. Runs are creation-ordered and GitHub offers no `updated`/`since`
   * filter, so each poll re-reads down to this floor; a floor pushed deeper
   * than `maxPages` by new runs fails closed as `backlog`.
   */
  runFloor?: string;
}

/** The part of a watch's state the source strategies read and write. */
export interface SourceState {
  cursor: WakeCursor;
  /** Validators by request URL. A source replaces this map wholesale on success. */
  etags?: Record<string, string>;
}

/**
 * Shared fetch state for one watch key: one cursor, one ETag map, one dedupe
 * ring, one backoff — regardless of how many sessions subscribe to it.
 */
export interface WatchState extends SourceState {
  /** Event ids the shared fetcher has already accepted. */
  seen: string[];
  consecutiveFailures: number;
  lastError?: string;
  lastPollAt?: string;
  nextPollAt: number;
  /** Subscription ids attached to this watch. Rebuilt from the subscriber store on load. */
  subscribers: string[];
  /** When the last subscriber left (age-out), or the last join. */
  lastTouchedAt: number;
}

/** One shared fetcher: its key, what it polls, and its state. */
export interface WatchRecord {
  readonly key: string;
  readonly target: WatchTarget;
  state: WatchState;
}

/** Loop guard state for one `(session, watch)` pair — i.e. one subscriber. */
export interface LoopState {
  /** Timestamps (ms) of recent delivered wakes, oldest first. */
  wakes: number[];
  /** Wakes coalesced away since the last delivery. */
  suppressed: number;
  /** True while the wake rate is over budget or a cooldown is running. */
  loopSuspected: boolean;
  cooldownUntil?: number;
}

/** Per-subscriber delivery state. Isolated per session even on a shared fetcher. */
export interface SubscriberState {
  /** Observed but not yet read by the model; survives a restart. */
  pending: WakeEvent[];
  /** Bounded ring of event ids this subscriber has already accepted. */
  seen: string[];
  /** Last delivery (not fetch) error for this subscriber. */
  lastError?: string;
  loop: LoopState;
}

/** A subscription plus its private delivery state. */
export interface SubscriptionRecord {
  readonly subscription: WakeSubscription;
  state: SubscriberState;
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
