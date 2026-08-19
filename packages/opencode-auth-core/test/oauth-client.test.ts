import { describe, expect, it } from "vitest";

import { OAuthClient } from "../src/oauth/client.js";
import { createServerConfig, createSilentLogger } from "./helpers.js";

function parseFormBody(init?: RequestInit): URLSearchParams {
  const body = init?.body;
  if (body instanceof URLSearchParams) {
    return body;
  }

  return new URLSearchParams(String(body ?? ""));
}

describe("OAuthClient token lifecycle", () => {
  it("reuses a valid token without network calls", async () => {
    const client = new OAuthClient(createServerConfig(), {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async () => {
        throw new Error("fetch should not be called for valid token");
      }
    });

    const token = {
      accessToken: "valid-access",
      tokenType: "Bearer",
      refreshToken: "valid-refresh",
      expiresAt: Date.now() + 10 * 60_000
    };

    await expect(client.ensureToken(token)).resolves.toEqual(token);
  });

  it("refreshes expired tokens and keeps previous refresh token if endpoint omits it", async () => {
    const server = createServerConfig();

    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe(server.tokenEndpoint);

        const body = parseFormBody(init);
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("old-refresh-token");

        return new Response(
          JSON.stringify({
            access_token: "new-access-token",
            token_type: "Bearer",
            expires_in: 3600
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
    });

    const token = await client.ensureToken({
      accessToken: "old-access-token",
      tokenType: "Bearer",
      refreshToken: "old-refresh-token",
      expiresAt: Date.now() - 1000
    });

    expect(token.accessToken).toBe("new-access-token");
    expect(token.refreshToken).toBe("old-refresh-token");
  });

  it("completes interactive login and returns refresh token", async () => {
    const server = createServerConfig();

    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe(server.tokenEndpoint);

        const body = parseFormBody(init);
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("auth-code-123");

        return new Response(
          JSON.stringify({
            access_token: "interactive-access",
            refresh_token: "interactive-refresh",
            token_type: "Bearer",
            expires_in: 3600
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      },
      onAuthorizationUrl: async (authorizationUrl) => {
        const parsed = new URL(authorizationUrl);
        const redirectUri = parsed.searchParams.get("redirect_uri");
        const state = parsed.searchParams.get("state");

        expect(parsed.searchParams.get("response_type")).toBe("code");
        expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
        expect(redirectUri).toBeTruthy();
        expect(state).toBeTruthy();

        await fetch(`${redirectUri}?code=auth-code-123&state=${state}`);
      }
    });

    const token = await client.ensureToken();
    expect(token.accessToken).toBe("interactive-access");
    expect(token.refreshToken).toBe("interactive-refresh");
  });

  it("does not log the authorize URL (or state nonce) into structured logs during interactive login", async () => {
    const server = createServerConfig();

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

    let observedState: string | undefined;

    const client = new OAuthClient(server, {
      logger: recordingLogger,
      timeoutMs: 5000,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            access_token: "a",
            refresh_token: "r",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      onAuthorizationUrl: async (authorizationUrl) => {
        const parsed = new URL(authorizationUrl);
        observedState = parsed.searchParams.get("state") ?? undefined;
        const redirectUri = parsed.searchParams.get("redirect_uri");
        await fetch(`${redirectUri}?code=c&state=${observedState}`);
      }
    });

    await client.ensureToken();

    expect(observedState).toBeTruthy();
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(observedState as string);
    expect(serialized).not.toMatch(/code_challenge=/);
    expect(serialized).not.toMatch(/redirect_uri=/);
  });

  it("acquires a token via the client_credentials grant", async () => {
    const server = createServerConfig({
      authFlow: "client_credentials",
      clientSecret: "machine-secret"
    });

    let captured: { url: string; body: URLSearchParams } | undefined;
    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async (input, init) => {
        captured = { url: String(input), body: parseFormBody(init) };
        return new Response(
          JSON.stringify({
            access_token: "machine-access",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    const token = await client.ensureToken();

    expect(token.accessToken).toBe("machine-access");
    expect(token.refreshToken).toBeUndefined();
    expect(token.expiresAt).toBeTypeOf("number");

    expect(captured?.url).toBe(server.tokenEndpoint);
    expect(captured?.body.get("grant_type")).toBe("client_credentials");
    expect(captured?.body.get("client_id")).toBe(server.clientId);
    expect(captured?.body.get("client_secret")).toBe("machine-secret");
    expect(captured?.body.get("scope")).toBe(server.scopes.join(" "));
  });

  it("re-acquires client_credentials when the cached token has no expiry (never trust a tokenless lifetime)", async () => {
    const server = createServerConfig({
      authFlow: "client_credentials",
      clientSecret: "machine-secret"
    });

    let calls = 0;
    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async () => {
        calls++;
        // Server omits expires_in — spec-allowed but operationally dangerous.
        return new Response(JSON.stringify({ access_token: `t-${calls}`, token_type: "Bearer" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });

    // First call acquires fresh.
    const t1 = await client.ensureToken();
    expect(t1.accessToken).toBe("t-1");
    expect(t1.expiresAt).toBeUndefined();

    // Passing the no-expiry cached token must still trigger re-acquisition.
    const t2 = await client.ensureToken(t1);
    expect(t2.accessToken).toBe("t-2");
    expect(calls).toBe(2);
  });

  it("aborts the client_credentials POST when it exceeds timeoutMs", async () => {
    const server = createServerConfig({
      authFlow: "client_credentials",
      clientSecret: "s"
    });

    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 50,
      fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        })) as typeof fetch
    });

    await expect(client.ensureToken()).rejects.toThrow();
  });

  it("re-acquires via client_credentials when the cached token expires (no refresh attempted)", async () => {
    const server = createServerConfig({
      authFlow: "client_credentials",
      clientSecret: "machine-secret"
    });

    const calls: URLSearchParams[] = [];
    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async (_input, init) => {
        calls.push(parseFormBody(init));
        return new Response(
          JSON.stringify({
            access_token: "fresh-machine",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    const token = await client.ensureToken({
      accessToken: "stale",
      tokenType: "Bearer",
      expiresAt: Date.now() - 1000
    });

    expect(token.accessToken).toBe("fresh-machine");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.get("grant_type")).toBe("client_credentials");
  });

  it("acquires a token via jwt_bearer (RFC 7523) using an env-sourced JWT", async () => {
    const server = createServerConfig({
      authFlow: "jwt_bearer",
      subjectTokenSource: { type: "env", var: "TEST_PLATFORM_JWT" }
    });

    let captured: URLSearchParams | undefined;
    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async (_input, init) => {
        captured = parseFormBody(init);
        return new Response(
          JSON.stringify({ access_token: "fed-access", token_type: "Bearer", expires_in: 600 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    process.env.TEST_PLATFORM_JWT = "platform.jwt.value";
    try {
      const token = await client.ensureToken();
      expect(token.accessToken).toBe("fed-access");
      expect(captured?.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      expect(captured?.get("assertion")).toBe("platform.jwt.value");
      expect(captured?.get("client_id")).toBe(server.clientId);
      expect(captured?.get("scope")).toBe(server.scopes.join(" "));
    } finally {
      delete process.env.TEST_PLATFORM_JWT;
    }
  });

  it("acquires a token via token_exchange (RFC 8693), including optional audience", async () => {
    const server = createServerConfig({
      authFlow: "token_exchange",
      subjectTokenSource: { type: "env", var: "TEST_PLATFORM_JWT2" },
      tokenExchangeAudience: "https://api.example.com"
    });

    let captured: URLSearchParams | undefined;
    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async (_input, init) => {
        captured = parseFormBody(init);
        return new Response(
          JSON.stringify({ access_token: "exchanged", token_type: "Bearer", expires_in: 600 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    process.env.TEST_PLATFORM_JWT2 = "subj.jwt.value";
    try {
      const token = await client.ensureToken();
      expect(token.accessToken).toBe("exchanged");
      expect(captured?.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
      expect(captured?.get("subject_token")).toBe("subj.jwt.value");
      expect(captured?.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:jwt");
      expect(captured?.get("audience")).toBe("https://api.example.com");
    } finally {
      delete process.env.TEST_PLATFORM_JWT2;
    }
  });

  it("re-acquires jwt_bearer when cached token has no expiry (machine flow policy)", async () => {
    const server = createServerConfig({
      authFlow: "jwt_bearer",
      subjectTokenSource: { type: "env", var: "TEST_PLATFORM_JWT3" }
    });

    let calls = 0;
    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify({ access_token: `t-${calls}`, token_type: "Bearer" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });

    process.env.TEST_PLATFORM_JWT3 = "jwt";
    try {
      const t1 = await client.ensureToken();
      expect(t1.accessToken).toBe("t-1");
      // Same as client_credentials: tokens with no expiry are never trusted.
      const t2 = await client.ensureToken(t1);
      expect(t2.accessToken).toBe("t-2");
      expect(calls).toBe(2);
    } finally {
      delete process.env.TEST_PLATFORM_JWT3;
    }
  });

  it("federated flows never log the platform JWT or clientSecret", async () => {
    const server = createServerConfig({
      authFlow: "jwt_bearer",
      clientSecret: "FEDERATED-SECRET-XYZ",
      subjectTokenSource: { type: "env", var: "TEST_PLATFORM_JWT4" }
    });

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

    const client = new OAuthClient(server, {
      logger: recordingLogger,
      timeoutMs: 5000,
      // Force a failure path so we exercise error logging too.
      fetchImpl: async () => new Response("invalid_grant", { status: 401 })
    });

    process.env.TEST_PLATFORM_JWT4 = "DO-NOT-LOG-THIS-JWT-VALUE";
    try {
      await expect(client.ensureToken()).rejects.toThrow();
    } finally {
      delete process.env.TEST_PLATFORM_JWT4;
    }

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("DO-NOT-LOG-THIS-JWT-VALUE");
    expect(serialized).not.toContain("FEDERATED-SECRET-XYZ");
  });

  it("does not log clientSecret on success or failure of client_credentials", async () => {
    const server = createServerConfig({
      authFlow: "client_credentials",
      clientSecret: "VERY-SECRET-VALUE"
    });

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

    const okClient = new OAuthClient(server, {
      logger: recordingLogger,
      timeoutMs: 5000,
      fetchImpl: async () =>
        new Response(JSON.stringify({ access_token: "a", token_type: "Bearer", expires_in: 60 }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    });
    await okClient.ensureToken();

    const failClient = new OAuthClient(server, {
      logger: recordingLogger,
      timeoutMs: 5000,
      fetchImpl: async () => new Response("invalid_client", { status: 401 })
    });
    await expect(failClient.ensureToken()).rejects.toThrow();

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("VERY-SECRET-VALUE");
  });

  it("refuses to start interactive flow when called with interactive=false (no cached token)", async () => {
    const server = createServerConfig();

    let fetchCalls = 0;
    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async () => {
        fetchCalls++;
        throw new Error("fetch must not be called in non-interactive path with no cached token");
      }
    });

    await expect(client.ensureToken(undefined, { interactive: false })).rejects.toThrow(
      /interactive authentication required/
    );
    expect(fetchCalls).toBe(0);
  });

  it("refreshes when interactive=false and a refresh token is cached", async () => {
    const server = createServerConfig();

    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async (_input, init) => {
        const body = parseFormBody(init);
        expect(body.get("grant_type")).toBe("refresh_token");
        return new Response(
          JSON.stringify({
            access_token: "refreshed",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    const token = await client.ensureToken(
      {
        accessToken: "old",
        tokenType: "Bearer",
        refreshToken: "rt",
        expiresAt: Date.now() - 1000
      },
      { interactive: false }
    );

    expect(token.accessToken).toBe("refreshed");
  });

  it("client_credentials works under interactive=false (no user, no browser)", async () => {
    const server = createServerConfig({
      authFlow: "client_credentials",
      clientSecret: "s"
    });

    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async () =>
        new Response(JSON.stringify({ access_token: "a", token_type: "Bearer", expires_in: 60 }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    });

    const token = await client.ensureToken(undefined, { interactive: false });
    expect(token.accessToken).toBe("a");
  });

  it("device_code skips OIDC discovery when tokenEndpoint + deviceAuthorizationEndpoint are configured", async () => {
    const server = createServerConfig({
      authFlow: "device_code",
      deviceAuthorizationEndpoint: "https://auth.example.com/device",
      // Intentionally omit authorizationEndpoint — the device flow doesn't need it.
      authorizationEndpoint: undefined as never
    });

    const calls: string[] = [];
    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 1000,
      sleep: async () => undefined,
      now: () => 1_000_000,
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        // Hard-fail discovery so we prove it was never called.
        if (url.includes("openid-configuration")) {
          throw new Error("discovery must not be called when device endpoints are explicit");
        }
        if (url === server.deviceAuthorizationEndpoint) {
          return new Response(
            JSON.stringify({
              device_code: "DC",
              user_code: "UC",
              verification_uri: "https://auth.example.com/device",
              expires_in: 60,
              interval: 1
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url === server.tokenEndpoint) {
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
        throw new Error(`unexpected URL: ${url}`);
      }
    } as never);

    const token = await client.ensureToken();
    expect(token.accessToken).toBe("a");
    expect(calls.some((u) => u.includes("openid-configuration"))).toBe(false);
  });

  it("treats a soon-to-expire token as invalid when skew exceeds remaining lifetime", async () => {
    const server = createServerConfig();

    let fetchCalls = 0;
    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      tokenExpirySkewMs: 30_000,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({
            access_token: "refreshed-access",
            token_type: "Bearer",
            expires_in: 3600
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
    });

    const token = await client.ensureToken({
      accessToken: "current",
      tokenType: "Bearer",
      refreshToken: "refresh",
      expiresAt: Date.now() + 10_000
    });

    expect(fetchCalls).toBe(1);
    expect(token.accessToken).toBe("refreshed-access");
  });

  it("treats a soon-to-expire token as valid when skew is below remaining lifetime", async () => {
    const server = createServerConfig();

    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      tokenExpirySkewMs: 5_000,
      fetchImpl: async () => {
        throw new Error("fetch should not be called for valid token");
      }
    });

    const expiresAt = Date.now() + 10_000;
    const token = await client.ensureToken({
      accessToken: "current",
      tokenType: "Bearer",
      refreshToken: "refresh",
      expiresAt
    });

    expect(token.accessToken).toBe("current");
    expect(token.expiresAt).toBe(expiresAt);
  });

  it("includes client_secret in authorization-code token exchange and refresh requests", async () => {
    const server = createServerConfig({ clientSecret: "super-secret-shh" });

    // First call: refresh
    let lastBody: URLSearchParams | undefined;
    const refreshClient = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async (_input, init) => {
        lastBody = parseFormBody(init);
        return new Response(
          JSON.stringify({
            access_token: "new-access",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    await refreshClient.ensureToken({
      accessToken: "old",
      tokenType: "Bearer",
      refreshToken: "old-refresh",
      expiresAt: Date.now() - 1000
    });

    expect(lastBody?.get("grant_type")).toBe("refresh_token");
    expect(lastBody?.get("client_secret")).toBe("super-secret-shh");

    // Second call: authorization_code exchange
    lastBody = undefined;
    const exchangeClient = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async (_input, init) => {
        lastBody = parseFormBody(init);
        return new Response(
          JSON.stringify({
            access_token: "a",
            refresh_token: "r",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      },
      onAuthorizationUrl: async (authorizationUrl) => {
        const parsed = new URL(authorizationUrl);
        const redirectUri = parsed.searchParams.get("redirect_uri");
        const state = parsed.searchParams.get("state");
        await fetch(`${redirectUri}?code=auth-code-123&state=${state}`);
      }
    });

    await exchangeClient.ensureToken();
    expect(lastBody?.get("grant_type")).toBe("authorization_code");
    expect(lastBody?.get("client_secret")).toBe("super-secret-shh");
    expect(lastBody?.get("code_verifier")).toBeTruthy();
  });

  it("does not leak clientSecret into structured logs on success or failure", async () => {
    const server = createServerConfig({ clientSecret: "leaky-secret-9000" });

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

    // Success path: authorization_code exchange.
    const successClient = new OAuthClient(server, {
      logger: recordingLogger,
      timeoutMs: 5000,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            access_token: "a",
            refresh_token: "r",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      onAuthorizationUrl: async (authorizationUrl) => {
        const parsed = new URL(authorizationUrl);
        const redirectUri = parsed.searchParams.get("redirect_uri");
        const state = parsed.searchParams.get("state");
        await fetch(`${redirectUri}?code=c&state=${state}`);
      }
    });

    await successClient.ensureToken();

    // Failure path: refresh fails with a 400, then the auth-code exchange
    // also fails. The server might echo the secret-bearing body in some
    // configurations; we must not include the secret in our own error logs
    // regardless.
    const failClient = new OAuthClient(server, {
      logger: recordingLogger,
      timeoutMs: 5000,
      fetchImpl: async () =>
        new Response("bad request", {
          status: 400,
          headers: { "Content-Type": "text/plain" }
        }),
      onAuthorizationUrl: async (authorizationUrl) => {
        const parsed = new URL(authorizationUrl);
        const redirectUri = parsed.searchParams.get("redirect_uri");
        const state = parsed.searchParams.get("state");
        await fetch(`${redirectUri}?code=c&state=${state}`);
      }
    });

    await expect(
      failClient.ensureToken({
        accessToken: "x",
        tokenType: "Bearer",
        refreshToken: "expired",
        expiresAt: Date.now() - 1000
      })
    ).rejects.toThrow();

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("leaky-secret-9000");
  });

  it("fails interactive login when provider does not return a refresh token", async () => {
    const server = createServerConfig();

    const client = new OAuthClient(server, {
      logger: createSilentLogger(),
      timeoutMs: 5000,
      fetchImpl: async () => {
        return new Response(
          JSON.stringify({
            access_token: "access-only",
            token_type: "Bearer"
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      },
      onAuthorizationUrl: async (authorizationUrl) => {
        const parsed = new URL(authorizationUrl);
        const redirectUri = parsed.searchParams.get("redirect_uri");
        const state = parsed.searchParams.get("state");

        await fetch(`${redirectUri}?code=auth-code-123&state=${state}`);
      }
    });

    await expect(client.ensureToken()).rejects.toThrow(/refresh_token/i);
  });
});
