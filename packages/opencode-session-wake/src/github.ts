import { TokenError, type TokenSource } from "./auth.js";
import type { WakeEvent, WakeEventKind } from "./types.js";

/** GitHub serves at most 100 items per page; sources use this to judge "single page". */
export const GITHUB_PAGE_SIZE = 100;

/**
 * Why a poll failed. Every kind is a *closed* failure: the caller logs it,
 * backs off and leaves the cursor alone. Nothing here is ever treated as "no
 * new events".
 */
export type TransportFailureKind =
  | "auth"
  | "forbidden"
  | "rate-limit"
  | "network"
  | "malformed"
  | "not-found"
  | "backlog"
  | "http";

export class TransportFailure extends Error {
  readonly kind: TransportFailureKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    kind: TransportFailureKind,
    message: string,
    extra: { status?: number; retryAfterMs?: number } = {}
  ) {
    super(message);
    this.name = "TransportFailure";
    this.kind = kind;
    this.status = extra.status;
    this.retryAfterMs = extra.retryAfterMs;
  }
}

export interface CommentPageRequest {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly page: number;
  /** ISO timestamp from the persisted cursor. */
  readonly since?: string;
  /** Only sent when it was earned for this exact request URL. */
  readonly etag?: string;
}

export interface CommentPage {
  /** A conditional request answered `304`: nothing changed since the cursor. */
  readonly notModified: boolean;
  readonly etag?: string;
  readonly events: readonly WakeEvent[];
  readonly hasNextPage: boolean;
}

export interface TimelineRequest {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly page: number;
  readonly etag?: string;
}

export interface TimelinePage {
  readonly notModified: boolean;
  readonly etag?: string;
  readonly events: readonly WakeEvent[];
  readonly hasNextPage: boolean;
  /** The last page number GitHub advertises (`Link: rel="last"`), when there is one. */
  readonly lastPage?: number;
}

export interface PullRequestRequest {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly etag?: string;
}

export interface PullRequestSnapshot {
  readonly notModified: boolean;
  readonly etag?: string;
  readonly headSHA: string;
  /** The PR's web URL, used for the "new head commit" event. */
  readonly htmlURL?: string;
}

export interface CheckRunsRequest {
  readonly owner: string;
  readonly repo: string;
  /** Commit sha (or ref) the runs belong to. */
  readonly ref: string;
  readonly page: number;
  readonly etag?: string;
}

export interface CheckRunsPage {
  readonly notModified: boolean;
  readonly etag?: string;
  readonly events: readonly WakeEvent[];
  readonly hasNextPage: boolean;
}

export interface WorkflowRunsRequest {
  readonly owner: string;
  readonly repo: string;
  /** Workflow id or file name. Omitted means every workflow in the repository. */
  readonly workflow?: string;
  /** Branch filter (`branch=`). */
  readonly branch?: string;
  readonly page: number;
  readonly etag?: string;
}

export interface WorkflowRunsPage {
  readonly notModified: boolean;
  readonly etag?: string;
  readonly events: readonly WakeEvent[];
  readonly hasNextPage: boolean;
}

/**
 * The seam tests replace with a fake. Read-only by construction: every method
 * is one `GET`, and the real transport has no other HTTP verb anywhere.
 */
export interface GitHubTransport {
  /** `github.thread` — issue/PR comments. */
  listComments(request: CommentPageRequest): Promise<CommentPage>;
  /** `github.timeline` — the issue/PR timeline (comments, reviews, state, labels, …). */
  listTimeline(request: TimelineRequest): Promise<TimelinePage>;
  /** `github.checks` — the PR's current head commit. */
  getPullRequest(request: PullRequestRequest): Promise<PullRequestSnapshot>;
  /** `github.checks` — check runs for one commit. */
  listCheckRuns(request: CheckRunsRequest): Promise<CheckRunsPage>;
  /** `github.actions` — workflow runs for a repository (optionally one workflow/branch). */
  listWorkflowRuns(request: WorkflowRunsRequest): Promise<WorkflowRunsPage>;
}

export interface GitHubTransportOptions {
  readonly token: TokenSource;
  /** Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Defaults to `https://api.github.com`. */
  readonly apiBase?: string;
  readonly now?: () => number;
}

