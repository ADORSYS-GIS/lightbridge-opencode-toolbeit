import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OpencodeOauth2Plugin, PLUGIN_ID, createOpencodeOauth2Plugin } from "../src/opencode.js";
import {
  type Harness,
  OAUTH_BLOCK,
  recordingLogger,
  requestEvent,
  seedCache,
  startPlugin
} from "./harness.js";

const open: Harness[] = [];

function settingsOf(
  record: { provider: Record<string, unknown> } | undefined
): Record<string, unknown> {
  return (record?.provider.settings ?? {}) as Record<string, unknown>;
}

async function start(...args: Parameters<typeof startPlugin>): Promise<Harness> {
  const harness = await startPlugin(...args);
  open.push(harness);
  return harness;
}

async function freshCacheDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

const declared = (settings: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => [
  {
    id: "example-ai",
    name: "Example AI",
    settings: { baseURL: "https://api.example.com/v1", oauth2: { ...OAUTH_BLOCK, ...settings } },
    ...extra
  }
];

describe("plugin identity", () => {
  it("has a stable id", () => {
    expect(PLUGIN_ID).toBe("vymalo.oauth2");
    expect(createOpencodeOauth2Plugin().id).toBe(PLUGIN_ID);
    expect(OpencodeOauth2Plugin.id).toBe(PLUGIN_ID);
  });

  it("registers a provider transform and the model.request / http.response hooks", async () => {
    const harness = await start({ sources: [] });
    expect([...harness.hooks.keys()].sort()).toEqual(["http.response", "model.request"]);
  });
});

describe("provider transform + model.request", () => {
  it("configures a settings.oauth2 provider, merges models and injects the bearer", async () => {
    const cacheDir = await freshCacheDir("opencode-v2-settings-");
    await seedCache(cacheDir);
    const harness = await start({ cacheDir, sources: declared() });

    harness.runTransform();
    await harness.settle();

    const record = harness.provider("example-ai");
    expect(record?.provider.package).toBe("aisdk:@ai-sdk/openai-compatible");
    expect(record?.models.get("glm-5")?.name).toBe("GLM 5");
    expect(harness.reloads()).toBe(1);

    const event = requestEvent("example-ai");
    await harness.call("model.request", event);
    expect(event.headers.Authorization).toBe("Bearer cached-access");
  });

  it("propagates the cached bearer onto Provider.Info.headers for downstream consumers", async () => {
    // The composition contract for @vymalo/opencode-models-info: once the
    // managed provider has been reloaded it carries a usable Authorization
    // header, so an OAuth2-protected metadata fetch inherits the token.
    const cacheDir = await freshCacheDir("opencode-v2-propagate-");
    await seedCache(cacheDir);
    const harness = await start({ cacheDir, sources: declared() });

    harness.runTransform();
    // Before the background build there is no token to propagate.
    expect(harness.provider("example-ai")?.provider.headers).toBeUndefined();
    await harness.settle();

    const headers = harness.provider("example-ai")?.provider.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer cached-access");
  });

  it("refreshes a near-expiry token during propagation instead of skipping it", async () => {
    // Regression guard: a token minted moments ago for a short-lived realm used
    // to fail the fixed expiry-skew gate and never get stamped, leaving
    // models-info to fetch an OAuth2-protected endpoint with no Authorization.
    // Propagation goes through a refresh-only ensure, so the header carries a
    // *fresh* token.
    const cacheDir = await freshCacheDir("opencode-v2-refresh-");
    // Inside the OAuth client's 30s validity skew -> treated as expired.
    await seedCache(cacheDir, { accessToken: "stale-access", expiresAt: Date.now() + 5_000 });

    const harness = await start({
      cacheDir,
      sources: declared({
        // Explicit endpoints so refresh skips OIDC discovery (no network).
        authorizationEndpoint: "https://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token"
      }),
      factory: {
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input) === "https://auth.example.com/token") {
            expect(new URLSearchParams(String(init?.body ?? "")).get("grant_type")).toBe(
              "refresh_token"
            );
            return new Response(
              JSON.stringify({
                access_token: "refreshed-access",
                refresh_token: "refreshed-refresh",
                token_type: "Bearer",
                expires_in: 3600
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          // Model discovery against the gateway: nothing to report.
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }) as typeof fetch
      }
    });

    harness.runTransform();
    await harness.settle();

    const headers = harness.provider("example-ai")?.provider.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer refreshed-access");
  });

  it("does not overwrite a user-set Authorization header during propagation", async () => {
    const cacheDir = await freshCacheDir("opencode-v2-userauth-");
    await seedCache(cacheDir);
    const harness = await start({
      cacheDir,
      // Lowercase to also exercise the case-insensitive guard.
      sources: declared({}, { headers: { authorization: "Bearer user-override" } })
    });

    harness.runTransform();
    await harness.settle();

    const headers = harness.provider("example-ai")?.provider.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer user-override");
    expect(headers.Authorization).toBeUndefined();
  });

  it("materializes providers from options.servers", async () => {
    const cacheDir = await freshCacheDir("opencode-v2-options-");
    const harness = await start({
      cacheDir,
      options: {
        servers: [
          {
            id: "server-from-options",
            name: "Server from options",
            issuer: "https://auth.example.com",
            baseURL: "https://api.example.com/v1",
            clientId: "opencode-client",
            scopes: ["openid", "offline_access"]
          }
        ]
      }
    });

    harness.runTransform();
    const record = harness.provider("server-from-options");
    expect(record?.provider.package).toBe("aisdk:@ai-sdk/openai-compatible");
    expect(record?.provider.name).toBe("Server from options");
    expect(record?.provider.activation).toBe("enabled");
    expect(settingsOf(record).baseURL).toBe("https://api.example.com/v1");
  });

  it("leaves every managed provider self-describing for other plugins' guards", async () => {
    const harness = await start({
      sources: declared(),
      options: {
        servers: [
          {
            id: "from-options",
            issuer: "https://auth.example.com",
            baseURL: "https://api.example.com/v1",
            clientId: "c",
            scopes: ["openid"]
          }
        ]
      }
    });
    harness.runTransform();

    // Declared block survives untouched; options.servers gets a marker.
    expect(settingsOf(harness.provider("example-ai")).oauth2).toMatchObject({
      clientId: "opencode-client"
    });
    expect(settingsOf(harness.provider("from-options")).oauth2).toEqual({
      managed: true,
      source: "options.servers"
    });
  });

  it("does not manage a provider without an oauth2 opt-in", async () => {
    const harness = await start({
      sources: [{ id: "plain", settings: { baseURL: "https://x.test/v1" } }]
    });
    harness.runTransform();
    await harness.settle();

    const event = requestEvent("plain");
    await harness.call("model.request", event);
    expect(event.headers.Authorization).toBeUndefined();
    expect(harness.handle.runtime()).toBeUndefined();
  });

  it("parses clientSecret + device_code authFlow from settings.oauth2", async () => {
    const harness = await start({
      sources: declared({
        clientSecret: "secret-from-provider",
        authFlow: "device_code",
        deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize"
      })
    });
    harness.runTransform();
    expect(harness.provider("example-ai")?.provider.package).toBe(
      "aisdk:@ai-sdk/openai-compatible"
    );
  });

  it("parses clientSecret + device_code authFlow from options.servers", async () => {
    const harness = await start({
      options: {
        servers: [
          {
            id: "server-secret",
            issuer: "https://auth.example.com",
            baseURL: "https://api.example.com/v1",
            clientId: "opencode-client",
            clientSecret: "secret-from-options",
            scopes: ["openid"],
            authFlow: "device_code",
            deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize"
          }
        ]
      }
    });
    harness.runTransform();
    expect(harness.provider("server-secret")?.provider.package).toBe(
      "aisdk:@ai-sdk/openai-compatible"
    );
  });

  it("accepts the plugin's own logLevel option", async () => {
    const harness = await start({
      options: {
        logLevel: "DEBUG",
        servers: [
          {
            id: "server-1",
            issuer: "https://auth.example.com",
            baseURL: "https://api.example.com/v1",
            clientId: "opencode-client",
            scopes: ["openid"]
          }
        ]
      }
    });
    harness.runTransform();
    expect(harness.provider("server-1")?.provider.package).toBe("aisdk:@ai-sdk/openai-compatible");
  });

  it("serves only one runtime across repeated transform passes", async () => {
    const cacheDir = await freshCacheDir("opencode-v2-repeat-");
    await seedCache(cacheDir);
    const harness = await start({ cacheDir, sources: declared() });

    harness.runTransform();
    await harness.settle();
    const runtime = harness.handle.runtime();
    expect(runtime).toBeDefined();

    harness.runTransform();
    harness.runTransform();
    await harness.settle();
    expect(harness.handle.runtime()).toBe(runtime);
    // Only the build's own reload — passes with an unchanged server set queue nothing.
    expect(harness.reloads()).toBe(1);
  });

  it("rebuilds when the server set changes and stops managing a removed provider", async () => {
    const cacheDir = await freshCacheDir("opencode-v2-rebuild-");
    await seedCache(cacheDir);
    const sources = declared();
    const harness = await start({ cacheDir, sources });

    harness.runTransform();
    await harness.settle();
    const first = harness.handle.runtime();

    sources[0].settings = {
      baseURL: "https://api.example.com/v1",
      oauth2: { ...OAUTH_BLOCK, scopes: ["openid", "offline_access", "extra"] }
    };
    harness.runTransform();
    await harness.settle();
    const second = harness.handle.runtime();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);

    sources.length = 0;
    harness.runTransform();
    await harness.settle();
    expect(harness.handle.runtime()).toBeUndefined();
  });
});

