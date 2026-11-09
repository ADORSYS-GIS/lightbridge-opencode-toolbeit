import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileCacheStore } from "../src/cache.js";

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("FileCacheStore permissions (ADR-0005, kept by ADR-0022)", () => {
  it("save() alone creates a missing nested directory 0o700 and the file 0o600", async () => {
    const root = await mkdtemp(join(tmpdir(), "auth-core-modes-"));
    const dir = join(root, "state", "opencode-x");
    // No ensureReady(): the first save must create the directory itself, privately.
    await new FileCacheStore(dir).save("alpha", { accessToken: "a", tokenType: "Bearer" });

    expect(await mode(dir)).toBe(0o700);
    expect(await mode(join(dir, "alpha.json"))).toBe(0o600);
    expect((await readdir(dir)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("ensureReady() creates the directory 0o700", async () => {
    const root = await mkdtemp(join(tmpdir(), "auth-core-modes-ready-"));
    const dir = join(root, "x", "y");
    await new FileCacheStore(dir).ensureReady();
    expect(await mode(dir)).toBe(0o700);
  });
});
