import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { vi } from "vitest";

import type {
  CheckRunsPage,
  CheckRunsRequest,
  CommentPage,
  CommentPageRequest,
  GitHubTransport,
  PullRequestRequest,
  PullRequestSnapshot,
  TimelinePage,
  TimelineRequest,
  WorkflowRunsPage,
  WorkflowRunsRequest
} from "../src/github.js";
import type { Logger } from "../src/logging.js";
import {
  initialSubscriberState,
  initialWatchState,
  newSubscriptionID,
  SubscriptionStore,
  targetOf,
  watchKey,
  WatchStore
} from "../src/state.js";
import type {
  SubscriptionRecord,
  WakeEvent,
  WakeNotice,
  WakeProject,
  WakeSubscription,
  WatchRecord,
  WatchState
} from "../src/types.js";

export const DEFAULT_API_BASE = "https://api.github.com";

/** Two distinct project identities for adoption tests. */
export const PROJECT_A: WakeProject = {
  id: "prj_a",
  directory: "/work/a",
  canonical: "/work/a"
};

export const PROJECT_B: WakeProject = {
  id: "prj_b",
  directory: "/work/b",
  canonical: "/work/b"
};

export interface FakeLogger extends Logger {
  readonly events: Array<{ level: string; event: string; fields?: Record<string, unknown> }>;
}

export function fakeLogger(): FakeLogger {
  const events: FakeLogger["events"] = [];
  const push = (level: string) => (event: string, fields?: Record<string, unknown>) => {
    events.push({ level, event, ...(fields ? { fields } : {}) });
  };
  return {
    events,
    trace: vi.fn(push("trace")),
    debug: vi.fn(push("debug")),
    info: vi.fn(push("info")),
    warn: vi.fn(push("warn")),
    error: vi.fn(push("error"))
  };
}

/** A temp state directory, removed after the test. */
export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-session-wake-"));
  return {
    dir,
    // A subscribe path starts a poll without awaiting it; a lease/cursor write
    // can still be in flight when a test finishes. Retry a transient ENOTEMPTY
    // instead of making every test wait on an internal background poll.
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 })
  };
}

export function event(id: string, over: Partial<WakeEvent> = {}): WakeEvent {
  const at = over.createdAt ?? "2026-01-01T00:00:00Z";
  return {
    id,
    kind: "comment",
    author: "alice",
    createdAt: at,
    updatedAt: over.updatedAt ?? at,
    url: `https://github.com/acme/widgets/issues/7#issuecomment-${id}`,
    body: "hello",
    ...over
  };
}

export function subscription(over: Partial<WakeSubscription> = {}): WakeSubscription {
  return {
    id: newSubscriptionID(),
    sessionID: "ses_owner",
    kind: "github.thread",
    owner: "acme",
    repo: "widgets",
    number: 7,
    mentions: [],
    ignoreAuthors: [],
    intervalMs: 60_000,
    createdAt: "2026-01-01T00:00:00Z",
    ...over
  };
}

export function record(over: Partial<WakeSubscription> = {}): SubscriptionRecord {
  return { subscription: subscription(over), state: initialSubscriberState() };
}

/** The shared watch key a subscription belongs to. */
export function keyOf(record: SubscriptionRecord, apiBase = DEFAULT_API_BASE): string {
  return watchKey(targetOf(record.subscription, apiBase));
}

/** Persist a watch for a subscription with the given state overrides. */
export async function seedWatch(
  watches: WatchStore,
  record: SubscriptionRecord,
  over: Partial<WatchState> = {}
): Promise<WatchRecord> {
  const key = keyOf(record);
  const existing = watches.get(key);
  const watch: WatchRecord = {
    key,
    target: targetOf(record.subscription, DEFAULT_API_BASE),
    state: {
      ...initialWatchState(1_000, [record.subscription.id]),
      ...(existing?.state ?? {}),
      ...over
    }
  };
  await watches.put(watch);
  return watch;
}

/** Both stores over one temp root, loaded and ready. */
export async function makeStores(
  dir: string,
  now = () => 1_000
): Promise<{ store: SubscriptionStore; watches: WatchStore }> {
  const store = new SubscriptionStore({
    dir: join(dir, "subscriptions"),
    logger: fakeLogger(),
    now
  });
  const watches = new WatchStore({ dir: join(dir, "watches"), logger: fakeLogger(), now });
  await store.load();
  await watches.load();
  return { store, watches };
}

