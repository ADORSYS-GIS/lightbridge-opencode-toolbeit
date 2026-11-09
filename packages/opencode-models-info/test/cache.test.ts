import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cacheKey, FileCacheStore, isExpired } from "../src/cache.js";
import type { CachedModelsRecord } from "../src/types.js";

describe("FileCacheStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "opencode-models-info-cache-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sample = (now: number): CachedModelsRecord => ({
    fetchedAt: now,
    ttlSeconds: 60,
    etag: "abc",
    models: [{ id: "model-a", context_length: 1024 }]
  });

  it("round-trips through disk and serves from memory on second read", async () => {
    const store = new FileCacheStore(dir);
    const key = cacheKey("p", "https://example.test/models");
    const record = sample(1000);

    await store.put(key, record);
    const fromDisk = await store.get(key);
    expect(fromDisk).toEqual(record);

    const onDisk = JSON.parse(await readFile(join(dir, `${key}.json`), "utf8"));
    expect(onDisk.fetchedAt).toBe(1000);

    const fromMem = await store.get(key);
    expect(fromMem).toEqual(record);
  });

  it("survives many concurrent puts of the same key (no temp-file race)", async () => {
    const store = new FileCacheStore(dir);
    const key = cacheKey("p", "https://example.test/models");

    const puts = Array.from({ length: 25 }, (_, i) =>
      store.put(key, { fetchedAt: 1000 + i, ttlSeconds: 60, models: [{ id: `m-${i}` }] })
    );
    await expect(Promise.all(puts)).resolves.toBeDefined();

    const onDisk = JSON.parse(await readFile(join(dir, `${key}.json`), "utf8"));
    expect(Array.isArray(onDisk.models)).toBe(true);

    const { readdir } = await import("node:fs/promises");
    const leftovers = (await readdir(dir)).filter((name) => name.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("returns undefined on cache miss", async () => {
    const store = new FileCacheStore(dir);
    expect(await store.get("missing")).toBeUndefined();
  });

  it("survives garbage on disk by returning undefined", async () => {
    const store = new FileCacheStore(dir);
    const key = cacheKey("p", "https://example.test/models");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, `${key}.json`), "{not json", { mode: 0o600 });
    expect(await store.get(key)).toBeUndefined();
  });
});

describe("isExpired", () => {
  it("returns false within the TTL window", () => {
    const record: CachedModelsRecord = {
      fetchedAt: 1_000_000,
      ttlSeconds: 60,
      models: []
    };
    expect(isExpired(record, 1_000_000 + 30_000)).toBe(false);
  });

  it("returns true past the TTL window", () => {
    const record: CachedModelsRecord = {
      fetchedAt: 1_000_000,
      ttlSeconds: 60,
      models: []
    };
    expect(isExpired(record, 1_000_000 + 61_000)).toBe(true);
  });
});

describe("cacheKey", () => {
  it("is deterministic and namespace-isolated per provider/url pair", () => {
    expect(cacheKey("a", "u")).toBe(cacheKey("a", "u"));
    expect(cacheKey("a", "u")).not.toBe(cacheKey("b", "u"));
    expect(cacheKey("a", "u")).not.toBe(cacheKey("a", "u2"));
  });

  it("partitions the cache by caller-supplied headers", () => {
    const noHeaders = cacheKey("a", "u");
    const tenant1 = cacheKey("a", "u", { "x-tenant": "t1" });
    const tenant2 = cacheKey("a", "u", { "x-tenant": "t2" });
    expect(tenant1).not.toBe(noHeaders);
    expect(tenant1).not.toBe(tenant2);
  });

  it("ignores header key order and case", () => {
    const a = cacheKey("a", "u", { "X-Tenant": "t1", Accept: "json" });
    const b = cacheKey("a", "u", { accept: "json", "x-tenant": "t1" });
    expect(a).toBe(b);
  });

  it("treats undefined and empty header maps the same", () => {
    expect(cacheKey("a", "u", undefined)).toBe(cacheKey("a", "u"));
  });
});

describe("resolveCacheDir stays in the disposable cache root (ADR-0022)", () => {
  it("never resolves into the durable state root", async () => {
    const { resolveCacheDir } = await import("../src/cache.js");
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "/var/durable-state";
    try {
      const dir = resolveCacheDir();
      expect(dir.endsWith("opencode-models-info")).toBe(true);
      expect(dir).not.toContain("Application Support");
      expect(dir).not.toContain("/var/durable-state");
      expect(dir).not.toContain(join(".local", "state"));
      if (process.platform === "darwin") {
        expect(dir).toContain(join("Library", "Caches"));
      }
    } finally {
      if (previous === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = previous;
      }
    }
  });
});