describe("tuning options", () => {
  it("passes cacheNamespace, httpTimeoutMs and tokenExpirySkewMs through to the engine", async () => {
    const cacheDir = await freshCacheDir("opencode-v2-tuning-");
    const harness = await start({
      cacheDir,
      sources: declared(),
      options: { cacheNamespace: "custom-ns", httpTimeoutMs: 1234, tokenExpirySkewMs: 5678 }
    });
    harness.runTransform();
    await harness.settle();

    const config = (harness.handle.runtime() as unknown as { config: Record<string, unknown> })
      .config;
    expect(config).toMatchObject({
      cacheNamespace: "custom-ns",
      httpTimeoutMs: 1234,
      tokenExpirySkewMs: 5678
    });
  });

  it("keeps the defaults, including the shared cache namespace, when unset", async () => {
    const harness = await start({ sources: declared() });
    harness.runTransform();
    await harness.settle();

    const config = (harness.handle.runtime() as unknown as { config: Record<string, unknown> })
      .config;
    expect(config).toMatchObject({
      cacheNamespace: "opencode-oauth2-model-sync",
      httpTimeoutMs: 15000,
      tokenExpirySkewMs: 30000
    });
  });

  it("logs an invalid tokenExpirySkewMs as a failed build", async () => {
    const logger = recordingLogger();
    const harness = await start({
      sources: declared(),
      options: { tokenExpirySkewMs: -1 },
      factory: { logger }
    });
    harness.runTransform();
    await harness.settle();
    expect(logger.error).toHaveBeenCalledWith(
      "oauth2_runtime_build_failed",
      expect.objectContaining({ error: expect.stringMatching(/tokenExpirySkewMs/) })
    );
  });
});

