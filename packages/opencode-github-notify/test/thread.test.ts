import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  matchesFilter,
  type PollOutcome,
  pollWatch,
  readWatchState,
  watchStatePath
} from "../src/thread.js";
import { FakeGitHub, fakeClock, pollDeps, tempDir, WATCH } from "./helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
let gh: FakeGitHub;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  gh = new FakeGitHub();
});
afterEach(() => cleanup());

const force = { force: true };

function added(outcome: PollOutcome) {
  return outcome.status === "changed" ? outcome.added : [];
}

describe("pollWatch — baseline and steady state", () => {
  it("records pre-existing comments as a baseline without emitting events", async () => {
    gh.add("old one");
    gh.add("old two");
    const outcome = await pollWatch(WATCH, pollDeps(dir, gh), force);
    expect(outcome.status).toBe("unchanged");
    const state = await readWatchState(dir, WATCH);
    expect(state?.baselined).toBe(true);
    expect(Object.keys(state?.comments ?? {})).toHaveLength(2);
    expect(state?.events).toEqual([]);
  });

  it("delivers nothing when polled repeatedly without new comments, using conditional requests", async () => {
    gh.add("old");
    const deps = pollDeps(dir, gh);
    await pollWatch(WATCH, deps, force);
    for (let i = 0; i < 3; i++) {
      expect((await pollWatch(WATCH, deps, force)).status).toBe("unchanged");
    }
    expect((await readWatchState(dir, WATCH))?.events).toEqual([]);
    // Every poll after the first sent the stored ETag.
    expect(gh.requests.slice(1).every((r) => r.headers["If-None-Match"])).toBe(true);
  });

  it("emits exactly one event for one new comment and advances the seq", async () => {
    const deps = pollDeps(dir, gh);
    await pollWatch(WATCH, deps, force);
    const comment = gh.add("decision: ship it", "bob");
    const outcome = await pollWatch(WATCH, deps, force);
    expect(added(outcome)).toHaveLength(1);
    expect(added(outcome)[0]).toMatchObject({
      seq: 1,
      kind: "created",
      commentId: comment.id,
      author: "bob",
      body: "decision: ship it",
      watch: "acme/plan#7"
    });
    expect((await pollWatch(WATCH, deps, force)).status).toBe("unchanged");
    const state = await readWatchState(dir, WATCH);
    expect(state?.events).toHaveLength(1);
    expect(state?.nextSeq).toBe(2);
  });

  it("only sends GET requests and never a write", async () => {
    const deps = pollDeps(dir, gh);
    gh.add("x");
    await pollWatch(WATCH, deps, force);
    gh.add("y");
    await pollWatch(WATCH, deps, force);
    expect(new Set(gh.requests.map((r) => r.method))).toEqual(new Set(["GET"]));
  });
});

describe("pollWatch — edits and deletions", () => {
  it("reports an edit with the new body and does not re-deliver unrelated comments", async () => {
    const deps = pollDeps(dir, gh);
    const a = gh.add("first");
    gh.add("second");
    await pollWatch(WATCH, deps, force);
    gh.edit(a.id, "first (edited)");
    const events = added(await pollWatch(WATCH, deps, force));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "edited", commentId: a.id, body: "first (edited)" });
  });

  it("reports a deletion without a body", async () => {
    const deps = pollDeps(dir, gh);
    const a = gh.add("to delete");
    gh.add("stays");
    await pollWatch(WATCH, deps, force);
    gh.remove(a.id);
    const events = added(await pollWatch(WATCH, deps, force));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "deleted", commentId: a.id });
    expect(events[0]?.body).toBeUndefined();
    expect((await readWatchState(dir, WATCH))?.comments[String(a.id)]).toBeUndefined();
  });

  it("emits created then edited as two distinct events for the same comment", async () => {
    const deps = pollDeps(dir, gh);
    await pollWatch(WATCH, deps, force);
    const c = gh.add("v1");
    await pollWatch(WATCH, deps, force);
    gh.edit(c.id, "v2");
    await pollWatch(WATCH, deps, force);
    const kinds = (await readWatchState(dir, WATCH))?.events.map((e) => e.kind);
    expect(kinds).toEqual(["created", "edited"]);
  });
});

