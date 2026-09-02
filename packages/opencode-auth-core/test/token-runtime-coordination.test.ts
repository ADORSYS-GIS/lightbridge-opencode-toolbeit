import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { FileCacheStore } from "../src/cache.js";
import { TokenRuntime } from "../src/token-runtime.js";
import type { TokenSet } from "../src/types.js";
import { createRecordingLogger, createServerConfig, createSilentLogger } from "./helpers.js";

/**
 * Fake IdP with RFC 6819 §5.2.2.3 semantics: refresh tokens are single-use and
 * rotate on every successful refresh; presenting an already-rotated one is a
 * `400 invalid_grant`. This is what makes an uncoordinated double-refresh
 * observable rather than merely wasteful.
 */
interface FakeIdp {
  fetchImpl: typeof fetch;
  counters: { refresh: number; device: number };
  accept(refreshToken: string): void;
}

function createFakeIdp(initialRefreshTokens: string[] = []): FakeIdp {
  const counters = { refresh: 0, device: 0 };
  const accepted = new Set(initialRefreshTokens);
  let issued = 0;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input);

    if (target.includes("/device")) {
      counters.device += 1;
      return new Response("device authorization unavailable", { status: 503 });
    }

    const body = new URLSearchParams(String(init?.body ?? ""));
    if (body.get("grant_type") === "refresh_token") {
      counters.refresh += 1;
      const presented = body.get("refresh_token") ?? "";
      if (!accepted.has(presented)) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
      accepted.delete(presented);
      issued += 1;
      const next = `rt-${issued + 1}`;
      accepted.add(next);
      return new Response(
        JSON.stringify({
          access_token: `access-${issued}`,
          refresh_token: next,
          token_type: "Bearer",
          expires_in: 3600
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("unexpected request", { status: 400 });
  }) as typeof fetch;

  return {
    fetchImpl,
    counters,
    accept(refreshToken: string) {
      accepted.add(refreshToken);
    }
  };
}

function expiredToken(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "access-0",
    tokenType: "Bearer",
    refreshToken: "rt-1",
    expiresAt: Date.now() - 1_000,
    ...overrides
  };
}

function validToken(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "access-fresh",
    tokenType: "Bearer",
    refreshToken: "rt-fresh",
    expiresAt: Date.now() + 3_600_000,
    ...overrides
  };
}

