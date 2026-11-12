import type { WakeOptions } from "./config.js";
import { GITHUB_PAGE_SIZE, TransportFailure, type GitHubTransport } from "./github.js";
import type { Logger } from "./logging.js";
import type { SourceState, WakeCursor, WakeEvent, WatchTarget } from "./types.js";

/** Everything a source needs for one poll. Pure strategy: no timers, no storage. */
export interface SourceContext {
  /** The shared fetch target — not a subscription: one fetcher serves many. */
  readonly target: WatchTarget;
  readonly state: SourceState;
  readonly transport: GitHubTransport;
  readonly options: WakeOptions;
  readonly logger: Logger;
  readonly now: () => number;
}

/** What one successful poll produced. The poller owns dedupe, filtering and delivery. */
export interface SourceResult {
  readonly events: readonly WakeEvent[];
  readonly cursor: WakeCursor;
  /** Validators to persist, keyed by the URL they were earned for. Replaces the map. */
  readonly etags: Record<string, string>;
  readonly notModified: boolean;
  /**
   * First observation of a `github.checks` watch: record what exists now without
   * waking. A new watch should report *changes*, not the current CI snapshot.
   */
  readonly baseline?: boolean;
}

function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** The issue/PR number a thread source needs; `github.actions` has none. */
function requireNumber(target: WatchTarget): number {
  if (target.number === undefined) {
    throw new TransportFailure("malformed", `${target.kind} requires an issue/PR number`);
  }
  return target.number;
}

function threadURL(target: WatchTarget, page: number, since: string): string {
  return `${repoPath(target.owner, target.repo)}/issues/${requireNumber(
    target
  )}/comments?per_page=${GITHUB_PAGE_SIZE}&page=${page}&since=${since}`;
}

function timelineURL(target: WatchTarget, page: number): string {
  return `${repoPath(target.owner, target.repo)}/issues/${requireNumber(
    target
  )}/timeline?per_page=${GITHUB_PAGE_SIZE}&page=${page}`;
}

function pullURL(target: WatchTarget): string {
  return `${repoPath(target.owner, target.repo)}/pulls/${requireNumber(target)}`;
}

function checksURL(target: WatchTarget, ref: string, page: number): string {
  return `${repoPath(target.owner, target.repo)}/commits/${encodeURIComponent(
    ref
  )}/check-runs?per_page=${GITHUB_PAGE_SIZE}&page=${page}`;
}

/**
 * The URL a workflow-runs request will use. `github.actions` needs it only as
 * the ETag key: it must be stable for the exact request variant (workflow,
 * branch, page), because a validator earned for one variant is never reused for
 * another. The real URL is built by the transport from the same parts.
 */
function runsURL(target: WatchTarget, page: number): string {
  const base =
    target.workflow !== undefined
      ? `${repoPath(target.owner, target.repo)}/actions/workflows/${encodeURIComponent(
          target.workflow
        )}/runs`
      : `${repoPath(target.owner, target.repo)}/actions/runs`;
  const query = [`per_page=${GITHUB_PAGE_SIZE}`, `page=${page}`];
  if (target.branch !== undefined) {
    query.push(`branch=${encodeURIComponent(target.branch)}`);
  }
  return `${base}?${query.join("&")}`;
}

/** Advance the cursor to the newest event, preserving fields the source owns. */
function advanceCursor(
  previous: WakeCursor,
  events: readonly WakeEvent[],
  extra: Partial<WakeCursor> = {}
): WakeCursor {
  let newestAt = previous.lastSeenAt;
  let newestID = previous.lastEventID;
  for (const event of events) {
    if (event.updatedAt > newestAt) {
      newestAt = event.updatedAt;
      newestID = event.id;
    }
  }
  return {
    lastSeenAt: newestAt,
    ...(newestID !== undefined ? { lastEventID: newestID } : {}),
    ...extra
  };
}

/**
 * `github.thread`: comments only, filtered server-side by `since`. Unchanged from
 * the first slice so existing watches keep their cursor and their dedupe history.
 */
