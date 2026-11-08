import { Model, Provider } from "@opencode/plugin/effect";
import type { ProviderEditor } from "@opencode/plugin/effect/provider";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { Logger } from "@vymalo/opencode-auth-core/lib";
import type { ProviderModelSyncEngine } from "../src/engine.js";
import {
  applyResponsesApiSettings,
  collectManagedProviders,
  mergeDiscoveredModels,
  parseOAuthExtension,
  parsePluginOptionsServers,
  propagateCachedBearer,
  resolveCachedBearer,
  resolveProviderPackage,
  runtimeSignature
} from "../src/opencode-helpers.js";

const KEYS = { settingsKeys: ["oauth2", "oauth2ModelSync"] as const };

function silentLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * A faithful-enough in-memory `ProviderEditor`: records hold real
 * `Provider.Info` / `Model.Info` values, `update` hands the callback an owned
 * copy (as the host does), and `models.set` replaces a provider's model list.
 */
function fakeEditor(initial: Array<Partial<Provider.Info> & { id: string }> = []): {
  editor: ProviderEditor;
  providers: Map<string, Provider.Info>;
  models: Map<string, Map<string, Model.Info>>;
} {
  const providers = new Map<string, Provider.Info>();
  const models = new Map<string, Map<string, Model.Info>>();

  const seed = (info: Provider.Info, list: readonly Model.Info[] = []): void => {
    providers.set(info.id, info);
    models.set(info.id, new Map(list.map((model) => [model.id as string, model])));
  };

  for (const partial of initial) {
    seed({
      ...Provider.Info.empty(Provider.ID.make(partial.id)),
      ...partial,
      id: Provider.ID.make(partial.id)
    } as Provider.Info);
  }

  const editor = {
    list: () =>
      [...providers.values()].map((provider) => ({
        provider,
        models: models.get(provider.id) ?? new Map()
      })),
    get: (providerID: string) => {
      const provider = providers.get(providerID);
      return provider ? { provider, models: models.get(providerID) ?? new Map() } : undefined;
    },
    add: ({ info, models: list }: { info: Provider.Info; models: readonly Model.Info[] }) =>
      seed(info, list),
    update: (providerID: string, fn: (provider: Mutable<Provider.Info>) => void) => {
      const current = providers.get(providerID);
      if (!current) {
        return;
      }
      const copy = structuredClone(current) as Mutable<Provider.Info>;
      fn(copy);
      providers.set(providerID, copy as Provider.Info);
    },
    remove: (providerID: string) => {
      providers.delete(providerID);
      models.delete(providerID);
    },
    models: {
      set: (providerID: string, list: readonly Model.Info[]) => {
        models.set(providerID, new Map(list.map((model) => [model.id as string, model])));
      },
      update: vi.fn(),
      remove: vi.fn()
    }
  } as unknown as ProviderEditor;

  return { editor, providers, models };
}

function modelOf(providerId: string, id: string, over: Partial<Model.Info> = {}): Model.Info {
  return {
    ...Model.Info.default(Provider.ID.make(providerId), Model.ID.make(id)),
    ...over
  } as Model.Info;
}

const SERVER = {
  id: "srv-1",
  issuer: "https://auth.example.com",
  baseURL: "https://api.example.com/v1",
  clientId: "client",
  scopes: ["openid"]
};

describe("resolveProviderPackage", () => {
  it("returns the aisdk-prefixed compatible package by default", () => {
    expect(resolveProviderPackage(undefined)).toBe("aisdk:@ai-sdk/openai-compatible");
    expect(resolveProviderPackage(false)).toBe("aisdk:@ai-sdk/openai-compatible");
  });

  it("returns the native Responses package when responseApi is enabled", () => {
    expect(resolveProviderPackage(true)).toBe("aisdk:@ai-sdk/openai");
  });
});

