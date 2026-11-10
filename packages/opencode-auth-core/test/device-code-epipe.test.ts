import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireTokenViaDeviceCode } from "../src/oauth/device-code.js";
import { resetTerminalPromptLatch } from "../src/terminal-prompt.js";
import { createSilentLogger } from "./helpers.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });

describe("acquireTokenViaDeviceCode — stderr prompt on a closed pipe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetTerminalPromptLatch();
  });

  it("an EPIPE on the prompt is swallowed: no 'error' event is left without a listener", async () => {
    // A v2 host runs the server with stderr as a closed pipe: a failed write
    // reports through the callback, then emits 'error' on a later tick. An
    // 'error' with no listener is what the host logs as an unhandled rejection.
    let unhandled = 0;
    vi.spyOn(process.stderr, "write").mockImplementation(((
      _chunk: unknown,
      callback?: (error?: Error | null) => void
    ) => {
      const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      process.nextTick(() => {
        callback?.(error);
        process.nextTick(() => {
          if (process.stderr.listenerCount("error") === 0) {
            unhandled += 1;
          } else {
            process.stderr.emit("error", error);
          }
        });
      });
      return false;
    }) as typeof process.stderr.write);

    const responses = [
      () =>
        json({
          device_code: "dev",
          user_code: "ABCD-EFGH",
          verification_uri: "https://idp.example.com/activate",
          expires_in: 600,
          interval: 1
        }),
      () => json({ access_token: "a", refresh_token: "r", token_type: "Bearer", expires_in: 60 })
    ];
    let index = 0;

    const token = await acquireTokenViaDeviceCode({
      deviceAuthorizationEndpoint: "https://idp.example.com/device",
      tokenEndpoint: "https://idp.example.com/token",
      clientId: "client",
      scopes: ["openid"],
      serverId: "example",
      logger: createSilentLogger(),
      timeoutMs: 1_000,
      pkce: false,
      sleep: async () => {},
      fetchImpl: (async () => responses[index++]?.()) as typeof fetch
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(token.accessToken).toBe("a");
    expect(unhandled).toBe(0);
  });
});
