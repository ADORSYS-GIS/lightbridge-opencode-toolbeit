import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  FileCacheStore as LegacyFileCacheStore,
  hashCacheKey,
  validateAuthConfig,
  type TokenSet
} from "@vymalo/opencode-auth-core/lib";
import {
  FileCacheStore as SharedFileCacheStore,
  type CachedServerState
} from "@vymalo/opencode-provider-sync/lib";

import {
  DEFAULT_CACHE_NAMESPACE,
  LIGHTBRIDGE_IDENTITY,
  LightbridgeRuntime,
  lightbridgeCacheDir,
  rootCacheDir
} from "../src/plugin.js";
import { createSilentLogger, makeAuth, makeJsonResponse } from "./helpers.js";

const PROJECT_ID = "proj-123";
const auth = validateAuthConfig(makeAuth());
const SERVER_ID = auth.id; // "lightbridge" per the fixture — the shared cache identity.

function parseFormBody(init?: RequestInit): URLSearchParams {
  const body = init?.body;
  if (body instanceof URLSearchParams) {
    return body;
  }
  return new URLSearchParams(String(body ?? ""));
}

function makeProjectToken(accessToken: string, expiresIn = 300): TokenSet {
  return { accessToken, tokenType: "Bearer", expiresAt: Date.now() + expiresIn * 1000 };
}

function makeHumanToken(accessToken: string, expiresIn = 3600): TokenSet {
  return {
    accessToken,
    tokenType: "Bearer",
    refreshToken: "human-refresh",
    expiresAt: Date.now() + expiresIn * 1000
  };
}

/** Seeds the SHARED root-token cache file (ADR-0017) — the same file
 * `@vymalo/opencode-oauth2` writes for a server of this id. */
async function seedHuman(
  cacheRoot: string,
  token: TokenSet,
  extra: Partial<CachedServerState> = {}
): Promise<void> {
  const store = new SharedFileCacheStore(rootCacheDir(cacheRoot));
  await store.ensureReady();
  await store.saveServerState({
    serverId: SERVER_ID,
    updatedAt: Date.now(),
    models: [],
    rawModels: [],
    token,
    ...extra
  });
}

async function readSharedState(cacheRoot: string): Promise<CachedServerState | undefined> {
  const store = new SharedFileCacheStore(rootCacheDir(cacheRoot));
  return store.loadServerState(SERVER_ID);
}

/** Seeds the lightbridge-EXCLUSIVE exchanged-token store (unchanged by ADR-0017). */
async function seedProject(cacheRoot: string, token: TokenSet, projectId: string): Promise<void> {
  await new LegacyFileCacheStore(lightbridgeCacheDir(cacheRoot)).save(
    `${LIGHTBRIDGE_IDENTITY}-${hashCacheKey(`${LIGHTBRIDGE_IDENTITY}:${projectId}`)}`,
    token
  );
}