describe("applyResponsesApiSettings", () => {
  const logger = silentLogger();

  it("is a no-op for Chat-Completions providers with no placeholder to scrub", () => {
    const settings = { baseURL: "https://api.example.com/v1" };
    expect(applyResponsesApiSettings(settings, false, "p1", logger)).toBe(settings);
  });

  it("scrubs a leftover placeholder apiKey when responseApi loses", () => {
    const settings = { apiKey: "oauth2-managed-bearer", baseURL: "https://api.example.com/v1" };
    const result = applyResponsesApiSettings(settings, false, "p1", logger);
    expect(result.apiKey).toBeUndefined();
    expect(result).not.toBe(settings);
  });

  it("stamps a placeholder apiKey when responseApi is enabled and none is set", () => {
    const result = applyResponsesApiSettings(
      { baseURL: "https://api.example.com/v1" },
      true,
      "p1",
      logger
    );
    expect(result.apiKey).toBe("oauth2-managed-bearer");
    expect(result.baseURL).toBe("https://api.example.com/v1");
  });

  it("does not overwrite a user-supplied apiKey", () => {
    const result = applyResponsesApiSettings(
      { apiKey: "user-key", baseURL: "https://api.example.com/v1" },
      true,
      "p1",
      logger
    );
    expect(result.apiKey).toBe("user-key");
  });

  it("never emits a fetch (Provider.Info has no such field)", () => {
    const result = applyResponsesApiSettings({ baseURL: "https://x" }, true, "p1", logger);
    expect("fetch" in result).toBe(false);
  });
});

describe("parseOAuthExtension", () => {
  it("returns undefined when there are no settings", () => {
    expect(parseOAuthExtension({}, KEYS)).toBeUndefined();
  });

  it("returns undefined when no matching settings key is present", () => {
    expect(parseOAuthExtension({ settings: { baseURL: "https://x" } }, KEYS)).toBeUndefined();
  });

  it("returns undefined when required fields are missing", () => {
    expect(
      parseOAuthExtension({ settings: { oauth2: { issuer: "https://auth" } } }, KEYS)
    ).toBeUndefined();
  });

  it("parses a full extension from the first matching key", () => {
    const extension = parseOAuthExtension(
      {
        settings: {
          oauth2: {
            issuer: "https://auth.example.com",
            clientId: "client",
            scopes: ["openid", "offline_access"],
            responseApi: true,
            syncIntervalMinutes: 5
          }
        }
      },
      KEYS
    );
    expect(extension?.issuer).toBe("https://auth.example.com");
    expect(extension?.clientId).toBe("client");
    expect(extension?.scopes).toEqual(["openid", "offline_access"]);
    expect(extension?.responseApi).toBe(true);
    expect(extension?.syncIntervalMinutes).toBe(5);
  });

  it("falls through to a later key", () => {
    const extension = parseOAuthExtension(
      { settings: { oauth2ModelSync: { issuer: "https://a", clientId: "c", scopes: "openid" } } },
      KEYS
    );
    expect(extension?.scopes).toEqual(["openid"]);
  });

  it("throws on an invalid authFlow, naming the matched settings key", () => {
    expect(() =>
      parseOAuthExtension(
        {
          settings: {
            oauth2ModelSync: {
              issuer: "https://auth",
              clientId: "client",
              scopes: ["openid"],
              authFlow: "implicit"
            }
          }
        },
        KEYS
      )
    ).toThrow(/provider\.settings\.oauth2ModelSync\.authFlow/);
  });

  it("throws on an out-of-range redirectPort", () => {
    expect(() =>
      parseOAuthExtension(
        {
          settings: {
            oauth2: {
              issuer: "https://auth",
              clientId: "client",
              scopes: ["openid"],
              redirectPort: 99999
            }
          }
        },
        KEYS
      )
    ).toThrow(/redirectPort/);
  });
});

