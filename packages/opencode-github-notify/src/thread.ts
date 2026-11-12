import { rename } from "node:fs/promises";
import { join } from "node:path";

import { type Comment, type GitHubClient, GitHubError, type GitHubErrorKind } from "./github.js";
import type { Logger } from "./logging.js";
import { fileKey, readJson, tryLock, writeJsonAtomic } from "./store.js";
import type { EventKind, FilterConfig, ThreadEvent, WatchConfig } from "./types.js";

export const WATCH_STATE_VERSION = 1;

/** One page of the comment listing as last seen: its validators and the ids it held. */
export interface PageState {
  readonly url: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly ids: readonly number[];
  readonly next?: string;
}

export interface PollStatus {
  readonly at: string;
  readonly ok: boolean;
  readonly kind?: GitHubErrorKind | "state_reset";
  readonly error?: string;
}

/**
 * The durable state of one watched thread: the snapshot the next poll diffs against, the
 * event log sessions read from, and the poll bookkeeping. Written only as a whole, under
 * the watch lock, by atomic rename — so "events appended" and "snapshot advanced" can
 * never be observed apart.
 */
export interface WatchState {
  readonly version: number;
  readonly watch: string;
  /** False until the first complete listing is recorded. Pre-existing comments are not events. */
  baselined: boolean;
  /** Seq the next event gets. Seqs are per watch, start at 1, and never repeat. */
  nextSeq: number;
  /** Highest seq dropped by retention (0 = none). A session behind it has a reported gap. */
  evictedThrough: number;
  pages: PageState[];
  comments: Record<string, { updatedAt: string; matched: boolean }>;
  events: ThreadEvent[];
  consecutiveFailures: number;
  nextPollAt: number;
  lastPoll?: PollStatus;
  lastSuccessAt?: string;
}

export function emptyWatchState(watch: string): WatchState {
  return {
    version: WATCH_STATE_VERSION,
    watch,
    baselined: false,
    nextSeq: 1,
    evictedThrough: 0,
    pages: [],
    comments: {},
    events: [],
    consecutiveFailures: 0,
    nextPollAt: 0
  };
}

export function watchStatePath(stateDir: string, watch: WatchConfig): string {
  return join(stateDir, "watches", `${fileKey(watch.key)}.json`);
}

