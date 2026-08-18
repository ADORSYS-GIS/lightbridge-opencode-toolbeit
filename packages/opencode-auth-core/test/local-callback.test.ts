import { describe, expect, it } from "vitest";

import { startLocalCallbackServer } from "../src/oauth/local-callback.js";

describe("startLocalCallbackServer", () => {
  it("binds to a random port when none is provided", async () => {
    const server = await startLocalCallbackServer();
    try {
      expect(server.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2\/callback$/);
    } finally {
      await server.close();
    }
  });

  it("binds to the requested port when provided", async () => {
    // First listen on port 0 to find a free port, then close, then re-bind.
    const probe = await startLocalCallbackServer();
    const match = probe.redirectUri.match(/:(\d+)\//);
    expect(match).not.toBeNull();
    const freePort = Number(match?.[1]);
    await probe.close();

    const server = await startLocalCallbackServer("/oauth2/callback", freePort);
    try {
      expect(server.redirectUri).toBe(`http://127.0.0.1:${freePort}/oauth2/callback`);
    } finally {
      await server.close();
    }
  });
});