describe("LightbridgeRuntime — exchange: false (default, ADR-0017)", () => {
  it("uses the IdP access token directly as the bearer, no exchange call", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-noexchange-"));
    await seedHuman(cacheRoot, makeHumanToken("human-token"));

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir: cacheRoot,
      fetchImpl: async () => {
        throw new Error("no network call expected");
      }
    });

    const token = await runtime.getProjectToken();
    expect(token.accessToken).toBe("human-token");
  });

  it("refreshes the IdP token transparently and persists it back to the shared file", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-noexchange-refresh-"));
    await seedHuman(cacheRoot, {
      accessToken: "old-human",
      tokenType: "Bearer",
      refreshToken: "human-refresh",
      expiresAt: Date.now() - 1000
    });

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir: cacheRoot,
      fetchImpl: async (_input, init) => {
        const body = parseFormBody(init);
        expect(body.get("grant_type")).toBe("refresh_token");
        return makeJsonResponse({
          access_token: "refreshed-human",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "new-human-refresh"
        });
      }
    });

    const token = await runtime.getProjectToken();
    expect(token.accessToken).toBe("refreshed-human");

    const persisted = await readSharedState(cacheRoot);
    expect(persisted?.token?.accessToken).toBe("refreshed-human");
  });

  it("preserves models already discovered by a colocated oauth2/register engine on refresh", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-preserve-models-"));
    await seedHuman(
      cacheRoot,
      { accessToken: "old", tokenType: "Bearer", refreshToken: "r1", expiresAt: Date.now() - 1000 },
      { models: [{ id: "glm-5", displayName: "GLM 5" }], rawModels: [{ id: "glm-5" }] }
    );

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir: cacheRoot,
      fetchImpl: async () =>
        makeJsonResponse({ access_token: "new", token_type: "Bearer", expires_in: 3600 })
    });

    await runtime.getProjectToken();

    const persisted = await readSharedState(cacheRoot);
    expect(persisted?.models).toEqual([{ id: "glm-5", displayName: "GLM 5" }]);
    expect(persisted?.token?.accessToken).toBe("new");
  });

  it("migrates a pre-ADR-0017 root token with NO re-login (mandatory migration test)", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-migrate-"));
    // Old-format file: bare TokenSet at <root>/opencode-lightbridge/lightbridge.json.
    await mkdir(lightbridgeCacheDir(cacheRoot), { recursive: true });
    await writeFile(
      join(lightbridgeCacheDir(cacheRoot), `${LIGHTBRIDGE_IDENTITY}.json`),
      JSON.stringify(makeHumanToken("legacy-human-token")),
      "utf8"
    );

    let loginAttempted = false;
    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir: cacheRoot,
      onAuthorizationUrl: () => {
        loginAttempted = true;
      },
      fetchImpl: async () => {
        loginAttempted = true;
        throw new Error("no login/refresh network call expected — token is still valid");
      }
    });

    const token = await runtime.getProjectToken();
    expect(token.accessToken).toBe("legacy-human-token");
    expect(loginAttempted).toBe(false);

    // Adopted into the NEW shared location.
    const migrated = await readSharedState(cacheRoot);
    expect(migrated?.token?.accessToken).toBe("legacy-human-token");

    // Old file left in place (non-destructive).
    const legacy = JSON.parse(
      await readFile(join(lightbridgeCacheDir(cacheRoot), `${LIGHTBRIDGE_IDENTITY}.json`), "utf8")
    );
    expect(legacy.accessToken).toBe("legacy-human-token");
  });

  it("does not overwrite an already-populated shared state from the legacy file", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-migrate-noop-"));
    await mkdir(lightbridgeCacheDir(cacheRoot), { recursive: true });
    await writeFile(
      join(lightbridgeCacheDir(cacheRoot), `${LIGHTBRIDGE_IDENTITY}.json`),
      JSON.stringify(makeHumanToken("legacy-should-be-ignored")),
      "utf8"
    );
    await seedHuman(cacheRoot, makeHumanToken("already-current"), {
      models: [{ id: "glm-9", displayName: "GLM 9" }]
    });

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir: cacheRoot,
      fetchImpl: async () => {
        throw new Error("no network call expected");
      }
    });

    const token = await runtime.getProjectToken();
    expect(token.accessToken).toBe("already-current");
    const state = await readSharedState(cacheRoot);
    expect(state?.models).toEqual([{ id: "glm-9", displayName: "GLM 9" }]);
  });

  it("no-ops the migration when there is no legacy file at all", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-no-legacy-"));
    // A machine flow (client_credentials) so this test exercises a normal
    // "nothing cached, nothing to migrate" login without needing to fake the
    // interactive device-code polling loop.
    const machineAuth = validateAuthConfig(
      makeAuth({ authFlow: "client_credentials", clientSecret: "s3cr3t" })
    );
    const runtime = new LightbridgeRuntime(machineAuth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir: cacheRoot,
      fetchImpl: async () =>
        makeJsonResponse({ access_token: "fresh-login", token_type: "Bearer", expires_in: 3600 })
    });

    const token = await runtime.getProjectToken();
    expect(token.accessToken).toBe("fresh-login");
  });
});

