import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LEASE_TTL_FLOOR_MS,
  LeaseStore,
  leaseFileFor,
  leaseTtlForIdleMs,
  leaseTtlMs,
  newLeaseOwnerID
} from "../src/lease.js";
import { deferred, fakeLogger, tempDir } from "./helpers.js";

type AnyMethod = (...args: unknown[]) => Promise<unknown>;
type StoreInternals = Record<string, AnyMethod | undefined>;

/**
 * Replace a private lease-store step for the duration of one test. The method
 * names differ between the pre-CAS implementation (`removeFile`) and the CAS
 * implementation (`moveAside`), so a missing method is simply skipped.
 */
function overrideMethod(
  store: LeaseStore,
  name: string,
  wrapper: (original: AnyMethod, ...args: unknown[]) => Promise<unknown>
): void {
  const internals = store as unknown as StoreInternals;
  const original = internals[name];
  if (typeof original !== "function") {
    return;
  }
  internals[name] = (...args) => wrapper(original.bind(store), ...args);
}

function clock(start = 1_000) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    }
  };
}

async function setup(start = 1_000) {
  const temp = await tempDir();
  const clockRef = clock(start);
  const logger = fakeLogger();
  const leases = new LeaseStore({
    dir: join(temp.dir, "leases"),
    logger,
    now: clockRef.now
  });
  return { temp, clockRef, logger, leases };
}

describe("leaseTtlMs", () => {
  it("floors a very short interval so the lease cannot expire between polls", () => {
    expect(leaseTtlMs(1_000, 600_000)).toBe(LEASE_TTL_FLOOR_MS);
    expect(leaseTtlMs(10_000, 600_000)).toBe(LEASE_TTL_FLOOR_MS);
  });

  it("gives a normal interval two polls plus margin", () => {
    expect(leaseTtlMs(60_000, 600_000)).toBe(150_000);
  });

  it("caps failover at two maximum intervals", () => {
    expect(leaseTtlMs(3_600_000, 3_600_000)).toBe(7_200_000);
  });

  it("extends the TTL to cover a failure backoff", () => {
    expect(leaseTtlForIdleMs(500_000, 60_000, 600_000)).toBe(530_000);
    expect(leaseTtlForIdleMs(0, 60_000, 600_000)).toBe(150_000);
    // Still bounded by the same ceiling as a normal lease.
    expect(leaseTtlForIdleMs(10_000_000, 60_000, 600_000)).toBe(1_200_000);
  });
});

describe("owner ids", () => {
  it("are random and carry the lease prefix", () => {
    const first = newLeaseOwnerID();
    const second = newLeaseOwnerID();
    expect(first).toMatch(/^lease_[a-f0-9]{16}$/);
    expect(first).not.toBe(second);
  });

  it("maps a key to a stable, path-safe file name", () => {
    expect(leaseFileFor("a|b")).toMatch(/^[a-f0-9]{16}\.json$/);
    expect(leaseFileFor("a|b")).toBe(leaseFileFor("a|b"));
    expect(leaseFileFor("a|b")).not.toBe(leaseFileFor("a|c"));
  });
});

