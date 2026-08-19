import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { FileCacheStore, hashCacheKey, type TokenSet } from "@vymalo/opencode-auth-core/lib";

import { HUMAN_IDENTITY, RepoAuthPlugin } from "../src/plugin.js";
import { createRepoAuthConfig, createSilentLogger, makeJsonResponse } from "./helpers.js";

function parseFormBody(init?: RequestInit): URLSearchParams {
  const body = init?.body;
  if (body instanceof URLSearchParams) {
    return body;
  }
  return new URLSearchParams(String(body ?? ""));
}

function makeProjectToken(accessToken: string, expiresIn = 300): TokenSet {
  return {
    accessToken,
    tokenType: "Bearer",
    expiresAt: Date.now() + expiresIn * 1000
  };
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
  await new FileCacheStore(cacheDir).save(HUMAN_IDENTITY, token);
}

async function seedProject(cacheDir: string, token: TokenSet, projectId: string): Promise<void> {
  await new FileCacheStore(cacheDir).save(
    `${HUMAN_IDENTITY}-${hashCacheKey(`${HUMAN_IDENTITY}:${projectId}`)}`,
    token
  );
}

describe("RepoAuthPlugin", () => {
  it("returns the cached project token without any network call when usable", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "repo-auth-hit-"));
    const config = createRepoAuthConfig();
    await seedHuman(cacheDir, makeHumanToken("human-token"));
    await seedProject(cacheDir, makeProjectToken("cached-project-token"), config.projectId);

    const plugin = new RepoAuthPlugin(config, {
      logger: createSilentLogger(),
      cacheDir,
      fetchImpl: async () => {
        throw new Error("fetch should not be called for a valid cached token");
      }
    });

    const token = await plugin.resolveProjectToken();
    expect(token.accessToken).toBe("cached-project-token");
  });

  it("re-exchanges when the cached project token is expired (model b), without an audience param", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "repo-auth-exch-"));
    const config = createRepoAuthConfig();
    await seedHuman(cacheDir, makeHumanToken("human-token"));
    await seedProject(
      cacheDir,
      { accessToken: "stale", tokenType: "Bearer", expiresAt: Date.now() - 1000 },
      config.projectId
    );

    let captured: URLSearchParams | undefined;
    const plugin = new RepoAuthPlugin(config, {
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

    const token = await plugin.resolveProjectToken();
    expect(token.accessToken).toBe("fresh-project-token");
    expect(captured?.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(captured?.get("subject_token")).toBe("human-token");
    expect(captured?.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:jwt");
    expect(captured?.get("project_id")).toBe(config.projectId);
    expect(captured?.has("audience")).toBe(false);
  });

  it("treats an undefined project-token expiry as expired (machine-flow policy)", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "repo-auth-noexp-"));
    const config = createRepoAuthConfig();
    await seedHuman(cacheDir, makeHumanToken("human-token"));
    await seedProject(
      cacheDir,
      { accessToken: "no-expiry", tokenType: "Bearer" },
      config.projectId
    );

    let called = 0;
    const plugin = new RepoAuthPlugin(config, {
      logger: createSilentLogger(),
      cacheDir,
      fetchImpl: async (_input, init) => {
        called += 1;
        expect(parseFormBody(init).get("grant_type")).toBe(
          "urn:ietf:params:oauth:grant-type:token-exchange"
        );
        return makeJsonResponse({
          access_token: "re-exchanged",
          token_type: "Bearer",
          expires_in: 300
        });
      }
    });

    const token = await plugin.resolveProjectToken();
    expect(token.accessToken).toBe("re-exchanged");
    expect(called).toBe(1);
  });

  it("refreshes the human root then re-exchanges (model-b automatic renewal)", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "repo-auth-refresh-"));
    const config = createRepoAuthConfig();
    await seedHuman(cacheDir, {
      accessToken: "old-human",
      tokenType: "Bearer",
      refreshToken: "human-refresh",
      expiresAt: Date.now() - 1000
    });

    const grantTypes: string[] = [];
    const plugin = new RepoAuthPlugin(config, {
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

    const token = await plugin.resolveProjectToken();
    expect(token.accessToken).toBe("project-after-refresh");
    expect(grantTypes).toEqual([
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:token-exchange"
    ]);
  });

  it("persists the exchanged token so a second instance reads it from disk", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "repo-auth-persist-"));
    const config = createRepoAuthConfig();
    await seedHuman(cacheDir, makeHumanToken("human-token"));

    const plugin = new RepoAuthPlugin(config, {
      logger: createSilentLogger(),
      cacheDir,
      fetchImpl: async () =>
        makeJsonResponse({ access_token: "exchanged-once", token_type: "Bearer", expires_in: 300 })
    });
    expect((await plugin.resolveProjectToken()).accessToken).toBe("exchanged-once");

    // A fresh plugin over the same cacheDir reuses the exchanged token offline.
    const second = new RepoAuthPlugin(config, {
      logger: createSilentLogger(),
      cacheDir,
      fetchImpl: async () => {
        throw new Error("fetch should not be called");
      }
    });
    expect((await second.resolveProjectToken()).accessToken).toBe("exchanged-once");
  });

  it("fails closed on a failed exchange (non-member / resolver error)", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "repo-auth-fail-"));
    const config = createRepoAuthConfig();
    await seedHuman(cacheDir, makeHumanToken("human-token"));

    const plugin = new RepoAuthPlugin(config, {
      logger: createSilentLogger(),
      cacheDir,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 404 })
    });

    await expect(plugin.resolveProjectToken()).rejects.toThrow();
  });

  it("deduplicates concurrent exchanges when the cached project token is unusable", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "repo-auth-dedup-"));
    const config = createRepoAuthConfig();
    await seedHuman(cacheDir, makeHumanToken("human-token"));

    let exchanges = 0;
    const plugin = new RepoAuthPlugin(config, {
      logger: createSilentLogger(),
      cacheDir,
      fetchImpl: async () => {
        exchanges += 1;
        return makeJsonResponse({ access_token: "deduped", token_type: "Bearer", expires_in: 300 });
      }
    });

    const [a, b] = await Promise.all([plugin.resolveProjectToken(), plugin.resolveProjectToken()]);
    expect(a.accessToken).toBe("deduped");
    expect(b.accessToken).toBe("deduped");
    expect(exchanges).toBe(1);
  });

  it("reset clears the human root and the exchanged project token from disk", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "repo-auth-reset-"));
    const config = createRepoAuthConfig();
    await seedHuman(cacheDir, makeHumanToken("human-token"));
    await seedProject(cacheDir, makeProjectToken("project-token"), config.projectId);

    const plugin = new RepoAuthPlugin(config, {
      logger: createSilentLogger(),
      cacheDir,
      fetchImpl: async () => {
        throw new Error("unused");
      }
    });
    await plugin.reset();

    await expect(readFile(join(cacheDir, `${HUMAN_IDENTITY}.json`))).rejects.toThrow();
    await expect(
      readFile(
        join(
          cacheDir,
          `${HUMAN_IDENTITY}-${hashCacheKey(`${HUMAN_IDENTITY}:${config.projectId}`)}.json`
        )
      )
    ).rejects.toThrow();
  });
});