async function pollThread(context: SourceContext): Promise<SourceResult> {
  const { target, state, transport, options } = context;
  const since = state.cursor.lastSeenAt;
  const firstURL = threadURL(target, 1, since);
  const cached = state.etags?.[firstURL];

  const events: WakeEvent[] = [];
  let firstPageETag: string | undefined;
  let notModified = false;
  let page = 1;
  let hasNextPage = true;

  while (hasNextPage && page <= options.maxPages) {
    const response = await transport.listComments({
      owner: target.owner,
      repo: target.repo,
      number: requireNumber(target),
      page,
      since,
      ...(page === 1 && cached !== undefined ? { etag: cached } : {})
    });
    if (response.notModified) {
      notModified = true;
      break;
    }
    events.push(...response.events);
    if (page === 1 && response.etag !== undefined) {
      firstPageETag = response.etag;
    }
    hasNextPage = response.hasNextPage;
    page += 1;
  }

  if (notModified) {
    return {
      events: [],
      cursor: state.cursor,
      etags: state.etags ?? {},
      notModified: true
    };
  }

  const cursor = advanceCursor(state.cursor, events);
  // The validator is only reusable when the next request repeats the same URL.
  const nextURL = threadURL(target, 1, cursor.lastSeenAt);
  return {
    events,
    cursor,
    etags: firstPageETag !== undefined && nextURL === firstURL ? { [nextURL]: firstPageETag } : {},
    notModified: false
  };
}

function coversBoundary(
  events: readonly WakeEvent[],
  since: string,
  cursorID: string | undefined
): boolean {
  if (events.length === 0) {
    // An empty page cannot add events; treat it as the end of what we need.
    return true;
  }
  if (cursorID !== undefined && events.some((event) => event.id === cursorID)) {
    // We reached the event we last saw: everything newer is already in hand.
    return true;
  }
  const oldest = events.reduce(
    (min, event) => (event.createdAt < min ? event.createdAt : min),
    events[0]?.createdAt ?? since
  );
  return oldest <= since;
}

/**
 * `github.timeline`: the whole issue/PR timeline. It has **no `since` parameter**,
 * so the tail is paged backwards from `Link: rel="last"` until a page reaches the
 * cursor (by event id, or by timestamp when the last event was deleted). A tail
 * deeper than `maxPages` fails closed rather than silently skipping the middle.
 *
 * Page 1 is the *oldest* page, so it is only the whole answer when GitHub says
 * there is no `last` page; otherwise the boundary must be found from the tail.
 */
async function pollTimeline(context: SourceContext): Promise<SourceResult> {
  const { target, state, transport, options } = context;
  const since = state.cursor.lastSeenAt;
  const cursorID = state.cursor.lastEventID;
  const firstURL = timelineURL(target, 1);
  const cached = state.etags?.[firstURL];

  const first = await transport.listTimeline({
    owner: target.owner,
    repo: target.repo,
    number: requireNumber(target),
    page: 1,
    ...(cached !== undefined ? { etag: cached } : {})
  });

  if (first.notModified) {
    return {
      events: [],
      cursor: state.cursor,
      etags: state.etags ?? {},
      notModified: true
    };
  }

  const lastPage = first.lastPage ?? 1;
  const pages: WakeEvent[][] = [];
  let boundary = lastPage === 1;
  let reachedStart = lastPage === 1;
  let fetched = 1; // page 1 is already in hand
  let page = lastPage;

  if (lastPage === 1) {
    pages.push([...first.events]);
  } else {
    while (!boundary && !reachedStart && fetched < options.maxPages) {
      const response =
        page === 1
          ? { events: first.events }
          : await transport.listTimeline({
              owner: target.owner,
              repo: target.repo,
              number: requireNumber(target),
              page
            });
      pages.unshift([...response.events]);
      fetched += 1;
      boundary = coversBoundary(response.events, since, cursorID);
      reachedStart = page === 1;
      page -= 1;
    }
    if (!boundary && !reachedStart) {
      throw new TransportFailure(
        "backlog",
        `timeline needs more than ${options.maxPages} pages to reach the cursor`
      );
    }
  }

  // The timeline has no `since`, so the boundary is enforced here: a page may
  // legitimately start before the cursor, and those events were never new.
  const events = pages.flat().filter((event) => event.createdAt >= since);
  const cursor = advanceCursor(state.cursor, events);
  // A page-1 ETag proves the whole timeline unchanged only when page 1 was the
  // only page and was not full: a new event must then change page 1's body.
  const etags =
    lastPage === 1 && first.events.length < GITHUB_PAGE_SIZE && first.etag
      ? { [firstURL]: first.etag }
      : {};
  return { events, cursor, etags, notModified: false };
}

