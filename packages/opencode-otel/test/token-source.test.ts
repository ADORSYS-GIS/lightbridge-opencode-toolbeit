import { describe, expect, it } from "vitest";

import {
  type CommandRunner,
  createTokenSource,
  EXPIRY_SKEW_MS,
  readJwtExpiry,
  type RunResult
} from "../src/token-source.js";
import { silentLogger } from "./helpers.js";

/** Build an unsigned JWT with the given `exp` (seconds). Signature is irrelevant here. */
function jwt(expSeconds?: number): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url").replace(/=+$/, "");
  return `${b64({ alg: "RS256" })}.${b64(expSeconds ? { exp: expSeconds } : {})}.sig`;
}

function runner(results: Array<Partial<RunResult>>): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const run: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    const next = results[Math.min(i, results.length - 1)];
    i += 1;
    return { stdout: "", stderr: "", code: 0, ...next };
  };
  return { run, calls };
}

describe("readJwtExpiry", () => {
  it("reads exp as epoch milliseconds", () => {
    expect(readJwtExpiry(jwt(1_800_000_000))).toBe(1_800_000_000_000);
  });

  it("returns undefined for a token with no exp, or one that is not a JWT", () => {
    expect(readJwtExpiry(jwt())).toBeUndefined();
    expect(readJwtExpiry("not-a-jwt")).toBeUndefined();
    expect(readJwtExpiry("a.b.c")).toBeUndefined();
  });
});

describe("createTokenSource", () => {
  it("runs the helper and uses its stdout as the bearer token", async () => {
    const { run, calls } = runner([{ stdout: "  token-value\n" }]);
    const source = createTokenSource({
      command: ["governance-auth", "token"],
      logger: silentLogger(),
      run
    });

    expect(await source.headers()).toEqual({ Authorization: "Bearer token-value" });
    expect(calls).toEqual([["governance-auth", "token"]]);
  });

  it("caches until shortly before the JWT's own expiry", async () => {
    let now = 1_000_000;
    const token = jwt(Math.floor((now + 300_000) / 1000));
    const { run, calls } = runner([{ stdout: token }]);
    const source = createTokenSource({
      command: ["helper"],
      logger: silentLogger(),
      now: () => now,
      run
    });

    await source.headers();
    now += 300_000 - EXPIRY_SKEW_MS - 1_000;
    await source.headers();
    expect(calls).toHaveLength(1);

    // Crossing the skew window re-runs the helper before the token is dead.
    now += 2_000;
    await source.headers();
    expect(calls).toHaveLength(2);
  });

  it("falls back to the refresh interval when the token carries no exp", async () => {
    let now = 0;
    const { run, calls } = runner([{ stdout: "opaque-token" }]);
    const source = createTokenSource({
      command: ["helper"],
      refreshMs: 60_000,
      logger: silentLogger(),
      now: () => now,
      run
    });

    await source.headers();
    now += 59_000;
    await source.headers();
    expect(calls).toHaveLength(1);

    now += 2_000;
    await source.headers();
    expect(calls).toHaveLength(2);
  });

  it("spawns one process for concurrent exports, not one each", async () => {
    const { run, calls } = runner([{ stdout: "token" }]);
    const source = createTokenSource({ command: ["helper"], logger: silentLogger(), run });

    const results = await Promise.all([source.headers(), source.headers(), source.headers()]);
    expect(calls).toHaveLength(1);
    for (const headers of results) {
      expect(headers).toEqual({ Authorization: "Bearer token" });
    }
  });

  it("emits no auth header when the helper fails, rather than a fabricated one", async () => {
    const logger = silentLogger();
    const { run } = runner([{ code: 1, stderr: "no session" }]);
    const source = createTokenSource({ command: ["helper"], logger, run });

    expect(await source.headers()).toEqual({});
    const failure = logger.events.find(([name]) => name === "warn:otel_token_command_failed");
    expect(failure?.[1]).toMatchObject({ command: "helper", exitCode: 1, emptyStdout: true });
  });

  it("treats empty stdout as a failure even on exit 0", async () => {
    const { run } = runner([{ stdout: "   \n", code: 0 }]);
    const source = createTokenSource({ command: ["helper"], logger: silentLogger(), run });
    expect(await source.headers()).toEqual({});
  });

  it("never logs the token or the helper's stderr contents", async () => {
    const logger = silentLogger();
    const { run } = runner([{ code: 1, stderr: "secret-detail-in-stderr" }]);
    const source = createTokenSource({ command: ["helper"], logger, run });
    await source.headers();

    const serialized = JSON.stringify(logger.events);
    expect(serialized).not.toContain("secret-detail-in-stderr");
    expect(serialized).toContain("stderrLength");
  });

  it("keeps serving a still-valid token when a later refresh fails", async () => {
    let now = 0;
    const { run } = runner([{ stdout: "good-token" }, { code: 1 }]);
    const source = createTokenSource({
      command: ["helper"],
      refreshMs: 10_000,
      logger: silentLogger(),
      now: () => now,
      run
    });

    expect(await source.headers()).toEqual({ Authorization: "Bearer good-token" });
    source.invalidate();
    // The refresh fails, and there is no cached token left to fall back to.
    expect(await source.headers()).toEqual({});
  });

  it("fails closed once the cached token has aged out and refresh cannot replace it", async () => {
    let now = 0;
    const logger = silentLogger();
    const { run } = runner([{ stdout: "good-token" }, { code: 1 }]);
    const source = createTokenSource({
      command: ["helper"],
      refreshMs: 10_000,
      logger,
      now: () => now,
      run
    });

    await source.headers();
    now += 11_000;
    expect(await source.headers()).toEqual({});
    expect(logger.events.some(([name]) => name === "warn:otel_token_expired")).toBe(true);
  });

  it("survives a runner that rejects outright", async () => {
    const logger = silentLogger();
    const run: CommandRunner = async () => {
      throw new Error("ENOENT");
    };
    const source = createTokenSource({ command: ["missing-binary"], logger, run });

    await expect(source.headers()).resolves.toEqual({});
    expect(
      logger.events.some(
        ([name, fields]) =>
          name === "warn:otel_token_command_failed" &&
          (fields as { reason?: string })?.reason === "ENOENT"
      )
    ).toBe(true);
  });

  it("runs a real process through the default runner", async () => {
    const source = createTokenSource({
      command: [process.execPath, "-e", "process.stdout.write('real-token')"],
      logger: silentLogger()
    });
    expect(await source.headers()).toEqual({ Authorization: "Bearer real-token" });
  });

  it("reports a real process that exits non-zero", async () => {
    const logger = silentLogger();
    const source = createTokenSource({
      command: [process.execPath, "-e", "process.stderr.write('nope'); process.exit(3)"],
      logger
    });
    expect(await source.headers()).toEqual({});
    expect(logger.events.some(([name]) => name === "warn:otel_token_command_failed")).toBe(true);
  });

  it("honours a custom header and prefix", async () => {
    const { run } = runner([{ stdout: "abc" }]);
    const source = createTokenSource({
      command: ["helper"],
      header: "x-api-key",
      prefix: "",
      logger: silentLogger(),
      run
    });
    expect(await source.headers()).toEqual({ "x-api-key": "abc" });
  });
});