describe("invalid user config is reported, not thrown", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      "an out-of-range redirectPort in settings.oauth2",
      { sources: declared({ redirectPort: 70000 }) },
      /redirectPort/
    ],
    [
      "a non-numeric redirectPort in options.servers",
      {
        options: {
          servers: [
            {
              id: "bad-port-server",
              issuer: "https://auth.example.com",
              baseURL: "https://api.example.com/v1",
              clientId: "opencode-client",
              scopes: ["openid"],
              redirectPort: "not-a-number"
            }
          ]
        }
      },
      /redirectPort/
    ],
    ["an unknown authFlow", { sources: declared({ authFlow: "implicit" }) }, /authFlow/],
    ["a non-boolean responseApi", { sources: declared({ responseApi: "yes" }) }, /responseApi/]
  ];

  for (const [name, startOptions, pattern] of cases) {
    it(`logs oauth2_config_invalid for ${name} and manages nothing`, async () => {
      const logger = recordingLogger();
      const harness = await start({
        ...(startOptions as Parameters<typeof startPlugin>[0]),
        factory: { logger }
      });

      expect(() => harness.runTransform()).not.toThrow();
      await harness.settle();

      expect(logger.error).toHaveBeenCalledWith(
        "oauth2_config_invalid",
        expect.objectContaining({ error: expect.stringMatching(pattern) })
      );
      expect(harness.handle.runtime()).toBeUndefined();
    });
  }
});

