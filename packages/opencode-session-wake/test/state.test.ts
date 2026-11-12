import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  initialSubscriberState,
  initialWatchState,
  isSubscriptionID,
  newSubscriptionID,
  SubscriptionStore,
  targetOf,
  watchFileFor,
  watchKey,
  WatchStore
} from "../src/state.js";
import { event, fakeLogger, makeStores, record, tempDir } from "./helpers.js";

describe("subscription ids", () => {
  it("generates ids the store accepts back", () => {
    const id = newSubscriptionID();
    expect(isSubscriptionID(id)).toBe(true);
    expect(isSubscriptionID("../../etc/passwd")).toBe(false);
    expect(isSubscriptionID("wake_short")).toBe(false);
    expect(isSubscriptionID(42)).toBe(false);
  });
});

describe("watchKey", () => {
  it("is the fetch identity: api base, source, owner, repo, number", () => {
    const base = {
      apiBase: "https://api.github.com",
      kind: "github.thread" as const,
      owner: "acme",
      repo: "widgets",
      number: 7
    };
    expect(watchKey(base)).toBe("https://api.github.com|github.thread|acme|widgets|7");
    expect(watchKey({ ...base, kind: "github.timeline" })).not.toBe(watchKey(base));
    expect(watchKey({ ...base, number: 8 })).not.toBe(watchKey(base));
  });

  it("treats owner and repo case-insensitively, like GitHub", () => {
    const key = watchKey({
      apiBase: "https://api.github.com",
      kind: "github.thread",
      owner: "Acme",
      repo: "Widgets",
      number: 7
    });
    expect(key).toBe("https://api.github.com|github.thread|acme|widgets|7");
  });

  it("derives a stable, path-safe file name", () => {
    expect(watchFileFor("a|b")).toMatch(/^[a-f0-9]{16}\.json$/);
    expect(watchFileFor("a|b")).toBe(watchFileFor("a|b"));
    expect(watchFileFor("a|b")).not.toBe(watchFileFor("a|c"));
  });
});

