import { describe, expect, it } from "vitest";

import {
  clampInterval,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_INTERVAL_MS,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_TOKEN_COMMAND,
  parseWakeOptions,
  resolveStateRoot,
  resolveWakeStateDir,
  wakeSubscriptionsDir,
  wakeWatchesDir
} from "../src/config.js";
import { fakeLogger } from "./helpers.js";

describe("resolveStateRoot", () => {
  it("uses XDG_STATE_HOME on Linux when it is absolute", () => {
    expect(
      resolveStateRoot({
        platform: "linux",
        env: { XDG_STATE_HOME: "/var/state" },
        home: "/home/a"
      })
    ).toBe("/var/state");
  });

  it("ignores an empty or relative XDG_STATE_HOME", () => {
    expect(
      resolveStateRoot({ platform: "linux", env: { XDG_STATE_HOME: "" }, home: "/home/a" })
    ).toBe("/home/a/.local/state");
    expect(
      resolveStateRoot({ platform: "linux", env: { XDG_STATE_HOME: "rel" }, home: "/home/a" })
    ).toBe("/home/a/.local/state");
  });

  it("uses the platform's durable root on macOS and Windows", () => {
    expect(resolveStateRoot({ platform: "darwin", env: {}, home: "/Users/a" })).toBe(
      "/Users/a/Library/Application Support"
    );
    expect(
      resolveStateRoot({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
        home: "C:\\Users\\a"
      })
    ).toBe("C:\\Users\\a\\AppData\\Local");
  });

  it("namespaces the directory under the state root", () => {
    expect(resolveWakeStateDir("/state")).toBe("/state/opencode-session-wake");
    expect(wakeSubscriptionsDir("/state/opencode-session-wake")).toBe(
      "/state/opencode-session-wake/subscriptions"
    );
    expect(wakeWatchesDir("/state/opencode-session-wake")).toBe(
      "/state/opencode-session-wake/watches"
    );
  });
});

describe("parseWakeOptions", () => {
  it("falls back to documented defaults", () => {
    const options = parseWakeOptions();
    expect(options.intervalMs).toBe(DEFAULT_INTERVAL_MS);
    expect(options.minIntervalMs).toBe(DEFAULT_MIN_INTERVAL_MS);
    expect(options.maxIntervalMs).toBe(DEFAULT_MAX_INTERVAL_MS);
    expect(options.tokenCommand).toEqual(DEFAULT_TOKEN_COMMAND);
    expect(options.apiBase).toBe("https://api.github.com");
  });

  it("clamps the interval into the configured bounds", () => {
    const tight = parseWakeOptions({
      intervalMs: 1_000,
      minIntervalMs: 5_000,
      maxIntervalMs: 10_000
    });
    expect(tight.intervalMs).toBe(5_000);
    const wide = parseWakeOptions({
      intervalMs: 900_000,
      minIntervalMs: 5_000,
      maxIntervalMs: 10_000
    });
    expect(wide.intervalMs).toBe(10_000);
  });

  it("ignores malformed values instead of failing startup", () => {
    const options = parseWakeOptions({
      intervalMs: "soon",
      maxPages: -3,
      apiBase: "",
      tokenCommand: [],
      stateDir: 42
    });
    expect(options.intervalMs).toBe(DEFAULT_INTERVAL_MS);
    expect(options.maxPages).toBe(10);
    expect(options.apiBase).toBe("https://api.github.com");
    expect(options.tokenCommand).toEqual(DEFAULT_TOKEN_COMMAND);
    expect(options.stateDir).toBeUndefined();
  });

  it("parses the loop guard and defaults it safely", () => {
    const defaults = parseWakeOptions();
    expect(defaults.loop.maxWakes).toBeGreaterThan(0);
    expect(defaults.loop.windowMs).toBeGreaterThanOrEqual(60_000);

    const custom = parseWakeOptions({
      loop: { maxWakes: 2, windowMs: 30_000, cooldownMs: 0 }
    });
    expect(custom.loop).toEqual({ maxWakes: 2, windowMs: 30_000, cooldownMs: 0 });

    const malformed = parseWakeOptions({ loop: { maxWakes: -1, windowMs: "soon" } });
    expect(malformed.loop).toEqual(defaults.loop);
    expect(parseWakeOptions({ loop: "nope" }).loop).toEqual(defaults.loop);
  });

  it("normalizes ignoreAuthors and drops non-strings", () => {
    const options = parseWakeOptions({ ignoreAuthors: ["@Alice", "github-actions[bot]", 42] });
    expect(options.ignoreAuthors).toEqual(["alice", "github-actions[bot]"]);
    expect(parseWakeOptions({ ignoreAuthors: "alice" }).ignoreAuthors).toEqual([]);
    expect(parseWakeOptions().ignoreAuthors).toEqual([]);
  });

  it("accepts a custom token command and state dir", () => {
    const options = parseWakeOptions({
      tokenCommand: ["pass", "show", "github"],
      stateDir: "/tmp/state",
      apiBase: "https://github.example/api/v3/"
    });
    expect(options.tokenCommand).toEqual(["pass", "show", "github"]);
    expect(options.stateDir).toBe("/tmp/state");
    expect(options.apiBase).toBe("https://github.example/api/v3");
  });
});

describe("clampInterval", () => {
  it("defaults when the caller gives nothing", () => {
    const options = parseWakeOptions({ intervalMs: 60_000 });
    expect(clampInterval(undefined, options)).toBe(60_000);
  });

  it("clamps and warns", () => {
    const options = parseWakeOptions({ minIntervalMs: 30_000, maxIntervalMs: 60_000 });
    const logger = fakeLogger();
    expect(clampInterval(1, options, logger)).toBe(30_000);
    expect(logger.events.some((e) => e.event === "wake_interval_clamped")).toBe(true);
  });

  it("does not warn when the request is already in range", () => {
    const options = parseWakeOptions({ minIntervalMs: 30_000, maxIntervalMs: 60_000 });
    const logger = fakeLogger();
    expect(clampInterval(45, options, logger)).toBe(45_000);
    expect(logger.events).toHaveLength(0);
  });
});
