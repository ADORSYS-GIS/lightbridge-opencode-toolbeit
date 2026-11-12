import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseWakeOptions } from "../src/config.js";
import { TransportFailure } from "../src/github.js";
import {
  backoffMs,
  buildNotice,
  createPoller,
  matchesMention,
  negotiatedIntervalMs,
  WATCH_TTL_MS
} from "../src/poller.js";
import { SubscriptionStore, WatchStore } from "../src/state.js";
import type { SubscriptionRecord } from "../src/types.js";
import {
  checksPage,
  deferred,
  event,
  fakeDeliver,
  fakeLogger,
  fakeTransport,
  keyOf,
  makeStores,
  page,
  record,
  seedWatch,
  tempDir,
  timelinePage
} from "./helpers.js";

const options = parseWakeOptions({
  intervalMs: 60_000,
  seenLimit: 10,
  maxPending: 5
});

function clock(start = 1_000) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    }
  };
}

async function setup(overrides: Record<string, unknown> = {}) {
  const temp = await tempDir();
  const clockRef = clock();
  const { store, watches } = await makeStores(temp.dir, clockRef.now);
  const transport = fakeTransport();
  const { deliver, notices } = fakeDeliver();
  const logger = fakeLogger();
  const opts = parseWakeOptions({
    intervalMs: 60_000,
    seenLimit: 10,
    maxPending: 5,
    ...overrides
  });
  const poller = createPoller({
    store,
    watches,
    transport,
    deliver,
    logger,
    options: opts,
    now: clockRef.now,
    random: () => 0,
    sleep: async () => {}
  });
  return {
    temp,
    store,
    watches,
    transport,
    deliver,
    notices,
    logger,
    poller,
    clockRef,
    options: opts
  };
}

function cursorOf(watches: WatchStore, record: SubscriptionRecord): string | undefined {
  return watches.get(keyOf(record))?.state.cursor.lastSeenAt;
}

describe("matchesMention", () => {
  it("matches every comment when the filter is empty", () => {
    expect(matchesMention(event("1", { body: "anything" }), [])).toBe(true);
  });

  it("matches @handle at a word boundary, case-insensitively", () => {
    expect(matchesMention(event("1", { body: "ping @Alice please" }), ["alice"])).toBe(true);
    expect(matchesMention(event("1", { body: "@alice" }), ["@alice"])).toBe(true);
  });

  it("does not match a longer handle or an email local part", () => {
    expect(matchesMention(event("1", { body: "@alicex" }), ["alice"])).toBe(false);
    expect(matchesMention(event("1", { body: "mail alice@example.com" }), ["example"])).toBe(false);
  });

  it("always passes an event with no body", () => {
    expect(
      matchesMention(event("1", { kind: "state", body: "", title: "merged" }), ["alice"])
    ).toBe(true);
  });
});

describe("buildNotice", () => {
  it("never carries a comment body", () => {
    const notice = buildNotice(record().subscription, 3);
    expect(notice.text).toContain("untrusted");
    expect(notice.text).toContain("acme/widgets#7");
    expect(notice.text).not.toContain("hello");
    expect(notice.resume).toBe(true);
  });
});

describe("backoffMs", () => {
  it("grows exponentially and caps at the ceiling", () => {
    const first = backoffMs(1, options, undefined, () => 0);
    const second = backoffMs(2, options, undefined, () => 0);
    expect(second).toBeGreaterThan(first);
    expect(backoffMs(50, options, undefined, () => 0)).toBe(options.maxIntervalMs);
  });

  it("prefers a server-provided hint", () => {
    expect(backoffMs(1, options, 120_000, () => 0)).toBe(120_000);
    expect(backoffMs(1, options, 1, () => 0)).toBe(1_000);
  });
});

describe("negotiatedIntervalMs", () => {
  it("uses the shortest interval any subscriber asked for", () => {
    const fast = record({ intervalMs: 20_000 });
    const slow = record({ intervalMs: 120_000 });
    expect(negotiatedIntervalMs([slow, fast], options)).toBe(20_000);
  });

  it("clamps into the global bounds", () => {
    expect(negotiatedIntervalMs([record({ intervalMs: 1 })], options)).toBe(options.minIntervalMs);
    expect(negotiatedIntervalMs([record({ intervalMs: 10_000_000 })], options)).toBe(
      options.maxIntervalMs
    );
  });
});