/** A subscriber store over a temp root, loaded and ready. */
export async function makeStore(dir: string, now = () => 1_000): Promise<SubscriptionStore> {
  const store = new SubscriptionStore({
    dir: join(dir, "subscriptions"),
    logger: fakeLogger(),
    now
  });
  await store.load();
  return store;
}

/**
 * A transport that answers from per-method queues and records every request.
 * `fail` makes the next call on *any* method throw, so a test can assert that a
 * failure in any source leaves the cursor alone.
 */
export interface FakeTransport extends GitHubTransport {
  readonly requests: {
    comments: CommentPageRequest[];
    timeline: TimelineRequest[];
    pull: PullRequestRequest[];
    checks: CheckRunsRequest[];
    runs: WorkflowRunsRequest[];
  };
  setComments(pages: CommentPage[]): void;
  setTimeline(pages: TimelinePage[]): void;
  setPull(snapshot: PullRequestSnapshot): void;
  setChecks(pages: CheckRunsPage[]): void;
  setRuns(pages: WorkflowRunsPage[]): void;
  fail(error: unknown): void;
}

export function fakeTransport(): FakeTransport {
  const requests: FakeTransport["requests"] = {
    comments: [],
    timeline: [],
    pull: [],
    checks: [],
    runs: []
  };
  let failure: unknown;
  let comments: CommentPage[] = [];
  let timeline: TimelinePage[] = [];
  let pull: PullRequestSnapshot | undefined;
  let checks: CheckRunsPage[] = [];
  let runs: WorkflowRunsPage[] = [];

  return {
    requests,
    setComments(pages) {
      comments = [...pages];
      failure = undefined;
    },
    setTimeline(pages) {
      timeline = [...pages];
      failure = undefined;
    },
    setPull(snapshot) {
      pull = snapshot;
      failure = undefined;
    },
    setChecks(pages) {
      checks = [...pages];
      failure = undefined;
    },
    setRuns(pages) {
      runs = [...pages];
      failure = undefined;
    },
    fail(error) {
      failure = error;
    },
    async listComments(request) {
      requests.comments.push(request);
      if (failure) {
        throw failure;
      }
      return comments.shift() ?? { notModified: false, events: [], hasNextPage: false };
    },
    async listTimeline(request) {
      requests.timeline.push(request);
      if (failure) {
        throw failure;
      }
      return timeline.shift() ?? { notModified: false, events: [], hasNextPage: false };
    },
    async getPullRequest(request) {
      requests.pull.push(request);
      if (failure) {
        throw failure;
      }
      if (!pull) {
        throw new Error("fakeTransport: no pull request configured (call setPull)");
      }
      return pull;
    },
    async listCheckRuns(request) {
      requests.checks.push(request);
      if (failure) {
        throw failure;
      }
      return checks.shift() ?? { notModified: false, events: [], hasNextPage: false };
    },
    async listWorkflowRuns(request) {
      requests.runs.push(request);
      if (failure) {
        throw failure;
      }
      return runs.shift() ?? { notModified: false, events: [], hasNextPage: false };
    }
  };
}

export function page(events: WakeEvent[], over: Partial<CommentPage> = {}): CommentPage {
  return { notModified: false, events, hasNextPage: false, ...over };
}

export function timelinePage(events: WakeEvent[], over: Partial<TimelinePage> = {}): TimelinePage {
  return { notModified: false, events, hasNextPage: false, ...over };
}

export function checksPage(events: WakeEvent[], over: Partial<CheckRunsPage> = {}): CheckRunsPage {
  return { notModified: false, events, hasNextPage: false, ...over };
}

export function runsPage(
  events: WakeEvent[],
  over: Partial<WorkflowRunsPage> = {}
): WorkflowRunsPage {
  return { notModified: false, events, hasNextPage: false, ...over };
}

/** The wake seam as a test double: records every notice it is given. */
export function fakeDeliver() {
  const notices: WakeNotice[] = [];
  const deliver = vi.fn(async (notice: WakeNotice) => {
    notices.push(notice);
  });
  return { deliver, notices };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Run a tool `execute` (its context is only read for `sessionID`). */
export async function exec(
  info: { execute: (input: unknown, context: never) => Effect.Effect<unknown, unknown> },
  args: unknown,
  sessionID = "ses_owner"
): Promise<{ content?: string; metadata?: Record<string, unknown> }> {
  const context = { sessionID } as never;
  return (await Effect.runPromise(
    info.execute(args, context) as Effect.Effect<
      { content?: string; metadata?: Record<string, unknown> },
      never
    >
  )) as { content?: string; metadata?: Record<string, unknown> };
}

/** Resolve once `predicate` is true, or reject after `timeoutMs`. */
export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
