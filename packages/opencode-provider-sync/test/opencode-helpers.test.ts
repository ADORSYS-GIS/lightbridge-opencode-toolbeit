import { describe, expect, it, vi } from "vitest";

import type { Logger } from "@vymalo/opencode-auth-core/lib";
import {
  applyResponsesApiOptions,
  collectManagedProviders,
  mergeDiscoveredModels,
  parseOAuthExtension,
  parsePluginConfigServers,
  propagateCachedBearer,
  resolveProviderNpm,
  runtimeSignature,
  type OpenCodeConfig,
  type OpenCodeProviderConfig
} from "../src/opencode-helpers.js";
import type { ProviderModelSyncEngine } from "../src/engine.js";

const KEYS = {
  optionKeys: ["oauth2", "oauth2ModelSync"] as const,
  pluginConfigKey: "oauth2ModelSync"
};

function silentLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

describe("resolveProviderNpm", () => {
  it("returns the compatible package by default", () => {
    expect(resolveProviderNpm(undefined)).toBe("@ai-sdk/openai-compatible");
    expect(resolveProviderNpm(false)).toBe("@ai-sdk/openai-compatible");
  });

  it("returns the native Responses package when responseApi is enabled", () => {
    expect(resolveProviderNpm(true)).toBe("@ai-sdk/openai");
  });
});

describe("applyResponsesApiOptions", () => {
  const logger = silentLogger();

  it("is a no-op for Chat-Completions providers with no placeholder to scrub", () => {
    const options = { baseURL: "https://api.example.com/v1" };
    expect(applyResponsesApiOptions(options, false, "p1", logger)).toBe(options);
  });

  it("scrubs a leftover placeholder apiKey when responseApi loses", () => {
    const options = { apiKey: "oauth2-managed-bearer", baseURL: "https://api.example.com/v1" };
    const result = applyResponsesApiOptions(options, false, "p1", logger);
    expect(result.apiKey).toBeUndefined();
    expect(result).not.toBe(options);
  });

  it("stamps a placeholder apiKey when responseApi is enabled and none is set", () => {
    const result = applyResponsesApiOptions(
      { baseURL: "https://api.example.com/v1" },
      true,
      "p1",
      logger
    );
    expect(result.apiKey).toBe("oauth2-managed-bearer");
  });

  it("does not overwrite a user-supplied apiKey", () => {
    const result = applyResponsesApiOptions(
      { apiKey: "user-key", baseURL: "https://api.example.com/v1" },
      true,
      "p1",
      logger
    );
    expect(result.apiKey).toBe("user-key");
  });

  it("leaves options.fetch untouched when no repair hook is injected", () => {
    const result = applyResponsesApiOptions(
      { baseURL: "https://api.example.com/v1" },
      true,
      "p1",
      logger
    );
    expect(result.fetch).toBeUndefined();
  });

  it("wraps options.fetch with the injected repair hook, composing with any delegate", () => {
    const delegate = vi.fn();
    const wrapped = vi.fn().mockReturnValue("wrapped-fetch");
    const result = applyResponsesApiOptions(
      { baseURL: "https://api.example.com/v1", fetch: delegate },
      true,
      "p1",
      logger,
      { createResponsesRepairFetch: wrapped }
    );
    expect(wrapped).toHaveBeenCalledWith(delegate);
    expect(result.fetch).toBe("wrapped-fetch");
  });
});