describe("createPoller — shared registry", () => {
  it("polls once for two sessions watching the same key and wakes both", async () => {
    const { temp, store, watches, transport, notices, poller } = await setup();
    try {
      const a = record({ sessionID: "ses_a" });
      const b = record({ sessionID: "ses_b" });
      await poller.join(a);
      await poller.join(b);
      transport.setComments([page([event("101")])]);

      const outcomes = await poller.tickDue();

      expect(outcomes).toHaveLength(1);
      expect(transport.requests.comments).toHaveLength(1);
      expect(notices).toHaveLength(2);
      expect(notices.map((n) => n.sessionID).sort()).toEqual(["ses_a", "ses_b"]);
      expect(store.get(a.subscription.id)?.state.pending).toHaveLength(1);
      expect(store.get(b.subscription.id)?.state.pending).toHaveLength(1);
      expect(watches.get(keyOf(a))?.state.subscribers).toHaveLength(2);
    } finally {
      await temp.cleanup();
    }
  });

  it("applies per-subscriber mention filters to one shared fetch", async () => {
    const { temp, transport, notices, store, poller } = await setup();
    try {
      const filtered = record({ sessionID: "ses_a", mentions: ["alice"] });
      const unfiltered = record({ sessionID: "ses_b" });
      await poller.join(filtered);
      await poller.join(unfiltered);
      transport.setComments([
        page([event("101", { body: "for @alice" }), event("102", { body: "for @bob" })])
      ]);

      await poller.tickDue();

      expect(transport.requests.comments).toHaveLength(1);
      expect(store.get(filtered.subscription.id)?.state.pending.map((e) => e.id)).toEqual(["101"]);
      expect(store.get(unfiltered.subscription.id)?.state.pending.map((e) => e.id)).toEqual([
        "101",
        "102"
      ]);
      expect(notices.map((n) => n.count).sort()).toEqual([1, 2]);
    } finally {
      await temp.cleanup();
    }
  });

  it("keeps the shared cursor and ETag across subscribers", async () => {
    const { temp, store, watches, transport, notices, poller, clockRef } = await setup();
    try {
      const a = record({ sessionID: "ses_a" });
      const b = record({ sessionID: "ses_b" });
      await poller.join(a);
      await poller.join(b);
      transport.setComments([page([event("101")], { etag: 'W/"one"' })]);
      await poller.tickDue();

      expect(cursorOf(watches, a)).toBe("2026-01-01T00:00:00Z");

      clockRef.advance(60_000);
      transport.setComments([page([event("102", { createdAt: "2026-01-01T00:05:00Z" })])]);
      await poller.tickDue();

      expect(cursorOf(watches, a)).toBe("2026-01-01T00:05:00Z");
      expect(store.get(a.subscription.id)?.state.pending.map((e) => e.id)).toEqual(["101", "102"]);
      expect(store.get(b.subscription.id)?.state.pending.map((e) => e.id)).toEqual(["101", "102"]);
      // Two polls, two subscribers each.
      expect(notices).toHaveLength(4);
    } finally {
      await temp.cleanup();
    }
  });

  it("does not poll a key again while a poll is in flight", async () => {
    const { temp, store, watches, transport, notices } = await setup();
    try {
      const a = record();
      const b = record({ sessionID: "ses_b" });
      await store.put(a);
      await store.put(b);
      const gate = deferred<void>();
      const poller = createPoller({
        store,
        watches,
        transport: {
          listComments: async (request) => {
            await gate.promise;
            return transport.listComments(request);
          },
          listTimeline: (request) => transport.listTimeline(request),
          getPullRequest: (request) => transport.getPullRequest(request),
          listCheckRuns: (request) => transport.listCheckRuns(request)
        },
        deliver: async (notice) => {
          notices.push(notice);
        },
        logger: fakeLogger(),
        options,
        now: () => 1_000,
        sleep: async () => {}
      });
      transport.setComments([page([event("101")])]);

      const first = poller.tick(a.subscription.id);
      const second = poller.tick(b.subscription.id);
      gate.resolve();
      const [left, right] = await Promise.all([first, second]);

      expect(left).toEqual(right);
      expect(transport.requests.comments).toHaveLength(1);
      expect(notices).toHaveLength(2);
    } finally {
      await temp.cleanup();
    }
  });

  it("unsubscribing one session leaves the other's watch intact", async () => {
    const { temp, store, watches, transport, notices, poller } = await setup();
    try {
      const a = record({ sessionID: "ses_a" });
      const b = record({ sessionID: "ses_b" });
      await poller.join(a);
      await poller.join(b);

      expect(await poller.leave(a.subscription.id)).toBe(true);
      expect(store.get(a.subscription.id)).toBeUndefined();
      expect(watches.get(keyOf(b))?.state.subscribers).toEqual([b.subscription.id]);

      transport.setComments([page([event("101")])]);
      await poller.tickDue();

      expect(notices).toHaveLength(1);
      expect(notices[0]?.sessionID).toBe("ses_b");
      expect(store.get(b.subscription.id)?.state.pending).toHaveLength(1);
    } finally {
      await temp.cleanup();
    }
  });

  it("stops the fetcher when the refcount reaches zero", async () => {
    const { temp, store, watches, transport, poller } = await setup();
    try {
      const only = record();
      await poller.join(only);
      await poller.leave(only.subscription.id);

      expect(watches.get(keyOf(only))?.state.subscribers).toEqual([]);
      transport.setComments([page([event("101")])]);
      const due = await poller.tickDue();
      expect(due).toEqual([]);
      expect(transport.requests.comments).toHaveLength(0);
      expect(store.get(only.subscription.id)).toBeUndefined();
    } finally {
      await temp.cleanup();
    }
  });

  it("dedupes a replayed page per subscriber", async () => {
    const { temp, store, transport, notices, poller, clockRef } = await setup();
    try {
      const a = record();
      await poller.join(a);
      transport.setComments([page([event("101")])]);
      await poller.tick(a.subscription.id);

      clockRef.advance(60_000);
      transport.setComments([page([event("101")])]);
      const second = await poller.tick(a.subscription.id);

      expect(second.status).toBe("no-change");
      expect(notices).toHaveLength(1);
      expect(store.get(a.subscription.id)?.state.pending).toHaveLength(1);
    } finally {
      await temp.cleanup();
    }
  });

  it("keeps the cursor across a restart", async () => {
    const { temp, store, transport, notices, poller } = await setup();
    try {
      const a = record();
      await poller.join(a);
      transport.setComments([page([event("101")])]);
      await poller.tick(a.subscription.id);
      expect(notices).toHaveLength(1);

      const reopenedStore = new SubscriptionStore({
        dir: `${temp.dir}/subscriptions`,
        logger: fakeLogger(),
        now: () => 61_000
      });
      const reopenedWatches = new WatchStore({
        dir: `${temp.dir}/watches`,
        logger: fakeLogger(),
        now: () => 61_000
      });
      await reopenedStore.load();
      await reopenedWatches.load();
      const restarted = createPoller({
        store: reopenedStore,
        watches: reopenedWatches,
        transport,
        deliver: async () => {},
        logger: fakeLogger(),
        options,
        now: () => 61_000,
        sleep: async () => {}
      });

      transport.setComments([page([event("101")])]);
      const outcome = await restarted.tick(a.subscription.id);

      expect(outcome.status).toBe("no-change");
      expect(reopenedStore.get(a.subscription.id)?.state.pending).toHaveLength(1);
      expect(store.get(a.subscription.id)).toBeDefined();
    } finally {
      await temp.cleanup();
    }
  });

  it("fails closed on 401 and leaves every subscriber alone", async () => {
    const { temp, store, watches, transport, notices, poller, logger, clockRef } = await setup();
    try {
      const a = record({ sessionID: "ses_a" });
      const b = record({ sessionID: "ses_b" });
      await poller.join(a);
      await poller.join(b);
      const before = cursorOf(watches, a);
      transport.fail(
        new TransportFailure("auth", "GitHub rejected the token (401)", { status: 401 })
      );

      const outcome = await poller.tick(a.subscription.id);

      expect(outcome.status).toBe("failed");
      expect(outcome.failure).toBe("auth");
      expect(notices).toHaveLength(0);
      expect(cursorOf(watches, a)).toBe(before);
      expect(watches.get(keyOf(a))?.state.consecutiveFailures).toBe(1);
      expect(watches.get(keyOf(a))?.state.nextPollAt).toBeGreaterThan(clockRef.now());
      expect(store.get(a.subscription.id)?.state.pending).toHaveLength(0);
      expect(store.get(b.subscription.id)?.state.pending).toHaveLength(0);
      expect(logger.events.some((e) => e.event === "wake_poll_failed")).toBe(true);
    } finally {
      await temp.cleanup();
    }
  });

  it("backs off on 429 and honours the server hint", async () => {
    const { temp, watches, transport, poller, clockRef } = await setup();
    try {
      const a = record();
      await poller.join(a);
      transport.fail(
        new TransportFailure("rate-limit", "rate limited", { status: 429, retryAfterMs: 120_000 })
      );
      await poller.tick(a.subscription.id);
      expect(watches.get(keyOf(a))?.state.nextPollAt).toBe(clockRef.now() + 120_000);
    } finally {
      await temp.cleanup();
    }
  });

  it("fails closed on a malformed payload", async () => {
    const { temp, store, watches, transport, notices, poller } = await setup();
    try {
      const a = record();
      await poller.join(a);
      const before = cursorOf(watches, a);
      transport.fail(new TransportFailure("malformed", "comment without a usable id"));

      const outcome = await poller.tick(a.subscription.id);

      expect(outcome.status).toBe("failed");
      expect(cursorOf(watches, a)).toBe(before);
      expect(notices).toHaveLength(0);
      expect(store.get(a.subscription.id)?.state.pending).toHaveLength(0);
    } finally {
      await temp.cleanup();
    }
  });

  it("resumes without loss after a failure", async () => {
    const { temp, store, transport, notices, poller, clockRef } = await setup();
    try {
      const a = record();
      await poller.join(a);
      transport.fail(new TransportFailure("network", "ECONNRESET"));
      await poller.tick(a.subscription.id);

      clockRef.advance(60_000);
      transport.setComments([page([event("101")])]);
      const outcome = await poller.tick(a.subscription.id);

      expect(outcome.status).toBe("delivered");
      expect(notices).toHaveLength(1);
      expect(store.get(a.subscription.id)?.state.pending).toHaveLength(1);
    } finally {
      await temp.cleanup();
    }
  });

  it("pages through a busy thread", async () => {
    const { temp, transport, poller } = await setup();
    try {
      const a = record();
      await poller.join(a);
      transport.setComments([
        page([event("101")], { hasNextPage: true, etag: 'W/"a"' }),
        page([event("102")])
      ]);

      const outcome = await poller.tick(a.subscription.id);

      expect(transport.requests.comments.map((r) => r.page)).toEqual([1, 2]);
      expect(outcome.newEvents).toBe(2);
    } finally {
      await temp.cleanup();
    }
  });

  it("sends the stored ETag for the same cursor and handles 304", async () => {
    const { temp, watches, transport, poller, clockRef } = await setup();
    try {
      const a = record();
      await poller.join(a);
      transport.setComments([page([], { etag: 'W/"a"' })]);
      await poller.tick(a.subscription.id);

      clockRef.advance(60_000);
      transport.setComments([page([], { notModified: true })]);
      const outcome = await poller.tick(a.subscription.id);

      expect(transport.requests.comments.at(-1)?.etag).toBe('W/"a"');
      expect(outcome.status).toBe("not-modified");
      expect(watches.get(keyOf(a))?.state.etags).toBeDefined();
    } finally {
      await temp.cleanup();
    }
  });

  it("skips a watch whose next poll is in the future", async () => {
    const { temp, store, watches, transport, poller } = await setup();
    try {
      const a = record();
      await store.put(a);
      await seedWatch(watches, a, { nextPollAt: 10_000_000 });
      const outcome = await poller.tick(a.subscription.id);
      expect(outcome.status).toBe("skipped");
      expect(transport.requests.comments).toHaveLength(0);
    } finally {
      await temp.cleanup();
    }
  });

  it("announces a recovered backlog with resume:false", async () => {
    const { temp, store, poller, notices } = await setup();
    try {
      const a = record();
      a.state.pending.push(event("101"));
      await store.put(a);

      await poller.start();
      poller.stop();

      expect(notices).toHaveLength(1);
      expect(notices[0]?.resume).toBe(false);
    } finally {
      await temp.cleanup();
    }
  });

  it("keeps events when the wake itself fails", async () => {
    const { temp, store, watches, transport } = await setup();
    try {
      const a = record();
      await store.put(a);
      const deliver = vi.fn(async () => {
        throw new Error("session gone");
      });
      const logger = fakeLogger();
      const poller = createPoller({
        store,
        watches,
        transport,
        deliver,
        logger,
        options,
        now: () => 1_000,
        sleep: async () => {}
      });
      transport.setComments([page([event("101")])]);

      const outcome = await poller.tick(a.subscription.id);

      expect(outcome.delivered).toBe(0);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(store.get(a.subscription.id)?.state.pending).toHaveLength(1);
      expect(store.get(a.subscription.id)?.state.lastError).toContain("session gone");
    } finally {
      await temp.cleanup();
    }
  });

  it("caps unread events at maxPending", async () => {
    const { temp, store, transport, poller } = await setup();
    try {
      const a = record();
      await poller.join(a);
      transport.setComments([
        page(Array.from({ length: 8 }, (_, index) => event(String(100 + index))))
      ]);
      await poller.tick(a.subscription.id);
      expect(store.get(a.subscription.id)?.state.pending).toHaveLength(options.maxPending);
    } finally {
      await temp.cleanup();
    }
  });
});

