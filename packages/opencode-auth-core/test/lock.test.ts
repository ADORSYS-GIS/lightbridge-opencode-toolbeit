import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireFileLock } from "../src/lock.js";

describe("acquireFileLock", () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const dir of created) {
      await chmod(join(dir, "locks"), 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
    created.length = 0;
  });

  it("times out to proceed-unlocked when a stale lock cannot be removed", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const base = await mkdtemp(join(tmpdir(), "auth-core-lock-"));
    created.push(base);
    const lockDir = join(base, "locks");
    await mkdir(lockDir, { mode: 0o700 });
    const lockPath = join(lockDir, "identity.lock");
    await writeFile(lockPath, JSON.stringify({ pid: 1, acquiredAt: Date.now() - 60_000 }));
    await chmod(lockDir, 0o500);

    const started = Date.now();
    const lock = await acquireFileLock(lockPath, {
      staleMs: 1_000,
      maxWaitMs: 300,
      pollIntervalMs: 20
    });

    expect(lock.acquired).toBe(false);
    expect(lock.reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 4_000);

  it("breaks a removable stale lock and acquires", async () => {
    const base = await mkdtemp(join(tmpdir(), "auth-core-lock-"));
    created.push(base);
    const lockDir = join(base, "locks");
    await mkdir(lockDir, { mode: 0o700 });
    const lockPath = join(lockDir, "identity.lock");
    await writeFile(lockPath, JSON.stringify({ pid: 1, acquiredAt: Date.now() - 60_000 }));

    const lock = await acquireFileLock(lockPath, { staleMs: 1_000, maxWaitMs: 2_000 });
    expect(lock.acquired).toBe(true);
    await lock.release();
  });
});
