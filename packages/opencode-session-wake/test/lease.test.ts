import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LEASE_TTL_FLOOR_MS,
  LeaseStore,
  leaseFileFor,
  leaseTtlMs,
  newLeaseOwnerID
} from "../src/lease.js";
import { fakeLogger, tempDir } from "./helpers.js";

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