function retryAfterFromHeaders(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) {
      return Math.max(0, at - now);
    }
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds)) {
      return Math.max(0, Math.round(epochSeconds * 1000 - now));
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Collapse untrusted text to one short line so it cannot forge a second entry. */
export function summarize(value: string, max = 200): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function loginOf(value: unknown): string | undefined {
  const record = asRecord(value);
  return stringOf(record?.login) ?? stringOf(record?.name);
}

function pageFromLink(link: string, rel: "next" | "last"): number | undefined {
  for (const part of link.split(",")) {
    if (!part.includes(`rel="${rel}"`)) {
      continue;
    }
    const match = /[?&]page=(\d+)/.exec(part);
    if (match?.[1]) {
      return Number(match[1]);
    }
  }
  return undefined;
}

/**
 * Map one REST comment onto a `WakeEvent`. Anything structurally unexpected is
 * a `malformed` failure, not a silently dropped comment: a page we cannot read
 * must not advance the cursor.
 */
function toCommentEvent(value: unknown): WakeEvent {
  const record = asRecord(value);
  const id = record?.id;
  if (record === undefined || (typeof id !== "number" && typeof id !== "string")) {
    throw new TransportFailure("malformed", "comment without a usable id");
  }
  const body = record.body;
  const createdAt = record.created_at;
  const updatedAt = record.updated_at ?? createdAt;
  if (typeof body !== "string" || typeof createdAt !== "string" || typeof updatedAt !== "string") {
    throw new TransportFailure("malformed", `comment ${String(id)} is missing body or timestamps`);
  }
  return {
    // Bare id, as `github.thread` has always stored it: changing it would
    // re-deliver every comment a live watch already saw.
    id: String(id),
    kind: "comment",
    author: loginOf(record.user) ?? "unknown",
    createdAt,
    updatedAt,
    url: stringOf(record.html_url) ?? "",
    body
  };
}

/**
 * Stable id for a timeline event. Most event types carry an `id`; a `committed`
 * event carries the commit `sha` instead. When neither exists the timestamp and
 * actor are the best available identity — a false positive (one duplicate
 * suppressed) is safer than a false negative (a duplicate delivered).
 */
function timelineID(record: Record<string, unknown>, createdAt: string, author: string): string {
  const raw = record.id;
  if (typeof raw === "number" || (typeof raw === "string" && raw.length > 0)) {
    return String(raw);
  }
  const sha = stringOf(record.sha);
  if (sha) {
    return `sha:${sha}`;
  }
  return `at:${createdAt}:${author}`;
}

interface TimelineDescription {
  readonly kind: WakeEventKind;
  readonly title: string;
  readonly body: string;
}

/** Translate a GitHub timeline `event` into our event kind, summary and body. */
function describeTimeline(type: string, record: Record<string, unknown>): TimelineDescription {
  const label = asRecord(record.label);
  const assignee = asRecord(record.assignee);
  const requestedReviewer = asRecord(record.requested_reviewer);
  const requestedTeam = asRecord(record.requested_team);
  const milestone = asRecord(record.milestone);
  const rename = asRecord(record.rename);
  const state = stringOf(record.state);

  switch (type) {
    case "commented":
      return { kind: "comment", title: "", body: stringOf(record.body) ?? "" };
    case "reviewed":
      return {
        kind: "review",
        title: summarize(`review ${state ?? "submitted"}`),
        body: stringOf(record.body) ?? ""
      };
    case "line-commented":
      return {
        kind: "review_comment",
        title: "review comment",
        body: stringOf(record.body) ?? ""
      };
    case "review_dismissed":
      return { kind: "review", title: "review dismissed", body: "" };
    case "closed":
      return { kind: "state", title: "closed", body: "" };
    case "reopened":
      return { kind: "state", title: "reopened", body: "" };
    case "merged":
      return { kind: "state", title: "merged", body: "" };
    case "labeled":
      return {
        kind: "label",
        title: summarize(`label added: ${stringOf(label?.name) ?? "unknown"}`),
        body: ""
      };
    case "unlabeled":
      return {
        kind: "label",
        title: summarize(`label removed: ${stringOf(label?.name) ?? "unknown"}`),
        body: ""
      };
    case "assigned":
      return {
        kind: "assignee",
        title: summarize(`assigned to @${loginOf(assignee) ?? "unknown"}`),
        body: ""
      };
    case "unassigned":
      return {
        kind: "assignee",
        title: summarize(`unassigned from @${loginOf(assignee) ?? "unknown"}`),
        body: ""
      };
    case "review_requested":
      return {
        kind: "review_request",
        title: summarize(
          `review requested from @${
            loginOf(requestedReviewer) ?? stringOf(requestedTeam?.name) ?? "unknown"
          }`
        ),
        body: ""
      };
    case "review_request_removed":
      return { kind: "review_request", title: "review request removed", body: "" };
    case "committed":
      return {
        kind: "commit",
        title: summarize(`commit ${(stringOf(record.sha) ?? "").slice(0, 7)}`),
        body: ""
      };
    case "head_ref_force_pushed":
      return { kind: "state", title: "head branch force-pushed", body: "" };
    case "ready_for_review":
      return { kind: "state", title: "ready for review", body: "" };
    case "convert_to_draft":
      return { kind: "state", title: "converted to draft", body: "" };
    case "renamed":
      return {
        kind: "state",
        title: "renamed",
        body: `from: ${stringOf(rename?.from) ?? ""}\nto: ${stringOf(rename?.to) ?? ""}`
      };
    case "milestoned":
      return {
        kind: "state",
        title: summarize(`milestone added: ${stringOf(milestone?.title) ?? "unknown"}`),
        body: ""
      };
    case "demilestoned":
      return {
        kind: "state",
        title: summarize(`milestone removed: ${stringOf(milestone?.title) ?? "unknown"}`),
        body: ""
      };
    case "comment_deleted":
      return { kind: "state", title: "comment deleted", body: "" };
    default:
      // Unknown-but-well-formed events are still reported (as a state change)
      // rather than dropped, so a new GitHub event type cannot hide an update.
      return { kind: "state", title: summarize(type), body: "" };
  }
}

function toTimelineEvent(value: unknown): WakeEvent {
  const record = asRecord(value);
  const type = stringOf(record?.event);
  if (record === undefined || type === undefined) {
    throw new TransportFailure("malformed", "timeline event without an `event` type");
  }
  // `committed` carries no `created_at`; a review carries `submitted_at`.
  const createdAt =
    stringOf(record.created_at) ??
    stringOf(record.submitted_at) ??
    stringOf(asRecord(record.committer)?.date) ??
    stringOf(asRecord(record.author)?.date);
  if (createdAt === undefined) {
    throw new TransportFailure("malformed", `timeline event \`${type}\` has no timestamp`);
  }
  const actor = asRecord(record.actor) ?? asRecord(record.user);
  const author = loginOf(actor) ?? loginOf(record.author) ?? "unknown";
  const description = describeTimeline(type, record);
  return {
    id: `${type}:${timelineID(record, createdAt, author)}`,
    kind: description.kind,
    author,
    createdAt,
    updatedAt: createdAt,
    url: stringOf(record.html_url) ?? "",
    body: description.body,
    title: description.title
  };
}

/**
 * One check run, keyed by `(run id, status, conclusion)` so each transition is a
 * distinct event and a repeated observation of the same state dedupes.
 */
function toCheckRunEvent(value: unknown, fallbackAt: string): WakeEvent {
  const record = asRecord(value);
  const id = record?.id;
  if (record === undefined || (typeof id !== "number" && typeof id !== "string")) {
    throw new TransportFailure("malformed", "check run without a usable id");
  }
  const name = stringOf(record.name) ?? "check";
  const status = stringOf(record.status) ?? "unknown";
  const conclusion = stringOf(record.conclusion);
  const startedAt = stringOf(record.started_at) ?? fallbackAt;
  const completedAt = stringOf(record.completed_at) ?? startedAt;
  const app = asRecord(record.app);
  return {
    id: `check:${String(id)}:${status}:${conclusion ?? ""}`,
    kind: "check",
    author: stringOf(app?.name) ?? "unknown",
    createdAt: startedAt,
    updatedAt: completedAt,
    url: stringOf(record.html_url) ?? stringOf(record.details_url) ?? "",
    body: "",
    title: summarize(`${name}: ${status}${conclusion ? ` / ${conclusion}` : ""}`)
  };
}

/**
 * One workflow run, keyed by `(run id, status, conclusion, updated_at)` so every
 * observed transition is a distinct event while a repeated observation of the
 * same state dedupes. `created_at` is the creation boundary the source pages
 * against; `run_started_at` is only a fallback because a queued run has none.
 */
function toWorkflowRunEvent(value: unknown, fallbackAt: string): WakeEvent {
  const record = asRecord(value);
  const id = record?.id;
  if (record === undefined || (typeof id !== "number" && typeof id !== "string")) {
    throw new TransportFailure("malformed", "workflow run without a usable id");
  }
  const status = stringOf(record.status) ?? "unknown";
  const conclusion = stringOf(record.conclusion);
  const createdAt =
    stringOf(record.created_at) ?? stringOf(record.run_started_at) ?? stringOf(record.updated_at);
  const updatedAt = stringOf(record.updated_at) ?? createdAt ?? fallbackAt;
  if (createdAt === undefined) {
    throw new TransportFailure("malformed", `workflow run ${String(id)} has no timestamp`);
  }
  const name = stringOf(record.name) ?? stringOf(record.display_title) ?? "workflow";
  const branch = stringOf(record.head_branch);
  return {
    id: `run:${String(id)}:${status}:${conclusion ?? ""}:${updatedAt}`,
    kind: "run",
    author: loginOf(record.actor) ?? "github",
    createdAt,
    updatedAt,
    url: stringOf(record.html_url) ?? "",
    body: "",
    title: summarize(
      `${name}${branch ? ` (${branch})` : ""}: ${status}${conclusion ? ` / ${conclusion}` : ""}`
    )
  };
}

interface RawResponse {
  readonly notModified: boolean;
  readonly etag?: string;
  readonly link?: string;
  readonly body: unknown;
}

/**
 * The real transport. Every method funnels through this one `GET`: the plugin
 * cannot post, react, label or merge, even by accident.
 */
export function createGitHubTransport(options: GitHubTransportOptions): GitHubTransport {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const now = options.now ?? Date.now;

  async function get(
    path: string,
    query: Record<string, string>,
    etag?: string
  ): Promise<RawResponse> {
    let token: string;
    try {
      token = await options.token.resolve();
    } catch (error) {
      // `TokenError` carries the command name only; the token never reaches a message.
      throw new TransportFailure(
        "auth",
        error instanceof TokenError ? error.message : "no GitHub token available"
      );
    }

    const url = new URL(`${apiBase}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "opencode-session-wake",
      "x-github-api-version": "2022-11-28"
    };
    if (etag) {
      headers["if-none-match"] = etag;
    }

    let response: Response;
    try {
      response = await fetchImpl(url, { method: "GET", headers });
    } catch (error) {
      throw new TransportFailure(
        "network",
        error instanceof Error ? error.message : "network request failed"
      );
    }

    const responseETag = response.headers.get("etag") ?? undefined;
    const link = response.headers.get("link") ?? undefined;

    if (response.status === 304) {
      return {
        notModified: true,
        body: undefined,
        ...(responseETag !== undefined ? { etag: responseETag } : {})
      };
    }

    if (response.status === 401) {
      throw new TransportFailure("auth", "GitHub rejected the token (401)", { status: 401 });
    }

    if (response.status === 403 || response.status === 429) {
      const retryAfterMs = retryAfterFromHeaders(response.headers, now());
      const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
      if (response.status === 429 || exhausted || retryAfterMs !== undefined) {
        throw new TransportFailure("rate-limit", "GitHub rate limit reached", {
          status: response.status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
        });
      }
      throw new TransportFailure("forbidden", "GitHub refused the request (403)", {
        status: 403
      });
    }

    if (response.status === 404) {
      throw new TransportFailure("not-found", "GitHub returned 404 (not found or no access)", {
        status: 404
      });
    }

    if (response.status !== 200) {
      throw new TransportFailure("http", `GitHub returned ${response.status}`, {
        status: response.status
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TransportFailure("malformed", "GitHub returned a non-JSON body", { status: 200 });
    }

    return {
      notModified: false,
      ...(responseETag !== undefined ? { etag: responseETag } : {}),
      ...(link !== undefined ? { link } : {}),
      body
    };
  }

  function arrayBody(body: unknown): unknown[] {
    if (!Array.isArray(body)) {
      throw new TransportFailure("malformed", "GitHub returned a non-array body", { status: 200 });
    }
    return body;
  }

  const repoPath = (owner: string, repo: string): string =>
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  return {
    async listComments(request) {
      const response = await get(
        `${repoPath(request.owner, request.repo)}/issues/${request.number}/comments`,
        {
          per_page: String(GITHUB_PAGE_SIZE),
          page: String(request.page),
          ...(request.since !== undefined ? { since: request.since } : {})
        },
        request.etag
      );
      if (response.notModified) {
        return { notModified: true, events: [], hasNextPage: false };
      }
      return {
        notModified: false,
        ...(response.etag !== undefined ? { etag: response.etag } : {}),
        events: arrayBody(response.body).map(toCommentEvent),
        hasNextPage: pageFromLink(response.link ?? "", "next") !== undefined
      };
    },

    async listTimeline(request) {
      const response = await get(
        `${repoPath(request.owner, request.repo)}/issues/${request.number}/timeline`,
        { per_page: String(GITHUB_PAGE_SIZE), page: String(request.page) },
        request.etag
      );
      if (response.notModified) {
        return { notModified: true, events: [], hasNextPage: false };
      }
      const link = response.link ?? "";
      const lastPage = pageFromLink(link, "last");
      return {
        notModified: false,
        ...(response.etag !== undefined ? { etag: response.etag } : {}),
        events: arrayBody(response.body).map(toTimelineEvent),
        hasNextPage: pageFromLink(link, "next") !== undefined,
        ...(lastPage !== undefined ? { lastPage } : {})
      };
    },

    async getPullRequest(request) {
      const response = await get(
        `${repoPath(request.owner, request.repo)}/pulls/${request.number}`,
        {},
        request.etag
      );
      if (response.notModified) {
        return { notModified: true, headSHA: "" };
      }
      const body = asRecord(response.body);
      const head = asRecord(body?.head);
      const headSHA = stringOf(head?.sha);
      const htmlURL = stringOf(body?.html_url);
      if (headSHA === undefined) {
        throw new TransportFailure("malformed", "pull request without a head sha", { status: 200 });
      }
      return {
        notModified: false,
        ...(response.etag !== undefined ? { etag: response.etag } : {}),
        headSHA,
        ...(htmlURL !== undefined ? { htmlURL } : {})
      };
    },

    async listCheckRuns(request) {
      const response = await get(
        `${repoPath(request.owner, request.repo)}/commits/${encodeURIComponent(
          request.ref
        )}/check-runs`,
        { per_page: String(GITHUB_PAGE_SIZE), page: String(request.page), filter: "latest" },
        request.etag
      );
      if (response.notModified) {
        return { notModified: true, events: [], hasNextPage: false };
      }
      const record = asRecord(response.body);
      const runs = record?.check_runs;
      if (!Array.isArray(runs)) {
        throw new TransportFailure("malformed", "check-runs response without `check_runs`", {
          status: 200
        });
      }
      const fallbackAt = new Date(now()).toISOString();
      return {
        notModified: false,
        ...(response.etag !== undefined ? { etag: response.etag } : {}),
        events: runs.map((run) => toCheckRunEvent(run, fallbackAt)),
        hasNextPage: pageFromLink(response.link ?? "", "next") !== undefined
      };
    },

    async listWorkflowRuns(request) {
      const path =
        request.workflow !== undefined
          ? `${repoPath(request.owner, request.repo)}/actions/workflows/${encodeURIComponent(
              request.workflow
            )}/runs`
          : `${repoPath(request.owner, request.repo)}/actions/runs`;
      const response = await get(
        path,
        {
          per_page: String(GITHUB_PAGE_SIZE),
          page: String(request.page),
          ...(request.branch !== undefined ? { branch: request.branch } : {})
        },
        request.etag
      );
      if (response.notModified) {
        return { notModified: true, events: [], hasNextPage: false };
      }
      const record = asRecord(response.body);
      const runs = record?.workflow_runs;
      if (!Array.isArray(runs)) {
        throw new TransportFailure("malformed", "workflow-runs response without `workflow_runs`", {
          status: 200
        });
      }
      const fallbackAt = new Date(now()).toISOString();
      return {
        notModified: false,
        ...(response.etag !== undefined ? { etag: response.etag } : {}),
        events: runs.map((run) => toWorkflowRunEvent(run, fallbackAt)),
        hasNextPage: pageFromLink(response.link ?? "", "next") !== undefined
      };
    }
  };
}
