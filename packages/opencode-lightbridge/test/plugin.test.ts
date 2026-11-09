import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  FileCacheStore as LegacyFileCacheStore,
  hashCacheKey,
  resolveCacheRoot,
  resolveStateRoot,
  validateAuthConfig,
  type TokenSet
} from "@vymalo/opencode-auth-core/lib";
import {
  ModelCacheStore,
  ServerCredentialStore,
  type StoredCredential
} from "@vymalo/opencode-provider-sync/lib";

import {
  EXCHANGE_STATE_NAMESPACE,
  LIGHTBRIDGE_IDENTITY,
  LightbridgeRuntime,
  lightbridgeStateDir,
  rootCacheDir,
  rootStateDir
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

/** Seeds the SHARED root credential file (ADR-0017, ADR-0022) — the same file
 * `@vymalo/opencode-oauth2` writes for a server of this id, under the STATE root. */
async function seedHuman(stateRoot: string, token: TokenSet): Promise<void> {
  const store = new ServerCredentialStore(rootStateDir(stateRoot));
  await store.ensureReady();
  await store.save(SERVER_ID, token, Date.now());
}

async function readSharedCredential(stateRoot: string): Promise<StoredCredential | undefined> {
  return new ServerCredentialStore(rootStateDir(stateRoot)).load(SERVER_ID);
}

/** Seeds the lightbridge-EXCLUSIVE exchanged-token store (unchanged by ADR-0017). */
async function seedProject(stateRoot: string, token: TokenSet, projectId: string): Promise<void> {
  await new LegacyFileCacheStore(lightbridgeStateDir(stateRoot)).save(
    `${LIGHTBRIDGE_IDENTITY}-${hashCacheKey(`${LIGHTBRIDGE_IDENTITY}:${projectId}`)}`,
    token
  );
}

describe("LightbridgeRuntime — exchange: false (default, ADR-0017)", () => {
  it("uses the IdP access token directly as the bearer, no exchange call", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "lightbridge-noexchange-"));
    await seedHuman(stateRoot, makeHumanToken("human-token"));

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      stateDir: stateRoot,
      fetchImpl: async () => {
        throw new Error("no network call expected");
      }
    });

    const token = await runtime.getProjectToken();
    expect(token.accessToken).toBe("human-token");
  });

  it("refreshes the IdP token transparently and persists it back to the shared file", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "lightbridge-noexchange-refresh-"));
    await seedHuman(stateRoot, {
      accessToken: "old-human",
      tokenType: "Bearer",
      refreshToken: "human-refresh",
      expiresAt: Date.now() - 1000
    });

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      stateDir: stateRoot,
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

    const persisted = await readSharedCredential(stateRoot);
    expect(persisted?.token?.accessToken).toBe("refreshed-human");
  });

  it("never touches the model cache: a colocated engine's models survive a refresh byte-for-byte", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "lightbridge-preserve-models-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-preserve-models-cache-"));
    await seedHuman(stateRoot, {
      accessToken: "old",
      tokenType: "Bearer",
      refreshToken: "r1",
      expiresAt: Date.now() - 1000
    });
    const models = new ModelCacheStore(rootCacheDir(cacheRoot));
    await models.ensureReady();
    await models.save({
      serverId: SERVER_ID,
      updatedAt: 5,
      models: [{ id: "glm-5", displayName: "GLM 5" }],
      rawModels: [{ id: "glm-5" }]
    });
    const before = await readFile(
      join(rootCacheDir(cacheRoot), `${SERVER_ID}.models.json`),
      "utf8"
    );

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      stateDir: stateRoot,
      fetchImpl: async () =>
        makeJsonResponse({ access_token: "new", token_type: "Bearer", expires_in: 3600 })
    });
    await runtime.getProjectToken();

    expect((await readSharedCredential(stateRoot))?.token.accessToken).toBe("new");
    expect(await readFile(join(rootCacheDir(cacheRoot), `${SERVER_ID}.models.json`), "utf8")).toBe(
      before
    );
    // The credential record carries no model data.
    expect(
      await readFile(join(rootStateDir(stateRoot), `${SERVER_ID}.json`), "utf8")
    ).not.toContain("glm-5");
  });

  it("does NOT adopt a pre-ADR-0017 token from the old cache location (migration removed, ADR-0022)", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "lightbridge-nomigrate-"));
    // Old-format file: bare TokenSet at <root>/opencode-lightbridge/lightbridge.json,
    // planted in BOTH roots so no location is left to fall back to.
    const legacy = new LegacyFileCacheStore(lightbridgeStateDir(stateRoot));
    await legacy.save(LIGHTBRIDGE_IDENTITY, makeHumanToken("legacy-human-token"));

    let networkCalls = 0;
    const machineAuth = validateAuthConfig(
      makeAuth({ authFlow: "client_credentials", clientSecret: "s3cr3t" })
    );
    const runtime = new LightbridgeRuntime(machineAuth, PROJECT_ID, {
      logger: createSilentLogger(),
      stateDir: stateRoot,
      fetchImpl: async () => {
        networkCalls += 1;
        return makeJsonResponse({
          access_token: "fresh-login",
          token_type: "Bearer",
          expires_in: 3600
        });
      }
    });

    const token = await runtime.getProjectToken();
    expect(token.accessToken).toBe("fresh-login");
    expect(networkCalls).toBe(1);
    expect((await readSharedCredential(stateRoot))?.token.accessToken).toBe("fresh-login");
  });

  it("never reads the root token from the cache root (no fallback to the old location)", async () => {
    if (resolveStateRoot() === resolveCacheRoot()) {
      return; // Windows: both roots coincide by design.
    }
    const id = "nofallback-gw";
    const machineAuth = validateAuthConfig(
      makeAuth({ id, authFlow: "client_credentials", clientSecret: "s3cr3t" })
    );
    // A pre-ADR-0022 fused record exactly where the old code kept the login: the
    // DEFAULT cache root (the vitest setup file isolated HOME, so it is a throwaway).
    await new LegacyFileCacheStore(rootCacheDir(resolveCacheRoot())).save(id, {
      serverId: id,
      updatedAt: Date.now(),
      models: [],
      rawModels: [],
      token: makeHumanToken("old-cache-token")
    });

    let fetches = 0;
    const runtime = new LightbridgeRuntime(machineAuth, PROJECT_ID, {
      logger: createSilentLogger(),
      fetchImpl: async () => {
        fetches += 1;
        return makeJsonResponse({
          access_token: "fresh-login",
          token_type: "Bearer",
          expires_in: 3600
        });
      }
    });

    // Had the old cache record been honoured, no login (fetch) would be needed.
    expect((await runtime.getProjectToken()).accessToken).toBe("fresh-login");
    expect(fetches).toBe(1);
  });

  it("writes the root token 0o600 under the state root and takes its refresh lock beside it", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "lightbridge-lock-"));
    await seedHuman(stateRoot, {
      accessToken: "old",
      tokenType: "Bearer",
      refreshToken: "r1",
      expiresAt: Date.now() - 1000
    });

    let locksDuringRefresh: string[] = [];
    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      stateDir: stateRoot,
      fetchImpl: async () => {
        locksDuringRefresh = await readdir(join(rootStateDir(stateRoot), "locks"));
        return makeJsonResponse({ access_token: "new", token_type: "Bearer", expires_in: 3600 });
      }
    });
    await runtime.getProjectToken();

    expect(locksDuringRefresh).toEqual([`${SERVER_ID}.lock`]);
    const file = join(rootStateDir(stateRoot), `${SERVER_ID}.json`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(rootStateDir(stateRoot))).mode & 0o777).toBe(0o700);
  });

  it("defaults the root to the OS state root, not the cache root", async () => {
    const machineAuth = validateAuthConfig(
      makeAuth({ authFlow: "client_credentials", clientSecret: "s3cr3t" })
    );
    // No stateDir injected: the vitest setup file isolated HOME so this is a throwaway home.
    const runtime = new LightbridgeRuntime(machineAuth, PROJECT_ID, {
      logger: createSilentLogger(),
      fetchImpl: async () =>
        makeJsonResponse({ access_token: "fresh-login", token_type: "Bearer", expires_in: 3600 })
    });
    await runtime.getProjectToken();

    const state = await new ServerCredentialStore(rootStateDir(resolveStateRoot())).load(SERVER_ID);
    expect(state?.token.accessToken).toBe("fresh-login");
    if (resolveStateRoot() !== resolveCacheRoot()) {
      await expect(
        stat(join(rootCacheDir(resolveCacheRoot()), `${SERVER_ID}.json`))
      ).rejects.toThrow();
    }
  });
});