describe("parseOAuthExtension", () => {
  it("returns undefined when no matching options key is present", () => {
    const provider: OpenCodeProviderConfig = { options: { baseURL: "https://x" } };
    expect(parseOAuthExtension(provider, KEYS)).toBeUndefined();
  });

  it("returns undefined when required fields are missing", () => {
    const provider: OpenCodeProviderConfig = { options: { oauth2: { issuer: "https://auth" } } };
    expect(parseOAuthExtension(provider, KEYS)).toBeUndefined();
  });

  it("parses a full extension from the first matching key", () => {
    const provider: OpenCodeProviderConfig = {
      options: {
        oauth2: {
          issuer: "https://auth.example.com",
          clientId: "client",
          scopes: ["openid", "offline_access"],
          responseApi: true
        }
      }
    };
    const extension = parseOAuthExtension(provider, KEYS);
    expect(extension?.issuer).toBe("https://auth.example.com");
    expect(extension?.clientId).toBe("client");
    expect(extension?.scopes).toEqual(["openid", "offline_access"]);
    expect(extension?.responseApi).toBe(true);
  });

  it("throws on an invalid authFlow", () => {
    const provider: OpenCodeProviderConfig = {
      options: {
        oauth2: {
          issuer: "https://auth",
          clientId: "client",
          scopes: ["openid"],
          authFlow: "implicit"
        }
      }
    };
    expect(() => parseOAuthExtension(provider, KEYS)).toThrow(/authFlow/);
  });

  it("throws on an out-of-range redirectPort", () => {
    const provider: OpenCodeProviderConfig = {
      options: {
        oauth2: {
          issuer: "https://auth",
          clientId: "client",
          scopes: ["openid"],
          redirectPort: 99999
        }
      }
    };
    expect(() => parseOAuthExtension(provider, KEYS)).toThrow(/redirectPort/);
  });
});

describe("parsePluginConfigServers", () => {
  it("returns an empty array when pluginConfig has no matching key", () => {
    expect(parsePluginConfigServers({} as OpenCodeConfig, silentLogger(), KEYS)).toEqual([]);
  });

  it("skips a non-object entry and warns", () => {
    const logger = silentLogger();
    const config = {
      pluginConfig: { oauth2ModelSync: { servers: ["not-an-object"] } }
    } as unknown as OpenCodeConfig;

    expect(parsePluginConfigServers(config, logger, KEYS)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "plugin_config_server_invalid",
      expect.objectContaining({ index: 0 })
    );
  });

  it("skips an entry missing required fields and warns", () => {
    const logger = silentLogger();
    const config = {
      pluginConfig: { oauth2ModelSync: { servers: [{ id: "srv-1" }] } }
    } as unknown as OpenCodeConfig;

    expect(parsePluginConfigServers(config, logger, KEYS)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "plugin_config_server_missing_fields",
      expect.objectContaining({ id: "srv-1" })
    );
  });

  it("parses a valid server entry", () => {
    const config = {
      pluginConfig: {
        oauth2ModelSync: {
          servers: [
            {
              id: "srv-1",
              issuer: "https://auth.example.com",
              baseURL: "https://api.example.com/v1",
              clientId: "client",
              scopes: ["openid"]
            }
          ]
        }
      }
    } as unknown as OpenCodeConfig;

    const servers = parsePluginConfigServers(config, silentLogger(), KEYS);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.id).toBe("srv-1");
    expect(servers[0]?.baseURL).toBe("https://api.example.com/v1");
  });
});

describe("collectManagedProviders", () => {
  it("materializes a pluginConfig server into config.provider", () => {
    const config = {
      provider: {},
      pluginConfig: {
        oauth2ModelSync: {
          servers: [
            {
              id: "srv-1",
              issuer: "https://auth.example.com",
              baseURL: "https://api.example.com/v1",
              clientId: "client",
              scopes: ["openid"]
            }
          ]
        }
      }
    } as unknown as OpenCodeConfig;

    const managed = collectManagedProviders(config, silentLogger(), KEYS);
    expect(managed.servers.map((s) => s.id)).toEqual(["srv-1"]);
    expect(config.provider?.["srv-1"]?.npm).toBe("@ai-sdk/openai-compatible");
  });

  it("materializes a provider.options.oauth2 extension", () => {
    const config = {
      provider: {
        "srv-2": {
          options: {
            baseURL: "https://api.example.com/v1",
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "client",
              scopes: ["openid"]
            }
          }
        }
      }
    } as unknown as OpenCodeConfig;

    const managed = collectManagedProviders(config, silentLogger(), KEYS);
    expect(managed.servers.map((s) => s.id)).toEqual(["srv-2"]);
  });

  it("skips a provider.options extension with no baseURL, warning", () => {
    const logger = silentLogger();
    const config = {
      provider: {
        "srv-3": {
          options: {
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "client",
              scopes: ["openid"]
            }
          }
        }
      }
    } as unknown as OpenCodeConfig;

    const managed = collectManagedProviders(config, logger, KEYS);
    expect(managed.servers).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "provider_skipped_missing_baseurl",
      expect.objectContaining({ providerId: "srv-3" })
    );
  });

  it("dedupes by id, letting the provider.options shape win over pluginConfig", () => {
    const config = {
      provider: {
        "dup-ai": {
          options: {
            baseURL: "https://api.example.com/v1",
            oauth2: { issuer: "https://auth.example.com", clientId: "client", scopes: ["openid"] }
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
              clientId: "client",
              scopes: ["openid"],
              responseApi: true
            }
          ]
        }
      }
    } as unknown as OpenCodeConfig;

    const managed = collectManagedProviders(config, silentLogger(), KEYS);
    expect(managed.servers).toHaveLength(1);
    // provider.options pass runs second and has no responseApi -> Chat Completions wins.
    expect(config.provider?.["dup-ai"]?.npm).toBe("@ai-sdk/openai-compatible");
  });
});