describe("SubscriptionStore", () => {
  it("round-trips a subscriber through disk", async () => {
    const temp = await tempDir();
    try {
      const { store } = await makeStores(temp.dir);
      const rec = record({ ignoreAuthors: ["github-actions[bot]"] });
      rec.state.pending.push(event("101"));
      rec.state.seen.push("101");
      rec.state.lastError = "deliver: session gone";
      rec.state.loop = { wakes: [1_000], suppressed: 2, loopSuspected: true, cooldownUntil: 5_000 };
      await store.put(rec);

      const reopened = new SubscriptionStore({
        dir: join(temp.dir, "subscriptions"),
        logger: fakeLogger()
      });
      await reopened.load();

      const loaded = reopened.get(rec.subscription.id);
      expect(loaded?.subscription).toEqual(rec.subscription);
      expect(loaded?.subscription.ignoreAuthors).toEqual(["github-actions[bot]"]);
      expect(loaded?.state.pending).toHaveLength(1);
      expect(loaded?.state.seen).toEqual(["101"]);
      expect(loaded?.state.lastError).toBe("deliver: session gone");
      expect(loaded?.state.loop).toMatchObject({ suppressed: 2, loopSuspected: true });
    } finally {
      await temp.cleanup();
    }
  });

  it("writes atomically with 0o600 and leaves no temp file behind", async () => {
    const temp = await tempDir();
    try {
      const { store } = await makeStores(temp.dir);
      const rec = record();
      await store.put(rec);

      const dir = join(temp.dir, "subscriptions");
      const files = await readdir(dir);
      expect(files).toEqual([`${rec.subscription.id}.json`]);
      const mode = (await stat(join(dir, files[0] as string))).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(JSON.parse(await readFile(join(dir, files[0] as string), "utf8"))).toHaveProperty(
        "subscription.id"
      );
    } finally {
      await temp.cleanup();
    }
  });

  it("skips a corrupt file instead of failing startup", async () => {
    const temp = await tempDir();
    try {
      const logger = fakeLogger();
      const store = new SubscriptionStore({ dir: join(temp.dir, "subscriptions"), logger });
      const good = record();
      await store.put(good);
      const dir = join(temp.dir, "subscriptions");
      await writeFile(join(dir, `${newSubscriptionID()}.json`), "{ not json", "utf8");
      await writeFile(join(dir, "not-a-subscription.json"), "{}", "utf8");

      const reopened = new SubscriptionStore({ dir, logger });
      await reopened.load();

      expect(reopened.list()).toHaveLength(1);
      expect(logger.events.filter((e) => e.event === "wake_subscription_unreadable")).toHaveLength(
        1
      );
    } finally {
      await temp.cleanup();
    }
  });

  it("defaults ignoreAuthors for pre-registry records", async () => {
    const temp = await tempDir();
    try {
      const rec = record();
      const dir = join(temp.dir, "subscriptions");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${rec.subscription.id}.json`),
        JSON.stringify({
          subscription: { ...rec.subscription, ignoreAuthors: undefined },
          state: { pending: [], seen: [] }
        }),
        "utf8"
      );
      const store = new SubscriptionStore({ dir, logger: fakeLogger() });
      await store.load();
      expect(store.get(rec.subscription.id)?.subscription.ignoreAuthors).toEqual([]);
    } finally {
      await temp.cleanup();
    }
  });

  it("exposes the legacy cursor as a watch seed and keeps the pending state", async () => {
    const temp = await tempDir();
    try {
      const rec = record();
      const dir = join(temp.dir, "subscriptions");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${rec.subscription.id}.json`),
        JSON.stringify({
          subscription: rec.subscription,
          state: {
            cursor: { lastSeenAt: "2026-01-01T00:00:00Z", lastEventID: "101" },
            etags: { "/repos/acme/widgets/issues/7/comments?page=1": 'W/"x"' },
            pending: [event("101")],
            seen: ["101"],
            consecutiveFailures: 2,
            lastError: "network: ECONNRESET",
            nextPollAt: 4_000
          }
        }),
        "utf8"
      );

      const store = new SubscriptionStore({ dir, logger: fakeLogger() });
      await store.load();

      const seeds = store.legacySeeds();
      expect(seeds).toHaveLength(1);
      expect(seeds[0]?.cursor).toEqual({ lastSeenAt: "2026-01-01T00:00:00Z", lastEventID: "101" });
      expect(seeds[0]?.etags).toEqual({ "/repos/acme/widgets/issues/7/comments?page=1": 'W/"x"' });
      expect(seeds[0]?.consecutiveFailures).toBe(2);
      expect(seeds[0]?.nextPollAt).toBe(4_000);
      expect(store.get(rec.subscription.id)?.state.pending).toHaveLength(1);
      expect(store.get(rec.subscription.id)?.state.seen).toEqual(["101"]);
    } finally {
      await temp.cleanup();
    }
  });

  it("filters by session and sorts by creation time", async () => {
    const temp = await tempDir();
    try {
      const { store } = await makeStores(temp.dir);
      const late = record({ sessionID: "ses_a", createdAt: "2026-01-02T00:00:00Z" });
      const early = record({ sessionID: "ses_a", createdAt: "2026-01-01T00:00:00Z" });
      const other = record({ sessionID: "ses_b" });
      await store.put(late);
      await store.put(early);
      await store.put(other);

      expect(store.list("ses_a").map((r) => r.subscription.id)).toEqual([
        early.subscription.id,
        late.subscription.id
      ]);
      expect(store.list("ses_b")).toHaveLength(1);
      expect(store.list()).toHaveLength(3);
    } finally {
      await temp.cleanup();
    }
  });

  it("groups subscribers by their watch key", async () => {
    const temp = await tempDir();
    try {
      const { store } = await makeStores(temp.dir);
      const a = record({ sessionID: "ses_a" });
      const b = record({ sessionID: "ses_b" });
      const other = record({ sessionID: "ses_a", number: 8 });
      await store.put(a);
      await store.put(b);
      await store.put(other);

      const key = watchKey(targetOf(a.subscription, "https://api.github.com"));
      expect(
        store
          .listByKey(key, "https://api.github.com")
          .map((r) => r.subscription.id)
          .sort()
      ).toEqual([a.subscription.id, b.subscription.id].sort());
    } finally {
      await temp.cleanup();
    }
  });

  it("removes a record from disk and memory", async () => {
    const temp = await tempDir();
    try {
      const { store } = await makeStores(temp.dir);
      const rec = record();
      await store.put(rec);

      expect(await store.remove(rec.subscription.id)).toBe(true);
      expect(store.get(rec.subscription.id)).toBeUndefined();
      expect(await readdir(join(temp.dir, "subscriptions"))).toEqual([]);
      expect(await store.remove(rec.subscription.id)).toBe(false);
    } finally {
      await temp.cleanup();
    }
  });

  it("rejects an unknown source kind", async () => {
    const temp = await tempDir();
    try {
      const rec = record();
      const id = newSubscriptionID();
      const dir = join(temp.dir, "subscriptions");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${id}.json`),
        JSON.stringify({
          subscription: { ...rec.subscription, id, kind: "github.webhooks" },
          state: rec.state
        }),
        "utf8"
      );

      const store = new SubscriptionStore({ dir, logger: fakeLogger() });
      await store.load();

      expect(store.list()).toEqual([]);
    } finally {
      await temp.cleanup();
    }
  });
});

describe("WatchStore", () => {
  it("round-trips a shared watch with its cursor, etags and subscribers", async () => {
    const temp = await tempDir();
    try {
      const { watches } = await makeStores(temp.dir);
      const rec = record({ kind: "github.checks" });
      const key = watchKey(targetOf(rec.subscription, "https://api.github.com"));
      await watches.put({
        key,
        target: targetOf(rec.subscription, "https://api.github.com"),
        state: {
          ...initialWatchState(1_000, [rec.subscription.id]),
          cursor: { lastSeenAt: "2026-01-01T00:00:00Z", headSHA: "abc123" },
          etags: { "/repos/acme/widgets/pulls/7": 'W/"p"' },
          seen: ["check:1:completed:failure"],
          consecutiveFailures: 1,
          lastError: "forbidden: no checks scope"
        }
      });

      const reopened = new WatchStore({ dir: join(temp.dir, "watches"), logger: fakeLogger() });
      await reopened.load();

      const loaded = reopened.get(key);
      expect(loaded?.target.kind).toBe("github.checks");
      expect(loaded?.state.cursor.headSHA).toBe("abc123");
      expect(loaded?.state.etags).toEqual({ "/repos/acme/widgets/pulls/7": 'W/"p"' });
      expect(loaded?.state.seen).toEqual(["check:1:completed:failure"]);
      expect(loaded?.state.subscribers).toEqual([rec.subscription.id]);
      expect(loaded?.state.lastError).toBe("forbidden: no checks scope");
    } finally {
      await temp.cleanup();
    }
  });

  it("skips a corrupt watch file", async () => {
    const temp = await tempDir();
    try {
      const logger = fakeLogger();
      const dir = join(temp.dir, "watches");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "deadbeefdeadbeef.json"), "{ not json", "utf8");
      const watches = new WatchStore({ dir, logger });
      await watches.load();
      expect(watches.list()).toEqual([]);
      expect(logger.events.some((e) => e.event === "wake_watch_unreadable")).toBe(true);
    } finally {
      await temp.cleanup();
    }
  });

  it("removes a watch file", async () => {
    const temp = await tempDir();
    try {
      const { watches } = await makeStores(temp.dir);
      const rec = record();
      const key = watchKey(targetOf(rec.subscription, "https://api.github.com"));
      await watches.put({
        key,
        target: targetOf(rec.subscription, "https://api.github.com"),
        state: initialWatchState(1_000, [rec.subscription.id])
      });
      expect(await watches.remove(key)).toBe(true);
      expect(watches.get(key)).toBeUndefined();
      expect(await readdir(join(temp.dir, "watches"))).toEqual([]);
    } finally {
      await temp.cleanup();
    }
  });
});

describe("initial state", () => {
  it("starts a subscriber with nothing pending and no loop history", () => {
    expect(initialSubscriberState()).toEqual({
      pending: [],
      seen: [],
      loop: { wakes: [], suppressed: 0, loopSuspected: false }
    });
  });

  it("starts a watch at the given time with an immediate poll", () => {
    const state = initialWatchState(1_000, ["wake_a"]);
    expect(state.cursor).toEqual({ lastSeenAt: "1970-01-01T00:00:01.000Z" });
    expect(state.nextPollAt).toBe(1_000);
    expect(state.subscribers).toEqual(["wake_a"]);
    expect(state.seen).toEqual([]);
  });
});
