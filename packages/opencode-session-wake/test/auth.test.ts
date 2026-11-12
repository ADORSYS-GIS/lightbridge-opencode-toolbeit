import { describe, expect, it, vi } from "vitest";

import { createTokenSource, execFileRunner, TokenError } from "../src/auth.js";

describe("createTokenSource", () => {
  it("trims the command output", async () => {
    const source = createTokenSource({
      command: ["gh", "auth", "token"],
      run: async () => " abc \n"
    });
    await expect(source.resolve()).resolves.toBe("abc");
  });

  it("caches the token for its TTL instead of spawning the command every tick", async () => {
    let at = 0;
    const run = vi.fn(async () => "abc");
    const source = createTokenSource({ command: ["gh"], run, ttlMs: 1_000, now: () => at });

    await source.resolve();
    at = 500;
    await source.resolve();
    expect(run).toHaveBeenCalledTimes(1);

    at = 1_001;
    await source.resolve();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("describes the command by name only", () => {
    const source = createTokenSource({ command: ["/usr/local/bin/gh", "auth", "token"] });
    expect(source.describe()).toBe("gh");
  });

  it("fails closed when the command fails or prints nothing", async () => {
    const failing = createTokenSource({
      command: ["gh"],
      run: async () => {
        throw new TokenError("token command failed (gh)");
      }
    });
    await expect(failing.resolve()).rejects.toBeInstanceOf(TokenError);

    const empty = createTokenSource({ command: ["gh"], run: async () => "   " });
    await expect(empty.resolve()).rejects.toMatchObject({ name: "TokenError" });
  });
});

describe("execFileRunner", () => {
  it("rejects an empty command", async () => {
    await expect(execFileRunner([])).rejects.toBeInstanceOf(TokenError);
  });

  it("runs without a shell and never echoes the token in an error", async () => {
    await expect(execFileRunner(["definitely-not-a-real-binary-xyz"])).rejects.toMatchObject({
      name: "TokenError",
      message: "token command failed (definitely-not-a-real-binary-xyz)"
    });
  });
});
