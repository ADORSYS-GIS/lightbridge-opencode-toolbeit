import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  FileCacheStore,
  hashCacheKey,
  validateAuthConfig,
  type TokenSet
} from "@vymalo/opencode-auth-core/lib";

import { LIGHTBRIDGE_IDENTITY, LightbridgeRuntime, lightbridgeCacheDir } from "../src/plugin.js";
import { createSilentLogger, makeAuth, makeJsonResponse } from "./helpers.js";

const PROJECT_ID = "proj-123";
const auth = validateAuthConfig(makeAuth());

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

async function seedHuman(cacheDir: string, token: TokenSet): Promise<void> {
  await new FileCacheStore(cacheDir).save(LIGHTBRIDGE_IDENTITY, token);
}

async function seedProject(cacheDir: string, token: TokenSet, projectId: string): Promise<void> {
  await new FileCacheStore(cacheDir).save(
    `${LIGHTBRIDGE_IDENTITY}-${hashCacheKey(`${LIGHTBRIDGE_IDENTITY}:${projectId}`)}`,
    token
  );
}

describe("LightbridgeRuntime", () => {
  it("returns the cached project token without a network call when usable", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "lightbridge-hit-"));
    await seedHuman(cacheDir, makeHumanToken("human-token"));
    await seedProject(cacheDir, makeProjectToken("cached-project-token"), PROJECT_ID);

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir,
      fetchImpl: async () => {
        throw new Error("fetch should not be called for a valid cached token");
      }
    });

    const token = await runtime.getProjectToken();
    expect(token.accessToken).toBe("cached-project-token");
  });

  it("re-exchanges when the cached project token is expired, presenting project_id only", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "lightbridge-exch-"));
    await seedHuman(cacheDir, makeHumanToken("human-token"));
    await seedProject(
      cacheDir,
      { accessToken: "stale", tokenType: "Bearer", expiresAt: Date.now() - 1000 },
      PROJECT_ID
    );

    let captured: URLSearchParams | undefined;
    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir,
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
    const cacheDir = await mkdtemp(join(tmpdir(), "lightbridge-exch-default-"));
    await seedHuman(cacheDir, makeHumanToken("human-token"));

    let captured: URLSearchParams | undefined;
    const runtime = new LightbridgeRuntime(auth, undefined, {
      logger: createSilentLogger(),
      cacheDir,
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
    const cacheDir = await mkdtemp(join(tmpdir(), "lightbridge-noexp-"));
    await seedHuman(cacheDir, makeHumanToken("human-token"));
    await seedProject(cacheDir, { accessToken: "no-expiry", tokenType: "Bearer" }, PROJECT_ID);

    let called = 0;
    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir,
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
    const cacheDir = await mkdtemp(join(tmpdir(), "lightbridge-refresh-"));
    await seedHuman(cacheDir, {
      accessToken: "old-human",
      tokenType: "Bearer",
      refreshToken: "human-refresh",
      expiresAt: Date.now() - 1000
    });

    const grantTypes: string[] = [];
    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir,
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
    const cacheDir = await mkdtemp(join(tmpdir(), "lightbridge-persist-"));
    await seedHuman(cacheDir, makeHumanToken("human-token"));

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir,
      fetchImpl: async () =>
        makeJsonResponse({ access_token: "exchanged-once", token_type: "Bearer", expires_in: 300 })
    });
    expect((await runtime.getProjectToken()).accessToken).toBe("exchanged-once");

    const second = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir,
      fetchImpl: async () => {
        throw new Error("fetch should not be called");
      }
    });
    expect((await second.getProjectToken()).accessToken).toBe("exchanged-once");
  });

  it("fails closed (rejects) on a failed exchange", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "lightbridge-fail-"));
    await seedHuman(cacheDir, makeHumanToken("human-token"));

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 404 })
    });

    await expect(runtime.getProjectToken()).rejects.toThrow();
  });

  it("deduplicates concurrent exchanges when the cached project token is unusable", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "lightbridge-dedup-"));
    await seedHuman(cacheDir, makeHumanToken("human-token"));

    let exchanges = 0;
    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir,
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

  it("reset clears the human root and the exchanged project token from disk", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "lightbridge-reset-"));
    await seedHuman(cacheDir, makeHumanToken("human-token"));
    await seedProject(cacheDir, makeProjectToken("project-token"), PROJECT_ID);

    const runtime = new LightbridgeRuntime(auth, PROJECT_ID, {
      logger: createSilentLogger(),
      cacheDir,
      fetchImpl: async () => {
        throw new Error("unused");
      }
    });
    await runtime.reset();

    await expect(readFile(join(cacheDir, `${LIGHTBRIDGE_IDENTITY}.json`))).rejects.toThrow();
    await expect(
      readFile(
        join(
          cacheDir,
          `${LIGHTBRIDGE_IDENTITY}-${hashCacheKey(`${LIGHTBRIDGE_IDENTITY}:${PROJECT_ID}`)}.json`
        )
      )
    ).rejects.toThrow();
  });
});

describe("lightbridgeCacheDir", () => {
  it("joins the cache root with the plugin's namespace", () => {
    expect(lightbridgeCacheDir("/home/alice/.cache")).toBe(
      join("/home/alice/.cache", "opencode-lightbridge")
    );
  });
});
