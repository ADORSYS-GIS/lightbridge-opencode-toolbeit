import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveCacheRoot, resolveStateRoot } from "@vymalo/opencode-auth-core/lib";
import { describe, expect, it } from "vitest";

import { ServerStateStore, resolveStateDir } from "../src/cache.js";
import { ProviderModelSyncEngine } from "../src/engine.js";
import { createServerConfig, createSilentLogger } from "./helpers.js";

const SERVER_ID = "example-ai";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

/** Fetch double: token endpoint rotates the refresh token, /models lists one model. */
function createFetch(onTokenRequest?: () => Promise<void>): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: unknown }).url);
    if (url.includes("/oauth/token")) {
      await onTokenRequest?.();
      return jsonResponse({
        access_token: "rotated-access",
        token_type: "Bearer",
        refresh_token: "rotated-refresh",
        expires_in: 3600
      });
    }
    if (url.includes("/models")) {
      return jsonResponse({ data: [{ id: "glm-5" }] });
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
}

async function expiredCredentialIn(cacheDir: string, stateDir: string): Promise<void> {
  const store = new ServerStateStore(cacheDir, stateDir);
  await store.ensureReady();
  await store.saveServerState({
    serverId: SERVER_ID,
    updatedAt: Date.now() - 10_000,
    models: [],
    rawModels: [],
    token: {
      accessToken: "expired",
      tokenType: "Bearer",
      refreshToken: "old-refresh",
      expiresAt: Date.now() - 60_000
    }
  });
}

describe("ProviderModelSyncEngine storage roots (ADR-0022)", () => {
  it("takes the refresh lock beside the token in the state dir, not in the cache dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "engine-lock-"));
    const cacheDir = join(root, "cache");
    const stateDir = join(root, "state");
    await expiredCredentialIn(cacheDir, stateDir);

    let locksSeenDuringRefresh: string[] = [];
    const engine = new ProviderModelSyncEngine(
      { servers: [createServerConfig()] },
      {
        cacheDir,
        stateDir,
        logger: createSilentLogger(),
        fetchImpl: createFetch(async () => {
          locksSeenDuringRefresh = await readdir(join(stateDir, "locks"));
        })
      }
    );
    await engine.initialize();
    await engine.syncServer(SERVER_ID);

    expect(locksSeenDuringRefresh).toEqual([`${SERVER_ID}.lock`]);
    await expect(stat(join(cacheDir, "locks"))).rejects.toThrow();
  });

  it("persists the rotated token under the state dir and the models under the cache dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "engine-split-"));
    const cacheDir = join(root, "cache");
    const stateDir = join(root, "state");
    await expiredCredentialIn(cacheDir, stateDir);

    const engine = new ProviderModelSyncEngine(
      { servers: [createServerConfig()] },
      { cacheDir, stateDir, logger: createSilentLogger(), fetchImpl: createFetch() }
    );
    await engine.initialize();
    await engine.syncServer(SERVER_ID);

    const credential = await readFile(join(stateDir, `${SERVER_ID}.json`), "utf8");
    expect(credential).toContain("rotated-refresh");
    expect(credential).not.toContain("glm-5");

    for (const name of await readdir(cacheDir)) {
      const content = await readFile(join(cacheDir, name), "utf8");
      expect(content).not.toContain("rotated-refresh");
      expect(content).not.toContain("rotated-access");
    }
    expect(await readFile(join(cacheDir, `${SERVER_ID}.models.json`), "utf8")).toContain("glm-5");
  });

  it("a token-only rotation does not rewrite the model cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "engine-tokenonly-"));
    const cacheDir = join(root, "cache");
    const stateDir = join(root, "state");
    await expiredCredentialIn(cacheDir, stateDir);

    const engine = new ProviderModelSyncEngine(
      { servers: [createServerConfig()] },
      { cacheDir, stateDir, logger: createSilentLogger(), fetchImpl: createFetch() }
    );
    await engine.initialize();
    await engine.ensureAccessToken(SERVER_ID);

    expect(
      (await readFile(join(stateDir, `${SERVER_ID}.json`), "utf8")).includes("rotated-refresh")
    ).toBe(true);
    expect(await readdir(cacheDir)).toEqual([`${SERVER_ID}.models.json`]);
    expect(await readFile(join(cacheDir, `${SERVER_ID}.models.json`), "utf8")).not.toContain(
      "glm-5"
    );
  });

  it("defaults the credential to the state root and the model list to the cache root", async () => {
    const id = "default-roots";
    // The vitest setup file isolated HOME, so these roots are throwaway directories.
    const stateDir = join(resolveStateRoot(), "seg", "ns");
    const cacheDir = join(resolveCacheRoot(), "seg", "ns");
    expect(resolveStateDir("seg", "ns")).toBe(stateDir);

    await new ServerStateStore(cacheDir, stateDir).saveServerState({
      serverId: id,
      updatedAt: Date.now(),
      models: [],
      rawModels: [],
      token: {
        accessToken: "valid-access",
        tokenType: "Bearer",
        refreshToken: "valid-refresh",
        expiresAt: Date.now() + 3_600_000
      }
    });

    const engine = new ProviderModelSyncEngine(
      { servers: [createServerConfig({ id })], cacheNamespace: "ns" },
      { cacheNamespaceSegment: "seg", logger: createSilentLogger(), fetchImpl: createFetch() }
    );
    await engine.initialize();
    // Found without any injected dir: the default credential location is the state root.
    expect(engine.getCachedToken(id)?.refreshToken).toBe("valid-refresh");

    await engine.syncServer(id);
    expect(await readdir(cacheDir)).toContain(`${id}.models.json`);
    expect(await readFile(join(stateDir, `${id}.json`), "utf8")).toContain("valid-refresh");
    if (resolveCacheRoot() !== resolveStateRoot()) {
      expect(await readdir(cacheDir)).not.toContain(`${id}.json`);
    }
  });
});