describe("parsePluginOptionsServers", () => {
  it("returns an empty array when options carry no servers", () => {
    expect(parsePluginOptionsServers(undefined, silentLogger())).toEqual([]);
    expect(parsePluginOptionsServers({}, silentLogger())).toEqual([]);
    expect(parsePluginOptionsServers({ servers: "nope" }, silentLogger())).toEqual([]);
  });

  it("skips a non-object entry and warns", () => {
    const logger = silentLogger();
    expect(parsePluginOptionsServers({ servers: ["not-an-object"] }, logger)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "plugin_config_server_invalid",
      expect.objectContaining({ index: 0 })
    );
  });

  it("skips an entry missing required fields and warns", () => {
    const logger = silentLogger();
    expect(parsePluginOptionsServers({ servers: [{ id: "srv-1" }] }, logger)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "plugin_config_server_missing_fields",
      expect.objectContaining({ id: "srv-1" })
    );
  });

  it("parses a valid server entry", () => {
    const servers = parsePluginOptionsServers(
      { servers: [{ ...SERVER, name: "Gateway", syncIntervalMinutes: 10 }] },
      silentLogger()
    );
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      id: "srv-1",
      name: "Gateway",
      baseURL: "https://api.example.com/v1",
      syncIntervalMinutes: 10
    });
  });

  it("labels validation errors with the options path", () => {
    expect(() =>
      parsePluginOptionsServers({ servers: [{ ...SERVER, redirectPort: 0 }] }, silentLogger())
    ).toThrow(/options\.servers\[0\] \(id=srv-1\)/);
  });
});

