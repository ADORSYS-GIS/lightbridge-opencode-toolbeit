import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ServerCredentialStore, ServerStateStore } from "../src/cache.js";
import { ProviderModelSyncEngine } from "../src/engine.js";
import { createServerConfig, createSilentLogger, seedServerState } from "./helpers.js";

const SERVER_ID = "example-ai";

const chain = (n: number) => ({
  accessToken: `A${n}`,
  tokenType: "Bearer",
  refreshToken: `R${n}`,
  expiresAt: Date.now() + 3_600_000
});

/**
 * Regression for the model-sync credential race (found in review of #152).
 *
 * oauth2 and lightbridge share ONE credential file (ADR-0017). `syncServer`
 * called `ensure()` (token R1), then fetched `/models`. If another process
 * rotated R1 -> R2 during that fetch, the sync used to write R1 back with a
 * NEWER stamp; every process then adopted R1, and the next refresh replayed it
 * - RFC 6819 reuse detection revokes the whole chain. Credentials are now
 * written only by TokenRuntime (under the refresh lock); sync writes models.
 */
describe("model sync never overwrites a concurrently rotated credential", () => {
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "sync-race-"));
    const dirs = { cacheDir: join(root, "cache"), stateDir: join(root, "state") };
    const store = new ServerStateStore(dirs.cacheDir, dirs.stateDir);
    await store.ensureReady();
    await seedServerState(store, {
      serverId: SERVER_ID,
      updatedAt: Date.now() - 10_000,
      token: chain(1),
      models: [],
      rawModels: []
    });
    const peer = new ServerCredentialStore(dirs.stateDir);
    const tokenEndpointCalls: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/models")) {
        // Another process (lightbridge / a second oauth2) rotates mid-sync.
        await peer.save(SERVER_ID, chain(2), Date.now());
        return new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      tokenEndpointCalls.push(url);
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const engine = new ProviderModelSyncEngine(
      { servers: [createServerConfig()] },
      { ...dirs, logger: createSilentLogger(), fetchImpl }
    );
    await engine.initialize();
    return { dirs, engine, tokenEndpointCalls };
  }

  it("the credential file still holds the rotated refresh token after the sync", async () => {
    const { dirs, engine } = await setup();
    await engine.syncServer(SERVER_ID, { interactive: false });

    const onDisk = JSON.parse(await readFile(join(dirs.stateDir, `${SERVER_ID}.json`), "utf8"));
    expect(onDisk.token.refreshToken).toBe("R2");
    expect(onDisk.token.accessToken).toBe("A2");
  });

  it("the engine's own next read adopts the rotated token (memory is not left ahead of the file)", async () => {
    const { engine, tokenEndpointCalls } = await setup();
    await engine.syncServer(SERVER_ID, { interactive: false });

    const token = await engine.ensureAccessToken(SERVER_ID, { interactive: false });
    expect(token.refreshToken).toBe("R2");
    expect(tokenEndpointCalls).toEqual([]);
  });

  it("the model record is still written by the sync", async () => {
    const { dirs, engine } = await setup();
    await engine.syncServer(SERVER_ID, { interactive: false });
    expect(await readFile(join(dirs.cacheDir, `${SERVER_ID}.models.json`), "utf8")).toContain("m1");
  });
});

describe("a refresh token the IdP rejected is cleared from the credential file", () => {
  it("clears it after a 400 and does not replay it on the next call", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-dead-"));
    const dirs = { cacheDir: join(root, "cache"), stateDir: join(root, "state") };
    const store = new ServerStateStore(dirs.cacheDir, dirs.stateDir);
    await store.ensureReady();
    await seedServerState(store, {
      serverId: SERVER_ID,
      updatedAt: Date.now() - 10_000,
      token: { ...chain(1), expiresAt: Date.now() - 60_000 },
      models: [],
      rawModels: []
    });
    let refreshPosts = 0;
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (String(input).includes("/oauth/token") && body.get("grant_type") === "refresh_token") {
        refreshPosts += 1;
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      throw new Error(`unexpected ${String(input)}`);
    }) as unknown as typeof fetch;
    const engine = new ProviderModelSyncEngine(
      { servers: [createServerConfig()] },
      { ...dirs, logger: createSilentLogger(), fetchImpl }
    );
    await engine.initialize();

    await engine.ensureAccessToken(SERVER_ID, { interactive: false }).catch(() => undefined);
    expect(refreshPosts).toBe(1);
    expect(await new ServerCredentialStore(dirs.stateDir).load(SERVER_ID)).toBeUndefined();

    await engine.ensureAccessToken(SERVER_ID, { interactive: false }).catch(() => undefined);
    expect(refreshPosts).toBe(1);
  });
});
