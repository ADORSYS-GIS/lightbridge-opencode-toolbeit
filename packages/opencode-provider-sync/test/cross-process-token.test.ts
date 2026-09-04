import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileCacheStore } from "../src/cache.js";
import { ProviderModelSyncEngine } from "../src/engine.js";
import type { NormalizedModel } from "../src/types.js";
import { createServerConfig, createSilentLogger } from "./helpers.js";

const SERVER_ID = "example-ai";

interface RecordedCall {
  url: string;
  grantType?: string;
}

interface FetchRecorder {
  calls: RecordedCall[];
  refreshCalls(): RecordedCall[];
  impl: typeof fetch;
}

/**
 * A fetch double that records every outbound call (and the `grant_type` of any
 * form-encoded token request) so a test can assert that a cross-process token
 * adoption happened WITHOUT a network round trip. `modelsPayload` lets a test
 * serve model discovery; token-endpoint calls always fail loudly because these
 * tests assert they never happen.
 */
function createFetchRecorder(modelsPayload?: unknown): FetchRecorder {
  const calls: RecordedCall[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: unknown }).url);
    const body = typeof init?.body === "string" ? init.body : undefined;
    const grantType = body ? (new URLSearchParams(body).get("grant_type") ?? undefined) : undefined;
    calls.push({ url, grantType });

    if (modelsPayload !== undefined && url.includes("/models")) {
      return new Response(JSON.stringify(modelsPayload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    throw new Error(`unexpected network call in cross-process test: ${url}`);
  }) as unknown as typeof fetch;

  return {
    calls,
    refreshCalls: () => calls.filter((call) => call.grantType === "refresh_token"),
    impl
  };
}

async function writeStateFile(
  cacheDir: string,
  accessToken: string,
  refreshToken: string,
  updatedAt: number,
  models: NormalizedModel[] = [{ id: "glm-5", displayName: "GLM 5" }]
): Promise<void> {
  const store = new FileCacheStore(cacheDir);
  await store.ensureReady();
  await store.saveServerState({
    serverId: SERVER_ID,
    updatedAt,
    lastSyncAt: updatedAt,
    token: {
      accessToken,
      tokenType: "Bearer",
      refreshToken,
      expiresAt: Date.now() + 3_600_000
    },
    rawModels: models.map((model) => ({ id: model.id })),
    models
  });
}

function createEngine(cacheDir: string, fetchImpl: typeof fetch): ProviderModelSyncEngine {
  return new ProviderModelSyncEngine(
    { servers: [createServerConfig()] },
    { cacheDir, logger: createSilentLogger(), fetchImpl }
  );
}

async function tempCacheDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `opencode-provider-sync-${name}-`));
}

