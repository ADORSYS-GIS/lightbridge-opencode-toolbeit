import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCacheRoot, resolveStateDir, resolveStateRoot } from "../src/cache.js";
import { TokenRuntime } from "../src/token-runtime.js";
import { createServerConfig, createSilentLogger } from "./helpers.js";

describe("resolveStateRoot (ADR-0022)", () => {
  const home = "/home/dev";

  it("darwin: ~/Library/Application Support (never ~/Library/Caches)", () => {
    expect(resolveStateRoot({ platform: "darwin", env: {}, home })).toBe(
      "/home/dev/Library/Application Support"
    );
  });

  it("linux: honours an absolute XDG_STATE_HOME", () => {
    expect(
      resolveStateRoot({ platform: "linux", env: { XDG_STATE_HOME: "/var/state/dev" }, home })
    ).toBe("/var/state/dev");
  });

  it("linux: falls back to ~/.local/state when XDG_STATE_HOME is unset", () => {
    expect(resolveStateRoot({ platform: "linux", env: {}, home })).toBe("/home/dev/.local/state");
  });

  it("linux: ignores a RELATIVE XDG_STATE_HOME (XDG spec: only absolute paths are valid)", () => {
    for (const relative of ["state", "./state", "../state", "~/state"]) {
      expect(resolveStateRoot({ platform: "linux", env: { XDG_STATE_HOME: relative }, home })).toBe(
        "/home/dev/.local/state"
      );
    }
  });

  it("linux: ignores an empty XDG_STATE_HOME", () => {
    expect(resolveStateRoot({ platform: "linux", env: { XDG_STATE_HOME: "" }, home })).toBe(
      "/home/dev/.local/state"
    );
  });

  it("linux: does not consult XDG_CACHE_HOME", () => {
    expect(
      resolveStateRoot({ platform: "linux", env: { XDG_CACHE_HOME: "/var/cache/dev" }, home })
    ).toBe("/home/dev/.local/state");
  });

  it("win32: %LOCALAPPDATA%, else ~/AppData/Local", () => {
    expect(
      resolveStateRoot({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\dev\\AL" }, home })
    ).toBe("C:\\Users\\dev\\AL");
    expect(resolveStateRoot({ platform: "win32", env: {}, home })).toBe(
      join(home, "AppData", "Local")
    );
  });

  it("resolveStateDir roots a namespace under the state root, not the cache root", () => {
    const dir = resolveStateDir("tokens");
    expect(dir).toBe(join(resolveStateRoot(), "opencode-auth-core", "tokens"));
    if (resolveStateRoot() !== resolveCacheRoot()) {
      expect(dir.startsWith(resolveCacheRoot())).toBe(false);
    }
  });
});

describe("TokenRuntime default credential location (ADR-0022)", () => {
  it("persists exchanged tokens under the state root and creates nothing in the cache root", async () => {
    // The vitest setup file isolated HOME, so both roots are throwaway directories.
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ access_token: "scoped", token_type: "Bearer", expires_in: 300 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as typeof fetch;
    const runtime = new TokenRuntime("human-id", createServerConfig(), {
      logger: createSilentLogger(),
      fetchImpl
    });

    await runtime.exchangeToAudience("/sources/src-1", "human.jwt");

    const stateDir = resolveStateDir("tokens");
    expect((await readdir(stateDir)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    if (resolveStateRoot() !== resolveCacheRoot()) {
      await expect(stat(join(resolveCacheRoot(), "opencode-auth-core"))).rejects.toThrow();
    }
  });

  it("takes the refresh lock inside stateDir, beside the token it guards", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auth-core-lock-beside-"));
    let lockNames: string[] = [];
    const fetchImpl = (async () => {
      lockNames = await readdir(join(stateDir, "locks"));
      return new Response(
        JSON.stringify({ access_token: "fresh", token_type: "Bearer", expires_in: 300 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;
    const runtime = new TokenRuntime(
      "human-id",
      createServerConfig({ authFlow: "client_credentials", clientSecret: "s" }),
      { logger: createSilentLogger(), fetchImpl, stateDir }
    );

    await runtime.ensure();

    expect(lockNames).toEqual(["human-id.lock"]);
    expect(await readdir(stateDir)).toContain("human-id.json");
  });
});

describe("env roots must be absolute (ADR-0022)", () => {
  const home = "/home/dev";

  it("win32: empty or relative LOCALAPPDATA falls back to ~/AppData/Local (state and cache)", () => {
    for (const bad of ["", "relative\\dir", ".\\x", "AppData"]) {
      const env = { LOCALAPPDATA: bad };
      expect(resolveStateRoot({ platform: "win32", env, home })).toBe(
        join(home, "AppData", "Local")
      );
      expect(resolveCacheRoot({ platform: "win32", env, home })).toBe(
        join(home, "AppData", "Local")
      );
    }
  });

  it("win32: an absolute LOCALAPPDATA (drive or UNC) is honoured by both roots", () => {
    for (const good of ["C:\\Users\\dev\\AL", "\\\\server\\share\\AL"]) {
      const env = { LOCALAPPDATA: good };
      expect(resolveStateRoot({ platform: "win32", env, home })).toBe(good);
      expect(resolveCacheRoot({ platform: "win32", env, home })).toBe(good);
    }
  });

  it("linux cache root: honours an absolute XDG_CACHE_HOME, ignores a relative or empty one", () => {
    expect(
      resolveCacheRoot({ platform: "linux", env: { XDG_CACHE_HOME: "/var/cache/dev" }, home })
    ).toBe("/var/cache/dev");
    for (const bad of ["", "cache", "./cache"]) {
      expect(resolveCacheRoot({ platform: "linux", env: { XDG_CACHE_HOME: bad }, home })).toBe(
        "/home/dev/.cache"
      );
    }
  });

  it("darwin cache root: ~/Library/Caches", () => {
    expect(resolveCacheRoot({ platform: "darwin", env: {}, home })).toBe(
      "/home/dev/Library/Caches"
    );
  });
});
