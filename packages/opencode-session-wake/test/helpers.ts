import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { vi } from "vitest";

import type { CommentPage, GitHubTransport } from "../src/github.js";
import type { Logger } from "../src/logging.js";
import { initialState, SubscriptionStore, newSubscriptionID } from "../src/state.js";
import type { SubscriptionRecord, WakeEvent, WakeNotice, WakeSubscription } from "../src/types.js";

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

/** A transport that answers from a queue of pages and records every request. */
export interface FakeTransport extends GitHubTransport {
  readonly requests: Array<Parameters<GitHubTransport["listComments"]>[0]>;
  setPages(pages: CommentPage[]): void;
  fail(error: unknown): void;
}

export function fakeTransport(pages: CommentPage[] = []): FakeTransport {
  let queue = [...pages];
  let failure: unknown;
  const requests: FakeTransport["requests"] = [];
  return {
    requests,
    setPages(next) {
      queue = [...next];
      failure = undefined;
    },
    fail(error) {
      failure = error;
    },
    async listComments(request) {
      requests.push(request);
      if (failure) {
        throw failure;
      }
      const page = queue.shift();
      if (!page) {
        return { notModified: false, events: [], hasNextPage: false };
      }
      return page;
    }
  };
}

export function page(events: WakeEvent[], over: Partial<CommentPage> = {}): CommentPage {
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
