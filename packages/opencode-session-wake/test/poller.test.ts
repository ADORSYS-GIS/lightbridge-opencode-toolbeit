import { describe, expect, it, vi } from "vitest";

import { parseWakeOptions } from "../src/config.js";
import { TransportFailure } from "../src/github.js";
import { backoffMs, buildNotice, createPoller, matchesMention } from "../src/poller.js";
import { initialState, SubscriptionStore } from "../src/state.js";
import {
  deferred,
  event,
  fakeDeliver,
  fakeLogger,
  fakeTransport,
  makeStore,
  page,
  record,
  subscription,
  tempDir
} from "./helpers.js";

const options = parseWakeOptions({ intervalMs: 60_000, seenLimit: 10, maxPending: 5 });

function clock(start = 1_000) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    }
  };
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
});

describe("buildNotice", () => {
  it("never carries a comment body", () => {
    const notice = buildNotice(subscription(), 3);
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

describe("createPoller", () => {
  async function setup() {
    const temp = await tempDir();
    const clockRef = clock();
    const store = await makeStore(temp.dir, clockRef.now);
    const transport = fakeTransport();
    const { deliver, notices } = fakeDeliver();
    const logger = fakeLogger();
    const poller = createPoller({
      store,
      transport,
      deliver,
      logger,
      options,
      now: clockRef.now,
      random: () => 0,
      sleep: async () => {}
    });
    return { temp, store, transport, deliver, notices, logger, poller, clockRef };
  }

  it("delivers exactly one notice for one new comment", async () => {
    const { temp, store, transport, notices, poller } = await setup();
    try {
      const rec = record();
      await store.put(rec);
      transport.setPages([page([event("101")])]);

      const outcome = await poller.tick(rec.subscription.id);

      expect(outcome.status).toBe("delivered");
      expect(outcome.newEvents).toBe(1);
      expect(notices).toHaveLength(1);
      expect(notices[0]?.sessionID).toBe("ses_owner");
      expect(notices[0]?.resume).toBe(true);
      expect(store.get(rec.subscription.id)?.state.pending).toHaveLength(1);
      expect(store.get(rec.subscription.id)?.state.cursor.lastSeenAt).toBe("2026-01-01T00:00:00Z");
    } finally {
      await temp.cleanup();
    }
  });

  it("does not deliver the same comment twice when a poll is repeated", async () => {
    const { temp, store, transport, notices, poller, clockRef } = await setup();
    try {
      const rec = record();
      await store.put(rec);
      transport.setPages([page([event("101")])]);
      await poller.tick(rec.subscription.id);

      // Same payload replayed by a later poll (GitHub may return it again).
      clockRef.advance(60_000);
      transport.setPages([page([event("101")])]);
      const second = await poller.tick(rec.subscription.id);

      expect(second.status).toBe("no-change");
      expect(notices).toHaveLength(1);
      expect(store.get(rec.subscription.id)?.state.pending).toHaveLength(1);
    } finally {
      await temp.cleanup();
    }
  });

  it("keeps the cursor across a restart, so nothing is re-delivered", async () => {
    const { temp, store, transport, notices, poller } = await setup();
    try {
      const rec = record();
      await store.put(rec);
      transport.setPages([page([event("101")])]);
      await poller.tick(rec.subscription.id);
      expect(notices).toHaveLength(1);

      // Restart: a brand-new store and poller over the same directory.
      const reopened = new SubscriptionStore({
        dir: temp.dir,
        logger: fakeLogger(),
        now: () => 61_000
      });
      await reopened.load();
      const restarted = createPoller({
        store: reopened,
        transport,
        deliver: async () => {},
        logger: fakeLogger(),
        options,
        now: () => 61_000,
        sleep: async () => {}
      });

      transport.setPages([page([event("101")])]);
      const outcome = await restarted.tick(rec.subscription.id);

      expect(outcome.status).toBe("no-change");
      expect(reopened.get(rec.subscription.id)?.state.pending).toHaveLength(1);
    } finally {
      await temp.cleanup();
    }
  });

  it("delivers once when two polls overlap", async () => {
    const { temp, store, notices } = await setup();
    try {
      const rec = record();
      await store.put(rec);
      const gate = deferred<void>();
      const slow = fakeTransport([page([event("101")])]);
      const slowPoller = createPoller({
        store,
        transport: {
          async listComments(request) {
            await gate.promise;
            return slow.listComments(request);
          }
        },
        deliver: async (notice) => {
          notices.push(notice);
        },
        logger: fakeLogger(),
        options,
        now: () => 1_000,
        sleep: async () => {}
      });

      const first = slowPoller.tick(rec.subscription.id);
      const second = slowPoller.tick(rec.subscription.id);
      gate.resolve();
      const [a, b] = await Promise.all([first, second]);

      expect(a).toEqual(b);
      expect(notices).toHaveLength(1);
    } finally {
      await temp.cleanup();
    }
  });

  it("fails closed on 401 and leaves the cursor alone", async () => {
    const { temp, store, transport, notices, poller, logger, clockRef } = await setup();
    try {
      const rec = record();
      await store.put(rec);
      const before = store.get(rec.subscription.id)?.state.cursor.lastSeenAt;
      transport.fail(
        new TransportFailure("auth", "GitHub rejected the token (401)", { status: 401 })
      );

      const outcome = await poller.tick(rec.subscription.id);
      const state = store.get(rec.subscription.id)?.state;

      expect(outcome.status).toBe("failed");
      expect(outcome.failure).toBe("auth");
      expect(notices).toHaveLength(0);
      expect(state?.cursor.lastSeenAt).toBe(before);
      expect(state?.consecutiveFailures).toBe(1);
      expect(state?.lastError).toContain("auth");
      expect(state?.nextPollAt).toBeGreaterThan(clockRef.now());
      expect(logger.events.some((e) => e.event === "wake_poll_failed")).toBe(true);
    } finally {
      await temp.cleanup();
    }
  });

  it("backs off on 403/429 and honours the server hint", async () => {
    const { temp, store, transport, poller, clockRef } = await setup();
    try {
      const rec = record();
      await store.put(rec);
      transport.fail(new TransportFailure("forbidden", "refused", { status: 403 }));
      await poller.tick(rec.subscription.id);
      expect(store.get(rec.subscription.id)?.state.nextPollAt).toBeGreaterThan(clockRef.now());

      const second = record({ sessionID: "ses_owner" });
      await store.put(second);
      transport.fail(
        new TransportFailure("rate-limit", "rate limited", { status: 429, retryAfterMs: 120_000 })
      );
      await poller.tick(second.subscription.id);
      expect(store.get(second.subscription.id)?.state.nextPollAt).toBe(clockRef.now() + 120_000);
    } finally {
      await temp.cleanup();
    }
  });

  it("fails closed on a malformed payload", async () => {
    const { temp, store, transport, notices, poller } = await setup();
    try {
      const rec = record();
      await store.put(rec);
      const before = store.get(rec.subscription.id)?.state.cursor.lastSeenAt;
      transport.fail(new TransportFailure("malformed", "comment without a usable id"));

      const outcome = await poller.tick(rec.subscription.id);

      expect(outcome.status).toBe("failed");
      expect(outcome.failure).toBe("malformed");
      expect(notices).toHaveLength(0);
      expect(store.get(rec.subscription.id)?.state.cursor.lastSeenAt).toBe(before);
    } finally {
      await temp.cleanup();
    }
  });

  it("resumes without loss after a failure", async () => {
    const { temp, store, transport, notices, poller, clockRef } = await setup();
    try {
      const rec = record();
      await store.put(rec);
      transport.fail(new TransportFailure("network", "ECONNRESET"));
      await poller.tick(rec.subscription.id);

      clockRef.advance(60_000);
      transport.setPages([page([event("101")])]);
      const outcome = await poller.tick(rec.subscription.id);

      expect(outcome.status).toBe("delivered");
      expect(notices).toHaveLength(1);
      expect(store.get(rec.subscription.id)?.state.consecutiveFailures).toBe(0);
    } finally {
      await temp.cleanup();
    }
  });

  it("applies the mention filter without re-delivering rejected comments", async () => {
    const { temp, store, transport, notices, poller, clockRef } = await setup();
    try {
      const rec = record({ mentions: ["alice"] });
      await store.put(rec);
      transport.setPages([
        page([
          event("101", { body: "for @alice" }),
          event("102", { body: "for @bob" }),
          event("103", { body: "for @alicex" })
        ])
      ]);

      await poller.tick(rec.subscription.id);
      expect(store.get(rec.subscription.id)?.state.pending.map((e) => e.id)).toEqual(["101"]);

      clockRef.advance(60_000);
      transport.setPages([page([event("101", { body: "for @alice" })])]);
      const replay = await poller.tick(rec.subscription.id);

      expect(replay.status).toBe("no-change");
      expect(notices).toHaveLength(1);
    } finally {
      await temp.cleanup();
    }
  });

  it("pages through a busy thread", async () => {
    const { temp, store, transport, poller } = await setup();
    try {
      const rec = record();
      await store.put(rec);
      transport.setPages([
        page([event("101")], { hasNextPage: true, etag: 'W/"a"' }),
        page([event("102")])
      ]);

      const outcome = await poller.tick(rec.subscription.id);

      expect(transport.requests.map((r) => r.page)).toEqual([1, 2]);
      expect(outcome.newEvents).toBe(2);
      expect(store.get(rec.subscription.id)?.state.pending).toHaveLength(2);
    } finally {
      await temp.cleanup();
    }
  });

  it("sends the stored ETag for the same cursor and handles 304", async () => {
    const { temp, store, transport, poller, clockRef } = await setup();
    try {
      const rec = record();
      await store.put(rec);
      transport.setPages([page([event("101")], { etag: 'W/"a"' })]);
      await poller.tick(rec.subscription.id);

      clockRef.advance(60_000);
      transport.setPages([page([], { notModified: true })]);
      const outcome = await poller.tick(rec.subscription.id);

      expect(transport.requests.at(-1)?.etag).toBe('W/"a"');
      expect(outcome.status).toBe("not-modified");
      expect(store.get(rec.subscription.id)?.state.cursor.lastSeenAt).toBe("2026-01-01T00:00:00Z");
    } finally {
      await temp.cleanup();
    }
  });

  it("skips a subscription whose next poll is in the future", async () => {
    const { temp, store, transport, poller } = await setup();
    try {
      const rec = record();
      rec.state.nextPollAt = 10_000_000;
      await store.put(rec);
      const outcome = await poller.tick(rec.subscription.id);
      expect(outcome.status).toBe("skipped");
      expect(transport.requests).toHaveLength(0);
    } finally {
      await temp.cleanup();
    }
  });

  it("announces a recovered backlog with resume:false", async () => {
    const temp = await tempDir();
    try {
      const store = await makeStore(temp.dir);
      const rec = record();
      rec.state = { ...initialState(1_000), pending: [event("101")] };
      await store.put(rec);
      const { deliver, notices } = fakeDeliver();
      const poller = createPoller({
        store,
        transport: fakeTransport(),
        deliver,
        logger: fakeLogger(),
        options,
        now: () => 2_000,
        sleep: async () => {}
      });

      await poller.start();
      poller.stop();

      expect(notices).toHaveLength(1);
      expect(notices[0]?.resume).toBe(false);
      expect(notices[0]?.count).toBe(1);
    } finally {
      await temp.cleanup();
    }
  });

  it("keeps polling after a delivery failure", async () => {
    const temp = await tempDir();
    try {
      const store = await makeStore(temp.dir);
      const rec = record();
      await store.put(rec);
      const transport = fakeTransport([page([event("101")])]);
      const deliver = vi.fn(async () => {
        throw new Error("session gone");
      });
      const logger = fakeLogger();
      const poller = createPoller({
        store,
        transport,
        deliver,
        logger,
        options,
        now: () => 1_000,
        sleep: async () => {}
      });

      const outcome = await poller.tick(rec.subscription.id);

      expect(outcome.status).toBe("delivered");
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(logger.events.some((e) => e.event === "wake_notice_failed")).toBe(true);
      // The events are durable, so `wake_next` can still read them.
      expect(store.get(rec.subscription.id)?.state.pending).toHaveLength(1);
    } finally {
      await temp.cleanup();
    }
  });

  it("caps unread events at maxPending", async () => {
    const { temp, store, transport, poller } = await setup();
    try {
      const rec = record();
      await store.put(rec);
      transport.setPages([
        page(Array.from({ length: 8 }, (_, index) => event(String(100 + index))))
      ]);
      await poller.tick(rec.subscription.id);
      expect(store.get(rec.subscription.id)?.state.pending).toHaveLength(options.maxPending);
    } finally {
      await temp.cleanup();
    }
  });
});