describe("collectManagedProviders", () => {
  it("adds an options.servers provider to the editor as a valid Provider.Info", () => {
    const { editor, providers } = fakeEditor();

    const managed = collectManagedProviders(editor, { servers: [SERVER] }, silentLogger(), KEYS);

    expect(managed.servers.map((s) => s.id)).toEqual(["srv-1"]);
    const info = providers.get("srv-1");
    expect(info).toMatchObject({
      id: "srv-1",
      name: "srv-1",
      activation: "enabled",
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: "https://api.example.com/v1" }
    });
    // The value the host would receive must satisfy the real v2 schema.
    expect(() => Schema.decodeUnknownSync(Provider.Info)(info)).not.toThrow();
  });

  it("merges an options.servers entry onto a provider the user already declared", () => {
    const { editor, providers } = fakeEditor([
      {
        id: "srv-1",
        name: "My Gateway",
        activation: "auto",
        package: "something-else",
        settings: { timeout: 5, region: "eu" },
        headers: { "x-team": "a" }
      }
    ]);

    collectManagedProviders(
      editor,
      { servers: [{ ...SERVER, name: "Ignored" }] },
      silentLogger(),
      KEYS
    );

    expect(providers.get("srv-1")).toMatchObject({
      name: "My Gateway",
      activation: "auto",
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { timeout: 5, region: "eu", baseURL: "https://api.example.com/v1" },
      headers: { "x-team": "a" }
    });
  });

  it("uses the server's name when the existing provider only has its defaulted id-name", () => {
    const { editor, providers } = fakeEditor([{ id: "srv-1" }]);
    collectManagedProviders(
      editor,
      { servers: [{ ...SERVER, name: "Gateway" }] },
      silentLogger(),
      KEYS
    );
    expect(providers.get("srv-1")?.name).toBe("Gateway");
  });

  it("materializes a provider.settings.oauth2 extension in place", () => {
    const { editor, providers } = fakeEditor([
      {
        id: "srv-2",
        name: "Two",
        settings: {
          baseURL: "https://api.example.com/v1",
          oauth2: { issuer: "https://auth.example.com", clientId: "client", scopes: ["openid"] }
        }
      }
    ]);

    const managed = collectManagedProviders(editor, undefined, silentLogger(), KEYS);

    expect(managed.servers.map((s) => s.id)).toEqual(["srv-2"]);
    expect(providers.get("srv-2")?.package).toBe("aisdk:@ai-sdk/openai-compatible");
    // The opt-in block is left in place for later reloads.
    expect(providers.get("srv-2")?.settings).toHaveProperty("oauth2");
  });

  it("skips a settings extension with no baseURL, warning", () => {
    const logger = silentLogger();
    const { editor } = fakeEditor([
      {
        id: "srv-3",
        settings: {
          oauth2: { issuer: "https://auth.example.com", clientId: "client", scopes: ["openid"] }
        }
      }
    ]);

    const managed = collectManagedProviders(editor, undefined, logger, KEYS);
    expect(managed.servers).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "provider_skipped_missing_baseurl",
      expect.objectContaining({ providerId: "srv-3" })
    );
  });

  it("leaves providers without an opt-in untouched", () => {
    const { editor, providers } = fakeEditor([{ id: "plain", package: "aisdk:@ai-sdk/anthropic" }]);
    const managed = collectManagedProviders(editor, undefined, silentLogger(), KEYS);
    expect(managed.servers).toHaveLength(0);
    expect(providers.get("plain")?.package).toBe("aisdk:@ai-sdk/anthropic");
  });

  it("dedupes by id, letting the settings shape win over options.servers", () => {
    const { editor, providers } = fakeEditor([
      {
        id: "dup-ai",
        settings: {
          baseURL: "https://api.example.com/v1",
          oauth2: { issuer: "https://auth.example.com", clientId: "client", scopes: ["openid"] }
        }
      }
    ]);

    const managed = collectManagedProviders(
      editor,
      { servers: [{ ...SERVER, id: "dup-ai", responseApi: true }] },
      silentLogger(),
      KEYS
    );

    expect(managed.servers).toHaveLength(1);
    // The settings pass runs second and has no responseApi -> Chat Completions wins,
    // and the placeholder key the first pass stamped is scrubbed again.
    expect(providers.get("dup-ai")?.package).toBe("aisdk:@ai-sdk/openai-compatible");
    expect(providers.get("dup-ai")?.settings).not.toHaveProperty("apiKey");
  });

  it("stamps the Responses package and placeholder key for responseApi", () => {
    const { editor, providers } = fakeEditor();
    collectManagedProviders(
      editor,
      { servers: [{ ...SERVER, responseApi: true }] },
      silentLogger(),
      KEYS
    );
    expect(providers.get("srv-1")?.package).toBe("aisdk:@ai-sdk/openai");
    expect(providers.get("srv-1")?.settings).toMatchObject({ apiKey: "oauth2-managed-bearer" });
  });

  it("is idempotent across repeated transform passes", () => {
    const { editor, providers } = fakeEditor();
    collectManagedProviders(editor, { servers: [SERVER] }, silentLogger(), KEYS);
    const first = structuredClone(providers.get("srv-1"));
    collectManagedProviders(editor, { servers: [SERVER] }, silentLogger(), KEYS);
    expect(providers.get("srv-1")).toEqual(first);
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
  it("adds discovered models as valid Model.Info placeholders carrying id, modelID and name", () => {
    const { editor } = fakeEditor([{ id: "p1" }]);

    mergeDiscoveredModels(editor, "p1", [{ id: "glm-5", displayName: "GLM 5" }]);

    const added = editor.get("p1")?.models.get("glm-5");
    expect(added).toMatchObject({
      id: "glm-5",
      modelID: "glm-5",
      providerID: "p1",
      name: "GLM 5",
      enabled: true,
      limit: { context: 0, output: 0 },
      cost: [],
      capabilities: { tools: false, input: [], output: [] }
    });
    expect(() => Schema.decodeUnknownSync(Model.Info)(added)).not.toThrow();
  });

  it("renames a discovered model but preserves every other existing field", () => {
    const { editor, models } = fakeEditor([{ id: "p1" }]);
    models.set(
      "p1",
      new Map([
        [
          "glm-5",
          modelOf("p1", "glm-5", {
            name: "old",
            limit: { context: 1_000_000, output: 64_000 }
          })
        ]
      ])
    );

    mergeDiscoveredModels(editor, "p1", [{ id: "glm-5", displayName: "GLM 5" }]);

    const merged = editor.get("p1")?.models.get("glm-5");
    expect(merged?.name).toBe("GLM 5");
    expect(merged?.limit).toEqual({ context: 1_000_000, output: 64_000 });
  });

  it("keeps existing models that were not discovered", () => {
    const { editor, models } = fakeEditor([{ id: "p1" }]);
    models.set("p1", new Map([["handwritten", modelOf("p1", "handwritten", { name: "Mine" })]]));

    mergeDiscoveredModels(editor, "p1", [{ id: "glm-5", displayName: "GLM 5" }]);

    const map = editor.get("p1")?.models;
    expect([...(map?.keys() ?? [])].sort()).toEqual(["glm-5", "handwritten"]);
    expect(map?.get("handwritten")?.name).toBe("Mine");
  });

  it("is a no-op for a provider the editor does not know", () => {
    const { editor, models } = fakeEditor();
    mergeDiscoveredModels(editor, "ghost", [{ id: "x", displayName: "X" }]);
    expect(models.has("ghost")).toBe(false);
  });
});

