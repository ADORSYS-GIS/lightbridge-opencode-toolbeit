import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { ModelCacheStore, ServerCredentialStore, ServerStateStore } from "../src/cache.js";
import type { CachedServerState } from "../src/types.js";
import { seedServerState } from "./helpers.js";

interface Dirs {
  cacheDir: string;
  stateDir: string;
}

async function tempDirs(name: string): Promise<Dirs> {
  const root = await mkdtemp(join(tmpdir(), `opencode-cache-${name}-`));
  return { cacheDir: join(root, "cache"), stateDir: join(root, "state") };
}

function sampleState(overrides: Partial<CachedServerState> = {}): CachedServerState {
  return {
    serverId: "example-ai",
    updatedAt: Date.now(),
    lastSyncAt: Date.now(),
    token: { accessToken: "access-token", tokenType: "Bearer", refreshToken: "refresh-token" },
    rawModels: [{ id: "glm-5" }],
    models: [{ id: "glm-5", displayName: "GLM 5" }],
    ...overrides
  };
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("ServerStateStore (ADR-0022: credentials in state, models in cache)", () => {
  it("round-trips cached server state across the two roots", async () => {
    const { cacheDir, stateDir } = await tempDirs("roundtrip");
    const store = new ServerStateStore(cacheDir, stateDir);
    await store.ensureReady();
    await seedServerState(store, sampleState());

    const loaded = await store.loadServerState("example-ai");
    expect(loaded?.token?.refreshToken).toBe("refresh-token");
    expect(loaded?.models.map((model) => model.id)).toEqual(["glm-5"]);
    expect(loaded?.lastSyncAt).toBeTypeOf("number");
  });

  it("writes the token under the state dir and NEVER under the cache dir", async () => {
    const { cacheDir, stateDir } = await tempDirs("split");
    const store = new ServerStateStore(cacheDir, stateDir);
    await store.ensureReady();
    await seedServerState(store, sampleState());

    expect(await readFile(join(stateDir, "example-ai.json"), "utf8")).toContain("refresh-token");

    // Every file in the cache dir is token-free; the model record has no `token` key.
    for (const name of await readdir(cacheDir)) {
      const content = await readFile(join(cacheDir, name), "utf8");
      expect(content).not.toContain("refresh-token");
      expect(content).not.toContain("access-token");
      expect(content).not.toContain('"token"');
    }
    expect(await readdir(cacheDir)).toEqual(["example-ai.models.json"]);
  });

  it("keeps the model list in the cache dir, not the state dir", async () => {
    const { cacheDir, stateDir } = await tempDirs("models");
    const store = new ServerStateStore(cacheDir, stateDir);
    await store.ensureReady();
    await seedServerState(store, sampleState());

    expect(await readFile(join(cacheDir, "example-ai.models.json"), "utf8")).toContain("glm-5");
    expect(await readFile(join(stateDir, "example-ai.json"), "utf8")).not.toContain("glm-5");
  });

  it("creates files 0o600 and directories 0o700 in both roots", async () => {
    const { cacheDir, stateDir } = await tempDirs("modes");
    const store = new ServerStateStore(cacheDir, stateDir);
    await store.ensureReady();
    await seedServerState(store, sampleState());

    expect(await mode(stateDir)).toBe(0o700);
    expect(await mode(cacheDir)).toBe(0o700);
    expect(await mode(join(stateDir, "example-ai.json"))).toBe(0o600);
    expect(await mode(join(cacheDir, "example-ai.models.json"))).toBe(0o600);
  });

  it("keeps cached tokens without refreshToken (client_credentials grant)", async () => {
    const { cacheDir, stateDir } = await tempDirs("no-refresh");
    const store = new ServerStateStore(cacheDir, stateDir);
    await store.ensureReady();
    await seedServerState(
      store,
      sampleState({ token: { accessToken: "access-token", tokenType: "Bearer" } })
    );

    const loaded = await store.loadServerState("example-ai");
    expect(loaded?.token?.accessToken).toBe("access-token");
    expect(loaded?.token?.refreshToken).toBeUndefined();
  });

  it("survives many concurrent saves of the same server (no temp-file race)", async () => {
    const { cacheDir, stateDir } = await tempDirs("concurrent");
    const store = new ServerStateStore(cacheDir, stateDir);
    await store.ensureReady();

    // Mirrors the desktop app restoring several project windows at once: many
    // writers racing the same record. A shared `.tmp` name made one writer's
    // rename ENOENT-fail on the temp file another had already consumed.
    const saves = Array.from({ length: 25 }, (_, i) =>
      seedServerState(
        store,
        sampleState({
          rawModels: [{ id: `glm-${i}` }],
          models: [{ id: `glm-${i}`, displayName: `GLM ${i}` }],
          token: { accessToken: `token-${i}`, tokenType: "Bearer" }
        })
      )
    );
    await expect(Promise.all(saves)).resolves.toBeDefined();

    const loaded = await store.loadServerState("example-ai");
    expect(loaded?.token?.accessToken).toMatch(/^token-\d+$/);

    for (const dir of [cacheDir, stateDir]) {
      expect((await readdir(dir)).filter((name) => name.includes(".tmp"))).toEqual([]);
    }
  });

  it("drops cached tokens with malformed required fields but keeps the models", async () => {
    const { cacheDir, stateDir } = await tempDirs("invalid");
    const store = new ServerStateStore(cacheDir, stateDir);
    await store.ensureReady();
    await seedServerState(store, sampleState());

    const filePath = join(stateDir, "example-ai.json");
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    delete (persisted.token as Record<string, unknown>).accessToken;
    await writeFile(filePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    const loaded = await store.loadServerState("example-ai");
    expect(loaded?.token).toBeUndefined();
    expect(loaded?.models.map((model) => model.id)).toEqual(["glm-5"]);
  });

  it("keeps the credential when the (disposable) cache dir is purged", async () => {
    const { cacheDir, stateDir } = await tempDirs("purged");
    const store = new ServerStateStore(cacheDir, stateDir);
    await store.ensureReady();
    await seedServerState(store, sampleState());

    // What macOS / cleanup tools do to ~/Library/Caches.
    await rm(cacheDir, { recursive: true, force: true });

    const loaded = await store.loadServerState("example-ai");
    expect(loaded?.token?.refreshToken).toBe("refresh-token");
    expect(loaded?.models).toEqual([]);
  });

  it("never reads a credential from the old cache location (no fallback)", async () => {
    const { cacheDir, stateDir } = await tempDirs("no-fallback");
    // A pre-ADR-0022 fused record, exactly where the old code kept the login.
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, "example-ai.json"),
      JSON.stringify(
        sampleState({
          token: { accessToken: "old", tokenType: "Bearer", refreshToken: "old-refresh" }
        })
      ),
      "utf8"
    );

    const store = new ServerStateStore(cacheDir, stateDir);
    expect(await store.loadServerState("example-ai")).toBeUndefined();
    expect(await store.credentials.load("example-ai")).toBeUndefined();
  });

  it("keeps credential and model records apart when both roots are the same directory (Windows)", async () => {
    const { cacheDir } = await tempDirs("same-root");
    const store = new ServerStateStore(cacheDir, cacheDir);
    await store.ensureReady();
    await seedServerState(store, sampleState());

    expect((await readdir(cacheDir)).sort()).toEqual(["example-ai.json", "example-ai.models.json"]);
    const loaded = await store.loadServerState("example-ai");
    expect(loaded?.token?.refreshToken).toBe("refresh-token");
    expect(loaded?.models.map((model) => model.id)).toEqual(["glm-5"]);
  });

  it("a model-path write never deletes or replaces the credential (credentials have one writer)", async () => {
    const { cacheDir, stateDir } = await tempDirs("model-write");
    const store = new ServerStateStore(cacheDir, stateDir);
    await store.ensureReady();
    await seedServerState(store, sampleState());
    const before = await readFile(join(stateDir, "example-ai.json"), "utf8");

    // A model-path write, even from a state with no token or a stale one.
    await store.models.save(sampleState({ token: undefined }));
    await store.models.save(
      sampleState({ token: { accessToken: "stale", tokenType: "Bearer", refreshToken: "R0" } })
    );

    expect(await readFile(join(stateDir, "example-ai.json"), "utf8")).toBe(before);
  });

  it("reports the CREDENTIAL's stamp as updatedAt, not the (newer) model record's", async () => {
    const { cacheDir, stateDir } = await tempDirs("stamp");
    const store = new ServerStateStore(cacheDir, stateDir);
    await store.ensureReady();
    await store.credentials.save("example-ai", { accessToken: "a", tokenType: "Bearer" }, 100);
    await store.models.save(sampleState({ updatedAt: 999_999 }));

    expect((await store.loadServerState("example-ai"))?.updatedAt).toBe(100);
  });

  it("returns undefined when neither record exists", async () => {
    const { cacheDir, stateDir } = await tempDirs("empty");
    const store = new ServerStateStore(cacheDir, stateDir);
    expect(await store.loadServerState("example-ai")).toBeUndefined();
  });
});

describe("single-purpose stores", () => {
  it("ServerCredentialStore rejects a record for another server id", async () => {
    const { stateDir } = await tempDirs("cred-mismatch");
    const store = new ServerCredentialStore(stateDir);
    await store.ensureReady();
    await store.save("a", { accessToken: "t", tokenType: "Bearer" }, 1);
    await writeFile(
      join(stateDir, "b.json"),
      await readFile(join(stateDir, "a.json"), "utf8"),
      "utf8"
    );
    expect(await store.load("b")).toBeUndefined();
    expect((await store.load("a"))?.updatedAt).toBe(1);
  });

  it("ModelCacheStore never persists a token even if the state object carries one", async () => {
    const { cacheDir } = await tempDirs("model-notoken");
    const store = new ModelCacheStore(cacheDir);
    await store.ensureReady();
    await store.save(sampleState());
    const raw = await readFile(join(cacheDir, "example-ai.models.json"), "utf8");
    expect(raw).not.toContain("refresh-token");
  });
});
