import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { FileCacheStore as LegacyFileCacheStore } from "@vymalo/opencode-auth-core/lib";
import { FileCacheStore as SharedFileCacheStore } from "@vymalo/opencode-provider-sync/lib";

import { migrateRootTokenIfNeeded } from "../src/migration.js";
import { ROOT_CACHE_NAMESPACE, ROOT_CACHE_SEGMENT } from "../src/plugin.js";
import { createSilentLogger } from "./helpers.js";

const OLD_NAMESPACE = "opencode-lightbridge";
const SERVER_ID = "lightbridge";

async function tempRoot(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `lightbridge-migration-${name}-`));
}

function sharedStore(cacheRoot: string): SharedFileCacheStore {
  return new SharedFileCacheStore(join(cacheRoot, ROOT_CACHE_SEGMENT, ROOT_CACHE_NAMESPACE));
}

describe("migrateRootTokenIfNeeded", () => {
  it("adopts a valid legacy token into the shared location", async () => {
    const cacheRoot = await tempRoot("adopt");
    const legacy = new LegacyFileCacheStore(join(cacheRoot, OLD_NAMESPACE));
    await legacy.save(SERVER_ID, {
      accessToken: "legacy-token",
      tokenType: "Bearer",
      refreshToken: "legacy-refresh",
      expiresAt: Date.now() + 3600_000
    });

    await migrateRootTokenIfNeeded(
      cacheRoot,
      ROOT_CACHE_SEGMENT,
      ROOT_CACHE_NAMESPACE,
      SERVER_ID,
      createSilentLogger()
    );

    const migrated = await sharedStore(cacheRoot).loadServerState(SERVER_ID);
    expect(migrated?.token?.accessToken).toBe("legacy-token");
    expect(migrated?.models).toEqual([]);
    expect(migrated?.serverId).toBe(SERVER_ID);
  });

  it("adopts an EXPIRED legacy token too (still refreshable — better than forcing a re-login)", async () => {
    const cacheRoot = await tempRoot("expired");
    const legacy = new LegacyFileCacheStore(join(cacheRoot, OLD_NAMESPACE));
    await legacy.save(SERVER_ID, {
      accessToken: "expired-legacy",
      tokenType: "Bearer",
      refreshToken: "legacy-refresh",
      expiresAt: Date.now() - 1000
    });

    await migrateRootTokenIfNeeded(
      cacheRoot,
      ROOT_CACHE_SEGMENT,
      ROOT_CACHE_NAMESPACE,
      SERVER_ID,
      createSilentLogger()
    );

    const migrated = await sharedStore(cacheRoot).loadServerState(SERVER_ID);
    expect(migrated?.token?.refreshToken).toBe("legacy-refresh");
  });

  it("is a no-op when there is no legacy file", async () => {
    const cacheRoot = await tempRoot("missing");
    await migrateRootTokenIfNeeded(
      cacheRoot,
      ROOT_CACHE_SEGMENT,
      ROOT_CACHE_NAMESPACE,
      SERVER_ID,
      createSilentLogger()
    );
    const migrated = await sharedStore(cacheRoot).loadServerState(SERVER_ID);
    expect(migrated).toBeUndefined();
  });

  it("is a no-op when the legacy file is malformed (missing accessToken/tokenType)", async () => {
    const cacheRoot = await tempRoot("malformed");
    await mkdir(join(cacheRoot, OLD_NAMESPACE), { recursive: true });
    await writeFile(
      join(cacheRoot, OLD_NAMESPACE, `${SERVER_ID}.json`),
      JSON.stringify({ foo: "bar" }),
      "utf8"
    );

    await migrateRootTokenIfNeeded(
      cacheRoot,
      ROOT_CACHE_SEGMENT,
      ROOT_CACHE_NAMESPACE,
      SERVER_ID,
      createSilentLogger()
    );
    const migrated = await sharedStore(cacheRoot).loadServerState(SERVER_ID);
    expect(migrated).toBeUndefined();
  });

  it("never overwrites an already-populated new-location state", async () => {
    const cacheRoot = await tempRoot("already-there");
    const legacy = new LegacyFileCacheStore(join(cacheRoot, OLD_NAMESPACE));
    await legacy.save(SERVER_ID, {
      accessToken: "legacy-should-be-ignored",
      tokenType: "Bearer"
    });
    const shared = sharedStore(cacheRoot);
    await shared.ensureReady();
    await shared.saveServerState({
      serverId: SERVER_ID,
      updatedAt: Date.now(),
      models: [{ id: "glm-9", displayName: "GLM 9" }],
      rawModels: [{ id: "glm-9" }],
      token: { accessToken: "current", tokenType: "Bearer" }
    });

    await migrateRootTokenIfNeeded(
      cacheRoot,
      ROOT_CACHE_SEGMENT,
      ROOT_CACHE_NAMESPACE,
      SERVER_ID,
      createSilentLogger()
    );

    const state = await shared.loadServerState(SERVER_ID);
    expect(state?.token?.accessToken).toBe("current");
    expect(state?.models).toEqual([{ id: "glm-9", displayName: "GLM 9" }]);
  });

  it("leaves the old file in place (non-destructive)", async () => {
    const cacheRoot = await tempRoot("non-destructive");
    const legacy = new LegacyFileCacheStore(join(cacheRoot, OLD_NAMESPACE));
    await legacy.save(SERVER_ID, { accessToken: "legacy-token", tokenType: "Bearer" });

    await migrateRootTokenIfNeeded(
      cacheRoot,
      ROOT_CACHE_SEGMENT,
      ROOT_CACHE_NAMESPACE,
      SERVER_ID,
      createSilentLogger()
    );

    const stillThere = await legacy.load<{ accessToken: string }>(SERVER_ID);
    expect(stillThere?.accessToken).toBe("legacy-token");
  });
});
