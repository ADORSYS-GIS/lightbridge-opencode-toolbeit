import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FileCacheStore } from "../src/cache.js";
import { createOpencodeOauth2Plugin, fromOpenCodeLogLevel } from "../src/opencode.js";
import { createSilentLogger } from "./helpers.js";

async function createHooks(cacheDir: string) {
  const plugin = createOpencodeOauth2Plugin({
    cacheDir,
    logger: createSilentLogger(),
    fetchImpl: async () => {
      throw new Error("fetch is not expected in these hook tests");
    }
  });

  return plugin({
    client: {
      app: {
        log: async () => ({ data: true })
      }
    },
    project: { id: "project-1" },
    directory: process.cwd(),
    worktree: process.cwd(),
    serverUrl: new URL("http://127.0.0.1:3000"),
    $: {} as never
  } as never);
}

describe("OpenCode plugin hooks", () => {
  it("configures provider from provider.options extension and injects auth header", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-cache-"));
    const cache = new FileCacheStore(cacheDir);
    await cache.ensureReady();

    await cache.saveServerState({
      serverId: "example-ai",
      updatedAt: Date.now(),
      lastSyncAt: Date.now(),
      token: {
        accessToken: "cached-access",
        tokenType: "Bearer",
        refreshToken: "cached-refresh",
        expiresAt: Date.now() + 60_000
      },
      rawModels: [{ id: "glm-5" }],
      models: [{ id: "glm-5", displayName: "GLM 5" }]
    });

    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      provider: {
        "example-ai": {
          name: "Example AI",
          options: {
            baseURL: "https://api.example.com/v1",
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              scopes: ["openid", "offline_access"]
            }
          }
        }
      }
    };

    await hooks.config?.(config as never);

    const providerConfig = (config.provider as Record<string, Record<string, unknown>>)[
      "example-ai"
    ];
    expect(providerConfig.npm).toBe("@ai-sdk/openai-compatible");

    const models = providerConfig.models as Record<string, Record<string, unknown>>;
    expect(models["glm-5"]?.name).toBe("GLM 5");

    const output = { headers: {} as Record<string, string> };
    await hooks["chat.headers"]?.(
      {
        sessionID: "session-1",
        agent: "general",
        model: { id: "glm-5", providerID: "example-ai" },
        provider: {
          source: "config",
          info: { id: "example-ai" },
          options: {}
        },
        message: { id: "message-1" }
      } as never,
      output
    );

    expect(output.headers.Authorization).toBe("Bearer cached-access");
  });

  it("uses model.providerID when provider context is not populated by the host", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-providerid-"));
    const cache = new FileCacheStore(cacheDir);
    await cache.ensureReady();

    await cache.saveServerState({
      serverId: "example-ai",
      updatedAt: Date.now(),
      lastSyncAt: Date.now(),
      token: {
        accessToken: "cached-access",
        tokenType: "Bearer",
        refreshToken: "cached-refresh",
        expiresAt: Date.now() + 60_000
      },
      rawModels: [{ id: "glm-5" }],
      models: [{ id: "glm-5", displayName: "GLM 5" }]
    });

    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      provider: {
        "example-ai": {
          name: "Example AI",
          options: {
            baseURL: "https://api.example.com/v1",
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              scopes: ["openid", "offline_access"]
            }
          }
        }
      }
    };

    await hooks.config?.(config as never);

    const output = { headers: {} as Record<string, string> };
    await hooks["chat.headers"]?.(
      {
        sessionID: "session-1",
        agent: "general",
        model: { id: "glm-5", providerID: "example-ai" },
        message: { id: "message-1" }
      } as never,
      output
    );

    expect(output.headers.Authorization).toBe("Bearer cached-access");
  });

  it("propagates the cached bearer into provider.options.headers for downstream config-time consumers", async () => {
    // The composition contract for @vymalo/opencode-models-info: by the time
    // a later `config` hook walks `config.provider[*]`, every managed
    // provider already carries a usable `Authorization` header so an
    // OAuth2-protected `meta.modelsInfoUrl` fetch inherits the token without
    // depending on this plugin.
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-propagate-"));
    const cache = new FileCacheStore(cacheDir);
    await cache.ensureReady();

    await cache.saveServerState({
      serverId: "example-ai",
      updatedAt: Date.now(),
      lastSyncAt: Date.now(),
      token: {
        accessToken: "cached-access",
        tokenType: "Bearer",
        refreshToken: "cached-refresh",
        expiresAt: Date.now() + 60_000
      },
      rawModels: [{ id: "glm-5" }],
      models: [{ id: "glm-5", displayName: "GLM 5" }]
    });

    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      provider: {
        "example-ai": {
          options: {
            baseURL: "https://api.example.com/v1",
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              scopes: ["openid", "offline_access"]
            }
          }
        }
      }
    };

    await hooks.config?.(config as never);

    const providerOptions = (config.provider as Record<string, Record<string, unknown>>)[
      "example-ai"
    ].options as Record<string, unknown>;
    const headers = providerOptions.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer cached-access");
  });

  it("refreshes a near-expiry token during propagation instead of skipping it", async () => {
    // Regression guard: a token minted moments ago for a short-lived realm used
    // to fail the fixed config-time expiry-skew gate and never get stamped,
    // leaving @vymalo/opencode-models-info to fetch an OAuth2-protected
    // `meta.modelsInfoUrl` with no Authorization (HTTP 401). Propagation now
    // goes through a refresh-only ensure, so the header carries a *fresh* token.
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-refresh-"));
    const cache = new FileCacheStore(cacheDir);
    await cache.ensureReady();

    await cache.saveServerState({
      serverId: "example-ai",
      updatedAt: Date.now(),
      lastSyncAt: Date.now(),
      token: {
        accessToken: "stale-access",
        tokenType: "Bearer",
        refreshToken: "cached-refresh",
        // Inside the OAuth client's 30s validity skew → treated as expired.
        expiresAt: Date.now() + 5_000
      },
      rawModels: [{ id: "glm-5" }],
      models: [{ id: "glm-5", displayName: "GLM 5" }]
    });

    const plugin = createOpencodeOauth2Plugin({
      cacheDir,
      logger: createSilentLogger(),
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body ?? ""));
        if (String(input) === "https://auth.example.com/token") {
          expect(body.get("grant_type")).toBe("refresh_token");
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
        throw new Error(`unexpected fetch: ${String(input)}`);
      }) as typeof fetch
    });

    const hooks = await plugin({
      client: { app: { log: async () => ({ data: true }) } },
      project: { id: "project-1" },
      directory: process.cwd(),
      worktree: process.cwd(),
      serverUrl: new URL("http://127.0.0.1:3000"),
      $: {} as never
    } as never);

    const config: Record<string, unknown> = {
      provider: {
        "example-ai": {
          options: {
            baseURL: "https://api.example.com/v1",
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              scopes: ["openid", "offline_access"],
              // Explicit endpoints so refresh skips OIDC discovery (no network).
              authorizationEndpoint: "https://auth.example.com/authorize",
              tokenEndpoint: "https://auth.example.com/token"
            }
          }
        }
      }
    };

    await hooks.config?.(config as never);

    const headers = (
      (config.provider as Record<string, Record<string, unknown>>)["example-ai"].options as Record<
        string,
        unknown
      >
    ).headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer refreshed-access");
  });

  it("does not overwrite a user-set Authorization header during propagation", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-userauth-"));
    const cache = new FileCacheStore(cacheDir);
    await cache.ensureReady();

    await cache.saveServerState({
      serverId: "example-ai",
      updatedAt: Date.now(),
      lastSyncAt: Date.now(),
      token: {
        accessToken: "cached-access",
        tokenType: "Bearer",
        refreshToken: "cached-refresh",
        expiresAt: Date.now() + 60_000
      },
      rawModels: [{ id: "glm-5" }],
      models: [{ id: "glm-5", displayName: "GLM 5" }]
    });

    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      provider: {
        "example-ai": {
          options: {
            baseURL: "https://api.example.com/v1",
            // Lowercase to also exercise the case-insensitive guard.
            headers: { authorization: "Bearer user-override" },
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              scopes: ["openid", "offline_access"]
            }
          }
        }
      }
    };

    await hooks.config?.(config as never);

    const headers = (
      (config.provider as Record<string, Record<string, unknown>>)["example-ai"].options as Record<
        string,
        unknown
      >
    ).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer user-override");
    expect(headers.Authorization).toBeUndefined();
  });

  it("rejects invalid redirectPort in provider.options.oauth2", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-badport-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      provider: {
        "example-ai": {
          options: {
            baseURL: "https://api.example.com/v1",
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              scopes: ["openid", "offline_access"],
              redirectPort: 70000
            }
          }
        }
      }
    };

    await expect(hooks.config?.(config as never)).rejects.toThrow(/redirectPort/);
  });

  it("rejects invalid redirectPort in pluginConfig.oauth2ModelSync.servers", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-badport-plugincfg-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      pluginConfig: {
        oauth2ModelSync: {
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
      }
    };

    await expect(hooks.config?.(config as never)).rejects.toThrow(/redirectPort/);
  });

  it("parses clientSecret + device_code authFlow from provider.options.oauth2", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-secret-provider-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      provider: {
        "example-ai": {
          name: "Example AI",
          options: {
            baseURL: "https://api.example.com/v1",
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              clientSecret: "secret-from-provider",
              scopes: ["openid", "offline_access"],
              authFlow: "device_code",
              deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize"
            }
          }
        }
      }
    };

    // Resolve should accept without throwing; the runtime is constructed and
    // wired up from this config — but we don't actually call the chat hook
    // here (which would attempt an OAuth flow), we just confirm parsing.
    await hooks.config?.(config as never);

    const providers = config.provider as Record<string, Record<string, unknown>>;
    expect(providers["example-ai"]?.npm).toBe("@ai-sdk/openai-compatible");
  });

  it("parses clientSecret + device_code authFlow from pluginConfig.oauth2ModelSync.servers", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-secret-plugincfg-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      pluginConfig: {
        oauth2ModelSync: {
          servers: [
            {
              id: "server-secret",
              issuer: "https://auth.example.com",
              baseURL: "https://api.example.com/v1",
              clientId: "opencode-client",
              clientSecret: "secret-from-plugin-config",
              scopes: ["openid"],
              authFlow: "device_code",
              deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize"
            }
          ]
        }
      }
    };

    await hooks.config?.(config as never);

    const providers = config.provider as Record<string, Record<string, unknown>>;
    expect(providers["server-secret"]).toBeDefined();
    expect(providers["server-secret"]?.npm).toBe("@ai-sdk/openai-compatible");
  });

  it("rejects unknown authFlow values from both config shapes", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-bad-authflow-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      provider: {
        "example-ai": {
          options: {
            baseURL: "https://api.example.com/v1",
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              scopes: ["openid"],
              authFlow: "implicit"
            }
          }
        }
      }
    };

    await expect(hooks.config?.(config as never)).rejects.toThrow(/authFlow/);
  });

  it("supports pluginConfig.oauth2ModelSync.servers and materializes provider entries", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-pluginconfig-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      pluginConfig: {
        oauth2ModelSync: {
          servers: [
            {
              id: "server-from-plugin-config",
              name: "Server from plugin config",
              issuer: "https://auth.example.com",
              baseURL: "https://api.example.com/v1",
              clientId: "opencode-client",
              scopes: ["openid", "offline_access"]
            }
          ]
        }
      }
    };

    await hooks.config?.(config as never);

    const providers = config.provider as Record<string, Record<string, unknown>>;
    expect(providers["server-from-plugin-config"]).toBeDefined();
    expect(providers["server-from-plugin-config"]?.npm).toBe("@ai-sdk/openai-compatible");

    const options = providers["server-from-plugin-config"]?.options as Record<string, unknown>;
    expect(options.baseURL).toBe("https://api.example.com/v1");
  });

  it("accepts an OpenCode host logLevel without requiring a plugin-specific override", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-host-loglevel-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      logLevel: "DEBUG",
      pluginConfig: {
        oauth2ModelSync: {
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
      }
    };

    await expect(hooks.config?.(config as never)).resolves.not.toThrow();

    const providers = config.provider as Record<string, Record<string, unknown>>;
    expect(providers["server-1"]?.npm).toBe("@ai-sdk/openai-compatible");
  });

  it("routes a responseApi provider through @ai-sdk/openai while still injecting the real bearer", async () => {
    // responseApi swaps the emitted npm to the native OpenAI provider (Responses
    // API by default since AI SDK v5) and stamps an inert placeholder apiKey so
    // its construction-time key guard passes. The real token is still injected
    // per-request by chat.headers — the placeholder never leaves the process.
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-responses-provider-"));
    const cache = new FileCacheStore(cacheDir);
    await cache.ensureReady();

    await cache.saveServerState({
      serverId: "example-ai",
      updatedAt: Date.now(),
      lastSyncAt: Date.now(),
      token: {
        accessToken: "cached-access",
        tokenType: "Bearer",
        refreshToken: "cached-refresh",
        expiresAt: Date.now() + 60_000
      },
      rawModels: [{ id: "glm-5" }],
      models: [{ id: "glm-5", displayName: "GLM 5" }]
    });

    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      provider: {
        "example-ai": {
          options: {
            baseURL: "https://api.example.com/v1",
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              scopes: ["openid", "offline_access"],
              responseApi: true
            }
          }
        }
      }
    };

    await hooks.config?.(config as never);

    const providerConfig = (config.provider as Record<string, Record<string, unknown>>)[
      "example-ai"
    ];
    expect(providerConfig.npm).toBe("@ai-sdk/openai");

    const options = providerConfig.options as Record<string, unknown>;
    expect(options.apiKey).toBe("oauth2-managed-bearer");
    expect(options.baseURL).toBe("https://api.example.com/v1");

    const output = { headers: {} as Record<string, string> };
    await hooks["chat.headers"]?.(
      {
        sessionID: "session-1",
        agent: "general",
        model: { id: "glm-5", providerID: "example-ai" },
        message: { id: "message-1" }
      } as never,
      output
    );

    expect(output.headers.Authorization).toBe("Bearer cached-access");
  });

  it("routes a responseApi server from pluginConfig through @ai-sdk/openai", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-responses-plugincfg-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      pluginConfig: {
        oauth2ModelSync: {
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
      }
    };

    await hooks.config?.(config as never);

    const providers = config.provider as Record<string, Record<string, unknown>>;
    expect(providers["responses-server"]?.npm).toBe("@ai-sdk/openai");

    const options = providers["responses-server"]?.options as Record<string, unknown>;
    expect(options.apiKey).toBe("oauth2-managed-bearer");
  });

  it("does not overwrite a user-supplied apiKey when responseApi is enabled", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-responses-userkey-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      provider: {
        "example-ai": {
          options: {
            baseURL: "https://api.example.com/v1",
            apiKey: "user-supplied-key",
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              scopes: ["openid"],
              responseApi: true
            }
          }
        }
      }
    };

    await hooks.config?.(config as never);

    const providerConfig = (config.provider as Record<string, Record<string, unknown>>)[
      "example-ai"
    ];
    expect(providerConfig.npm).toBe("@ai-sdk/openai");
    expect((providerConfig.options as Record<string, unknown>).apiKey).toBe("user-supplied-key");
  });

  it("scrubs the placeholder apiKey when responseApi loses across duplicate config shapes", async () => {
    // Same provider id in both shapes: the pluginConfig server enables
    // responseApi (stamping the placeholder + npm @ai-sdk/openai), but the
    // provider-embedded oauth2 block omits it and must win — leaving a clean
    // Chat-Completions provider with no leftover fake key.
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-responses-dup-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      provider: {
        "dup-ai": {
          options: {
            baseURL: "https://api.example.com/v1",
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              scopes: ["openid"]
              // responseApi omitted -> Chat Completions wins
            }
          }
        }
      },
      pluginConfig: {
        oauth2ModelSync: {
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
      }
    };

    await hooks.config?.(config as never);

    const providerConfig = (config.provider as Record<string, Record<string, unknown>>)["dup-ai"];
    expect(providerConfig.npm).toBe("@ai-sdk/openai-compatible");
    expect((providerConfig.options as Record<string, unknown>).apiKey).toBeUndefined();
  });

  it("rejects a non-boolean responseApi value", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-responses-bad-"));
    const hooks = await createHooks(cacheDir);

    const config: Record<string, unknown> = {
      provider: {
        "example-ai": {
          options: {
            baseURL: "https://api.example.com/v1",
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              scopes: ["openid"],
              responseApi: "yes"
            }
          }
        }
      }
    };

    await expect(hooks.config?.(config as never)).rejects.toThrow(/responseApi/);
  });
});