async function makeCacheDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("TokenRuntime refresh coordination", () => {
  it("adopts a token another process persisted instead of replaying its own refresh token", async () => {
    const cacheDir = await makeCacheDir("auth-core-adopt-");
    const store = new FileCacheStore(cacheDir);
    const idp = createFakeIdp(["rt-1"]);
    const stale = expiredToken();
    await store.save("shared-id", stale);

    const runtimeA = new TokenRuntime("shared-id", createServerConfig(), {
      logger: createSilentLogger(),
      fetchImpl: idp.fetchImpl,
      cacheDir
    });

    const recording = createRecordingLogger();
    // Models a second process: its first read is the in-memory snapshot it
    // already held (stale); every later read re-reads the shared state.
    let reads = 0;
    const runtimeB = new TokenRuntime("shared-id", createServerConfig(), {
      logger: recording.logger,
      fetchImpl: idp.fetchImpl,
      cacheDir,
      getCached: async () => {
        reads += 1;
        return reads === 1 ? stale : store.load<TokenSet>("shared-id");
      },
      setCached: async (token) => {
        await store.save("shared-id", token);
      }
    });

    const tokenA = await runtimeA.ensure({ interactive: false });
    expect(tokenA.accessToken).toBe("access-1");

    const tokenB = await runtimeB.ensure({ interactive: false });

    expect(tokenB.accessToken).toBe(tokenA.accessToken);
    expect(idp.counters.refresh).toBe(1);
    expect(recording.eventNames()).toContain("token_refresh_adopted_persisted");
  });

  it("serializes two runtimes over one cache dir into a single refresh", async () => {
    const cacheDir = await makeCacheDir("auth-core-two-proc-");
    const store = new FileCacheStore(cacheDir);
    const idp = createFakeIdp(["rt-1"]);
    await store.save("shared-id", expiredToken());

    const build = (): TokenRuntime =>
      new TokenRuntime("shared-id", createServerConfig(), {
        logger: createSilentLogger(),
        fetchImpl: idp.fetchImpl,
        cacheDir
      });

    const [first, second] = await Promise.all([
      build().ensure({ interactive: false }),
      build().ensure({ interactive: false })
    ]);

    expect(idp.counters.refresh).toBe(1);
    expect(first.accessToken).toBe("access-1");
    expect(second.accessToken).toBe(first.accessToken);
  });

  it("collapses ten concurrent ensure() calls in one runtime into a single refresh", async () => {
    const cacheDir = await makeCacheDir("auth-core-single-flight-");
    const store = new FileCacheStore(cacheDir);
    const idp = createFakeIdp(["rt-1"]);
    await store.save("shared-id", expiredToken());

    const recording = createRecordingLogger();
    const runtime = new TokenRuntime("shared-id", createServerConfig(), {
      logger: recording.logger,
      fetchImpl: idp.fetchImpl,
      cacheDir
    });

    const tokens = await Promise.all(
      Array.from({ length: 10 }, () => runtime.ensure({ interactive: false }))
    );

    expect(idp.counters.refresh).toBe(1);
    for (const token of tokens) {
      expect(token.accessToken).toBe("access-1");
    }
    // Pins the in-process single-flight specifically: the nine other callers
    // joined the one in-flight refresh rather than each queueing behind the
    // cross-process lock (which would also yield one refresh, and so would not
    // distinguish the two mechanisms).
    expect(
      recording.eventNames().filter((name) => name === "token_refresh_joined_in_flight")
    ).toHaveLength(9);
  });

  it("never starts an interactive login when a newer valid token is already persisted", async () => {
    const idp = createFakeIdp([]);
    const cacheDir = await makeCacheDir("auth-core-400-adopt-");
    const recording = createRecordingLogger();
    const newer = validToken();
    let reads = 0;

    const runtime = new TokenRuntime(
      "device-id",
      createServerConfig({
        authFlow: "device_code",
        deviceAuthorizationEndpoint: "https://auth.example.com/oauth/device"
      }),
      {
        logger: recording.logger,
        fetchImpl: idp.fetchImpl,
        cacheDir,
        // Reads 1 and 2 (fast path + inside the lock) still see the stale
        // token; the other process persists only while our refresh is in
        // flight, so the post-failure re-read is the first to see it.
        getCached: async () => {
          reads += 1;
          return reads <= 2 ? expiredToken() : newer;
        },
        setCached: async () => {}
      }
    );

    const token = await runtime.ensure();

    expect(token.accessToken).toBe("access-fresh");
    expect(idp.counters.device).toBe(0);
    expect(idp.counters.refresh).toBe(1);
    expect(recording.eventNames()).toContain("token_refresh_adopted_persisted");
  });

  it("retries once with a newer persisted refresh token after a 4xx", async () => {
    const idp = createFakeIdp(["rt-newer"]);
    const cacheDir = await makeCacheDir("auth-core-400-retry-");
    const recording = createRecordingLogger();
    let reads = 0;

    const runtime = new TokenRuntime(
      "device-id",
      createServerConfig({
        authFlow: "device_code",
        deviceAuthorizationEndpoint: "https://auth.example.com/oauth/device"
      }),
      {
        logger: recording.logger,
        fetchImpl: idp.fetchImpl,
        cacheDir,
        getCached: async () => {
          reads += 1;
          return reads <= 2
            ? expiredToken({ refreshToken: "rt-rotated-away" })
            : expiredToken({ refreshToken: "rt-newer", accessToken: "access-other" });
        },
        setCached: async () => {}
      }
    );

    const token = await runtime.ensure();

    expect(token.accessToken).toBe("access-1");
    expect(idp.counters.device).toBe(0);
    expect(idp.counters.refresh).toBe(2);
    expect(recording.eventNames()).toContain("token_refresh_retry_with_newer");
  });

  it("breaks a stale lock file and proceeds", async () => {
    const cacheDir = await makeCacheDir("auth-core-stale-lock-");
    const store = new FileCacheStore(cacheDir);
    const idp = createFakeIdp(["rt-1"]);
    await store.save("shared-id", expiredToken());

    const lockDir = join(cacheDir, "locks");
    const lockPath = join(lockDir, "shared-id.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999_999, acquiredAt: Date.now() - 10_000 }),
      "utf8"
    );

    const recording = createRecordingLogger();
    const runtime = new TokenRuntime("shared-id", createServerConfig(), {
      logger: recording.logger,
      fetchImpl: idp.fetchImpl,
      cacheDir,
      lockStaleMs: 1_000
    });

    const token = await runtime.ensure({ interactive: false });

    expect(token.accessToken).toBe("access-1");
    expect(idp.counters.refresh).toBe(1);
    expect(recording.eventNames()).toContain("token_lock_stale_broken");
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
  });

  it("waits behind a live lock and adopts the token that holder persisted", async () => {
    const cacheDir = await makeCacheDir("auth-core-live-lock-");
    const store = new FileCacheStore(cacheDir);
    const idp = createFakeIdp(["rt-1"]);
    await store.save("shared-id", expiredToken());

    const lockDir = join(cacheDir, "locks");
    const lockPath = join(lockDir, "shared-id.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: 999_999, acquiredAt: Date.now() }), "utf8");

    const holder = setTimeout(() => {
      void (async () => {
        await store.save("shared-id", validToken({ accessToken: "access-by-holder" }));
        await unlink(lockPath).catch(() => {});
      })();
    }, 150);

    const recording = createRecordingLogger();
    const runtime = new TokenRuntime("shared-id", createServerConfig(), {
      logger: recording.logger,
      fetchImpl: idp.fetchImpl,
      cacheDir
    });

    try {
      const token = await runtime.ensure({ interactive: false });
      expect(token.accessToken).toBe("access-by-holder");
      expect(idp.counters.refresh).toBe(0);
      expect(recording.eventNames()).toContain("token_lock_wait");
    } finally {
      clearTimeout(holder);
    }
  });

  it("proceeds without the lock, warning once, when the lock dir cannot be created", async () => {
    const cacheDir = await makeCacheDir("auth-core-lock-unwritable-");
    const store = new FileCacheStore(cacheDir);
    const idp = createFakeIdp(["rt-1"]);
    await store.save("shared-id", expiredToken());
    // A plain file where the lock directory should go: mkdir fails ENOTDIR for
    // every user, root included.
    await writeFile(join(cacheDir, "locks"), "not a directory", "utf8");

    const recording = createRecordingLogger();
    const runtime = new TokenRuntime("shared-id", createServerConfig(), {
      logger: recording.logger,
      fetchImpl: idp.fetchImpl,
      cacheDir
    });

    const token = await runtime.ensure({ interactive: false });

    expect(token.accessToken).toBe("access-1");
    expect(idp.counters.refresh).toBe(1);
    const unavailable = recording.events.filter(
      (entry) => entry.event === "token_lock_unavailable"
    );
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]?.level).toBe("warn");
  });
});