describe("pollWatch — pagination", () => {
  it("walks every page and emits one event for a comment on the last page", async () => {
    for (let i = 0; i < 250; i++) {
      gh.add(`c${i}`);
    }
    const deps = pollDeps(dir, gh);
    await pollWatch(WATCH, deps, force);
    expect((await readWatchState(dir, WATCH))?.pages).toHaveLength(3);

    gh.requests = [];
    gh.add("new on page 3");
    const events = added(await pollWatch(WATCH, deps, force));
    expect(events).toHaveLength(1);
    expect(events[0]?.body).toBe("new on page 3");
    // Pages 1–2 answered 304; only page 3 carried data.
    expect(gh.requests).toHaveLength(3);
  });

  it("detects a deletion on a page that shifted every later page", async () => {
    const first = gh.add("p1-first");
    for (let i = 0; i < 150; i++) {
      gh.add(`c${i}`);
    }
    const deps = pollDeps(dir, gh);
    await pollWatch(WATCH, deps, force);
    gh.remove(first.id);
    const events = added(await pollWatch(WATCH, deps, force));
    expect(events.map((e) => [e.kind, e.commentId])).toEqual([["deleted", first.id]]);
  });

  it("drops a page that disappeared and does not treat its comments as new", async () => {
    for (let i = 0; i < 101; i++) {
      gh.add(`c${i}`);
    }
    const deps = pollDeps(dir, gh);
    await pollWatch(WATCH, deps, force);
    const last = gh.comments[100];
    gh.remove(last?.id ?? -1);
    const events = added(await pollWatch(WATCH, deps, force));
    expect(events.map((e) => e.kind)).toEqual(["deleted"]);
    expect((await readWatchState(dir, WATCH))?.pages).toHaveLength(1);
  });

  it("never reports deletions from a truncated listing", async () => {
    for (let i = 0; i < 150; i++) {
      gh.add(`c${i}`);
    }
    const deps = pollDeps(dir, gh, { maxPages: 1 });
    await pollWatch(WATCH, deps, force);
    gh.remove(gh.comments[0]?.id ?? -1);
    const events = added(await pollWatch(WATCH, deps, force));
    expect(events.filter((e) => e.kind === "deleted")).toEqual([]);
  });

  it("refuses to follow a pagination link to another origin", async () => {
    gh.fail({
      status: 200,
      headers: { link: '<https://evil.test/steal?page=2>; rel="next"' },
      body: "[]"
    });
    const outcome = await pollWatch(WATCH, pollDeps(dir, gh), force);
    expect(outcome.status).toBe("failed");
    expect(gh.requests.map((r) => new URL(r.url).host)).toEqual(["api.github.test"]);
  });
});