describe("ADR-0014: the plugin's own diagnostics never touch the terminal", () => {
  // Builds hooks WITHOUT an injected `logger` option, so the real
  // `createOpenCodeLogger` (from src/opencode.ts) runs — unlike `createHooks`
  // above, which always passes `createSilentLogger()` and therefore bypasses
  // it entirely.
  async function createRealLoggerHooks(cacheDir: string) {
    const log = vi.fn(async () => ({ data: true }));
    const plugin = createOpencodeOauth2Plugin({
      cacheDir,
      fetchImpl: async () => {
        throw new Error("fetch is not expected in these hook tests");
      }
    });

    const hooks = await plugin({
      client: { app: { log } },
      project: { id: "project-1" },
      directory: process.cwd(),
      worktree: process.cwd(),
      serverUrl: new URL("http://127.0.0.1:3000"),
      $: {} as never
    } as never);

    return { hooks, log };
  }

  // A malformed (non-object) entry in `pluginConfig.oauth2ModelSync.servers`
  // is the simplest way to trigger a real `warn` record
  // (`plugin_config_server_invalid`) purely from the `config` hook, with no
  // network calls and no valid managed provider left over afterwards.
  const invalidServerConfig: Record<string, unknown> = {
    pluginConfig: {
      oauth2ModelSync: {
        servers: ["not-an-object"]
      }
    }
  };

  it("never mirrors a warn record to the console fallback", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-adr0014-console-"));
    const { hooks } = await createRealLoggerHooks(cacheDir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await hooks.config?.(invalidServerConfig as never);

    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    warn.mockRestore();
    log.mockRestore();
  });

  it("still forwards the warn record to client.app.log at its true level", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-adr0014-hostlog-"));
    const { hooks, log } = await createRealLoggerHooks(cacheDir);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await hooks.config?.(invalidServerConfig as never);

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          service: "opencode-oauth2-plugin",
          level: "warn",
          message: "plugin_config_server_invalid"
        })
      })
    );
    vi.restoreAllMocks();
  });

  it("restores the console mirror when VYMALO_PLUGIN_CONSOLE_LOG is set", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opencode-hook-adr0014-restore-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const previous = process.env.VYMALO_PLUGIN_CONSOLE_LOG;
    // createOpenCodeLogger reads this env var once, at plugin-construction
    // time (inside the factory's returned hook, not per write() call) — so it
    // must be set BEFORE building the hooks, not merely before invoking them.
    process.env.VYMALO_PLUGIN_CONSOLE_LOG = "1";

    try {
      const { hooks } = await createRealLoggerHooks(cacheDir);
      await hooks.config?.(invalidServerConfig as never);
      expect(warn).toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.VYMALO_PLUGIN_CONSOLE_LOG;
      } else {
        process.env.VYMALO_PLUGIN_CONSOLE_LOG = previous;
      }
      warn.mockRestore();
    }
  });
});