/**
 * `github.checks`: the PR's head commit plus its check runs. Needs a pull-request
 * number — a plain issue answers `404` on `/pulls/{n}` and fails closed.
 *
 * This source stays check-run based. Workflow runs are a different signal and a
 * different scope (`actions: read`); they live in `github.actions` instead, so a
 * repository can watch one, the other, or both deliberately.
 */
async function pollChecks(context: SourceContext): Promise<SourceResult> {
  const { target, state, transport, options, now } = context;
  const pull = await transport.getPullRequest({
    owner: target.owner,
    repo: target.repo,
    number: requireNumber(target),
    ...(state.etags?.[pullURL(target)] !== undefined ? { etag: state.etags[pullURL(target)] } : {})
  });

  const headSHA = pull.notModified ? state.cursor.headSHA : pull.headSHA;
  if (headSHA === undefined || headSHA.length === 0) {
    throw new TransportFailure("malformed", "pull request head sha unknown");
  }

  const baseline = state.cursor.headSHA === undefined;
  const events: WakeEvent[] = [];
  if (!baseline && state.cursor.headSHA !== headSHA) {
    const at = new Date(now()).toISOString();
    events.push({
      id: `commit:${headSHA}`,
      kind: "commit",
      author: "github",
      createdAt: at,
      updatedAt: at,
      url: pull.htmlURL ?? "",
      body: "",
      title: `new head commit ${headSHA.slice(0, 7)}`
    });
  }

  const checksFirstURL = checksURL(target, headSHA, 1);
  const cachedChecks = state.etags?.[checksFirstURL];
  const runs: WakeEvent[] = [];
  let firstPageETag: string | undefined;
  let checksNotModified = false;
  let singlePage = true;
  let page = 1;
  let hasNextPage = true;

  while (hasNextPage && page <= options.maxPages) {
    const response = await transport.listCheckRuns({
      owner: target.owner,
      repo: target.repo,
      ref: headSHA,
      page,
      ...(page === 1 && cachedChecks !== undefined ? { etag: cachedChecks } : {})
    });
    if (response.notModified) {
      checksNotModified = true;
      break;
    }
    runs.push(...response.events);
    if (page === 1 && response.etag !== undefined) {
      firstPageETag = response.etag;
    }
    if (page > 1) {
      singlePage = false;
    }
    hasNextPage = response.hasNextPage;
    page += 1;
  }

  events.push(...runs);

  const cursor = advanceCursor(state.cursor, events, { headSHA });
  const etags: Record<string, string> = {};
  const pullETag = pull.notModified ? state.etags?.[pullURL(target)] : pull.etag;
  if (pullETag !== undefined) {
    etags[pullURL(target)] = pullETag;
  }
  const checksETag = checksNotModified
    ? cachedChecks
    : singlePage && runs.length < GITHUB_PAGE_SIZE
      ? firstPageETag
      : undefined;
  if (checksETag !== undefined) {
    etags[checksFirstURL] = checksETag;
  }

  return {
    events,
    cursor,
    etags,
    notModified: pull.notModified && checksNotModified && events.length === 0,
    baseline
  };
}

/**
 * `github.actions`: the repository's workflow runs (or one workflow's, or one
 * branch's). Run-level only — jobs are out of scope.
 *
 * GitHub has **no `since`/`updated` filter** for workflow runs: the list is
 * creation-ordered, and a run that was created an hour ago and just finished
 * does not move to page 1. The watch therefore keeps a *window*: the cursor's
 * `runFloor` is the `created_at` of the oldest run in the tracked window, and
 * every poll re-reads from the newest page down to that floor, fingerprinting
 * each run as `(run id, status, conclusion, updated_at)` so only transitions
 * are reported. If new runs push the floor past `maxPages`, the poll fails
 * closed as `backlog` instead of silently dropping the middle.
 *
 * The first successful poll records a baseline (no wake), exactly like
 * `github.checks`: a new watch reports *changes*, not the current CI snapshot.
 */
