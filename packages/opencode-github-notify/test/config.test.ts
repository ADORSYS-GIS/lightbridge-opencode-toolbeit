import { describe, expect, it } from "vitest";

import { ConfigError, parseWatchRef, resolveOptions } from "../src/config.js";

describe("resolveOptions", () => {
  it("applies defaults", () => {
    const options = resolveOptions({ watches: ["acme/plan#7"] });
    expect(options).toMatchObject({
      enabled: true,
      pollIntervalMs: 60_000,
      maxBackoffMs: 900_000,
      notify: "queue",
      apiBaseUrl: "https://api.github.com",
      auth: { kind: "command", command: ["gh", "auth", "token"] },
      filter: { mentions: [], markers: [] },
      batchSize: 20
    });
    expect(options.watches).toEqual([
      { owner: "acme", repo: "plan", number: 7, key: "acme/plan#7" }
    ]);
  });

  it("accepts repo + threads, merges with watches, and dedupes case-insensitively", () => {
    const options = resolveOptions({
      repo: "acme/plan",
      threads: [7, 8],
      watches: ["ACME/Plan#7"]
    });
    expect(options.watches.map((w) => w.key).sort()).toEqual(["acme/plan#7", "acme/plan#8"]);
  });

  it("clamps the poll interval to the minimum and backoff to at least the interval", () => {
    const options = resolveOptions({
      watches: ["a/b#1"],
      pollIntervalSeconds: 1,
      maxBackoffSeconds: 5
    });
    expect(options.pollIntervalMs).toBe(15_000);
    expect(options.maxBackoffMs).toBe(15_000);
  });

  it("parses filter, auth, notify and the rest", () => {
    const options = resolveOptions({
      watches: ["a/b#1"],
      filter: { mentions: ["@bot", "other"], markers: ["[agent]"] },
      auth: { env: "GITHUB_TOKEN" },
      notify: "wake",
      apiBaseUrl: "https://ghe.example.com/api/v3/",
      maxLogEvents: 10,
      maxPages: 2,
      batchSize: 5,
      enabled: false,
      stateDir: "/tmp/x"
    });
    expect(options).toMatchObject({
      filter: { mentions: ["bot", "other"], markers: ["[agent]"] },
      auth: { kind: "env", env: "GITHUB_TOKEN" },
      notify: "wake",
      apiBaseUrl: "https://ghe.example.com/api/v3",
      maxLogEvents: 10,
      maxPages: 2,
      batchSize: 5,
      enabled: false,
      stateDir: "/tmp/x"
    });
    expect(resolveOptions({ notify: false }).notify).toBe("off");
    expect(resolveOptions({ auth: { command: ["pass", "gh"] } }).auth).toEqual({
      kind: "command",
      command: ["pass", "gh"]
    });
    expect(resolveOptions({ apiBaseUrl: "http://127.0.0.1:8080" }).apiBaseUrl).toBe(
      "http://127.0.0.1:8080"
    );
  });

  it.each([
    ["bad watch", { watches: ["acme/plan"] }],
    ["bad repo", { repo: "acme", threads: [1] }],
    ["threads without repo", { threads: [1] }],
    ["empty threads", { repo: "a/b", threads: [] }],
    ["non-numeric thread", { repo: "a/b", threads: ["1"] }],
    ["zero thread", { watches: ["a/b#0"] }],
    ["bad owner chars", { repo: "a b/c", threads: [1] }],
    ["filter not object", { filter: [] }],
    ["mentions not strings", { filter: { mentions: [1] } }],
    ["auth not object", { auth: "gh" }],
    ["auth empty command", { auth: { command: [] } }],
    ["auth bad env", { auth: { env: "1X" } }],
    ["bad notify", { notify: "loud" }],
    ["apiBaseUrl not string", { apiBaseUrl: 1 }],
    ["apiBaseUrl not url", { apiBaseUrl: "nope" }],
    ["apiBaseUrl plain http", { apiBaseUrl: "http://ghe.example.com" }],
    ["interval not int", { pollIntervalSeconds: 1.5 }]
  ])("rejects %s", (_name, raw) => {
    expect(() => resolveOptions(raw)).toThrow(ConfigError);
  });

  it("treats non-object options as empty", () => {
    expect(resolveOptions(undefined).watches).toEqual([]);
    expect(() => parseWatchRef("x")).toThrow(ConfigError);
  });
});