describe("responseApi", () => {
  it("routes a settings.oauth2 responseApi provider through @ai-sdk/openai and still injects the real bearer", async () => {
    // responseApi swaps the emitted package to the native OpenAI provider
    // (Responses API) and stamps an inert placeholder apiKey so its
    // construction-time key guard passes. The real token is injected
    // per-request by model.request — the placeholder never leaves the process.
    const cacheDir = await freshCacheDir("opencode-v2-responses-");
    await seedCache(cacheDir);
    const harness = await start({ cacheDir, sources: declared({ responseApi: true }) });

    harness.runTransform();
    await harness.settle();

    const record = harness.provider("example-ai");
    expect(record?.provider.package).toBe("aisdk:@ai-sdk/openai");
    const settings = record?.provider.settings as Record<string, unknown>;
    expect(settings.apiKey).toBe("oauth2-managed-bearer");
    expect(settings.baseURL).toBe("https://api.example.com/v1");

    // The host may merge the placeholder key into the request as Authorization;
    // the plugin must replace it, whatever the header's case.
    const event = requestEvent("example-ai", { authorization: "Bearer oauth2-managed-bearer" });
    await harness.call("model.request", event);
    expect(event.headers.Authorization).toBe("Bearer cached-access");
    expect(event.headers.authorization).toBeUndefined();
  });

  it("routes a responseApi server from options.servers through @ai-sdk/openai", async () => {
    const harness = await start({
      options: {
        servers: [
          {
            id: "responses-server",
            issuer: "https://auth.example.com",
            baseURL: "https://api.example.com/v1",
            clientId: "opencode-client",
            scopes: ["openid"],
            responseApi: true
          }
        ]
      }
    });
    harness.runTransform();

    const record = harness.provider("responses-server");
    expect(record?.provider.package).toBe("aisdk:@ai-sdk/openai");
    expect(settingsOf(record).apiKey).toBe("oauth2-managed-bearer");
  });

  it("does not overwrite a user-supplied apiKey", async () => {
    const harness = await start({
      sources: [
        {
          id: "example-ai",
          settings: {
            baseURL: "https://api.example.com/v1",
            apiKey: "user-supplied-key",
            oauth2: { ...OAUTH_BLOCK, scopes: ["openid"], responseApi: true }
          }
        }
      ]
    });
    harness.runTransform();

    const record = harness.provider("example-ai");
    expect(record?.provider.package).toBe("aisdk:@ai-sdk/openai");
    expect(settingsOf(record).apiKey).toBe("user-supplied-key");
  });

  it("scrubs the placeholder apiKey when responseApi loses across duplicate config shapes", async () => {
    // Same provider id in both shapes: the options.servers entry enables
    // responseApi (placeholder + @ai-sdk/openai), but the provider's own
    // settings.oauth2 block omits it and must win — leaving a clean
    // Chat-Completions provider with no leftover fake key.
    const harness = await start({
      sources: [
        {
          id: "dup-ai",
          settings: {
            baseURL: "https://api.example.com/v1",
            oauth2: { ...OAUTH_BLOCK, scopes: ["openid"] }
          }
        }
      ],
      options: {
        servers: [
          {
            id: "dup-ai",
            issuer: "https://auth.example.com",
            baseURL: "https://api.example.com/v1",
            clientId: "opencode-client",
            scopes: ["openid"],
            responseApi: true
          }
        ]
      }
    });
    harness.runTransform();

    const record = harness.provider("dup-ai");
    expect(record?.provider.package).toBe("aisdk:@ai-sdk/openai-compatible");
    expect(settingsOf(record).apiKey).toBeUndefined();
  });
});