describe("runtimeSignature", () => {
  it("is stable regardless of input server order", () => {
    const a = runtimeSignature({ servers: [{ id: "b" }, { id: "a" }] });
    const b = runtimeSignature({ servers: [{ id: "a" }, { id: "b" }] });
    expect(a).toBe(b);
  });

  it("changes when the server set changes", () => {
    const a = runtimeSignature({ servers: [{ id: "a" }] });
    const b = runtimeSignature({ servers: [{ id: "a" }, { id: "b" }] });
    expect(a).not.toBe(b);
  });
});

describe("mergeDiscoveredModels", () => {
  it("merges discovered models into an empty provider, preserving existing fields", () => {
    const providerConfig: OpenCodeProviderConfig = {
      models: { "glm-5": { id: "glm-5", extra: "keep-me" } as never }
    };

    mergeDiscoveredModels(providerConfig, [{ id: "glm-5", displayName: "GLM 5" }]);

    const models = providerConfig.models as Record<
      string,
      { id: string; name: string; extra?: string }
    >;
    expect(models["glm-5"]?.name).toBe("GLM 5");
    expect(models["glm-5"]?.extra).toBe("keep-me");
  });
});

describe("propagateCachedBearer", () => {
  function fakeEngine(
    token: { accessToken: string; tokenType?: string } | Error
  ): ProviderModelSyncEngine {
    return {
      ensureAccessToken: vi.fn().mockImplementation(async () => {
        if (token instanceof Error) {
          throw token;
        }
        return token;
      })
    } as unknown as ProviderModelSyncEngine;
  }

  it("stamps the Authorization header from the cached bearer", async () => {
    const providerConfig: OpenCodeProviderConfig = {};
    await propagateCachedBearer(
      providerConfig,
      "p1",
      fakeEngine({ accessToken: "tok", tokenType: "Bearer" }),
      silentLogger()
    );
    expect(
      (providerConfig.options as { headers?: Record<string, string> })?.headers?.Authorization
    ).toBe("Bearer tok");
  });

  it("never overwrites a user-set Authorization header (case-insensitive)", async () => {
    const providerConfig: OpenCodeProviderConfig = {
      options: { headers: { authorization: "Bearer user-set" } }
    };
    await propagateCachedBearer(
      providerConfig,
      "p1",
      fakeEngine({ accessToken: "tok" }),
      silentLogger()
    );
    const headers = (providerConfig.options as { headers?: Record<string, string> })?.headers;
    expect(headers?.authorization).toBe("Bearer user-set");
    expect(headers?.Authorization).toBeUndefined();
  });

  it("swallows an ensureAccessToken failure instead of throwing", async () => {
    const providerConfig: OpenCodeProviderConfig = {};
    await expect(
      propagateCachedBearer(providerConfig, "p1", fakeEngine(new Error("no token")), silentLogger())
    ).resolves.toBeUndefined();
    expect(
      (providerConfig.options as { headers?: Record<string, string> })?.headers?.Authorization
    ).toBeUndefined();
  });

  it("leaves no header when the resolved token has no accessToken", async () => {
    const providerConfig: OpenCodeProviderConfig = {};
    await propagateCachedBearer(
      providerConfig,
      "p1",
      fakeEngine({ accessToken: "" }),
      silentLogger()
    );
    expect(
      (providerConfig.options as { headers?: Record<string, string> })?.headers?.Authorization
    ).toBeUndefined();
  });
});