describe("LeaseStore", () => {
  it("lets exactly one of two owners claim a free lease", async () => {
    const { temp, leases } = await setup();
    try {
      expect(await leases.acquire("k", "owner-a", 60_000)).toBe(true);
      expect(await leases.acquire("k", "owner-b", 60_000)).toBe(false);
      expect(await leases.read("k")).toMatchObject({ key: "k", owner: "owner-a" });
    } finally {
      await temp.cleanup();
    }
  });

  it("renews only the current owner", async () => {
    const { temp, leases, clockRef } = await setup();
    try {
      expect(await leases.acquire("k", "owner-a", 100)).toBe(true);
      expect(await leases.renew("k", "owner-b", 100)).toBe(false);
      clockRef.advance(50);
      expect(await leases.renew("k", "owner-a", 100)).toBe(true);
      expect((await leases.read("k"))?.expiresAt).toBe(1_150);
    } finally {
      await temp.cleanup();
    }
  });

  it("does not release another owner's live lease", async () => {
    const { temp, leases } = await setup();
    try {
      await leases.acquire("k", "owner-a", 60_000);
      await leases.release("k", "owner-b");
      expect(await leases.read("k")).toMatchObject({ owner: "owner-a" });
      await leases.release("k", "owner-a");
      expect(await leases.read("k")).toBeUndefined();
    } finally {
      await temp.cleanup();
    }
  });

  it("lets a survivor take over only after the lease expires", async () => {
    const { temp, leases, clockRef } = await setup();
    try {
      expect(await leases.acquire("k", "crashed", 100)).toBe(true);
      clockRef.advance(99);
      expect(await leases.acquire("k", "survivor", 100)).toBe(false);
      clockRef.advance(2);
      expect(await leases.acquire("k", "survivor", 100)).toBe(true);
      expect((await leases.read("k"))?.owner).toBe("survivor");
    } finally {
      await temp.cleanup();
    }
  });

  it("lets exactly one of two independent stores take over an expired lease", async () => {
    const { temp, leases, clockRef } = await setup();
    try {
      const dir = join(temp.dir, "leases");
      const logger = fakeLogger();
      const key = "race";
      expect(await leases.acquire(key, "crashed", 100)).toBe(true);
      clockRef.advance(200);

      const first = new LeaseStore({ dir, logger, now: clockRef.now });
      const second = new LeaseStore({ dir, logger, now: clockRef.now });

      // Force the exact interleaving that broke the old read → unlink → wx
      // takeover: both stores read the expired lease, the first publishes its
      // fresh claim, and only then does the second run its removal step. Before
      // the compare-and-swap that second removal deleted the first's fresh
      // lease, so both `wx` creates succeeded. With the CAS the second store
      // sees the first's claim, restores it, and loses.
      const bothRead = deferred<void>();
      let reads = 0;
      for (const store of [first, second]) {
        overrideMethod(store, "readRaw", async (original, ...args) => {
          const result = await original(...args);
          reads += 1;
          if (reads === 2) {
            bothRead.resolve();
          }
          await bothRead.promise;
          return result;
        });
      }
      const firstClaimed = deferred<void>();
      for (const method of ["createExclusive", "linkClaim"]) {
        overrideMethod(first, method, async (original, ...args) => {
          const result = await original(...args);
          firstClaimed.resolve();
          return result;
        });
      }
      for (const method of ["removeFile", "moveAside"]) {
        overrideMethod(second, method, async (original, ...args) => {
          await firstClaimed.promise;
          return original(...args);
        });
      }

      const outcomes = await Promise.all([
        first.acquire(key, "owner-a", 100),
        second.acquire(key, "owner-b", 100)
      ]);
      expect(outcomes.filter(Boolean)).toHaveLength(1);

      const winner = outcomes[0] ? "owner-a" : "owner-b";
      const loserStore = outcomes[0] ? second : first;
      const loser = outcomes[0] ? "owner-b" : "owner-a";
      expect((await leases.read(key))?.owner).toBe(winner);
      // The loser must not be able to renew over the winner's fresh lease.
      expect(await loserStore.renew(key, loser, 100)).toBe(false);
      expect((await leases.read(key))?.owner).toBe(winner);
    } finally {
      await temp.cleanup();
    }
  });

  it("does not let a renew clobber a takeover", async () => {
    const { temp, leases, clockRef } = await setup();
    try {
      expect(await leases.acquire("k", "owner-a", 100)).toBe(true);
      clockRef.advance(200);
      const other = new LeaseStore({
        dir: join(temp.dir, "leases"),
        logger: fakeLogger(),
        now: clockRef.now
      });
      expect(await other.acquire("k", "owner-b", 100)).toBe(true);

      expect(await leases.renew("k", "owner-a", 100)).toBe(false);
      expect((await other.read("k"))?.owner).toBe("owner-b");
    } finally {
      await temp.cleanup();
    }
  });

  it("fails closed on a fresh unreadable lease (a claim may still be written)", async () => {
    const { temp, leases, logger } = await setup();
    try {
      const dir = join(temp.dir, "leases");
      await mkdir(dir, { recursive: true });
      const path = join(dir, leaseFileFor("k"));
      await writeFile(path, "not json", "utf8");

      expect(await leases.read("k")).toBeUndefined();
      expect(await leases.acquire("k", "owner-a", 60_000)).toBe(false);
      expect(logger.events.some((entry) => entry.event === "wake_lease_unreadable")).toBe(true);
    } finally {
      await temp.cleanup();
    }
  });

  it("reclaims a stale unreadable lease instead of wedging the watch", async () => {
    const { temp, leases, logger } = await setup(1_000_000);
    try {
      const dir = join(temp.dir, "leases");
      await mkdir(dir, { recursive: true });
      const path = join(dir, leaseFileFor("k"));
      await writeFile(path, "not json", "utf8");
      // Older than one TTL: a crashed/corrupt claim, not one being written now.
      await utimes(path, new Date(0), new Date(0));

      expect(await leases.acquire("k", "owner-a", 60_000)).toBe(true);
      expect((await leases.read("k"))?.owner).toBe("owner-a");
      expect(logger.events.some((entry) => entry.event === "wake_lease_stale_unreadable")).toBe(
        true
      );
    } finally {
      await temp.cleanup();
    }
  });
});
