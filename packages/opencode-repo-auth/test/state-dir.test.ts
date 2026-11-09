import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileCacheStore,
  resolveCacheRoot,
  resolveStateRoot,
  type TokenSet
} from "@vymalo/opencode-auth-core/lib";
import { describe, expect, it } from "vitest";

import { HUMAN_IDENTITY, RepoAuthPlugin, repoAuthStateDir } from "../src/plugin.js";
import { createRepoAuthConfig, createSilentLogger, makeJsonResponse } from "./helpers.js";

const human: TokenSet = {
  accessToken: "human-token",
  tokenType: "Bearer",
  refreshToken: "human-refresh",
  expiresAt: Date.now() + 3_600_000
};

describe("repo-auth credentials live in the state dir (ADR-0022)", () => {
  it("defaults the human root and project token to <stateRoot>/opencode-repo-auth, 0o600", async () => {
    // The vitest setup file isolated HOME: default dirs, no injection, throwaway home.
    const dir = repoAuthStateDir(resolveStateRoot());
    // Expired, so the human root must be refreshed - which takes the refresh lock.
    await new FileCacheStore(dir).save(HUMAN_IDENTITY, { ...human, expiresAt: Date.now() - 1000 });

    let locksDuringRefresh: string[] | undefined;
    const plugin = new RepoAuthPlugin(createRepoAuthConfig(), {
      logger: createSilentLogger(),
      fetchImpl: async (_input, init) => {
        const body = new URLSearchParams(String(init?.body ?? ""));
        if (body.get("grant_type") === "refresh_token") {
          locksDuringRefresh = await readdir(join(dir, "locks"));
          return makeJsonResponse({
            access_token: "human-token",
            token_type: "Bearer",
            refresh_token: "human-refresh-2",
            expires_in: 3600
          });
        }
        return makeJsonResponse({
          access_token: "project-token",
          token_type: "Bearer",
          expires_in: 300
        });
      }
    });
    const token = await plugin.resolveProjectToken();
    expect(token.accessToken).toBe("project-token");

    const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
    expect(files).toHaveLength(2); // human root + project token
    for (const name of files) {
      expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(join(dir, `${HUMAN_IDENTITY}.json`), "utf8")).toContain(
      "human-refresh-2"
    );
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    // The refresh lock sat beside the tokens it guards.
    expect(locksDuringRefresh).toEqual([`${HUMAN_IDENTITY}.lock`]);

    if (resolveStateRoot() !== resolveCacheRoot()) {
      await expect(stat(join(resolveCacheRoot(), "opencode-repo-auth"))).rejects.toThrow();
    }
  });

  it("never reads the human root from the old cache location (no fallback)", async () => {
    if (resolveStateRoot() === resolveCacheRoot()) {
      return; // Windows: both roots coincide by design.
    }
    // A fresh home so the previous test's state-dir login is not visible.
    const originalHome = process.env.HOME;
    process.env.HOME = await mkdtemp(join(tmpdir(), "repo-auth-fresh-home-"));
    await new FileCacheStore(join(resolveCacheRoot(), "opencode-repo-auth")).save(
      HUMAN_IDENTITY,
      human
    );

    const bodies: string[] = [];
    const plugin = new RepoAuthPlugin(createRepoAuthConfig({ projectId: "other-project" }), {
      logger: createSilentLogger(),
      fetchImpl: async (_input, init) => {
        bodies.push(String(init?.body ?? ""));
        throw new Error("network");
      }
    });
    try {
      await expect(plugin.resolveProjectToken()).rejects.toThrow();
    } finally {
      process.env.HOME = originalHome;
    }
    // Had the old-cache human token been honoured, it would have been presented
    // as the subject token of an exchange.
    expect(bodies.some((body) => body.includes("human-token"))).toBe(false);
  });
});
