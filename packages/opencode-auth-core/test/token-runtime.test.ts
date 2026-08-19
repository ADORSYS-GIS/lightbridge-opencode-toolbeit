import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import { TokenRuntime } from "../src/token-runtime.js";
import { FileCacheStore } from "../src/cache.js";
import { createServerConfig, createSilentLogger } from "./helpers.js";

function makeJsonResponse(body: unknown, _ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("TokenRuntime", () => {
  it("returns a cached token when still valid, without any fetch", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auth-core-token-"));
    let fetched = 0;
    const fetchImpl = (async () => {
      fetched += 1;
      return makeJsonResponse({});
    }) as typeof fetch;

    const runtime = new TokenRuntime("id-1", createServerConfig(), {
      logger: createSilentLogger(),
      fetchImpl,
      cacheDir
    });

    const cached = {
      accessToken: "cached-access",
      tokenType: "Bearer",
      expiresAt: Date.now() + 60_000
    };
    const store = new FileCacheStore(cacheDir);
    await store.save("id-1", cached);

    const token = await runtime.ensure();
    expect(token.accessToken).toBe("cached-access");
    expect(fetched).toBe(0);
  });

  it("writes a fetched token to the identity-keyed cache", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auth-core-token-write-"));
    const fetchImpl = (async () =>
      makeJsonResponse({
        access_token: "fresh-access",
        token_type: "Bearer",
        expires_in: 3600
      })) as typeof fetch;

    const runtime = new TokenRuntime(
      "write-id",
      createServerConfig({
        authFlow: "client_credentials",
        clientSecret: "machine-secret"
      }),
      {
        logger: createSilentLogger(),
        fetchImpl,
        cacheDir
      }
    );

    const token = await runtime.ensure();
    expect(token.accessToken).toBe("fresh-access");

    const persisted = await readFile(join(cacheDir, "write-id.json"), "utf8");
    expect(persisted).toContain("fresh-access");
  });

  it("isolates caches between identities", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auth-core-iso-"));
    const runtimeA = new TokenRuntime("alpha", createServerConfig(), {
      logger: createSilentLogger(),
      cacheDir
    });
    const runtimeB = new TokenRuntime("beta", createServerConfig(), {
      logger: createSilentLogger(),
      cacheDir
    });

    await new FileCacheStore(cacheDir).save("alpha", {
      accessToken: "alpha-token",
      tokenType: "Bearer"
    });

    expect((await runtimeA.getCached())?.accessToken).toBe("alpha-token");
    expect(await runtimeB.getCached()).toBeUndefined();
  });

  it("supports injectable cache hooks (oauth2 fused-state style)", async () => {
    let token: { accessToken: string; tokenType: string } | undefined;
    const setCached = vi.fn(async (t) => {
      token = t;
    });
    const getCached = vi.fn(async () => token);

    const fetchImpl = (async () =>
      makeJsonResponse({
        access_token: "hooked-access",
        token_type: "Bearer",
        expires_in: 3600
      })) as typeof fetch;

    const runtime = new TokenRuntime(
      "hooked-id",
      createServerConfig({
        authFlow: "client_credentials",
        clientSecret: "machine-secret"
      }),
      {
        logger: createSilentLogger(),
        fetchImpl,
        getCached,
        setCached
      }
    );

    const result = await runtime.ensure();
    expect(result.accessToken).toBe("hooked-access");
    expect(setCached).toHaveBeenCalled();
    expect((await runtime.getCached())?.accessToken).toBe("hooked-access");
  });

  it("exchangeToAudience persists under a derived audience key", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auth-core-ex-"));
    const capturedBodies: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit | undefined) => {
      capturedBodies.push(String(init?.body));
      return makeJsonResponse({
        access_token: "source-scoped-access",
        token_type: "Bearer",
        expires_in: 300
      });
    }) as typeof fetch;

    const runtime = new TokenRuntime("human-id", createServerConfig(), {
      logger: createSilentLogger(),
      fetchImpl,
      cacheDir
    });

    const token = await runtime.exchangeToAudience("/sources/src-123", "human.jwt");
    expect(token.accessToken).toBe("source-scoped-access");

    const body = capturedBodies[0];
    expect(body).toContain("subject_token=human.jwt");
    expect(body).toContain("audience=%2Fsources%2Fsrc-123");

    const exchanged = await runtime.getExchanged("/sources/src-123");
    expect(exchanged?.accessToken).toBe("source-scoped-access");
  });

  it("reset clears the identity cache and leaves no temp files", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auth-core-reset-"));
    const runtime = new TokenRuntime("reset-id", createServerConfig(), {
      logger: createSilentLogger(),
      cacheDir
    });
    await new FileCacheStore(cacheDir).save("reset-id", {
      accessToken: "x",
      tokenType: "Bearer"
    });

    expect(await runtime.getCached()).toBeDefined();
    await runtime.reset();
    expect(await runtime.getCached()).toBeUndefined();

    const leftovers = (await readdir(cacheDir)).filter((name) => name.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