function watchLockPath(stateDir: string, watch: WatchConfig): string {
  return join(stateDir, "locks", `watch-${fileKey(watch.key)}.lock`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does this comment body pass the filter? Empty filter = everything passes. */
export function matchesFilter(filter: FilterConfig, body: string): boolean {
  if (filter.mentions.length === 0 && filter.markers.length === 0) {
    return true;
  }
  for (const handle of filter.mentions) {
    // `@handle` not followed by another login character (so @bob does not match @bobby).
    if (new RegExp(`(^|[^A-Za-z0-9_])@${escapeRegExp(handle)}(?![A-Za-z0-9-])`, "i").test(body)) {
      return true;
    }
  }
  return filter.markers.some((marker) => body.includes(marker));
}

export interface ReadWatchResult {
  readonly state: WatchState;
  /** Set when the stored file was unreadable and has been moved aside. */
  readonly reset?: string;
}

function isWatchState(value: unknown, watch: WatchConfig): value is WatchState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const state = value as Partial<WatchState>;
  return (
    state.version === WATCH_STATE_VERSION &&
    state.watch === watch.key &&
    typeof state.nextSeq === "number" &&
    Array.isArray(state.events) &&
    Array.isArray(state.pages) &&
    typeof state.comments === "object" &&
    state.comments !== null
  );
}

/** Read a watch's state for display or delivery (no lock: writes are atomic renames). */
export async function readWatchState(
  stateDir: string,
  watch: WatchConfig
): Promise<WatchState | undefined> {
  const result = await readJson<unknown>(watchStatePath(stateDir, watch));
  return result.status === "ok" && isWatchState(result.value, watch) ? result.value : undefined;
}

async function loadForPoll(stateDir: string, watch: WatchConfig): Promise<ReadWatchResult> {
  const path = watchStatePath(stateDir, watch);
  const result = await readJson<unknown>(path);
  if (result.status === "missing") {
    return { state: emptyWatchState(watch.key) };
  }
  if (result.status === "ok" && isWatchState(result.value, watch)) {
    return { state: result.value };
  }
  // Unreadable state. Keep the evidence, start a new baseline, and say so loudly: changes
  // made while the state was unreadable cannot be reconstructed.
  const aside = `${path}.corrupt-${Date.now()}`;
  await rename(path, aside).catch(() => {});
  const reason = result.status === "corrupt" ? result.error : "unrecognised state shape";
  return { state: emptyWatchState(watch.key), reset: `${reason}; moved to ${aside}` };
}

export interface PollDeps {
  readonly stateDir: string;
  readonly client: GitHubClient;
  readonly filter: FilterConfig;
  readonly logger: Logger;
  readonly pollIntervalMs: number;
  readonly maxBackoffMs: number;
  readonly maxLogEvents: number;
  readonly maxPages: number;
  readonly now?: () => number;
}

export type PollOutcome =
  | { readonly status: "busy" }
  | { readonly status: "not_due"; readonly nextPollAt: number }
  | { readonly status: "unchanged" }
  | { readonly status: "changed"; readonly added: readonly ThreadEvent[] }
  | { readonly status: "failed"; readonly error: GitHubError };

interface Listing {
  readonly pages: PageState[];
  /** Comments from pages that returned 200 (a 304 page's comments are unchanged by definition). */
  readonly fresh: Map<number, Comment>;
  readonly complete: boolean;
  readonly anyChanged: boolean;
}

async function fetchListing(
  watch: WatchConfig,
  previous: readonly PageState[],
  deps: PollDeps
): Promise<Listing> {
  const pages: PageState[] = [];
  const fresh = new Map<number, Comment>();
  let anyChanged = previous.length === 0;
  let url: string | undefined = deps.client.firstPageUrl(watch.owner, watch.repo, watch.number);

  while (url !== undefined && pages.length < deps.maxPages) {
    const prior: PageState | undefined = previous[pages.length];
    const known: PageState | undefined = prior?.url === url ? prior : undefined;
    const page = await deps.client.fetchPage(url, known);

    if (page.status === "not_modified") {
      if (!known) {
        // A 304 for a page we hold no snapshot of cannot be interpreted.
        throw new GitHubError("malformed", "304 for a page without a stored snapshot");
      }
      pages.push(known);
      url = known.next;
      continue;
    }

    anyChanged = true;
    for (const comment of page.comments) {
      // A comment can shift across a page boundary between two page fetches; keep one.
      fresh.set(comment.id, comment);
    }
    pages.push({
      url,
      ids: page.comments.map((comment) => comment.id),
      ...(page.etag ? { etag: page.etag } : {}),
      ...(page.lastModified ? { lastModified: page.lastModified } : {}),
      ...(page.next ? { next: page.next } : {})
    });
    url = page.next;
  }

  // The listing shrank (pages dropped off the end) — that is a change too.
  if (pages.length !== previous.length) {
    anyChanged = true;
  }
  return { pages, fresh, complete: url === undefined, anyChanged };
}

function makeEvent(
  watch: WatchConfig,
  kind: EventKind,
  comment: Pick<Comment, "id" | "author" | "createdAt" | "updatedAt" | "url"> & { body?: string },
  observedAt: string
): Omit<ThreadEvent, "seq"> {
  return {
    id: `${comment.id}:${kind}:${comment.updatedAt}`,
    kind,
    watch: watch.key,
    commentId: comment.id,
    author: comment.author,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    url: comment.url,
    ...(kind === "deleted" || comment.body === undefined ? {} : { body: comment.body }),
    observedAt
  };
}

/**
 * Diff a fetched listing against the stored snapshot. Mutates `state.comments` and
 * returns the events to append (without seqs).
 */
export function diffListing(
  watch: WatchConfig,
  state: WatchState,
  listing: Listing,
  filter: FilterConfig,
  observedAt: string
): Omit<ThreadEvent, "seq">[] {
  const events: Omit<ThreadEvent, "seq">[] = [];
  const emit = state.baselined;

  const ordered = [...listing.fresh.values()].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id - b.id : a.createdAt < b.createdAt ? -1 : 1
  );
  for (const comment of ordered) {
    const key = String(comment.id);
    const prior = state.comments[key];
    const matched = matchesFilter(filter, comment.body);
    if (!prior) {
      if (emit && matched) {
        events.push(makeEvent(watch, "created", comment, observedAt));
      }
    } else if (prior.updatedAt !== comment.updatedAt) {
      // An edit that makes a comment match, or one that changes a delivered comment.
      if (emit && (matched || prior.matched)) {
        events.push(makeEvent(watch, "edited", comment, observedAt));
      }
    }
    state.comments[key] = { updatedAt: comment.updatedAt, matched: matched || !!prior?.matched };
  }

  // Deletions are only knowable from a complete listing.
  if (listing.complete) {
    const present = new Set<number>(listing.pages.flatMap((page) => page.ids));
    for (const [key, prior] of Object.entries(state.comments)) {
      const id = Number(key);
      if (present.has(id)) {
        continue;
      }
      if (emit && prior.matched) {
        events.push(
          makeEvent(
            watch,
            "deleted",
            { id, author: "unknown", createdAt: "", updatedAt: prior.updatedAt, url: "" },
            observedAt
          )
        );
      }
      delete state.comments[key];
    }
  }
  return events;
}

