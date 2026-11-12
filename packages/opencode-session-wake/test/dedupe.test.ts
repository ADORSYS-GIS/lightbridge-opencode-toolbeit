import { describe, expect, it } from "vitest";

import { parseWakeOptions, wakeLeasesDir } from "../src/config.js";
import type { GitHubTransport } from "../src/github.js";
import { LeaseStore } from "../src/lease.js";
import { createPoller } from "../src/poller.js";
import { createWakeToolInfos } from "../src/tools.js";
import type { WakeNotice } from "../src/types.js";
import {
  deferred,
  event,
  exec,
  fakeDeliver,
  fakeLogger,
  fakeTransport,
  keyOf,
  makeStore,
  makeStores,
  page,
  record,
  seedWatch,
  tempDir
} from "./helpers.js";

const options = parseWakeOptions({
  intervalMs: 60_000,
  minIntervalMs: 15_000,
  maxIntervalMs: 600_000,
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

interface StackOptions {
  readonly transport?: GitHubTransport;
  readonly ownerID?: string;
}

/**
 * One plugin instance's worth of state over a shared state root: its own
 * in-memory stores, its own lease handle and its own wake seam. Two stacks over
 * one directory are the test's model of two OpenCode processes.
 */
async function stack(dir: string, now: () => number, overrides: StackOptions = {}) {
  const { store, watches } = await makeStores(dir, now);
  const logger = fakeLogger();
  const leases = new LeaseStore({ dir: wakeLeasesDir(dir), logger, now });
  const transport = overrides.transport ?? fakeTransport();
  const { deliver, notices } = fakeDeliver();
  const poller = createPoller({
    store,
    watches,
    leases,
    transport,
    deliver,
    logger,
    options,
    now,
    sleep: async () => {},
    ...(overrides.ownerID !== undefined ? { ownerID: overrides.ownerID } : {})
  });
  const infos = createWakeToolInfos({ store, poller, options, logger, now });
  const byName = Object.fromEntries(infos.map((info) => [info.name, info]));
  const tool = (name: string) => {
    const info = byName[name];
    if (!info) {
      throw new Error(`missing tool ${name}`);
    }
    return info;
  };
  return { store, watches, leases, transport, poller, notices, logger, tool };
}

/** Read a subscription straight from disk, as a third process would. */
async function pendingOnDisk(dir: string, id: string): Promise<number> {
  const store = await makeStore(dir);
  const record = await store.refresh(id);
  return record?.state.pending.length ?? -1;
}

describe("cross-poller dedupe", () => {
  it("delivers one event exactly once when two pollers race over one state root", async () => {
    const temp = await tempDir();
    try {
      const seed = await makeStore(temp.dir);
      const rec = record({ sessionID: "ses_a" });
      await seed.put(rec);
      const key = keyOf(rec);

      const a = await stack(temp.dir, () => 1_000, { ownerID: "poller-a" });
      const b = await stack(temp.dir, () => 1_000, { ownerID: "poller-b" });
      await a.poller.join(rec);
      await b.poller.watchFor(rec.subscription.id);

      a.transport.setComments([page([event("101")])]);
      b.transport.setComments([page([event("101")])]);

      const outcomes = await Promise.all([a.poller.tickKey(key), b.poller.tickKey(key)]);
      const notices: WakeNotice[] = [...a.notices, ...b.notices];
      expect(notices).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "delivered")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "skipped")).toHaveLength(1);

      // The loser never fetched: the lease is checked before the poll, so a
      // second process cannot advance the cursor or duplicate the fan-out.
      const loser = a.notices.length === 0 ? a : b;
      const winner = loser === a ? b : a;
      expect(loser.transport.requests.comments).toHaveLength(0);

      expect(await pendingOnDisk(temp.dir, rec.subscription.id)).toBe(1);

      // The notice count is the number the following wake_next returns.
      const drained = await exec(winner.tool("wake_next"), {}, "ses_a");
      expect(drained.metadata?.count).toBe(notices[0]?.count);
      expect(drained.metadata?.count).toBe(1);
      expect(await pendingOnDisk(temp.dir, rec.subscription.id)).toBe(0);

      // A second drain has nothing: the event was consumed once.
      const again = await exec(winner.tool("wake_next"), {}, "ses_a");
      expect(again.content).toBe("No unread comments.");
    } finally {
      await temp.cleanup();
    }
  });

  it("sends no notice and appends nothing when another live owner holds the lease", async () => {
    const temp = await tempDir();
    try {
      const seed = await makeStore(temp.dir);
      const rec = record({ sessionID: "ses_a" });
      await seed.put(rec);
      const key = keyOf(rec);

      const a = await stack(temp.dir, () => 1_000, { ownerID: "poller-a" });
      await a.poller.join(rec);
      const other = new LeaseStore({
        dir: wakeLeasesDir(temp.dir),
        logger: fakeLogger(),
        now: () => 1_000
      });
      expect(await other.acquire(key, "another-live-poller", 60_000)).toBe(true);

      a.transport.setComments([page([event("101")])]);
      const outcome = await a.poller.tickKey(key);

      expect(outcome.status).toBe("skipped");
      expect(a.notices).toHaveLength(0);
      expect(a.transport.requests.comments).toHaveLength(0);
      expect(await pendingOnDisk(temp.dir, rec.subscription.id)).toBe(0);

      // Once the other owner releases, the same poller delivers exactly once.
      await other.release(key, "another-live-poller");
      const delivered = await a.poller.tickKey(key);
      expect(delivered.status).toBe("delivered");
      expect(a.notices).toHaveLength(1);
      expect(await pendingOnDisk(temp.dir, rec.subscription.id)).toBe(1);
    } finally {
      await temp.cleanup();
    }
  });

  it("takes over after a crashed owner's lease expires and delivers once", async () => {
    const temp = await tempDir();
    const clockRef = clock();
    try {
      const seed = await makeStore(temp.dir);
      const rec = record({ sessionID: "ses_a" });
      await seed.put(rec);
      const key = keyOf(rec);

      const crashed = await stack(temp.dir, clockRef.now, { ownerID: "crashed" });
      const survivor = await stack(temp.dir, clockRef.now, { ownerID: "survivor" });
      await crashed.poller.join(rec);
      await survivor.poller.watchFor(rec.subscription.id);

      // The crashed poller acquires the lease with an empty poll, then "dies"
      // without stop() — the lease file stays behind until it expires.
      crashed.transport.setComments([page([])]);
      await crashed.poller.tickKey(key);
      expect(crashed.notices).toHaveLength(0);

      // Default interval 60 s => TTL 150 s; 200 s is safely past it.
      clockRef.advance(200_000);
      survivor.transport.setComments([page([event("101")])]);
      const takeover = await survivor.poller.tickKey(key);

      expect(takeover.status).toBe("delivered");
      expect(survivor.notices).toHaveLength(1);
      expect(crashed.notices).toHaveLength(0);
      expect(await pendingOnDisk(temp.dir, rec.subscription.id)).toBe(1);

      // If the crashed process comes back, it must not deliver while the
      // survivor's renewed lease is live.
      crashed.transport.setComments([page([event("102")])]);
      const late = await crashed.poller.tickKey(key);
      expect(late.status).toBe("skipped");
      expect(crashed.notices).toHaveLength(0);
    } finally {
      await temp.cleanup();
    }
  });

  it("does not re-announce an event after wake_next marked it seen", async () => {
    const temp = await tempDir();
    const clockRef = clock();
    try {
      const seed = await makeStore(temp.dir);
      const rec = record({ sessionID: "ses_a" });
      await seed.put(rec);
      const key = keyOf(rec);

      const a = await stack(temp.dir, clockRef.now);
      await a.poller.join(rec);
      a.transport.setComments([page([event("101")])]);
      await a.poller.tickKey(key);
      expect(a.notices).toHaveLength(1);

      const drained = await exec(a.tool("wake_next"), {}, "ses_a");
      expect(drained.metadata?.count).toBe(1);
      expect(a.watches.get(key)?.state.seen).toContain("101");

      // A replay of the same page after the next poll is due must not wake.
      clockRef.advance(60_000);
      a.transport.setComments([page([event("101")])]);
      const again = await a.poller.tickKey(key);

      expect(again.status).toBe("no-change");
      expect(a.notices).toHaveLength(1);
      expect(a.watches.get(key)?.state.seen).toContain("101");
      expect(await pendingOnDisk(temp.dir, rec.subscription.id)).toBe(0);
    } finally {
      await temp.cleanup();
    }
  });

  it("keeps the notice count equal to the drainable count for two subscribers", async () => {
    const temp = await tempDir();
    try {
      const seed = await makeStore(temp.dir);
      const recA = record({ sessionID: "ses_a" });
      const recB = record({ sessionID: "ses_b" });
      await seed.put(recA);
      await seed.put(recB);

      const a = await stack(temp.dir, () => 1_000);
      await a.poller.join(recA);
      await a.poller.join(recB);

      a.transport.setComments([page([event("101"), event("102"), event("103")])]);
      const outcome = await a.poller.tickKey(keyOf(recA));
      expect(outcome.delivered).toBe(2);
      expect(a.notices).toHaveLength(2);

      const noticeA = a.notices.find((notice) => notice.sessionID === "ses_a");
      const noticeB = a.notices.find((notice) => notice.sessionID === "ses_b");
      expect(noticeA?.count).toBe(3);
      expect(noticeB?.count).toBe(3);

      const drainA = await exec(a.tool("wake_next"), {}, "ses_a");
      const drainB = await exec(a.tool("wake_next"), {}, "ses_b");
      expect(drainA.metadata?.count).toBe(noticeA?.count);
      expect(drainB.metadata?.count).toBe(noticeB?.count);
      expect(drainA.metadata?.count).toBe(3);
      expect(drainB.metadata?.count).toBe(3);

      expect(await pendingOnDisk(temp.dir, recA.subscription.id)).toBe(0);
      expect(await pendingOnDisk(temp.dir, recB.subscription.id)).toBe(0);
    } finally {
      await temp.cleanup();
    }
  });

  it("writes nothing when the lease is taken over during a long fetch", async () => {
    const temp = await tempDir();
    const clockRef = clock();
    try {
      const seed = await makeStore(temp.dir);
      const rec = record({ sessionID: "ses_a" });
      await seed.put(rec);
      const key = keyOf(rec);

      const base = fakeTransport();
      const gate = deferred<void>();
      const started = deferred<void>();
      const transport: GitHubTransport = {
        ...base,
        listComments: async (request) => {
          started.resolve();
          await gate.promise;
          return base.listComments(request);
        }
      };
      const a = await stack(temp.dir, clockRef.now, { transport });
      await a.poller.join(rec);
      a.transport.setComments([page([event("101")])]);

      const ticking = a.poller.tickKey(key);
      await started.promise;
      // The fetch outlives the lease (150 s for a 60 s interval), so another
      // poller legitimately takes over while this one is still waiting.
      clockRef.advance(200_000);
      const intruder = new LeaseStore({
        dir: wakeLeasesDir(temp.dir),
        logger: fakeLogger(),
        now: clockRef.now
      });
      expect(await intruder.acquire(key, "intruder", 150_000)).toBe(true);

      gate.resolve();
      const outcome = await ticking;

      expect(outcome.status).toBe("skipped");
      expect(a.notices).toHaveLength(0);
      // No pending append and no cursor advance: the new owner must be able to
      // deliver this event itself.
      expect(await pendingOnDisk(temp.dir, rec.subscription.id)).toBe(0);
    } finally {
      await temp.cleanup();
    }
  });

  it("drains pending appended by another process even when this store is stale", async () => {
    const temp = await tempDir();
    try {
      const seed = await makeStore(temp.dir);
      const rec = record({ sessionID: "ses_a" });
      await seed.put(rec);

      const a = await stack(temp.dir, () => 1_000);
      // Simulate the poller process appending an event after this process
      // loaded its snapshot: this is the live "pending=1 but No unread
      // comments" anomaly.
      const writer = await makeStore(temp.dir);
      const live = await writer.refresh(rec.subscription.id);
      if (!live) {
        throw new Error("seed record missing");
      }
      live.state.pending.push(event("101"));
      live.state.seen.push("101");
      await writer.put(live);

      const drained = await exec(a.tool("wake_next"), {}, "ses_a");
      expect(drained.metadata?.count).toBe(1);
      expect(drained.content).toContain("id: 101");
      expect(await pendingOnDisk(temp.dir, rec.subscription.id)).toBe(0);
    } finally {
      await temp.cleanup();
    }
  });

  it("does not resurrect an event drained while a poll was in flight", async () => {
    const temp = await tempDir();
    try {
      const seed = await makeStore(temp.dir);
      const rec = record({ sessionID: "ses_a" });
      rec.state.pending.push(event("100"));
      rec.state.seen.push("100");
      await seed.put(rec);
      const key = keyOf(rec);

      const base = fakeTransport();
      const gate = deferred<void>();
      const started = deferred<void>();
      const transport: GitHubTransport = {
        ...base,
        listComments: async (request) => {
          started.resolve();
          await gate.promise;
          return base.listComments(request);
        }
      };
      const a = await stack(temp.dir, () => 1_000, { transport });
      await a.poller.join(rec);
      a.transport.setComments([page([event("101")])]);

      const ticking = a.poller.tickKey(key);
      await started.promise;

      // A second process drains the old event while the first is fetching.
      const b = await stack(temp.dir, () => 1_000);
      const drained = await exec(b.tool("wake_next"), {}, "ses_a");
      expect(drained.metadata?.count).toBe(1);

      gate.resolve();
      const outcome = await ticking;
      expect(outcome.delivered).toBe(1);
      expect(a.notices).toHaveLength(1);
      expect(a.notices[0]?.count).toBe(1);

      const after = await makeStore(temp.dir);
      const stored = await after.refresh(rec.subscription.id);
      // The drained event is gone; only the event from this poll remains.
      expect(stored?.state.pending.map((item) => item.id)).toEqual(["101"]);
    } finally {
      await temp.cleanup();
    }
  });

  it("sends no notice when updateState reports the record was removed mid-poll", async () => {
    const temp = await tempDir();
    try {
      const seed = await makeStore(temp.dir);
      const rec = record({ sessionID: "ses_a" });
      await seed.put(rec);
      const key = keyOf(rec);

      const base = fakeTransport();
      const gate = deferred<void>();
      const started = deferred<void>();
      const transport: GitHubTransport = {
        ...base,
        listComments: async (request) => {
          started.resolve();
          await gate.promise;
          return base.listComments(request);
        }
      };
      const a = await stack(temp.dir, () => 1_000, { transport });
      await a.poller.join(rec);
      a.transport.setComments([page([event("101")])]);

      const ticking = a.poller.tickKey(key);
      await started.promise;
      // Remove the subscription while the fetch is in flight. updateState must
      // return undefined, and a removed record must never be re-created.
      await a.store.remove(rec.subscription.id);
      gate.resolve();
      const outcome = await ticking;

      expect(outcome.delivered).toBe(0);
      expect(a.notices).toHaveLength(0);
      expect(a.store.get(rec.subscription.id)).toBeUndefined();
      expect(await pendingOnDisk(temp.dir, rec.subscription.id)).toBe(-1);
    } finally {
      await temp.cleanup();
    }
  });
});

describe("seen-ring trimming", () => {
  it("keeps drained ids past the cap instead of evicting them before the next poll", async () => {
    const temp = await tempDir();
    try {
      const rec = record();
      const { watches } = await makeStores(temp.dir);
      const key = keyOf(rec);
      await seedWatch(watches, rec, { seen: ["a", "b", "c"] });

      const recorded = await watches.recordSeen(key, ["a", "b", "c"], 2);

      expect(recorded).toBe(true);
      // All three ids are protected, so the ring exceeds the cap rather than
      // losing the proof that these events were already delivered.
      expect(watches.get(key)?.state.seen).toEqual(["a", "b", "c"]);
    } finally {
      await temp.cleanup();
    }
  });

  it("evicts unprotected ids first, then stops when only protected ids remain", async () => {
    const temp = await tempDir();
    try {
      const rec = record();
      const { watches } = await makeStores(temp.dir);
      const key = keyOf(rec);
      await seedWatch(watches, rec, { seen: ["old-1", "old-2", "drained"] });

      await watches.recordSeen(key, ["drained"], 2);

      expect(watches.get(key)?.state.seen).toEqual(["old-2", "drained"]);
    } finally {
      await temp.cleanup();
    }
  });
});