describe("pollWatch — failures never move the cursor", () => {
  const cases: Array<[string, Parameters<FakeGitHub["fail"]>[0], string]> = [
    ["403", { status: 403 }, "forbidden"],
    ["429", { status: 429, headers: { "retry-after": "120" } }, "rate_limited"],
    [
      "403 rate limit",
      { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" } },
      "rate_limited"
    ],
    ["500", { status: 500 }, "server"],
    ["404 private", { status: 404 }, "not_found"],
    ["network", { networkError: "ECONNRESET" }, "network"],
    ["malformed JSON", { status: 200, body: "{not json" }, "malformed"],
    ["non-array", { status: 200, body: '{"message":"x"}' }, "malformed"],
    ["bad item", { status: 200, body: '[{"id":"nope"}]' }, "malformed"]
  ];

  it.each(cases)(
    "%s: records the failure, keeps the log, and resumes without loss",
    async (_name, failure, kind) => {
      const clock = fakeClock();
      const deps = pollDeps(dir, gh, { now: clock.now });
      gh.add("baseline");
      await pollWatch(WATCH, deps, force);
      const before = await readFile(watchStatePath(dir, WATCH), "utf8");

      gh.add("posted during the outage");
      gh.fail(failure);
      const outcome = await pollWatch(WATCH, deps, force);
      expect(outcome.status).toBe("failed");
      expect(outcome.status === "failed" && outcome.error.kind).toBe(kind);

      const during = await readWatchState(dir, WATCH);
      const original = JSON.parse(before);
      expect(during?.events).toEqual(original.events);
      expect(during?.comments).toEqual(original.comments);
      expect(during?.nextSeq).toBe(original.nextSeq);
      expect(during?.lastPoll).toMatchObject({ ok: false, kind });
      expect(during?.consecutiveFailures).toBe(1);

      const events = added(await pollWatch(WATCH, deps, force));
      expect(events.map((e) => e.body)).toEqual(["posted during the outage"]);
      expect((await readWatchState(dir, WATCH))?.consecutiveFailures).toBe(0);
    }
  );

  it("retries a 401 once with a re-resolved token", async () => {
    const deps = pollDeps(dir, gh);
    gh.fail({ status: 401 });
    expect((await pollWatch(WATCH, deps, force)).status).toBe("unchanged");
    expect(gh.requests).toHaveLength(2);
  });

  it("reports a persistent 401 as unauthorized", async () => {
    gh.fail({ status: 401 }, { status: 401 });
    const outcome = await pollWatch(WATCH, pollDeps(dir, gh), force);
    expect(outcome.status === "failed" && outcome.error.kind).toBe("unauthorized");
    expect((await readWatchState(dir, WATCH))?.baselined).toBe(false);
  });

  it("claims no thread state for a private repo it cannot see", async () => {
    gh.fail({ status: 404 });
    await pollWatch(WATCH, pollDeps(dir, gh), force);
    const state = await readWatchState(dir, WATCH);
    expect(state?.baselined).toBe(false);
    expect(state?.comments).toEqual({});
    expect(state?.lastPoll?.error).toMatch(/private/);
  });

  it("backs off exponentially and honours retry-after", async () => {
    const clock = fakeClock();
    const deps = pollDeps(dir, gh, { now: clock.now });
    gh.fail({ status: 500 });
    await pollWatch(WATCH, deps, force);
    expect((await readWatchState(dir, WATCH))?.nextPollAt).toBe(clock.now() + 60_000);
    gh.fail({ status: 500 });
    await pollWatch(WATCH, deps, force);
    expect((await readWatchState(dir, WATCH))?.nextPollAt).toBe(clock.now() + 120_000);
    gh.fail({ status: 429, headers: { "retry-after": "600" } });
    await pollWatch(WATCH, deps, force);
    expect((await readWatchState(dir, WATCH))?.nextPollAt).toBe(clock.now() + 600_000);
  });

  it("skips a poll that is not due yet", async () => {
    const clock = fakeClock();
    const deps = pollDeps(dir, gh, { now: clock.now });
    await pollWatch(WATCH, deps);
    expect((await pollWatch(WATCH, deps)).status).toBe("not_due");
    clock.advance(60_000);
    expect((await pollWatch(WATCH, deps)).status).toBe("unchanged");
  });
});

describe("pollWatch — concurrency and durability", () => {
  it("two concurrent pollers (separate clients, shared state) record a comment once", async () => {
    const a = pollDeps(dir, gh);
    const b = pollDeps(dir, gh);
    await pollWatch(WATCH, a, force);
    gh.add("race");
    const outcomes = await Promise.all([
      pollWatch(WATCH, a, force),
      pollWatch(WATCH, b, force),
      pollWatch(WATCH, a, force)
    ]);
    expect(outcomes.some((o) => o.status === "busy")).toBe(true);
    await pollWatch(WATCH, b, force);
    expect((await readWatchState(dir, WATCH))?.events).toHaveLength(1);
  });

  it("a crash before commit (no state written) re-fetches and records the comment once", async () => {
    const deps = pollDeps(dir, gh);
    await pollWatch(WATCH, deps, force);
    const snapshot = await readFile(watchStatePath(dir, WATCH), "utf8");
    gh.add("survives a crash");
    await pollWatch(WATCH, deps, force);
    // Simulate the crash: the commit never landed.
    await writeFile(watchStatePath(dir, WATCH), snapshot);
    const events = added(await pollWatch(WATCH, deps, force));
    expect(events.map((e) => e.body)).toEqual(["survives a crash"]);
    expect((await readWatchState(dir, WATCH))?.events).toHaveLength(1);
  });

  it("dedupes an event id already in the log", async () => {
    const deps = pollDeps(dir, gh);
    await pollWatch(WATCH, deps, force);
    gh.add("once");
    await pollWatch(WATCH, deps, force);
    // Forget the snapshot entry but keep the log: the diff re-detects it, dedupe drops it.
    const state = JSON.parse(await readFile(watchStatePath(dir, WATCH), "utf8"));
    state.comments = {};
    state.pages = [];
    await writeFile(watchStatePath(dir, WATCH), JSON.stringify(state));
    expect((await pollWatch(WATCH, deps, force)).status).toBe("unchanged");
    expect((await readWatchState(dir, WATCH))?.events).toHaveLength(1);
  });

  it("moves an unreadable state file aside and reports the reset", async () => {
    const deps = pollDeps(dir, gh);
    await pollWatch(WATCH, deps, force);
    await writeFile(watchStatePath(dir, WATCH), "{garbage");
    await pollWatch(WATCH, deps);
    const state = await readWatchState(dir, WATCH);
    expect(state?.lastPoll).toMatchObject({ ok: false, kind: "state_reset" });
    const files = await readdir(join(dir, "watches"));
    expect(files.some((f) => f.includes(".corrupt-"))).toBe(true);
  });

  it("evicts beyond maxLogEvents and records the eviction point", async () => {
    const deps = pollDeps(dir, gh, { maxLogEvents: 2 });
    await pollWatch(WATCH, deps, force);
    gh.add("1");
    gh.add("2");
    gh.add("3");
    await pollWatch(WATCH, deps, force);
    const state = await readWatchState(dir, WATCH);
    expect(state?.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(state?.evictedThrough).toBe(1);
  });
});

describe("filters", () => {
  const filter = { mentions: ["agent-bot"], markers: ["[decision]"] };

  it("matches a mention on a word boundary, case-insensitively", () => {
    expect(matchesFilter(filter, "hey @Agent-Bot please")).toBe(true);
    expect(matchesFilter(filter, "hey @agent-bots")).toBe(false);
    expect(matchesFilter(filter, "mail me at x@agent-bot.com")).toBe(false);
  });

  it("matches a marker and passes everything when empty", () => {
    expect(matchesFilter(filter, "[decision] go")).toBe(true);
    expect(matchesFilter(filter, "chit chat")).toBe(false);
    expect(matchesFilter({ mentions: [], markers: [] }, "anything")).toBe(true);
  });

  it("emits only matching comments, and an edit that starts matching", async () => {
    const deps = pollDeps(dir, gh, { filter });
    await pollWatch(WATCH, deps, force);
    gh.add("chit chat");
    const later = gh.add("not yet");
    gh.add("@agent-bot look");
    expect(added(await pollWatch(WATCH, deps, force)).map((e) => e.body)).toEqual([
      "@agent-bot look"
    ]);
    gh.edit(later.id, "[decision] now");
    expect(added(await pollWatch(WATCH, deps, force)).map((e) => e.kind)).toEqual(["edited"]);
  });
});