function backoffMs(error: GitHubError, failures: number, deps: PollDeps): number {
  if (error.kind === "rate_limited") {
    return Math.min(
      Math.max(error.retryAfterMs ?? deps.pollIntervalMs, deps.pollIntervalMs),
      3_600_000
    );
  }
  return Math.min(deps.pollIntervalMs * 2 ** Math.min(failures, 16), deps.maxBackoffMs);
}

/**
 * Poll one watch: take the watch lock (or report `busy` — another process is polling and
 * will record the result), fetch the listing conditionally, diff, and commit events +
 * snapshot in a single atomic write. On any failure the snapshot and log are untouched;
 * only the failure status and the backoff deadline are recorded.
 */
export async function pollWatch(
  watch: WatchConfig,
  deps: PollDeps,
  options: { force?: boolean } = {}
): Promise<PollOutcome> {
  const now = deps.now ?? Date.now;
  const lock = await tryLock(watchLockPath(deps.stateDir, watch));
  if (!lock) {
    return { status: "busy" };
  }

  try {
    const { state, reset } = await loadForPoll(deps.stateDir, watch);
    if (reset) {
      deps.logger.error("github_notify_state_reset", { watch: watch.key, reason: reset });
      state.lastPoll = {
        at: new Date(now()).toISOString(),
        ok: false,
        kind: "state_reset",
        error: reset
      };
    }
    if (!options.force && !reset && state.nextPollAt > now()) {
      return { status: "not_due", nextPollAt: state.nextPollAt };
    }

    let listing: Listing;
    try {
      listing = await fetchListing(watch, state.pages, deps);
    } catch (error) {
      const failure =
        error instanceof GitHubError
          ? error
          : new GitHubError("network", error instanceof Error ? error.message : String(error));
      state.consecutiveFailures += 1;
      state.nextPollAt = now() + backoffMs(failure, state.consecutiveFailures - 1, deps);
      state.lastPoll = {
        at: new Date(now()).toISOString(),
        ok: false,
        kind: failure.kind,
        error: failure.message
      };
      await writeJsonAtomic(watchStatePath(deps.stateDir, watch), state);
      deps.logger.warn("github_notify_poll_failed", {
        watch: watch.key,
        kind: failure.kind,
        status: failure.status,
        error: failure.message,
        consecutiveFailures: state.consecutiveFailures,
        retryInMs: state.nextPollAt - now()
      });
      return { status: "failed", error: failure };
    }

    const at = new Date(now()).toISOString();
    let added: ThreadEvent[] = [];
    if (listing.anyChanged || !state.baselined) {
      if (!listing.complete) {
        deps.logger.warn("github_notify_listing_truncated", {
          watch: watch.key,
          maxPages: deps.maxPages
        });
      }
      const wasBaselined = state.baselined;
      const known = new Set(state.events.map((event) => event.id));
      const fresh = diffListing(watch, state, listing, deps.filter, at).filter(
        (event) => !known.has(event.id)
      );
      added = fresh.map((event) => ({ ...event, seq: state.nextSeq++ }));
      state.events.push(...added);
      const overflow = state.events.length - deps.maxLogEvents;
      if (overflow > 0) {
        const dropped = state.events.splice(0, overflow);
        state.evictedThrough = dropped[dropped.length - 1]?.seq ?? state.evictedThrough;
      }
      state.pages = listing.pages;
      state.baselined = true;
      if (!wasBaselined) {
        deps.logger.info("github_notify_baselined", {
          watch: watch.key,
          comments: Object.keys(state.comments).length
        });
      }
    }

    state.consecutiveFailures = 0;
    state.nextPollAt = now() + deps.pollIntervalMs;
    state.lastPoll = reset ? state.lastPoll : { at, ok: true };
    state.lastSuccessAt = at;
    await writeJsonAtomic(watchStatePath(deps.stateDir, watch), state);

    if (added.length > 0) {
      deps.logger.info("github_notify_events_recorded", {
        watch: watch.key,
        count: added.length,
        lastSeq: state.nextSeq - 1
      });
      return { status: "changed", added };
    }
    deps.logger.trace("github_notify_poll_unchanged", { watch: watch.key });
    return { status: "unchanged" };
  } finally {
    await lock.release();
  }
}