describe("cross-process token state (shared cache file)", () => {
  it("adopts a token another process rotated into the state file, without a refresh call", async () => {
    const cacheDir = await tempCacheDir("adopt");
    await writeStateFile(cacheDir, "process-a-initial", "refresh-1", Date.now() - 10_000);

    const recorder = createFetchRecorder();
    const processB = createEngine(cacheDir, recorder.impl);
    await processB.initialize();
    expect(processB.getCachedToken(SERVER_ID)?.accessToken).toBe("process-a-initial");

    // Process A rotates the refresh chain and persists the result.
    await writeStateFile(cacheDir, "process-a-rotated", "refresh-2", Date.now(), [
      { id: "glm-9", displayName: "GLM 9" }
    ]);

    const token = await processB.ensureAccessToken(SERVER_ID);

    expect(token.accessToken).toBe("process-a-rotated");
    expect(token.refreshToken).toBe("refresh-2");
    expect(processB.getCachedToken(SERVER_ID)?.accessToken).toBe("process-a-rotated");
    expect(recorder.refreshCalls()).toHaveLength(0);
    expect(recorder.calls).toHaveLength(0);
  });

  it("adopts the whole persisted state (models included) when the file is newer", async () => {
    const cacheDir = await tempCacheDir("adopt-models");
    await writeStateFile(cacheDir, "initial", "refresh-1", Date.now() - 10_000);

    const recorder = createFetchRecorder();
    const processB = createEngine(cacheDir, recorder.impl);
    await processB.initialize();
    expect(processB.getServerModels(SERVER_ID).map((model) => model.id)).toEqual(["glm-5"]);

    await writeStateFile(cacheDir, "rotated", "refresh-2", Date.now(), [
      { id: "glm-9", displayName: "GLM 9" }
    ]);

    await processB.ensureAccessToken(SERVER_ID);

    expect(processB.getServerModels(SERVER_ID).map((model) => model.id)).toEqual(["glm-9"]);
  });

  it("falls back to the in-memory token when the state file has been removed", async () => {
    const cacheDir = await tempCacheDir("missing");
    await writeStateFile(cacheDir, "in-memory-token", "refresh-1", Date.now());

    const recorder = createFetchRecorder();
    const processB = createEngine(cacheDir, recorder.impl);
    await processB.initialize();

    await rm(join(cacheDir, `${SERVER_ID}.json`));

    const token = await processB.ensureAccessToken(SERVER_ID);

    expect(token.accessToken).toBe("in-memory-token");
    expect(processB.getCachedToken(SERVER_ID)?.accessToken).toBe("in-memory-token");
    expect(recorder.calls).toHaveLength(0);
  });

  it("falls back to the in-memory token when the state file is corrupt", async () => {
    const cacheDir = await tempCacheDir("corrupt");
    await writeStateFile(cacheDir, "in-memory-token", "refresh-1", Date.now());

    const recorder = createFetchRecorder();
    const processB = createEngine(cacheDir, recorder.impl);
    await processB.initialize();

    await writeFile(join(cacheDir, `${SERVER_ID}.json`), "{ not json", "utf8");

    const token = await processB.ensureAccessToken(SERVER_ID);

    expect(token.accessToken).toBe("in-memory-token");
    expect(recorder.calls).toHaveLength(0);
  });

  it("keeps the in-memory state when the persisted state is older", async () => {
    const cacheDir = await tempCacheDir("older");
    const now = Date.now();
    await writeStateFile(cacheDir, "current-in-memory", "refresh-2", now);

    const recorder = createFetchRecorder();
    const processB = createEngine(cacheDir, recorder.impl);
    await processB.initialize();

    // A straggler writer persists an OLDER snapshot (e.g. a process that had
    // been holding a pre-rotation state). Memory must win.
    await writeStateFile(cacheDir, "stale-from-disk", "refresh-1", now - 60_000);

    const token = await processB.ensureAccessToken(SERVER_ID);

    expect(token.accessToken).toBe("current-in-memory");
    expect(processB.getCachedToken(SERVER_ID)?.accessToken).toBe("current-in-memory");
    expect(recorder.calls).toHaveLength(0);
  });

  it("keeps the in-memory token when the persisted state carries none", async () => {
    const cacheDir = await tempCacheDir("tokenless");
    await writeStateFile(cacheDir, "in-memory-token", "refresh-1", Date.now() - 10_000);

    const recorder = createFetchRecorder();
    const processB = createEngine(cacheDir, recorder.impl);
    await processB.initialize();

    const store = new FileCacheStore(cacheDir);
    await store.saveServerState({
      serverId: SERVER_ID,
      updatedAt: Date.now(),
      models: [],
      rawModels: []
    });

    const token = await processB.ensureAccessToken(SERVER_ID);

    expect(token.accessToken).toBe("in-memory-token");
    expect(recorder.calls).toHaveLength(0);
  });

  it("bases the post-sync state on the re-read state, not the pre-ensure snapshot", async () => {
    const cacheDir = await tempCacheDir("sync");
    await writeStateFile(cacheDir, "process-a-initial", "refresh-1", Date.now() - 10_000);

    const recorder = createFetchRecorder({ data: [{ id: "glm-7" }] });
    const processB = createEngine(cacheDir, recorder.impl);
    await processB.initialize();

    await writeStateFile(cacheDir, "process-a-rotated", "refresh-2", Date.now(), [
      { id: "glm-9", displayName: "GLM 9" }
    ]);

    const snapshot = await processB.syncServer(SERVER_ID);

    expect(snapshot.models.map((model) => model.id)).toEqual(["glm-7"]);
    expect(recorder.refreshCalls()).toHaveLength(0);

    const persisted = await new FileCacheStore(cacheDir).loadServerState(SERVER_ID);
    expect(persisted?.token?.accessToken).toBe("process-a-rotated");
    expect(persisted?.token?.refreshToken).toBe("refresh-2");
    expect(persisted?.models.map((model) => model.id)).toEqual(["glm-7"]);
  });
});
