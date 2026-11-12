import type { WakeOptions } from "./config.js";
import { GITHUB_PAGE_SIZE, TransportFailure, type GitHubTransport } from "./github.js";
import type { Logger } from "./logging.js";
import type { SubscriptionState, WakeCursor, WakeEvent, WakeSubscription } from "./types.js";

/** Everything a source needs for one poll. Pure strategy: no timers, no storage. */
export interface SourceContext {
  readonly subscription: WakeSubscription;
  readonly state: SubscriptionState;
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

function threadURL(subscription: WakeSubscription, page: number, since: string): string {
  return `${repoPath(subscription.owner, subscription.repo)}/issues/${
    subscription.number
  }/comments?per_page=${GITHUB_PAGE_SIZE}&page=${page}&since=${since}`;
}

function timelineURL(subscription: WakeSubscription, page: number): string {
  return `${repoPath(subscription.owner, subscription.repo)}/issues/${
    subscription.number
  }/timeline?per_page=${GITHUB_PAGE_SIZE}&page=${page}`;
}

function pullURL(subscription: WakeSubscription): string {
  return `${repoPath(subscription.owner, subscription.repo)}/pulls/${subscription.number}`;
}

function checksURL(subscription: WakeSubscription, ref: string, page: number): string {
  return `${repoPath(subscription.owner, subscription.repo)}/commits/${encodeURIComponent(
    ref
  )}/check-runs?per_page=${GITHUB_PAGE_SIZE}&page=${page}`;
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
  const { subscription, state, transport, options } = context;
  const since = state.cursor.lastSeenAt;
  const firstURL = threadURL(subscription, 1, since);
  const cached = state.etags?.[firstURL];

  const events: WakeEvent[] = [];
  let firstPageETag: string | undefined;
  let notModified = false;
  let page = 1;
  let hasNextPage = true;

  while (hasNextPage && page <= options.maxPages) {
    const response = await transport.listComments({
      owner: subscription.owner,
      repo: subscription.repo,
      number: subscription.number,
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
  const nextURL = threadURL(subscription, 1, cursor.lastSeenAt);
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
  const { subscription, state, transport, options } = context;
  const since = state.cursor.lastSeenAt;
  const cursorID = state.cursor.lastEventID;
  const firstURL = timelineURL(subscription, 1);
  const cached = state.etags?.[firstURL];

  const first = await transport.listTimeline({
    owner: subscription.owner,
    repo: subscription.repo,
    number: subscription.number,
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
              owner: subscription.owner,
              repo: subscription.repo,
              number: subscription.number,
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
 * Workflow runs (`/actions/runs`) are deliberately not fetched: they need a
 * separate `actions: read` scope and would report the same CI twice.
 */
async function pollChecks(context: SourceContext): Promise<SourceResult> {
  const { subscription, state, transport, options, now } = context;
  const pull = await transport.getPullRequest({
    owner: subscription.owner,
    repo: subscription.repo,
    number: subscription.number,
    ...(state.etags?.[pullURL(subscription)] !== undefined
      ? { etag: state.etags[pullURL(subscription)] }
      : {})
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

  const checksFirstURL = checksURL(subscription, headSHA, 1);
  const cachedChecks = state.etags?.[checksFirstURL];
  const runs: WakeEvent[] = [];
  let firstPageETag: string | undefined;
  let checksNotModified = false;
  let singlePage = true;
  let page = 1;
  let hasNextPage = true;

  while (hasNextPage && page <= options.maxPages) {
    const response = await transport.listCheckRuns({
      owner: subscription.owner,
      repo: subscription.repo,
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
  const pullETag = pull.notModified ? state.etags?.[pullURL(subscription)] : pull.etag;
  if (pullETag !== undefined) {
    etags[pullURL(subscription)] = pullETag;
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

/** Dispatch to the adapter for this subscription's source kind. */
export function pollSource(context: SourceContext): Promise<SourceResult> {
  switch (context.subscription.kind) {
    case "github.thread":
      return pollThread(context);
    case "github.timeline":
      return pollTimeline(context);
    case "github.checks":
      return pollChecks(context);
    default: {
      const kind: never = context.subscription.kind;
      return Promise.reject(
        new TransportFailure("malformed", `unsupported source kind: ${String(kind)}`)
      );
    }
  }
}