describe("LightbridgeRuntime — exchange: true (ADR-0012, unchanged)", () => {
  it("returns the cached project token without a network call when usable", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "lightbridge-hit-"));
    await seedHuman(stateRoot, makeHumanToken("human-token"));
    await seedProject(stateRoot, makeProjectToken("cached-project-token"), PROJECT_ID);

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      stateDir: stateRoot,
      exchange: true,
      fetchImpl: async () => {
        throw new Error("fetch should not be called for a valid cached token");
      }
    });

    const token = await runtime.getProjectToken();
    expect(token.accessToken).toBe("cached-project-token");
  });

  it("re-exchanges when the cached project token is expired, presenting project_id only", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "lightbridge-exch-"));
    await seedHuman(stateRoot, makeHumanToken("human-token"));
    await seedProject(
      stateRoot,
      { accessToken: "stale", tokenType: "Bearer", expiresAt: Date.now() - 1000 },
      PROJECT_ID
    );

    let captured: URLSearchParams | undefined;
    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      stateDir: stateRoot,
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
    const stateRoot = await mkdtemp(join(tmpdir(), "lightbridge-exch-default-"));
    await seedHuman(stateRoot, makeHumanToken("human-token"));

    let captured: URLSearchParams | undefined;
    const runtime = new LightbridgeRuntime(auth, undefined, {
      logger: createSilentLogger(),
      stateDir: stateRoot,
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
    const stateRoot = await mkdtemp(join(tmpdir(), "lightbridge-noexp-"));
    await seedHuman(stateRoot, makeHumanToken("human-token"));
    await seedProject(stateRoot, { accessToken: "no-expiry", tokenType: "Bearer" }, PROJECT_ID);

    let called = 0;
    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      stateDir: stateRoot,
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
    const stateRoot = await mkdtemp(join(tmpdir(), "lightbridge-refresh-"));
    await seedHuman(stateRoot, {
      accessToken: "old-human",
      tokenType: "Bearer",
      refreshToken: "human-refresh",
      expiresAt: Date.now() - 1000
    });

    const grantTypes: string[] = [];
    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      stateDir: stateRoot,
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
    const stateRoot = await mkdtemp(join(tmpdir(), "lightbridge-persist-"));
    await seedHuman(stateRoot, makeHumanToken("human-token"));

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      stateDir: stateRoot,
      exchange: true,
      fetchImpl: async () =>
        makeJsonResponse({ access_token: "exchanged-once", token_type: "Bearer", expires_in: 300 })
    });
    expect((await runtime.getProjectToken()).accessToken).toBe("exchanged-once");

    const second = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      stateDir: stateRoot,
      exchange: true,
      fetchImpl: async () => {
        throw new Error("fetch should not be called");
      }
    });
    expect((await second.getProjectToken()).accessToken).toBe("exchanged-once");
  });

  it("fails closed (rejects) on a failed exchange", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "lightbridge-fail-"));
    await seedHuman(stateRoot, makeHumanToken("human-token"));

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      stateDir: stateRoot,
      exchange: true,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 404 })
    });

    await expect(runtime.getProjectToken()).rejects.toThrow();
  });

  it("deduplicates concurrent exchanges when the cached project token is unusable", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "lightbridge-dedup-"));
    await seedHuman(stateRoot, makeHumanToken("human-token"));

    let exchanges = 0;
    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      stateDir: stateRoot,
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

  it("reset clears the exchanged token AND the shared root credential, leaving the model cache alone", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "lightbridge-reset-"));
    await seedHuman(stateRoot, makeHumanToken("human-token"));
    await seedProject(stateRoot, makeProjectToken("project-token"), PROJECT_ID);
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-reset-cache-"));
    const models = new ModelCacheStore(rootCacheDir(cacheRoot));
    await models.save({
      serverId: SERVER_ID,
      updatedAt: 1,
      models: [{ id: "glm-5", displayName: "GLM 5" }],
      rawModels: []
    });

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      stateDir: stateRoot,
      exchange: true,
      fetchImpl: async () => {
        throw new Error("unused");
      }
    });
    await runtime.reset();

    await expect(
      readFile(
        join(
          lightbridgeStateDir(stateRoot),
          `${LIGHTBRIDGE_IDENTITY}-${hashCacheKey(`${LIGHTBRIDGE_IDENTITY}:${PROJECT_ID}`)}.json`
        )
      )
    ).rejects.toThrow();

    expect(await readSharedCredential(stateRoot)).toBeUndefined();
    expect((await models.load(SERVER_ID))?.models).toEqual([{ id: "glm-5", displayName: "GLM 5" }]);
  });
});

describe("lightbridgeStateDir / rootStateDir / rootCacheDir", () => {
  it("joins the state root with the plugin's exclusive namespace", () => {
    expect(lightbridgeStateDir("/home/alice/.local/state")).toBe(
      join("/home/alice/.local/state", EXCHANGE_STATE_NAMESPACE)
    );
  });

  it("joins the state root with the SHARED (oauth2) segment + namespace", () => {
    expect(rootStateDir("/home/alice/.local/state")).toBe(
      join("/home/alice/.local/state", "opencode-oauth2", "opencode-oauth2-model-sync")
    );
  });

  it("keeps the same relative path under the cache root for the disposable model list", () => {
    expect(rootCacheDir("/home/alice/.cache")).toBe(
      join("/home/alice/.cache", "opencode-oauth2", "opencode-oauth2-model-sync")
    );
  });
});
