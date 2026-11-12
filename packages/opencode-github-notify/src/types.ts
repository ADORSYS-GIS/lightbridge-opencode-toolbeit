export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/**
 * How a session learns that comments are waiting.
 *
 * - `off`   — nothing is pushed; the model only sees comments when it calls the tool.
 * - `queue` — a fixed-text notice is queued into the session's inbox and is read on its
 *             next turn. An idle session is not woken.
 * - `wake`  — as `queue`, and an idle session is resumed to read the notice.
 */
export type NotifyMode = "off" | "queue" | "wake";

/** One watched issue or pull-request conversation. */
export interface WatchConfig {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  /** Stable display + storage identity: `owner/repo#number`. */
  readonly key: string;
}

/**
 * Comment selection. With both lists empty every comment is delivered. Otherwise a comment
 * is delivered when it mentions any handle OR contains any marker.
 */
export interface FilterConfig {
  /** Handles without the leading `@`, matched case-insensitively as `@handle`. */
  readonly mentions: readonly string[];
  /** Literal substrings, matched case-sensitively. */
  readonly markers: readonly string[];
}

/** Where the GitHub token comes from. It is never written to disk by this plugin. */
export type AuthConfig =
  | { readonly kind: "command"; readonly command: readonly string[] }
  | { readonly kind: "env"; readonly env: string };

export interface ResolvedOptions {
  readonly enabled: boolean;
  readonly watches: readonly WatchConfig[];
  readonly pollIntervalMs: number;
  readonly maxBackoffMs: number;
  readonly filter: FilterConfig;
  readonly auth: AuthConfig;
  readonly notify: NotifyMode;
  readonly apiBaseUrl: string;
  /** Events retained per watch; older ones are evicted (and reported as a gap, never silently). */
  readonly maxLogEvents: number;
  /** Upper bound on pages fetched per watch per poll (100 comments each). */
  readonly maxPages: number;
  /** Default number of events one `next` call returns. */
  readonly batchSize: number;
  /** Override the state directory (tests). Defaults to `<stateRoot>/opencode-github-notify`. */
  readonly stateDir?: string;
}

export type EventKind = "created" | "edited" | "deleted";

/**
 * One change observed on a watched thread. `body` is untrusted external content and is
 * absent on `deleted` (the comment is gone; the plugin keeps no copy of old bodies).
 */
export interface ThreadEvent {
  readonly seq: number;
  /** Dedupe identity: one delivery per `(comment, kind, updatedAt)`. */
  readonly id: string;
  readonly kind: EventKind;
  readonly watch: string;
  readonly commentId: number;
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url: string;
  readonly body?: string;
  readonly observedAt: string;
}
