import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CursorError, createInbox, initialCursor } from "../src/inbox.js";
import { tryLock } from "../src/store.js";
import { emptyWatchState, pollWatch } from "../src/thread.js";
import type { ThreadEvent } from "../src/types.js";
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
const S1 = "ses_one";
const S2 = "ses_two";

/** A session that started before any event, so first contact sees everything recorded. */
const startedLongAgo = async () => 0;

function inbox() {
  return createInbox({ stateDir: dir, watches: [WATCH], sessionStartedAt: startedLongAgo });
}

function bodies(batches: Awaited<ReturnType<ReturnType<typeof createInbox>["next"]>>) {
  return batches.flatMap((b) => b.events.map((e) => e.body));
}

async function record(...texts: string[]) {
  const deps = pollDeps(dir, gh);
  await pollWatch(WATCH, deps, force);
  for (const text of texts) {
    gh.add(text);
  }
  await pollWatch(WATCH, deps, force);
}

describe("next — exactly once per session", () => {
  it("delivers a new comment once and then nothing", async () => {
    await record("hello");
    const box = inbox();
    expect(bodies(await box.next(S1, 20))).toEqual(["hello"]);
    expect(bodies(await box.next(S1, 20))).toEqual([]);
  });

  it("does not re-deliver after a restart (a fresh inbox over the same state dir)", async () => {
    await record("before restart");
    expect(bodies(await inbox().next(S1, 20))).toEqual(["before restart"]);
    const afterRestart = inbox();
    expect(bodies(await afterRestart.next(S1, 20))).toEqual([]);
    gh.add("after restart");
    await pollWatch(WATCH, pollDeps(dir, gh), force);
    expect(bodies(await afterRestart.next(S1, 20))).toEqual(["after restart"]);
  });

  it("two concurrent calls in one process never hand out the same event", async () => {
    await record("a", "b", "c");
    const box = inbox();
    const [x, y] = await Promise.all([box.next(S1, 2), box.next(S1, 2)]);
    const all = [...bodies(x), ...bodies(y)];
    expect(all.sort()).toEqual(["a", "b", "c"]);
  });

  it("two processes (independent inboxes) racing on one session deliver each event once", async () => {
    await record("a", "b", "c", "d");
    const results = await Promise.all([
      inbox().next(S1, 1),
      inbox().next(S1, 1),
      inbox().next(S1, 1)
    ]);
    const all = results.flatMap(bodies);
    expect(new Set(all).size).toBe(all.length);
    const rest = bodies(await inbox().next(S1, 20));
    expect([...all, ...rest].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("gives every session its own copy (several agents sharing one account)", async () => {
    await record("decision");
    const box = inbox();
    expect(bodies(await box.next(S1, 20))).toEqual(["decision"]);
    expect(bodies(await box.next(S2, 20))).toEqual(["decision"]);
  });

  it("honours the limit and reports what remains", async () => {
    await record("a", "b", "c");
    const [batch] = await inbox().next(S1, 2);
    expect(batch?.events.map((e) => e.body)).toEqual(["a", "b"]);
    expect(batch?.remaining).toBe(1);
  });

  it("reports a watch that has not been polled yet", async () => {
    const [batch] = await inbox().next(S1, 20);
    expect(batch).toMatchObject({ pendingBaseline: true, events: [] });
  });

  it("reports events evicted before the session read them, and moves past them", async () => {
    const deps = pollDeps(dir, gh, { maxLogEvents: 2 });
    await pollWatch(WATCH, deps, force);
    const box = inbox();
    await box.status(S1);
    gh.add("1");
    gh.add("2");
    gh.add("3");
    await pollWatch(WATCH, deps, force);
    const [batch] = await box.next(S1, 20);
    expect(batch?.missed).toBe(1);
    expect(batch?.events.map((e) => e.body)).toEqual(["2", "3"]);
    expect((await box.next(S1, 20))[0]?.missed).toBe(0);
  });

  it("refuses to guess when the cursor file is corrupt", async () => {
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "sessions", `${S1}.json`), "{nope");
    await expect(inbox().next(S1, 20)).rejects.toBeInstanceOf(CursorError);
  });

  it("reports busy instead of proceeding unlocked", async () => {
    const lock = await tryLock(join(dir, "locks", `session-${S1}.lock`));
    const box = createInbox({ stateDir: dir, watches: [WATCH], lockWaitMs: 100 });
    await expect(box.next(S1, 20)).rejects.toThrow(/retry/);
    await lock?.release();
    expect(bodies(await box.next(S1, 20))).toEqual([]);
  });
});

describe("first contact", () => {
  it("starts a new session after events observed before it began", async () => {
    const clock = fakeClock();
    const deps = pollDeps(dir, gh, { now: clock.now });
    await pollWatch(WATCH, deps, force);
    gh.add("history");
    await pollWatch(WATCH, deps, force);
    clock.advance(10_000);
    const sessionStart = clock.now();
    clock.advance(10_000);
    gh.add("after the session began");
    await pollWatch(WATCH, deps, force);

    const box = createInbox({
      stateDir: dir,
      watches: [WATCH],
      sessionStartedAt: async () => sessionStart
    });
    expect(bodies(await box.next(S1, 20))).toEqual(["after the session began"]);
  });

  it("falls back to now when the session start is unknown", async () => {
    await record("old");
    const box = createInbox({
      stateDir: dir,
      watches: [WATCH],
      sessionStartedAt: async () => {
        throw new Error("no such session");
      }
    });
    expect(bodies(await box.next(S1, 20))).toEqual([]);
  });

  it("initialCursor handles an unpolled watch and evictions", () => {
    expect(initialCursor(undefined, 0)).toBe(0);
    const state = emptyWatchState(WATCH.key);
    state.evictedThrough = 4;
    state.events = [
      { seq: 5, observedAt: "2026-11-11T10:00:00Z" },
      { seq: 6, observedAt: "2026-11-11T12:00:00Z" }
    ] as ThreadEvent[];
    expect(initialCursor(state, Date.parse("2026-11-11T11:00:00Z"))).toBe(5);
    expect(initialCursor(state, 0)).toBe(4);
  });
});

describe("recent, status and notices", () => {
  it("recent re-reads without moving the cursor", async () => {
    await record("a", "b");
    const box = inbox();
    await box.next(S1, 20);
    expect((await box.recent(1)).map((e) => e.body)).toEqual(["b"]);
    expect((await box.recent(10, "ACME/plan#7")).map((e) => e.body)).toEqual(["a", "b"]);
    expect(await box.recent(10, "other/repo#1")).toEqual([]);
    expect(bodies(await box.next(S1, 20))).toEqual([]);
  });

  it("status reports pending counts and poll health", async () => {
    await record("a");
    gh.fail({ status: 403 });
    await pollWatch(WATCH, pollDeps(dir, gh), force);
    const [status] = await inbox().status(S1);
    expect(status).toMatchObject({ watch: WATCH.key, baselined: true, pending: 1 });
    expect(status?.lastPoll).toMatchObject({ ok: false, kind: "forbidden" });
  });

  it("notices once per batch, and not for events already read", async () => {
    await record("a", "b");
    const box = inbox();
    const first = await box.unnotified(S1);
    expect(first.total).toBe(2);
    expect(first.counts[WATCH.key]).toEqual({ created: 2 });
    await first.commit();
    expect((await box.unnotified(S1)).total).toBe(0);

    gh.add("c");
    await pollWatch(WATCH, pollDeps(dir, gh), force);
    expect((await box.unnotified(S1)).total).toBe(1);
    await box.next(S1, 20);
    expect((await box.unnotified(S1)).total).toBe(0);
  });

  it("an uncommitted notice is offered again", async () => {
    await record("a");
    const box = inbox();
    await box.unnotified(S1);
    expect((await box.unnotified(S1)).total).toBe(1);
  });
});