describe("createPoller — loop prevention", () => {
  it("drops events from ignored authors at fan-out", async () => {
    const { temp, store, transport, notices, poller } = await setup({
      ignoreAuthors: ["github-actions[bot]"]
    });
    try {
      const a = record({ ignoreAuthors: ["dependabot[bot]"] });
      await poller.join(a);
      transport.setComments([
        page([
          event("101", { author: "github-actions[bot]" }),
          event("102", { author: "dependabot[bot]" }),
          event("103", { author: "alice" })
        ])
      ]);

      await poller.tick(a.subscription.id);

      expect(store.get(a.subscription.id)?.state.pending.map((e) => e.id)).toEqual(["103"]);
      expect(notices).toHaveLength(1);
      expect(notices[0]?.count).toBe(1);
    } finally {
      await temp.cleanup();
    }
  });

  it("suppresses our own originated event ids", async () => {
    const { temp, store, transport, notices, poller } = await setup();
    try {
      const a = record();
      await poller.join(a);
      poller.markOriginated("101");
      transport.setComments([page([event("101"), event("102")])]);

      await poller.tick(a.subscription.id);

      expect(store.get(a.subscription.id)?.state.pending.map((e) => e.id)).toEqual(["102"]);
      expect(notices[0]?.count).toBe(1);
    } finally {
      await temp.cleanup();
    }
  });

  it("coalesces wakes after N in M seconds and surfaces loop_suspected", async () => {
    const { temp, store, watches, transport, notices, poller, clockRef } = await setup({
      intervalMs: 1_000,
      minIntervalMs: 1_000,
      loop: { maxWakes: 2, windowMs: 60_000, cooldownMs: 300_000 }
    });
    try {
      const a = record({ intervalMs: 1_000 });
      await poller.join(a);

      for (const id of ["101", "102", "103"]) {
        transport.setComments([page([event(id)])]);
        await poller.tick(a.subscription.id);
        clockRef.advance(1_000);
      }

      const state = store.get(a.subscription.id)?.state;
      expect(notices).toHaveLength(2);
      expect(state?.pending.map((e) => e.id)).toEqual(["101", "102", "103"]);
      expect(state?.loop.loopSuspected).toBe(true);
      expect(state?.loop.suppressed).toBe(1);
      expect(state?.loop.cooldownUntil).toBeDefined();
      expect(watches.get(keyOf(a))?.state.cursor.lastSeenAt).toBe("2026-01-01T00:00:00Z");
    } finally {
      await temp.cleanup();
    }
  });

  it("resumes waking after the cooldown expires", async () => {
    const { temp, store, transport, notices, poller, clockRef } = await setup({
      intervalMs: 1_000,
      minIntervalMs: 1_000,
      loop: { maxWakes: 1, windowMs: 60_000, cooldownMs: 5_000 }
    });
    try {
      const a = record({ intervalMs: 1_000 });
      await poller.join(a);
      transport.setComments([page([event("101")])]);
      await poller.tick(a.subscription.id);
      clockRef.advance(1_000);
      transport.setComments([page([event("102")])]);
      await poller.tick(a.subscription.id);
      expect(notices).toHaveLength(1);

      clockRef.advance(10_000);
      transport.setComments([page([event("103")])]);
      const outcome = await poller.tick(a.subscription.id);

      expect(outcome.status).toBe("delivered");
      expect(notices).toHaveLength(2);
      expect(store.get(a.subscription.id)?.state.loop.loopSuspected).toBe(false);
    } finally {
      await temp.cleanup();
    }
  });

  it("does not duplicate a wake for a replayed page", async () => {
    const { temp, store, transport, notices, poller, clockRef } = await setup();
    try {
      const a = record();
      await poller.join(a);
      transport.setComments([page([event("101")])]);
      await poller.tick(a.subscription.id);
      clockRef.advance(60_000);
      transport.setComments([page([event("101")])]);
      await poller.tick(a.subscription.id);

      expect(notices).toHaveLength(1);
      expect(store.get(a.subscription.id)?.state.pending).toHaveLength(1);
      expect(store.get(a.subscription.id)?.state.loop.wakes).toHaveLength(1);
    } finally {
      await temp.cleanup();
    }
  });
});