async function pollActions(context: SourceContext): Promise<SourceResult> {
  const { target, state, transport, options, now } = context;
  const floor = state.cursor.runFloor;
  const baseline = floor === undefined;
  const firstURL = runsURL(target, 1);
  const cached = state.etags?.[firstURL];

  const observed: WakeEvent[] = [];
  let firstPageETag: string | undefined;
  let notModified = false;
  let page = 1;
  let hasNextPage = true;
  let reachedFloor = false;
  let singlePage = true;
  let oldestCreatedAt: string | undefined;

  while (hasNextPage && page <= options.maxPages) {
    const response = await transport.listWorkflowRuns({
      owner: target.owner,
      repo: target.repo,
      ...(target.workflow !== undefined ? { workflow: target.workflow } : {}),
      ...(target.branch !== undefined ? { branch: target.branch } : {}),
      page,
      ...(page === 1 && cached !== undefined ? { etag: cached } : {})
    });
    if (response.notModified) {
      notModified = true;
      break;
    }
    observed.push(...response.events);
    if (page === 1 && response.etag !== undefined) {
      firstPageETag = response.etag;
    }
    if (page > 1) {
      singlePage = false;
    }
    // The list is creation-ordered, so the page's oldest `created_at` is the
    // boundary candidate. An empty page has none and cannot extend the window.
    let oldest: string | undefined;
    for (const event of response.events) {
      if (oldest === undefined || event.createdAt < oldest) {
        oldest = event.createdAt;
      }
    }
    if (oldest !== undefined && (oldestCreatedAt === undefined || oldest < oldestCreatedAt)) {
      oldestCreatedAt = oldest;
    }
    if (!baseline && floor !== undefined && oldest !== undefined && oldest <= floor) {
      reachedFloor = true;
      break;
    }
    hasNextPage = response.hasNextPage;
    page += 1;
  }

  if (notModified) {
    return {
      events: [],
      cursor: state.cursor,
      etags: state.etags ?? {},
      notModified: true
    };
  }

  if (!baseline && !reachedFloor && hasNextPage) {
    throw new TransportFailure(
      "backlog",
      `workflow runs need more than ${options.maxPages} pages to reach the cursor`
    );
  }

  const advanced = advanceCursor(state.cursor, observed);
  const cursor: WakeCursor = {
    ...advanced,
    // An empty baseline still needs a floor, otherwise the next run to appear
    // would be swallowed as a second baseline instead of waking.
    runFloor: baseline ? (oldestCreatedAt ?? new Date(now()).toISOString()) : (floor as string)
  };

  // Re-reading the window is cheap for the HTTP cache but would overflow the
  // bounded `seen` ring; `updated_at` only moves forward, so anything not newer
  // than the previous boundary is an unchanged fingerprint by definition.
  const events = baseline
    ? observed
    : observed.filter((event) => event.updatedAt >= state.cursor.lastSeenAt);

  // Same rule as `github.checks`: a page-1 validator proves the whole tracked
  // set unchanged only when it was the only page and was not full.
  const etags: Record<string, string> = {};
  if (singlePage && observed.length < GITHUB_PAGE_SIZE && firstPageETag !== undefined) {
    etags[firstURL] = firstPageETag;
  }

  return { events, cursor, etags, notModified: false, baseline };
}

/** Dispatch to the adapter for this watch target's source kind. */
export function pollSource(context: SourceContext): Promise<SourceResult> {
  switch (context.target.kind) {
    case "github.thread":
      return pollThread(context);
    case "github.timeline":
      return pollTimeline(context);
    case "github.checks":
      return pollChecks(context);
    case "github.actions":
      return pollActions(context);
    default: {
      const kind: never = context.target.kind;
      return Promise.reject(
        new TransportFailure("malformed", `unsupported source kind: ${String(kind)}`)
      );
    }
  }
}
