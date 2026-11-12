import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  initialState,
  isSubscriptionID,
  newSubscriptionID,
  SubscriptionStore
} from "../src/state.js";
import { event, fakeLogger, makeStore, record, tempDir } from "./helpers.js";

describe("subscription ids", () => {
  it("generates ids the store accepts back", () => {
    const id = newSubscriptionID();
    expect(isSubscriptionID(id)).toBe(true);
    expect(isSubscriptionID("../../etc/passwd")).toBe(false);
    expect(isSubscriptionID("wake_short")).toBe(false);
    expect(isSubscriptionID(42)).toBe(false);
  });
});

describe("SubscriptionStore", () => {
  it("round-trips a record through disk", async () => {
    const temp = await tempDir();
    try {
      const store = await makeStore(temp.dir);
      const rec = record();
      rec.state.pending.push(event("101"));
      rec.state.seen.push("101");
      rec.state.consecutiveFailures = 2;
      rec.state.lastError = "network: ECONNRESET";
      await store.put(rec);

      const reopened = new SubscriptionStore({ dir: temp.dir, logger: fakeLogger() });
      await reopened.load();

      const loaded = reopened.get(rec.subscription.id);
      expect(loaded?.subscription).toEqual(rec.subscription);
      expect(loaded?.state.pending).toHaveLength(1);
      expect(loaded?.state.seen).toEqual(["101"]);
      expect(loaded?.state.consecutiveFailures).toBe(2);
      expect(loaded?.state.lastError).toBe("network: ECONNRESET");
    } finally {
      await temp.cleanup();
    }
  });

  it("writes atomically with 0o600 and leaves no temp file behind", async () => {
    const temp = await tempDir();
    try {
      const store = await makeStore(temp.dir);
      const rec = record();
      await store.put(rec);

      const files = await readdir(temp.dir);
      expect(files).toEqual([`${rec.subscription.id}.json`]);
      const mode = (await stat(join(temp.dir, files[0] as string))).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(JSON.parse(await readFile(join(temp.dir, files[0] as string), "utf8"))).toHaveProperty(
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
      const store = new SubscriptionStore({ dir: temp.dir, logger });
      const good = record();
      await store.put(good);
      await writeFile(join(temp.dir, `${newSubscriptionID()}.json`), "{ not json", "utf8");
      await writeFile(join(temp.dir, "not-a-subscription.json"), "{}", "utf8");

      const reopened = new SubscriptionStore({ dir: temp.dir, logger });
      await reopened.load();

      expect(reopened.list()).toHaveLength(1);
      expect(logger.events.filter((e) => e.event === "wake_subscription_unreadable")).toHaveLength(
        1
      );
    } finally {
      await temp.cleanup();
    }
  });

  it("falls back on a corrupt state field but drops an unusable subscription", async () => {
    const temp = await tempDir();
    try {
      const logger = fakeLogger();
      const store = new SubscriptionStore({ dir: temp.dir, logger, now: () => 5_000 });
      const rec = record();
      await store.put(rec);
      await writeFile(
        join(temp.dir, `${rec.subscription.id}.json`),
        JSON.stringify({ subscription: rec.subscription, state: { pending: "nope", seen: [1] } }),
        "utf8"
      );
      const brokenSub = join(temp.dir, `${newSubscriptionID()}.json`);
      await writeFile(
        brokenSub,
        JSON.stringify({ subscription: { id: "wake_bad" }, state: {} }),
        "utf8"
      );

      const reopened = new SubscriptionStore({ dir: temp.dir, logger, now: () => 5_000 });
      await reopened.load();

      const loaded = reopened.get(rec.subscription.id);
      expect(loaded?.state.pending).toEqual([]);
      expect(loaded?.state.seen).toEqual([]);
      expect(loaded?.state.nextPollAt).toBe(5_000);
      expect(reopened.list()).toHaveLength(1);
    } finally {
      await temp.cleanup();
    }
  });

  it("returns an empty store when the directory does not exist yet", async () => {
    const temp = await tempDir();
    try {
      const store = new SubscriptionStore({
        dir: join(temp.dir, "missing", "nested"),
        logger: fakeLogger()
      });
      await expect(store.load()).resolves.toBeUndefined();
      expect(store.list()).toEqual([]);
    } finally {
      await temp.cleanup();
    }
  });

  it("filters by session and sorts by creation time", async () => {
    const temp = await tempDir();
    try {
      const store = await makeStore(temp.dir);
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

  it("removes a record from disk and memory", async () => {
    const temp = await tempDir();
    try {
      const store = await makeStore(temp.dir);
      const rec = record();
      await store.put(rec);

      expect(await store.remove(rec.subscription.id)).toBe(true);
      expect(store.get(rec.subscription.id)).toBeUndefined();
      expect(await readdir(temp.dir)).toEqual([]);
      expect(await store.remove(rec.subscription.id)).toBe(false);
    } finally {
      await temp.cleanup();
    }
  });

  it("creates a fresh state with an immediate poll and no backlog", () => {
    const state = initialState(1_000);
    expect(state.cursor).toEqual({ lastSeenAt: "1970-01-01T00:00:01.000Z" });
    expect(state.pending).toEqual([]);
    expect(state.nextPollAt).toBe(1_000);
  });
});

describe("SubscriptionStore — source kinds and schema migration", () => {
  it("round-trips every source kind with its cursor", async () => {
    const temp = await tempDir();
    try {
      const store = await makeStore(temp.dir);
      for (const kind of ["github.thread", "github.timeline", "github.checks"] as const) {
        const rec = record({ kind });
        rec.state.cursor = { lastSeenAt: "2026-01-01T00:00:00Z", lastEventID: "x:1" };
        if (kind === "github.checks") {
          rec.state.cursor.headSHA = "abc123";
        }
        await store.put(rec);
      }

      const reopened = new SubscriptionStore({ dir: temp.dir, logger: fakeLogger() });
      await reopened.load();

      expect(
        reopened
          .list()
          .map((r) => r.subscription.kind)
          .sort()
      ).toEqual(["github.checks", "github.thread", "github.timeline"]);
      const checks = reopened.list().find((r) => r.subscription.kind === "github.checks");
      expect(checks?.state.cursor.headSHA).toBe("abc123");
    } finally {
      await temp.cleanup();
    }
  });

  it("keeps non-comment pending events and their summaries", async () => {
    const temp = await tempDir();
    try {
      const store = await makeStore(temp.dir);
      const rec = record({ kind: "github.checks" });
      rec.state.pending.push({
        id: "check:1:completed:failure",
        kind: "check",
        author: "GitHub Actions",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:05:00Z",
        url: "https://github.com/acme/widgets/runs/1",
        body: "",
        title: "build: completed / failure"
      });
      await store.put(rec);

      const reopened = new SubscriptionStore({ dir: temp.dir, logger: fakeLogger() });
      await reopened.load();

      expect(reopened.get(rec.subscription.id)?.state.pending[0]).toMatchObject({
        kind: "check",
        title: "build: completed / failure"
      });
    } finally {
      await temp.cleanup();
    }
  });

  it("restores the per-URL etag map", async () => {
    const temp = await tempDir();
    try {
      const store = await makeStore(temp.dir);
      const rec = record({ kind: "github.timeline" });
      rec.state.etags = { "/repos/acme/widgets/issues/7/timeline?per_page=100&page=1": 'W/"t"' };
      await store.put(rec);

      const reopened = new SubscriptionStore({ dir: temp.dir, logger: fakeLogger() });
      await reopened.load();

      expect(reopened.get(rec.subscription.id)?.state.etags).toEqual({
        "/repos/acme/widgets/issues/7/timeline?per_page=100&page=1": 'W/"t"'
      });
    } finally {
      await temp.cleanup();
    }
  });

  it("drops the pre-multi-source etag shape instead of trusting it", async () => {
    const temp = await tempDir();
    try {
      const store = await makeStore(temp.dir);
      const rec = record();
      await store.put(rec);
      // The first slice persisted `{ value, since }`; it cannot be mapped to a
      // request URL, so it must be discarded (one extra full fetch, never a
      // stale 304).
      const path = join(temp.dir, `${rec.subscription.id}.json`);
      await writeFile(
        path,
        JSON.stringify({
          subscription: rec.subscription,
          state: { ...rec.state, etag: { value: 'W/"old"', since: "2026-01-01T00:00:00Z" } }
        }),
        "utf8"
      );

      const reopened = new SubscriptionStore({ dir: temp.dir, logger: fakeLogger() });
      await reopened.load();

      expect(reopened.get(rec.subscription.id)?.state.etags).toBeUndefined();
    } finally {
      await temp.cleanup();
    }
  });

  it("rejects an unknown source kind", async () => {
    const temp = await tempDir();
    try {
      const rec = record();
      const id = newSubscriptionID();
      await writeFile(
        join(temp.dir, `${id}.json`),
        JSON.stringify({
          subscription: { ...rec.subscription, id, kind: "github.webhooks" },
          state: rec.state
        }),
        "utf8"
      );

      const reopened = new SubscriptionStore({ dir: temp.dir, logger: fakeLogger() });
      await reopened.load();

      expect(reopened.list()).toEqual([]);
    } finally {
      await temp.cleanup();
    }
  });
});