describe("createPoller — sources on the shared fetcher", () => {
  it("delivers a timeline batch once for two subscribers", async () => {
    const { temp, store, transport, notices, poller } = await setup();
    try {
      const a = record({ kind: "github.timeline", sessionID: "ses_a" });
      const b = record({ kind: "github.timeline", sessionID: "ses_b" });
      await poller.join(a);
      await poller.join(b);
      transport.setTimeline([
        timelinePage([
          {
            id: "reviewed:1",
            kind: "review",
            author: "bob",
            createdAt: "2026-01-01T00:10:00Z",
            updatedAt: "2026-01-01T00:10:00Z",
            url: "",
            body: "LGTM",
            title: "review approved"
          },
          {
            id: "merged:2",
            kind: "state",
            author: "dave",
            createdAt: "2026-01-01T00:11:00Z",
            updatedAt: "2026-01-01T00:11:00Z",
            url: "",
            body: "",
            title: "merged"
          }
        ])
      ]);

      await poller.tickDue();

      expect(transport.requests.timeline).toHaveLength(1);
      expect(notices).toHaveLength(2);
      expect(notices[0]?.count).toBe(2);
      expect(store.get(a.subscription.id)?.state.pending).toHaveLength(2);
      expect(store.get(b.subscription.id)?.state.pending).toHaveLength(2);
    } finally {
      await temp.cleanup();
    }
  });

  it("records the checks baseline without waking, then wakes on a failure", async () => {
    const { temp, store, watches, transport, notices, poller, clockRef } = await setup();
    try {
      const a = record({ kind: "github.checks" });
      await poller.join(a);
      transport.setPull({ notModified: false, headSHA: "aaa" });
      transport.setChecks([
        checksPage([
          {
            id: "check:1:in_progress:",
            kind: "check",
            author: "GitHub Actions",
            createdAt: "2026-01-01T00:20:00Z",
            updatedAt: "2026-01-01T00:20:00Z",
            url: "",
            body: "",
            title: "build: in_progress"
          }
        ])
      ]);

      await poller.tick(a.subscription.id);
      expect(notices).toHaveLength(0);
      expect(watches.get(keyOf(a))?.state.cursor.headSHA).toBe("aaa");

      clockRef.advance(60_000);
      transport.setPull({ notModified: true, headSHA: "" });
      transport.setChecks([
        checksPage([
          {
            id: "check:1:completed:failure",
            kind: "check",
            author: "GitHub Actions",
            createdAt: "2026-01-01T00:20:00Z",
            updatedAt: "2026-01-01T00:25:00Z",
            url: "",
            body: "",
            title: "build: completed / failure"
          }
        ])
      ]);
      await poller.tick(a.subscription.id);

      expect(notices).toHaveLength(1);
      expect(store.get(a.subscription.id)?.state.pending[0]?.title).toContain("failure");
    } finally {
      await temp.cleanup();
    }
  });

  it("wakes only the session that owns each watch", async () => {
    const { temp, store, transport, notices, poller } = await setup();
    try {
      const mine = record({ kind: "github.timeline", sessionID: "ses_a", number: 7 });
      const other = record({ kind: "github.timeline", sessionID: "ses_b", number: 8 });
      await poller.join(mine);
      await poller.join(other);
      transport.setTimeline([
        timelinePage([
          {
            id: "merged:1",
            kind: "state",
            author: "dave",
            createdAt: "2026-01-01T00:10:00Z",
            updatedAt: "2026-01-01T00:10:00Z",
            url: "",
            body: "",
            title: "merged"
          }
        ]),
        timelinePage([
          {
            id: "merged:2",
            kind: "state",
            author: "dave",
            createdAt: "2026-01-01T00:11:00Z",
            updatedAt: "2026-01-01T00:11:00Z",
            url: "",
            body: "",
            title: "merged"
          }
        ])
      ]);

      await poller.tickDue();

      expect(notices).toHaveLength(2);
      expect(notices.map((n) => n.sessionID).sort()).toEqual(["ses_a", "ses_b"]);
      expect(store.get(mine.subscription.id)?.state.pending).toHaveLength(1);
      expect(store.get(other.subscription.id)?.state.pending).toHaveLength(1);
    } finally {
      await temp.cleanup();
    }
  });
});