describe("fromOpenCodeLogLevel", () => {
  it("maps OpenCode's uppercase log levels to internal levels (DEBUG unlocks trace)", () => {
    // Host DEBUG is intentionally mapped to the most-verbose `trace` tier so
    // `--log-level DEBUG` surfaces the oauth2_* trace events.
    expect(fromOpenCodeLogLevel("DEBUG")).toBe("trace");
    expect(fromOpenCodeLogLevel("INFO")).toBe("info");
    expect(fromOpenCodeLogLevel("WARN")).toBe("warn");
    expect(fromOpenCodeLogLevel("ERROR")).toBe("error");
  });

  it("tolerates mixed-case input from non-canonical hosts", () => {
    expect(fromOpenCodeLogLevel("debug")).toBe("trace");
    expect(fromOpenCodeLogLevel("Info")).toBe("info");
  });

  it("returns undefined for missing or unrecognized values so the caller can apply a default", () => {
    expect(fromOpenCodeLogLevel(undefined)).toBeUndefined();
    expect(fromOpenCodeLogLevel(null)).toBeUndefined();
    // There is no host "TRACE" level; an unknown string still falls through.
    expect(fromOpenCodeLogLevel("trace")).toBeUndefined();
    expect(fromOpenCodeLogLevel(42)).toBeUndefined();
  });
});