describe("LightbridgeRuntime — exchange: true (ADR-0012, unchanged)", () => {
  it("returns the cached project token without a network call when usable", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-hit-"));
    await seedHuman(cacheRoot, makeHumanToken("human-token"));
    await seedProject(cacheRoot, makeProjectToken("cached-project-token"), PROJECT_ID);

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir: cacheRoot,
      exchange: true,
      fetchImpl: async () => {
        throw new Error("fetch should not be called for a valid cached token");
      }
    });

    const token = await runtime.getProjectToken();
    expect(token.accessToken).toBe("cached-project-token");
  });

  it("re-exchanges when the cached project token is expired, presenting project_id only", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-exch-"));
    await seedHuman(cacheRoot, makeHumanToken("human-token"));
    await seedProject(
      cacheRoot,
      { accessToken: "stale", tokenType: "Bearer", expiresAt: Date.now() - 1000 },
      PROJECT_ID
    );

    let captured: URLSearchParams | undefined;
    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir: cacheRoot,
      exchange: true,
      fetchImpl: async (_input, init) => {
        captured = parseFormBody(init);
        return makeJsonResponse({
          access_token: "fresh-project-token",
          token_type: "Bearer",
          expires_in: 300
        });
      }
    });

    const token = await runtime.getProjectToken();
    expect(token.accessToken).toBe("fresh-project-token");
    expect(captured?.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(captured?.get("subject_token")).toBe("human-token");
    expect(captured?.get("project_id")).toBe(PROJECT_ID);
    expect(captured?.has("audience")).toBe(false);
  });

  it("exchanges with NO project_id when constructed without a projectId (default project)", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-exch-default-"));
    await seedHuman(cacheRoot, makeHumanToken("human-token"));

    let captured: URLSearchParams | undefined;
    const runtime = new LightbridgeRuntime(auth, undefined, {
      logger: createSilentLogger(),
      cacheDir: cacheRoot,
      exchange: true,
      fetchImpl: async (_input, init) => {
        captured = parseFormBody(init);
        return makeJsonResponse({
          access_token: "default-project-token",
          token_type: "Bearer",
          expires_in: 300
        });
      }
    });

    const token = await runtime.getProjectToken();
    expect(token.accessToken).toBe("default-project-token");
    expect(captured?.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(captured?.get("subject_token")).toBe("human-token");
    // The whole point: no project_id is sent, so the backend mints for the
    // caller's default project (ADR-0012).
    expect(captured?.has("project_id")).toBe(false);
    expect(captured?.has("audience")).toBe(false);
  });

  it("treats an undefined project-token expiry as expired", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-noexp-"));
    await seedHuman(cacheRoot, makeHumanToken("human-token"));
    await seedProject(cacheRoot, { accessToken: "no-expiry", tokenType: "Bearer" }, PROJECT_ID);

    let called = 0;
    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir: cacheRoot,
      exchange: true,
      fetchImpl: async () => {
        called += 1;
        return makeJsonResponse({
          access_token: "re-exchanged",
          token_type: "Bearer",
          expires_in: 300
        });
      }
    });

    const token = await runtime.getProjectToken();
    expect(token.accessToken).toBe("re-exchanged");
    expect(called).toBe(1);
  });

  it("refreshes the human root then re-exchanges automatically", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-refresh-"));
    await seedHuman(cacheRoot, {
      accessToken: "old-human",
      tokenType: "Bearer",
      refreshToken: "human-refresh",
      expiresAt: Date.now() - 1000
    });

    const grantTypes: string[] = [];
    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir: cacheRoot,
      exchange: true,
      fetchImpl: async (_input, init) => {
        const body = parseFormBody(init);
        grantTypes.push(body.get("grant_type") ?? "");
        if (body.get("grant_type") === "refresh_token") {
          return makeJsonResponse({
            access_token: "refreshed-human",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "new-human-refresh"
          });
        }
        return makeJsonResponse({
          access_token: "project-after-refresh",
          token_type: "Bearer",
          expires_in: 300
        });
      }
    });

    const token = await runtime.getProjectToken();
    expect(token.accessToken).toBe("project-after-refresh");
    expect(grantTypes).toEqual([
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:token-exchange"
    ]);
  });

  it("persists the exchanged token so a second instance reads it from disk", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-persist-"));
    await seedHuman(cacheRoot, makeHumanToken("human-token"));

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir: cacheRoot,
      exchange: true,
      fetchImpl: async () =>
        makeJsonResponse({ access_token: "exchanged-once", token_type: "Bearer", expires_in: 300 })
    });
    expect((await runtime.getProjectToken()).accessToken).toBe("exchanged-once");

    const second = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir: cacheRoot,
      exchange: true,
      fetchImpl: async () => {
        throw new Error("fetch should not be called");
      }
    });
    expect((await second.getProjectToken()).accessToken).toBe("exchanged-once");
  });

  it("fails closed (rejects) on a failed exchange", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-fail-"));
    await seedHuman(cacheRoot, makeHumanToken("human-token"));

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir: cacheRoot,
      exchange: true,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 404 })
    });

    await expect(runtime.getProjectToken()).rejects.toThrow();
  });

  it("deduplicates concurrent exchanges when the cached project token is unusable", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-dedup-"));
    await seedHuman(cacheRoot, makeHumanToken("human-token"));

    let exchanges = 0;
    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir: cacheRoot,
      exchange: true,
      fetchImpl: async () => {
        exchanges += 1;
        return makeJsonResponse({ access_token: "deduped", token_type: "Bearer", expires_in: 300 });
      }
    });

    const [a, b] = await Promise.all([runtime.getProjectToken(), runtime.getProjectToken()]);
    expect(a.accessToken).toBe("deduped");
    expect(b.accessToken).toBe("deduped");
    expect(exchanges).toBe(1);
  });

  it("reset clears the exchanged token AND the shared root token's `token` field, preserving models", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-reset-"));
    await seedHuman(cacheRoot, makeHumanToken("human-token"), {
      models: [{ id: "glm-5", displayName: "GLM 5" }]
    });
    await seedProject(cacheRoot, makeProjectToken("project-token"), PROJECT_ID);

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir: cacheRoot,
      exchange: true,
      fetchImpl: async () => {
        throw new Error("unused");
      }
    });
    await runtime.reset();

    await expect(
      readFile(
        join(
          lightbridgeCacheDir(cacheRoot),
          `${LIGHTBRIDGE_IDENTITY}-${hashCacheKey(`${LIGHTBRIDGE_IDENTITY}:${PROJECT_ID}`)}.json`
        )
      )
    ).rejects.toThrow();

    const state = await readSharedState(cacheRoot);
    expect(state?.token).toBeUndefined();
    expect(state?.models).toEqual([{ id: "glm-5", displayName: "GLM 5" }]);
  });
});

describe("lightbridgeCacheDir / rootCacheDir", () => {
  it("joins the cache root with the plugin's exclusive namespace", () => {
    expect(lightbridgeCacheDir("/home/alice/.cache")).toBe(
      join("/home/alice/.cache", DEFAULT_CACHE_NAMESPACE)
    );
  });

  it("joins the cache root with the SHARED (oauth2) segment + namespace", () => {
    expect(rootCacheDir("/home/alice/.cache")).toBe(
      join("/home/alice/.cache", "opencode-oauth2", "opencode-oauth2-model-sync")
    );
  });
});