describe("createPoller — migration and lifecycle", () => {
  it("migrates a pre-registry subscription into a shared watch without re-delivering", async () => {
    const temp = await tempDir();
    const clockRef = clock();
    try {
      const rec = record();
      rec.state.pending.push(event("101"));
      rec.state.seen.push("101");
      const dir = join(temp.dir, "subscriptions");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${rec.subscription.id}.json`),
        JSON.stringify({
          subscription: rec.subscription,
          state: {
            cursor: { lastSeenAt: "2026-01-01T00:00:00Z", lastEventID: "101" },
            etags: {
              "/repos/acme/widgets/issues/7/comments?per_page=100&page=1&since=2026-01-01T00:00:00Z":
                'W/"x"'
            },
            pending: rec.state.pending,
            seen: rec.state.seen,
            consecutiveFailures: 0,
            nextPollAt: 1_000
          }
        }),
        "utf8"
      );

      const { store, watches } = await makeStores(temp.dir, clockRef.now);
      const transport = fakeTransport();
      const { deliver, notices } = fakeDeliver();
      const poller = createPoller({
        store,
        watches,
        transport,
        deliver,
        logger: fakeLogger(),
        options,
        now: clockRef.now,
        sleep: async () => {}
      });

      await poller.start();
      poller.stop();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const watch = watches.get(keyOf(rec));
      expect(watch?.state.cursor.lastSeenAt).toBe("2026-01-01T00:00:00Z");
      // The migrated validator is used on the first conditional request.
      expect(transport.requests.comments[0]?.etag).toBe('W/"x"');
      expect(watch?.state.subscribers).toEqual([rec.subscription.id]);
      // The unread event survived, announced once with resume:false.
      expect(store.get(rec.subscription.id)?.state.pending).toHaveLength(1);
      expect(notices).toHaveLength(1);
      expect(notices[0]?.resume).toBe(false);

      clockRef.advance(60_000);
      transport.setComments([page([event("101")])]);
      const outcome = await poller.tick(rec.subscription.id);
      expect(outcome.status).toBe("no-change");
      expect(store.get(rec.subscription.id)?.state.pending).toHaveLength(1);
    } finally {
      await temp.cleanup();
    }
  });

  it("tightens the shared interval when a faster subscriber joins", async () => {
    const { temp, watches, poller, clockRef } = await setup();
    try {
      const slow = record({ intervalMs: 120_000 });
      await poller.join(slow);
      clockRef.advance(1_000);
      const fast = record({ sessionID: "ses_b", intervalMs: 15_000 });
      await poller.join(fast);

      const watch = watches.get(keyOf(slow));
      expect(watch?.state.nextPollAt).toBeLessThanOrEqual(clockRef.now() + 15_000);
      expect(negotiatedIntervalMs([slow, fast], options)).toBe(15_000);
    } finally {
      await temp.cleanup();
    }
  });

  it("ages out a watch whose last subscriber left long ago", async () => {
    const { temp, watches, poller, clockRef } = await setup();
    try {
      const only = record();
      await poller.join(only);
      await poller.leave(only.subscription.id);

      const watch = watches.get(keyOf(only));
      if (!watch) {
        throw new Error("watch missing");
      }
      watch.state.lastTouchedAt = clockRef.now() - WATCH_TTL_MS - 1;
      await watches.put(watch);

      await poller.start();
      poller.stop();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(watches.get(keyOf(only))).toBeUndefined();
    } finally {
      await temp.cleanup();
    }
  });

  it("keeps a watch with no subscribers until it ages out", async () => {
    const { temp, watches, poller } = await setup();
    try {
      const only = record();
      await poller.join(only);
      await poller.leave(only.subscription.id);
      expect(watches.get(keyOf(only))?.state.subscribers).toEqual([]);
    } finally {
      await temp.cleanup();
    }
  });
});
