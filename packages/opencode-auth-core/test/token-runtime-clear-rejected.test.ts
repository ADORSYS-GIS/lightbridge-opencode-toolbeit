import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FileCacheStore } from "../src/cache.js";
import { TokenRuntime } from "../src/token-runtime.js";
import type { TokenSet } from "../src/types.js";
import { createServerConfig, createSilentLogger } from "./helpers.js";

const KEY = "device-id";

const deviceConfig = () =>
  createServerConfig({
    authFlow: "device_code",
    deviceAuthorizationEndpoint: "https://auth.example.com/oauth/device"
  });

function expired(refreshToken: string, accessToken = "stale-access"): TokenSet {
  return {
    accessToken,
    tokenType: "Bearer",
    refreshToken,
    expiresAt: Date.now() - 60_000
  };
}

interface Idp {
  fetchImpl: typeof fetch;
  refreshCalls: () => number;
}

/** Token endpoint answering every refresh with `refreshStatus`; the device endpoint is down. */
function idp(refreshStatus: number | "network"): Idp {
  let refreshes = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/device")) {
      return new Response("unavailable", { status: 503 });
    }
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (body.get("grant_type") === "refresh_token") {
      refreshes += 1;
      if (refreshStatus === "network") {
        throw new TypeError("fetch failed");
      }
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: refreshStatus,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, refreshCalls: () => refreshes };
}

async function seeded(refreshToken: string): Promise<{ stateDir: string; store: FileCacheStore }> {
  const stateDir = await mkdtemp(join(tmpdir(), "auth-core-clear-"));
  const store = new FileCacheStore(stateDir);
  await store.save(KEY, expired(refreshToken));
  return { stateDir, store };
}

describe("a refresh token the IdP rejected is cleared, not replayed", () => {
  it("clears the stored credential after a definitive 400, so later calls do not POST it again", async () => {
    const { stateDir, store } = await seeded("rt-dead");
    const server = idp(400);
    const runtime = new TokenRuntime(KEY, deviceConfig(), {
      logger: createSilentLogger(),
      fetchImpl: server.fetchImpl,
      stateDir
    });

    await runtime.ensure().catch(() => undefined);
    expect(server.refreshCalls()).toBe(1);
    expect(await store.load(KEY)).toBeUndefined();

    // A later call (here a fresh runtime, as a later process would be) finds no dead token.
    const later = new TokenRuntime(KEY, deviceConfig(), {
      logger: createSilentLogger(),
      fetchImpl: server.fetchImpl,
      stateDir
    });
    await later.ensure().catch(() => undefined);
    expect(server.refreshCalls()).toBe(1);
  });

  it("compare-and-clear: leaves the store alone when another process rotated it meanwhile", async () => {
    const server = idp(400);
    const clearCached = vi.fn(async () => {});
    let reads = 0;
    const runtime = new TokenRuntime(KEY, deviceConfig(), {
      logger: createSilentLogger(),
      fetchImpl: server.fetchImpl,
      // Reads 1-3 (fast path, in-lock, post-rejection) see the dead token; by the
      // read made just before clearing, another process has rotated it.
      getCached: async () => {
        reads += 1;
        return reads <= 3 ? expired("rt-dead") : expired("rt-rotated-by-peer");
      },
      setCached: async () => {},
      clearCached
    });

    await runtime.ensure().catch(() => undefined);

    expect(reads).toBeGreaterThanOrEqual(4);
    expect(clearCached).not.toHaveBeenCalled();
  });

  it("compare-and-clear: does clear when the store still holds the rejected token", async () => {
    const server = idp(400);
    const clearCached = vi.fn(async () => {});
    const runtime = new TokenRuntime(KEY, deviceConfig(), {
      logger: createSilentLogger(),
      fetchImpl: server.fetchImpl,
      getCached: async () => expired("rt-dead"),
      setCached: async () => {},
      clearCached
    });

    await runtime.ensure().catch(() => undefined);

    expect(clearCached).toHaveBeenCalledTimes(1);
  });

  it("does not clear on a network error", async () => {
    const { stateDir, store } = await seeded("rt-alive");
    const server = idp("network");
    const runtime = new TokenRuntime(KEY, deviceConfig(), {
      logger: createSilentLogger(),
      fetchImpl: server.fetchImpl,
      stateDir
    });

    await runtime.ensure().catch(() => undefined);

    expect(server.refreshCalls()).toBe(1);
    expect((await store.load<TokenSet>(KEY))?.refreshToken).toBe("rt-alive");
  });

  it.each([500, 503, 401])(
    "does not clear on HTTP %i (not a definitive invalid_grant)",
    async (status) => {
      const { stateDir, store } = await seeded("rt-alive");
      const server = idp(status);
      const runtime = new TokenRuntime(KEY, deviceConfig(), {
        logger: createSilentLogger(),
        fetchImpl: server.fetchImpl,
        stateDir
      });

      await runtime.ensure().catch(() => undefined);

      expect((await store.load<TokenSet>(KEY))?.refreshToken).toBe("rt-alive");
    }
  );

  it("without a clearCached override, a getCached/setCached caller's store is left untouched", async () => {
    const server = idp(400);
    const setCached = vi.fn(async () => {});
    const runtime = new TokenRuntime(KEY, deviceConfig(), {
      logger: createSilentLogger(),
      fetchImpl: server.fetchImpl,
      getCached: async () => expired("rt-dead"),
      setCached
    });

    await expect(runtime.ensure()).rejects.toThrow();
    expect(setCached).not.toHaveBeenCalled();
  });
});

describe("TokenRuntimeOptions.cacheDir was renamed (ADR-0022)", () => {
  it("throws instead of silently ignoring the old option names", () => {
    expect(
      () =>
        new TokenRuntime(KEY, deviceConfig(), {
          logger: createSilentLogger(),
          cacheDir: "/tmp/x"
        } as never)
    ).toThrow(/renamed stateDir/);
    expect(
      () =>
        new TokenRuntime(KEY, deviceConfig(), {
          logger: createSilentLogger(),
          cacheNamespace: "x"
        } as never)
    ).toThrow(/renamed stateDir/);
  });
});
