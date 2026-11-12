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
  TimelineRequest
} from "../src/github.js";
import type { Logger } from "../src/logging.js";
import { initialState, SubscriptionStore, newSubscriptionID } from "../src/state.js";
import type {
  SubscriptionRecord,
  WakeEvent,
  WakeNotice,
  WakeSourceKind,
  WakeSubscription
} from "../src/types.js";

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
    cleanup: () => rm(dir, { recursive: true, force: true })
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
    intervalMs: 60_000,
    createdAt: "2026-01-01T00:00:00Z",
    ...over
  };
}

export function record(over: Partial<WakeSubscription> = {}, at = 1_000): SubscriptionRecord {
  return { subscription: subscription(over), state: initialState(at) };
}

export function kinded(kind: WakeSourceKind, over: Partial<WakeSubscription> = {}) {
  return record({ kind, ...over });
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
  };
  setComments(pages: CommentPage[]): void;
  setTimeline(pages: TimelinePage[]): void;
  setPull(snapshot: PullRequestSnapshot): void;
  setChecks(pages: CheckRunsPage[]): void;
  fail(error: unknown): void;
}

export function fakeTransport(): FakeTransport {
  const requests: FakeTransport["requests"] = {
    comments: [],
    timeline: [],
    pull: [],
    checks: []
  };
  let failure: unknown;
  let comments: CommentPage[] = [];
  let timeline: TimelinePage[] = [];
  let pull: PullRequestSnapshot | undefined;
  let checks: CheckRunsPage[] = [];

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

/** A store over a temp dir, loaded and ready. */
export async function makeStore(dir: string, now = () => 1_000): Promise<SubscriptionStore> {
  const store = new SubscriptionStore({ dir, logger: fakeLogger(), now });
  await store.load();
  return store;
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