describe("resolveCachedBearer", () => {
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

  it("returns '<type> <token>' using a refresh-only ensure", async () => {
    const engine = fakeEngine({ accessToken: "tok", tokenType: "DPoP" });
    await expect(resolveCachedBearer("p1", engine, silentLogger())).resolves.toBe("DPoP tok");
    expect(engine.ensureAccessToken).toHaveBeenCalledWith("p1", { interactive: false });
  });

  it("defaults the token type to Bearer", async () => {
    await expect(
      resolveCachedBearer("p1", fakeEngine({ accessToken: "tok" }), silentLogger())
    ).resolves.toBe("Bearer tok");
  });

  it("swallows an ensureAccessToken failure and returns undefined", async () => {
    const logger = silentLogger();
    await expect(
      resolveCachedBearer("p1", fakeEngine(new Error("no token")), logger)
    ).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(
      "oauth2_bearer_propagation_skipped_no_token",
      expect.objectContaining({ providerId: "p1", error: "no token" })
    );
  });

  it("stringifies a non-Error rejection", async () => {
    const engine = {
      ensureAccessToken: vi.fn().mockRejectedValue("boom")
    } as unknown as ProviderModelSyncEngine;
    const logger = silentLogger();
    await resolveCachedBearer("p1", engine, logger);
    expect(logger.debug).toHaveBeenCalledWith(
      "oauth2_bearer_propagation_skipped_no_token",
      expect.objectContaining({ error: "boom" })
    );
  });

  it("returns undefined when the resolved token has no accessToken", async () => {
    const logger = silentLogger();
    await expect(
      resolveCachedBearer("p1", fakeEngine({ accessToken: "" }), logger)
    ).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith("oauth2_bearer_propagation_skipped_empty_token", {
      providerId: "p1"
    });
  });
});

describe("propagateCachedBearer", () => {
  it("stamps Authorization onto Provider.Info.headers, keeping other headers", () => {
    const { editor, providers } = fakeEditor([{ id: "p1", headers: { "x-team": "a" } }]);
    propagateCachedBearer(editor, "p1", "Bearer tok", silentLogger());
    expect(providers.get("p1")?.headers).toEqual({ "x-team": "a", Authorization: "Bearer tok" });
  });

  it("never overwrites a user-set Authorization header (case-insensitive)", () => {
    const logger = silentLogger();
    const { editor, providers } = fakeEditor([
      { id: "p1", headers: { authorization: "Bearer user-set" } }
    ]);
    propagateCachedBearer(editor, "p1", "Bearer tok", logger);
    expect(providers.get("p1")?.headers).toEqual({ authorization: "Bearer user-set" });
    expect(logger.debug).toHaveBeenCalledWith("oauth2_bearer_propagation_skipped_user_set", {
      providerId: "p1"
    });
  });

  it("refreshes a header it stamped itself earlier, but not a user value that differs", () => {
    const stamped = new Map<string, string>();
    const { editor, providers } = fakeEditor([{ id: "p1" }]);

    propagateCachedBearer(editor, "p1", "Bearer one", silentLogger(), stamped);
    // Same editor state carried over (no fresh pass): our own value is refreshed.
    propagateCachedBearer(editor, "p1", "Bearer two", silentLogger(), stamped);
    expect(providers.get("p1")?.headers).toEqual({ Authorization: "Bearer two" });

    // The user replaces it with their own value: it now differs from what we stamped.
    editor.update("p1", (p) => {
      p.headers = { Authorization: "Bearer user" };
    });
    propagateCachedBearer(editor, "p1", "Bearer three", silentLogger(), stamped);
    expect(providers.get("p1")?.headers).toEqual({ Authorization: "Bearer user" });
  });

  it("leaves headers alone when there is no bearer to propagate", () => {
    const { editor, providers } = fakeEditor([{ id: "p1" }]);
    propagateCachedBearer(editor, "p1", undefined, silentLogger());
    expect(providers.get("p1")?.headers).toBeUndefined();
  });

  it("is a no-op for a provider the editor does not know", () => {
    const { editor, providers } = fakeEditor();
    propagateCachedBearer(editor, "ghost", "Bearer tok", silentLogger());
    expect(providers.size).toBe(0);
  });
});