describe("model.request", () => {
  it("leaves a managed provider's request alone when no runtime exists for it", async () => {
    const harness = await start({ sources: [] });
    harness.runTransform();
    const event = requestEvent("example-ai", { Authorization: "Bearer other" });
    await harness.call("model.request", event);
    expect(event.headers.Authorization).toBe("Bearer other");
  });

  it("fails closed and logs when no token can be obtained", async () => {
    // Empty cache + a non-interactive-incapable flow with no endpoints: the
    // lazy ensure cannot produce a token, so the request must not go out.
    const logger = recordingLogger();
    const harness = await start({
      factory: { logger },
      sources: declared({
        authFlow: "client_credentials",
        clientSecret: "s",
        tokenEndpoint: "https://auth.example.com/token",
        authorizationEndpoint: "https://auth.example.com/authorize"
      })
    });
    harness.runTransform();
    await harness.settle();

    const event = requestEvent("example-ai", { Authorization: "Bearer placeholder" });
    await expect(harness.call("model.request", event)).rejects.toBeDefined();

    expect(logger.error).toHaveBeenCalledWith(
      "oauth2_model_request_token_failed",
      expect.objectContaining({ providerId: "example-ai" })
    );
  });

  it("kicks off a lazy model sync and reloads once models appear", async () => {
    const cacheDir = await freshCacheDir("opencode-v2-lazy-");
    await seedCache(cacheDir);
    // Warmup discovers nothing, so the provider has no models and a token; the
    // first request then triggers the lazy sync, which finds one.
    let discovered: Array<{ id: string }> = [];
    const harness = await start({
      cacheDir,
      sources: declared(),
      factory: {
        fetchImpl: (async () =>
          new Response(JSON.stringify({ data: discovered }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          })) as typeof fetch
      }
    });
    harness.runTransform();
    await harness.settle();
    expect(harness.handle.runtime()?.getServerModels("example-ai")).toEqual([]);

    discovered = [{ id: "late-model" }];
    const before = harness.reloads();
    await harness.call("model.request", requestEvent("example-ai"));
    await vi.waitFor(() => expect(harness.reloads()).toBeGreaterThan(before));

    expect(harness.provider("example-ai")?.models.has("late-model")).toBe(true);
  });
});

describe("scope teardown", () => {
  it("stops the engine's scheduler when the plugin scope closes", async () => {
    const cacheDir = await freshCacheDir("opencode-v2-teardown-");
    await seedCache(cacheDir);
    const harness = await start({ cacheDir, sources: declared() });
    harness.runTransform();
    await harness.settle();

    const runtime = harness.handle.runtime() as unknown as {
      runtimeByServer: Map<string, { scheduler?: unknown; ownsScheduler?: boolean }>;
    };
    expect(runtime.runtimeByServer.get("example-ai")?.ownsScheduler).toBe(true);

    await harness.close();
    expect(runtime.runtimeByServer.get("example-ai")?.ownsScheduler).toBe(false);
  });
});
