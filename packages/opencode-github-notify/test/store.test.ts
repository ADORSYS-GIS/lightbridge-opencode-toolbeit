import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isProcessAlive, resolveStateRoot, tryLock } from "../src/store.js";
import { tempDir } from "./helpers.js";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(() => cleanup());

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "0"]);
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid as number;
}

async function plantLock(path: string, holder: { pid?: number; acquiredAt: number }) {
  await mkdir(join(dir, "locks"), { recursive: true });
  await writeFile(path, JSON.stringify(holder));
}

describe("tryLock", () => {
  it("breaks a fresh lock at once when its holder process is dead", async () => {
    // Regression: a host exiting mid-poll left this behind and blocked polling for 2 min.
    const path = join(dir, "locks", "w.lock");
    await plantLock(path, { pid: await deadPid(), acquiredAt: Date.now() });
    const lock = await tryLock(path);
    expect(lock).toBeDefined();
    expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid);
    await lock?.release();
  });

  it("respects a fresh lock held by a live process", async () => {
    const path = join(dir, "locks", "w.lock");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
    try {
      await plantLock(path, { pid: child.pid as number, acquiredAt: Date.now() });
      expect(await tryLock(path)).toBeUndefined();
    } finally {
      child.kill();
    }
  });

  it("still breaks a lock by age when the holder is unknown", async () => {
    const path = join(dir, "locks", "w.lock");
    await plantLock(path, { acquiredAt: Date.now() - 1_000 });
    expect(await tryLock(path, { staleMs: 60_000 })).toBeUndefined();
    expect(await tryLock(path, { staleMs: 500 })).toBeDefined();
  });

  it("waits for a lock released meanwhile", async () => {
    const path = join(dir, "locks", "w.lock");
    const first = await tryLock(path);
    setTimeout(() => void first?.release(), 100);
    expect(await tryLock(path, { waitMs: 2_000 })).toBeDefined();
  });
});

describe("isProcessAlive", () => {
  it("tells live, dead and invalid pids apart", async () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(await deadPid())).toBe(false);
    expect(isProcessAlive(0)).toBeUndefined();
    expect(isProcessAlive(-5)).toBeUndefined();
  });
});

describe("resolveStateRoot", () => {
  it("uses XDG_STATE_HOME only when absolute, per platform", () => {
    expect(resolveStateRoot({ platform: "linux", env: { XDG_STATE_HOME: "/s" }, home: "/h" })).toBe(
      "/s"
    );
    expect(
      resolveStateRoot({ platform: "linux", env: { XDG_STATE_HOME: "rel" }, home: "/h" })
    ).toBe("/h/.local/state");
    expect(resolveStateRoot({ platform: "darwin", env: {}, home: "/h" })).toBe(
      "/h/Library/Application Support"
    );
    expect(
      resolveStateRoot({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, home: "C:\\h" })
    ).toBe("C:\\L");
  });
});
