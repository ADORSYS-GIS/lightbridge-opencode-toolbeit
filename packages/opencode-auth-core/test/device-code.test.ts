import { describe, expect, it } from "vitest";

import { acquireTokenViaDeviceCode } from "../src/oauth/device-code.js";
import { createSilentLogger } from "./helpers.js";

interface FetchCall {
  url: string;
  body: URLSearchParams;
}

function parseFormBody(init?: RequestInit): URLSearchParams {
  const body = init?.body;
  if (body instanceof URLSearchParams) {
    return body;
  }
  return new URLSearchParams(String(body ?? ""));
}

function recordingFetch(responses: Array<() => Response>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: parseFormBody(init) });
    const producer = responses[i++];
    if (!producer) {
      throw new Error(`unexpected fetch call (#${i})`);
    }
    return producer();
  }) as typeof fetch;
  return { fetch: fn, calls };
}

describe("acquireTokenViaDeviceCode", () => {
  it("happy path: requests device code, polls past authorization_pending, returns tokens", async () => {
    const sleeps: number[] = [];
    const { fetch: fetchImpl, calls } = recordingFetch([
      () =>
        new Response(
          JSON.stringify({
            device_code: "dev-code-abc",
            user_code: "WDJB-MJHT",
            verification_uri: "https://auth.example.com/device",
            verification_uri_complete: "https://auth.example.com/device?user_code=WDJB-MJHT",
            expires_in: 600,
            interval: 2
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      () =>
        new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }),
      () =>
        new Response(
          JSON.stringify({
            access_token: "device-access",
            refresh_token: "device-refresh",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    ]);

    const token = await acquireTokenViaDeviceCode({
      deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize",
      tokenEndpoint: "https://auth.example.com/oauth/token",
      clientId: "device-client",
      scopes: ["openid", "offline_access"],
      serverId: "example-ai",
      logger: createSilentLogger(),
      fetchImpl,
      timeoutMs: 5000,
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    });

    expect(token.accessToken).toBe("device-access");
    expect(token.refreshToken).toBe("device-refresh");

    // First call: device authorization request
    expect(calls[0].url).toBe("https://auth.example.com/device/authorize");
    expect(calls[0].body.get("client_id")).toBe("device-client");
    expect(calls[0].body.get("scope")).toBe("openid offline_access");
    // PKCE is sent on the device-authorization request (Keycloak enforces it).
    const challenge = calls[0].body.get("code_challenge");
    expect(calls[0].body.get("code_challenge_method")).toBe("S256");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);

    // Second call: poll #1 (authorization_pending)
    expect(calls[1].url).toBe("https://auth.example.com/oauth/token");
    expect(calls[1].body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(calls[1].body.get("device_code")).toBe("dev-code-abc");
    expect(calls[1].body.get("client_id")).toBe("device-client");
    // The matching verifier is replayed on the token poll.
    expect(calls[1].body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]+$/);

    // Third call: poll #2 (success)
    expect(calls[2].url).toBe("https://auth.example.com/oauth/token");

    // Sleeps respect the server-provided interval of 2s
    expect(sleeps[0]).toBe(2000);
    expect(sleeps[1]).toBe(2000);
  });

  it("omits PKCE parameters when pkce is disabled", async () => {
    const { fetch: fetchImpl, calls } = recordingFetch([
      () =>
        new Response(
          JSON.stringify({
            device_code: "dev-code-abc",
            user_code: "WDJB-MJHT",
            verification_uri: "https://auth.example.com/device",
            expires_in: 600,
            interval: 1
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      () =>
        new Response(
          JSON.stringify({
            access_token: "device-access",
            refresh_token: "device-refresh",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    ]);

    await acquireTokenViaDeviceCode({
      deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize",
      tokenEndpoint: "https://auth.example.com/oauth/token",
      clientId: "device-client",
      scopes: ["openid"],
      serverId: "example-ai",
      logger: createSilentLogger(),
      fetchImpl,
      timeoutMs: 5000,
      pkce: false,
      sleep: async () => {}
    });

    // Device-authorization request carries no challenge…
    expect(calls[0].body.get("code_challenge")).toBeNull();
    expect(calls[0].body.get("code_challenge_method")).toBeNull();
    // …and the token poll carries no verifier.
    expect(calls[1].body.get("code_verifier")).toBeNull();
  });

  it("increases polling interval by 5s on slow_down", async () => {
    const sleeps: number[] = [];
    const { fetch: fetchImpl } = recordingFetch([
      () =>
        new Response(
          JSON.stringify({
            device_code: "dev-code-abc",
            user_code: "WDJB-MJHT",
            verification_uri: "https://auth.example.com/device",
            expires_in: 600,
            interval: 3
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      () =>
        new Response(JSON.stringify({ error: "slow_down" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }),
      () =>
        new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }),
      () =>
        new Response(
          JSON.stringify({
            access_token: "device-access",
            refresh_token: "device-refresh",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    ]);

    await acquireTokenViaDeviceCode({
      deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize",
      tokenEndpoint: "https://auth.example.com/oauth/token",
      clientId: "device-client",
      scopes: ["openid", "offline_access"],
      serverId: "example-ai",
      logger: createSilentLogger(),
      fetchImpl,
      timeoutMs: 5000,
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    });

    // First poll: 3s (server-provided interval)
    expect(sleeps[0]).toBe(3000);
    // After slow_down: interval bumped to 8s
    expect(sleeps[1]).toBe(8000);
    // After authorization_pending: still 8s
    expect(sleeps[2]).toBe(8000);
  });

  it("throws on expired_token error from token endpoint", async () => {
    const { fetch: fetchImpl } = recordingFetch([
      () =>
        new Response(
          JSON.stringify({
            device_code: "dev-code-abc",
            user_code: "WDJB-MJHT",
            verification_uri: "https://auth.example.com/device",
            expires_in: 600,
            interval: 1
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      () =>
        new Response(JSON.stringify({ error: "expired_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        })
    ]);

    await expect(
      acquireTokenViaDeviceCode({
        deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize",
        tokenEndpoint: "https://auth.example.com/oauth/token",
        clientId: "device-client",
        scopes: ["openid"],
        serverId: "example-ai",
        logger: createSilentLogger(),
        fetchImpl,
        timeoutMs: 5000,
        sleep: async () => {}
      })
    ).rejects.toThrow(/expired/i);
  });

  it("throws on access_denied error from token endpoint", async () => {
    const { fetch: fetchImpl } = recordingFetch([
      () =>
        new Response(
          JSON.stringify({
            device_code: "dev-code-abc",
            user_code: "WDJB-MJHT",
            verification_uri: "https://auth.example.com/device",
            expires_in: 600,
            interval: 1
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      () =>
        new Response(JSON.stringify({ error: "access_denied" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        })
    ]);

    await expect(
      acquireTokenViaDeviceCode({
        deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize",
        tokenEndpoint: "https://auth.example.com/oauth/token",
        clientId: "device-client",
        scopes: ["openid"],
        serverId: "example-ai",
        logger: createSilentLogger(),
        fetchImpl,
        timeoutMs: 5000,
        sleep: async () => {}
      })
    ).rejects.toThrow(/denied/i);
  });

  it("throws when success response is missing refresh_token", async () => {
    const { fetch: fetchImpl } = recordingFetch([
      () =>
        new Response(
          JSON.stringify({
            device_code: "dev-code-abc",
            user_code: "WDJB-MJHT",
            verification_uri: "https://auth.example.com/device",
            expires_in: 600,
            interval: 1
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      () =>
        new Response(
          JSON.stringify({
            access_token: "no-refresh-token-here",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    ]);

    await expect(
      acquireTokenViaDeviceCode({
        deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize",
        tokenEndpoint: "https://auth.example.com/oauth/token",
        clientId: "device-client",
        scopes: ["openid"],
        serverId: "example-ai",
        logger: createSilentLogger(),
        fetchImpl,
        timeoutMs: 5000,
        sleep: async () => {}
      })
    ).rejects.toThrow(/refresh_token/i);
  });

  it("includes client_secret in device-auth and poll requests; never logs it", async () => {
    type Entry = { level: string; event: string; fields?: Record<string, unknown> };
    const entries: Entry[] = [];
    const recordingLogger = {
      trace(event: string, fields?: Record<string, unknown>) {
        entries.push({ level: "trace", event, fields });
      },
      debug(event: string, fields?: Record<string, unknown>) {
        entries.push({ level: "debug", event, fields });
      },
      info(event: string, fields?: Record<string, unknown>) {
        entries.push({ level: "info", event, fields });
      },
      warn(event: string, fields?: Record<string, unknown>) {
        entries.push({ level: "warn", event, fields });
      },
      error(event: string, fields?: Record<string, unknown>) {
        entries.push({ level: "error", event, fields });
      }
    };

    const { fetch: fetchImpl, calls } = recordingFetch([
      () =>
        new Response(
          JSON.stringify({
            device_code: "dev-code-abc",
            user_code: "WDJB-MJHT",
            verification_uri: "https://auth.example.com/device",
            expires_in: 600,
            interval: 1
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      () =>
        new Response(
          JSON.stringify({
            access_token: "a",
            refresh_token: "r",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    ]);

    await acquireTokenViaDeviceCode({
      deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize",
      tokenEndpoint: "https://auth.example.com/oauth/token",
      clientId: "device-client",
      clientSecret: "device-secret-shhh",
      scopes: ["openid"],
      serverId: "example-ai",
      logger: recordingLogger,
      fetchImpl,
      timeoutMs: 5000,
      sleep: async () => {}
    });

    expect(calls[0].body.get("client_secret")).toBe("device-secret-shhh");
    expect(calls[1].body.get("client_secret")).toBe("device-secret-shhh");

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("device-secret-shhh");
  });

  it("expires before user authorizes when deadline elapses", async () => {
    let nowValue = 1_000_000;
    const { fetch: fetchImpl } = recordingFetch([
      () =>
        new Response(
          JSON.stringify({
            device_code: "dev-code-abc",
            user_code: "WDJB-MJHT",
            verification_uri: "https://auth.example.com/device",
            expires_in: 2,
            interval: 1
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      () =>
        new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        })
    ]);

    await expect(
      acquireTokenViaDeviceCode({
        deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize",
        tokenEndpoint: "https://auth.example.com/oauth/token",
        clientId: "device-client",
        scopes: ["openid"],
        serverId: "example-ai",
        logger: createSilentLogger(),
        fetchImpl,
        timeoutMs: 5000,
        sleep: async () => {
          // advance clock past the deadline
          nowValue += 5_000;
        },
        now: () => nowValue
      })
    ).rejects.toThrow(/expired/i);
  });

  it("retries on transient fetch errors during polling instead of failing the flow", async () => {
    let callIndex = 0;
    const fetchImpl: typeof fetch = (async () => {
      callIndex++;
      if (callIndex === 1) {
        // device authorization request
        return new Response(
          JSON.stringify({
            device_code: "dev-code",
            user_code: "ABCD-EFGH",
            verification_uri: "https://auth.example.com/device",
            expires_in: 60,
            interval: 1
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (callIndex === 2) {
        // First poll — simulate a transient network error
        throw new Error("ECONNRESET");
      }
      if (callIndex === 3) {
        // Second poll — succeeds
        return new Response(
          JSON.stringify({
            access_token: "a",
            refresh_token: "r",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`unexpected fetch (call #${callIndex})`);
    }) as typeof fetch;

    type Entry = { level: string; event: string; fields?: Record<string, unknown> };
    const entries: Entry[] = [];
    const logger = {
      trace(event: string, fields?: Record<string, unknown>) {
        entries.push({ level: "trace", event, fields });
      },
      debug(event: string, fields?: Record<string, unknown>) {
        entries.push({ level: "debug", event, fields });
      },
      info(event: string, fields?: Record<string, unknown>) {
        entries.push({ level: "info", event, fields });
      },
      warn(event: string, fields?: Record<string, unknown>) {
        entries.push({ level: "warn", event, fields });
      },
      error(event: string, fields?: Record<string, unknown>) {
        entries.push({ level: "error", event, fields });
      }
    };

    const token = await acquireTokenViaDeviceCode({
      deviceAuthorizationEndpoint: "https://auth.example.com/device",
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "client",
      scopes: ["openid"],
      serverId: "example-ai",
      logger,
      fetchImpl,
      timeoutMs: 1000,
      sleep: async () => undefined,
      now: () => 1_000_000
    });

    expect(token.accessToken).toBe("a");
    expect(callIndex).toBe(3);
    const transientWarn = entries.find((e) => e.event === "oauth_device_code_poll_transient_error");
    expect(transientWarn).toBeDefined();
    expect(transientWarn?.fields?.error).toMatch(/ECONNRESET/);
  });

  it("bumps polling interval after a transient fetch failure (RFC 8628 §3.5)", async () => {
    const sleeps: number[] = [];
    let pollCount = 0;
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/device")) {
        return new Response(
          JSON.stringify({
            device_code: "dc",
            user_code: "UC",
            verification_uri: "https://auth.example.com/device",
            expires_in: 60,
            interval: 2
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      pollCount++;
      if (pollCount === 1) {
        throw new Error("transient");
      }
      return new Response(
        JSON.stringify({
          access_token: "a",
          refresh_token: "r",
          token_type: "Bearer",
          expires_in: 3600
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    await acquireTokenViaDeviceCode({
      deviceAuthorizationEndpoint: "https://auth.example.com/device",
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "client",
      scopes: ["openid"],
      serverId: "example-ai",
      logger: createSilentLogger(),
      fetchImpl,
      timeoutMs: 1000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 1_000_000
    });

    // First sleep: server interval 2s
    expect(sleeps[0]).toBe(2000);
    // After transient failure: bumped by SLOW_DOWN_INCREMENT_SECONDS (5s) → 7s
    expect(sleeps[1]).toBe(7000);
  });

  it("keeps polling through many transient transport failures until expires_in (no hard retry cap)", async () => {
    // Simulates a VPN flap / DNS flakiness mid-flow: 10 consecutive fetch
    // throws, then a successful poll. Round-3 hard-cap-3 would have failed
    // here; the round-4 behavior is to keep polling, backing off, until
    // either expires_in elapses or a real terminal OAuth error arrives.
    let pollCount = 0;
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/device")) {
        return new Response(
          JSON.stringify({
            device_code: "dc",
            user_code: "UC",
            verification_uri: "https://auth.example.com/device",
            expires_in: 600,
            interval: 1
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      pollCount++;
      if (pollCount <= 10) {
        throw new Error("ECONNRESET");
      }
      return new Response(
        JSON.stringify({
          access_token: "a",
          refresh_token: "r",
          token_type: "Bearer",
          expires_in: 3600
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const token = await acquireTokenViaDeviceCode({
      deviceAuthorizationEndpoint: "https://auth.example.com/device",
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "client",
      scopes: ["openid"],
      serverId: "example-ai",
      logger: createSilentLogger(),
      fetchImpl,
      timeoutMs: 1000,
      sleep: async () => undefined,
      now: () => 1_000_000
    });

    expect(token.accessToken).toBe("a");
    expect(pollCount).toBe(11);
  });

  it("aborts immediately on TypeError (programming/config error, not a transient transport issue)", async () => {
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/device")) {
        return new Response(
          JSON.stringify({
            device_code: "dc",
            user_code: "UC",
            verification_uri: "https://auth.example.com/device",
            expires_in: 600,
            interval: 1
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      // E.g. fetch throws TypeError("Invalid URL") on a malformed endpoint.
      throw new TypeError("Invalid URL");
    }) as typeof fetch;

    await expect(
      acquireTokenViaDeviceCode({
        deviceAuthorizationEndpoint: "https://auth.example.com/device",
        tokenEndpoint: "https://auth.example.com/token",
        clientId: "client",
        scopes: ["openid"],
        serverId: "example-ai",
        logger: createSilentLogger(),
        fetchImpl,
        timeoutMs: 1000,
        sleep: async () => undefined,
        now: () => 1_000_000
      })
    ).rejects.toThrow(/Invalid URL/);
  });

  it("caps polling interval growth after many transient failures", async () => {
    // Confirms intervalSeconds doesn't grow without bound — once it hits the
    // cap, subsequent transient failures don't make sleeps longer.
    const sleeps: number[] = [];
    let pollCount = 0;
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/device")) {
        return new Response(
          JSON.stringify({
            device_code: "dc",
            user_code: "UC",
            verification_uri: "https://auth.example.com/device",
            expires_in: 6000,
            interval: 5
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      pollCount++;
      if (pollCount <= 20) {
        throw new Error("transient");
      }
      return new Response(
        JSON.stringify({
          access_token: "a",
          refresh_token: "r",
          token_type: "Bearer",
          expires_in: 3600
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    await acquireTokenViaDeviceCode({
      deviceAuthorizationEndpoint: "https://auth.example.com/device",
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "client",
      scopes: ["openid"],
      serverId: "example-ai",
      logger: createSilentLogger(),
      fetchImpl,
      timeoutMs: 1000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 1_000_000
    });

    // After several transient failures, interval should hit the cap (60s)
    // and stay there — not keep climbing into hour-scale waits.
    const maxSleep = Math.max(...sleeps);
    expect(maxSleep).toBeLessThanOrEqual(60_000);
  });
});
