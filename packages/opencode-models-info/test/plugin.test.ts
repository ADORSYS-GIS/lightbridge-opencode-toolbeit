import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CacheStore } from "../src/cache.js";
import type { Logger } from "../src/logging.js";
import {
  enrichConfig,
  type EnrichConfigInput,
  type ProviderConfigLike,
  startCacheRefreshSchedulers
} from "../src/plugin.js";
import type { CachedModelsRecord, OpenRouterModel } from "../src/types.js";

function silentLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function memoryCache(seed: Map<string, CachedModelsRecord> = new Map()): CacheStore {
  return {
    get: async (key) => seed.get(key),
    put: async (key, record) => void seed.set(key, record)
  };
}

function getModel(
  config: EnrichConfigInput,
  providerId: string,
  modelId: string
): Record<string, unknown> {
  const provider = config.provider?.[providerId];
  if (!provider) {
    throw new Error(`provider ${providerId} missing`);
  }
  const model = provider.models?.[modelId];
  if (!model) {
    throw new Error(`model ${providerId}.${modelId} missing`);
  }
  return model;
}

function withProvider(providerId: string, provider: ProviderConfigLike): EnrichConfigInput {
  return { provider: { [providerId]: provider } };
}

const openRouterEntry: OpenRouterModel = {
  id: "model-a",
  name: "Model A",
  context_length: 128_000,
  pricing: { prompt: "0.000003", completion: "0.000015" },
  top_provider: { max_completion_tokens: 4096 },
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  supported_parameters: ["tools", "temperature"]
};

describe("enrichConfig", () => {
  it("skips providers without meta.modelsInfoUrl", async () => {
    const config = withProvider("bare", {
      options: { baseURL: "https://x.test" },
      models: { "model-a": {} }
    });
    const fetchImpl = vi.fn();
    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getModel(config, "bare", "model-a")).toEqual({});
  });

  it("fetches once, caches, and merges metadata onto matching models", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [openRouterEntry] }), {
        status: 200,
        headers: { "content-type": "application/json", etag: "v1" }
      })
    );
    const config = withProvider("custom", {
      options: {
        baseURL: "https://x.test/v1",
        meta: { modelsInfoUrl: "models/info" }
      },
      models: { "model-a": {}, unmatched: { name: "Untouched" } }
    });

    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 0
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://x.test/v1/models/info");

    const enriched = getModel(config, "custom", "model-a");
    expect(enriched.limit).toEqual({ context: 128_000, output: 4096 });
    expect(enriched.cost).toEqual({ input: 3, output: 15 });
    expect(enriched.tool_call).toBe(true);
    expect(enriched.attachment).toBe(true);
    expect(enriched.name).toBe("Model A");

    expect(getModel(config, "custom", "unmatched").name).toBe("Untouched");
  });

  it("lets the endpoint name win over a pre-stamped name when modelsInfoOverwrite lists it", async () => {
    // Mirrors the oauth2 composition: another plugin already wrote a normalized
    // `name` onto the entry, so plain upstream-wins would freeze it. Opting
    // `name` into overwrite lets the metadata endpoint's name take over, while
    // un-listed fields (here the upstream tool_call) stay untouched.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [openRouterEntry] }), { status: 200 })
      );
    const config = withProvider("custom", {
      options: {
        baseURL: "https://x.test/v1",
        meta: { modelsInfoUrl: "models/info", modelsInfoOverwrite: ["name"] }
      },
      models: { "model-a": { name: "Model A (normalized)", tool_call: false } }
    });

    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const enriched = getModel(config, "custom", "model-a");
    expect(enriched.name).toBe("Model A");
    expect(enriched.tool_call).toBe(false);
  });

  it("clears a stale-true capability flag when the field is overwritten (endpoint reports no tools)", async () => {
    // The exact gap a reviewer flagged: another plugin stamped tool_call:true,
    // the endpoint's supported_parameters is present but lacks tools, and the
    // user opted tool_call into overwrite — the false must win.
    const noToolsEntry: OpenRouterModel = {
      id: "model-a",
      supported_parameters: ["temperature"]
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [noToolsEntry] }), { status: 200 }));
    const config = withProvider("custom", {
      options: {
        baseURL: "https://x.test/v1",
        meta: { modelsInfoUrl: "models/info", modelsInfoOverwrite: ["tool_call"] }
      },
      models: { "model-a": { tool_call: true } }
    });

    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(getModel(config, "custom", "model-a").tool_call).toBe(false);
  });

  it("keeps a pre-stamped name when modelsInfoOverwrite is absent (default upstream-wins)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [openRouterEntry] }), { status: 200 })
      );
    const config = withProvider("custom", {
      options: { baseURL: "https://x.test/v1", meta: { modelsInfoUrl: "models/info" } },
      models: { "model-a": { name: "Model A (normalized)" } }
    });

    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(getModel(config, "custom", "model-a").name).toBe("Model A (normalized)");
  });

  it("hides a text-only model when modelsInfoHideTextOnly is set", async () => {
    const textOnlyEntry: OpenRouterModel = {
      id: "model-text",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] }
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [openRouterEntry, textOnlyEntry] }), {
        status: 200
      })
    );
    const config = withProvider("custom", {
      options: {
        baseURL: "https://x.test/v1",
        meta: { modelsInfoUrl: "models/info", modelsInfoHideTextOnly: true }
      },
      models: { "model-a": {}, "model-text": {} }
    });

    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    // Multimodal model stays and is enriched as usual.
    expect(getModel(config, "custom", "model-a").limit).toEqual({ context: 128_000, output: 4096 });
    // Text-only model is dropped from the provider's `models` map entirely.
    expect(config.provider?.custom.models?.["model-text"]).toBeUndefined();
  });

  it("drops a model the catalog doesn't mention at all when modelsInfoHideTextOnly is set", async () => {
    // modelsInfoHideTextOnly makes the catalog authoritative for membership,
    // not just modality: a model discovery/config produced that the catalog
    // never confirms should be dropped too, not merely left un-enriched.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [openRouterEntry] }), { status: 200 })
      );
    const config = withProvider("custom", {
      options: {
        baseURL: "https://x.test/v1",
        meta: { modelsInfoUrl: "models/info", modelsInfoHideTextOnly: true }
      },
      models: { "model-a": {}, "not-in-catalog": {} }
    });

    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(getModel(config, "custom", "model-a").limit).toEqual({ context: 128_000, output: 4096 });
    expect(config.provider?.custom.models?.["not-in-catalog"]).toBeUndefined();
  });

  it("keeps an unmatched model when modelsInfoHideTextOnly is not set", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [openRouterEntry] }), { status: 200 })
      );
    const config = withProvider("custom", {
      options: { baseURL: "https://x.test/v1", meta: { modelsInfoUrl: "models/info" } },
      models: { "not-in-catalog": { name: "Untouched" } }
    });

    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(getModel(config, "custom", "not-in-catalog").name).toBe("Untouched");
  });

  it("keeps a text-only model when modelsInfoHideTextOnly is not set", async () => {
    const textOnlyEntry: OpenRouterModel = {
      id: "model-text",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] }
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [textOnlyEntry] }), { status: 200 }));
    const config = withProvider("custom", {
      options: { baseURL: "https://x.test/v1", meta: { modelsInfoUrl: "models/info" } },
      models: { "model-text": {} }
    });

    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(config.provider?.custom.models?.["model-text"]).toBeDefined();
  });

  it("does not hide a model when hideTextOnly is set but modalities are unknown", async () => {
    // No architecture on the source entry at all → we genuinely don't know
    // the modalities, so hiding must not fire on a guess.
    const noArchEntry: OpenRouterModel = { id: "model-unknown" };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [noArchEntry] }), { status: 200 }));
    const config = withProvider("custom", {
      options: {
        baseURL: "https://x.test/v1",
        meta: { modelsInfoUrl: "models/info", modelsInfoHideTextOnly: true }
      },
      models: { "model-unknown": {} }
    });

    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(config.provider?.custom.models?.["model-unknown"]).toBeDefined();
  });

  it("hides a model the catalog flags internal when modelsInfoHideInternal is set", async () => {
    const internalEntry: OpenRouterModel = {
      id: "model-internal",
      internal: true,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [openRouterEntry, internalEntry] }), {
        status: 200
      })
    );
    const config = withProvider("custom", {
      options: {
        baseURL: "https://x.test/v1",
        meta: { modelsInfoUrl: "models/info", modelsInfoHideInternal: true }
      },
      models: { "model-a": {}, "model-internal": {} }
    });

    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(getModel(config, "custom", "model-a").limit).toEqual({ context: 128_000, output: 4096 });
    expect(config.provider?.custom.models?.["model-internal"]).toBeUndefined();
  });

  it("does not hide an internal model when modelsInfoHideInternal is not set", async () => {
    const internalEntry: OpenRouterModel = { id: "model-internal", internal: true };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [internalEntry] }), { status: 200 }));
    const config = withProvider("custom", {
      options: { baseURL: "https://x.test/v1", meta: { modelsInfoUrl: "models/info" } },
      models: { "model-internal": {} }
    });

    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(config.provider?.custom.models?.["model-internal"]).toBeDefined();
  });

  it("does not hide a model when hideInternal is set but the catalog doesn't say internal", async () => {
    // `internal` absent entirely → unknown, not "not internal" — must not
    // hide on a guess, same rule as the text-only/capability flags.
    const unknownEntry: OpenRouterModel = { id: "model-unknown-internal" };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [unknownEntry] }), { status: 200 }));
    const config = withProvider("custom", {
      options: {
        baseURL: "https://x.test/v1",
        meta: { modelsInfoUrl: "models/info", modelsInfoHideInternal: true }
      },
      models: { "model-unknown-internal": {} }
    });

    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(config.provider?.custom.models?.["model-unknown-internal"]).toBeDefined();
  });

  it("keeps a text-only external model when only modelsInfoHideInternal is set (the bug this option fixes)", async () => {
    // This is the exact false-positive modelsInfoHideTextOnly caused: a
    // legitimate, externally-usable text-only model must not be hidden just
    // because it lacks vision input — hideInternal only reacts to `internal`.
    const textOnlyExternal: OpenRouterModel = {
      id: "glm-4.7-flash",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] }
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [textOnlyExternal] }), { status: 200 })
      );
    const config = withProvider("custom", {
      options: {
        baseURL: "https://x.test/v1",
        meta: { modelsInfoUrl: "models/info", modelsInfoHideInternal: true }
      },
      models: { "glm-4.7-flash": {} }
    });

    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(config.provider?.custom.models?.["glm-4.7-flash"]).toBeDefined();
  });

  it("does not hide an unmatched model when only modelsInfoHideInternal is set", async () => {
    // The unmatched-model deletion path stays governed solely by
    // modelsInfoHideTextOnly — an unknown model's status is unknown, not
    // "internal", so modelsInfoHideInternal alone must not delete it.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [openRouterEntry] }), { status: 200 })
      );
    const config = withProvider("custom", {
      options: {
        baseURL: "https://x.test/v1",
        meta: { modelsInfoUrl: "models/info", modelsInfoHideInternal: true }
      },
      models: { "not-in-catalog": { name: "Untouched" } }
    });

    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(getModel(config, "custom", "not-in-catalog").name).toBe("Untouched");
  });

  it("does not refetch when a non-expired cache entry exists", async () => {
    const seed = new Map<string, CachedModelsRecord>();
    const fetchImpl = vi.fn();
    const config = withProvider("custom", {
      options: { baseURL: "https://x.test", meta: { modelsInfoUrl: "https://x.test/m" } },
      models: { "model-a": {} }
    });

    const { cacheKey } = await import("../src/cache.js");
    seed.set(cacheKey("custom", "https://x.test/m"), {
      fetchedAt: 0,
      ttlSeconds: 3600,
      models: [openRouterEntry]
    });

    await enrichConfig(config, {
      cache: memoryCache(seed),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1000
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getModel(config, "custom", "model-a").cost).toEqual({ input: 3, output: 15 });
  });

  it("serves stale on fetch failure when a previous cache entry exists", async () => {
    const seed = new Map<string, CachedModelsRecord>();
    const { cacheKey } = await import("../src/cache.js");
    seed.set(cacheKey("custom", "https://x.test/m"), {
      fetchedAt: 0,
      ttlSeconds: 1,
      etag: "v1",
      models: [openRouterEntry]
    });

    const fetchImpl = vi.fn().mockResolvedValue(new Response("boom", { status: 502 }));
    const logger = silentLogger();
    const config = withProvider("custom", {
      options: { meta: { modelsInfoUrl: "https://x.test/m" } },
      models: { "model-a": {} }
    });

    await enrichConfig(config, {
      cache: memoryCache(seed),
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_000_000
    });

    expect(getModel(config, "custom", "model-a").cost).toEqual({ input: 3, output: 15 });
    expect(logger.warn).toHaveBeenCalledWith(
      "models_info_fetch_failed_using_stale",
      expect.objectContaining({ providerId: "custom" })
    );
  });

  it("respects 304 Not Modified by reusing cached models and refreshing fetchedAt", async () => {
    const seed = new Map<string, CachedModelsRecord>();
    const { cacheKey } = await import("../src/cache.js");
    const key = cacheKey("custom", "https://x.test/m");
    seed.set(key, {
      fetchedAt: 0,
      ttlSeconds: 1,
      etag: "v1",
      models: [openRouterEntry]
    });

    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));
    const config = withProvider("custom", {
      options: { meta: { modelsInfoUrl: "https://x.test/m" } },
      models: { "model-a": {} }
    });

    await enrichConfig(config, {
      cache: memoryCache(seed),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 9_000_000
    });

    expect(getModel(config, "custom", "model-a").limit).toEqual({
      context: 128_000,
      output: 4096
    });
    expect(seed.get(key)?.fetchedAt).toBe(9_000_000);
  });

  it("forwards provider.options.headers into the fetch (auth-agnostic composition)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [openRouterEntry] }), { status: 200 })
      );
    const config = withProvider("custom", {
      options: {
        headers: { Authorization: "Bearer from-provider", "x-tenant": "t1" },
        meta: { modelsInfoUrl: "https://x.test/m" }
      },
      models: { "model-a": {} }
    });

    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer from-provider");
    expect(headers["x-tenant"]).toBe("t1");
  });

  it("lets meta.modelsInfoHeaders override provider.options.headers on conflict", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [openRouterEntry] }), { status: 200 })
      );
    const config = withProvider("custom", {
      options: {
        headers: { Authorization: "Bearer provider" },
        meta: {
          modelsInfoUrl: "https://x.test/m",
          modelsInfoHeaders: { Authorization: "Bearer meta-wins" }
        }
      },
      models: { "model-a": {} }
    });

    await enrichConfig(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer meta-wins");
  });

  it("logs models_info_enrichment_failed instead of silently swallowing an unexpected error", async () => {
    const logger = silentLogger();
    const explodingCache: CacheStore = {
      get: async () => {
        throw new Error("disk on fire");
      },
      put: async () => undefined
    };
    const config = withProvider("custom", {
      options: { meta: { modelsInfoUrl: "https://x.test/m" } },
      models: { "model-a": {} }
    });

    await enrichConfig(config, {
      cache: explodingCache,
      logger,
      fetchImpl: vi.fn() as unknown as typeof fetch
    });

    expect(logger.error).toHaveBeenCalledWith(
      "models_info_enrichment_failed",
      expect.objectContaining({ providerId: "custom", error: "disk on fire" })
    );
  });

  it("treats a fully-filtered response as a parse error and serves stale cache", async () => {
    const seed = new Map<string, CachedModelsRecord>();
    const { cacheKey } = await import("../src/cache.js");
    seed.set(cacheKey("custom", "https://x.test/m"), {
      fetchedAt: 0,
      ttlSeconds: 1,
      models: [openRouterEntry]
    });

    // Response has entries, but none have a string `id` — looks like a
    // schema mismatch (e.g. provider changed its catalog format). Plugin
    // should keep the previous snapshot rather than overwriting with [].
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ name: "no-id" }, { id: 42 }] }), { status: 200 })
      );
    const logger = silentLogger();
    const config = withProvider("custom", {
      options: { meta: { modelsInfoUrl: "https://x.test/m" } },
      models: { "model-a": {} }
    });

    await enrichConfig(config, {
      cache: memoryCache(seed),
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_000_000
    });

    expect(getModel(config, "custom", "model-a").cost).toEqual({ input: 3, output: 15 });
    expect(logger.warn).toHaveBeenCalledWith(
      "models_info_fetch_failed_using_stale",
      expect.objectContaining({ providerId: "custom" })
    );
  });

  it("logs a warning but still enriches when cache.put fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [openRouterEntry] }), { status: 200 })
      );
    const logger = silentLogger();
    const flakyCache: CacheStore = {
      get: async () => undefined,
      put: async () => {
        throw new Error("read-only filesystem");
      }
    };

    const config = withProvider("custom", {
      options: { meta: { modelsInfoUrl: "https://x.test/m" } },
      models: { "model-a": {} }
    });

    await enrichConfig(config, {
      cache: flakyCache,
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "models_info_cache_write_failed",
      expect.objectContaining({ providerId: "custom", error: "read-only filesystem" })
    );
    // Crucially, the model was enriched even though the disk write failed.
    expect(getModel(config, "custom", "model-a").cost).toEqual({ input: 3, output: 15 });
  });

  it("applies the current TTL when refreshing a 304 response", async () => {
    const seed = new Map<string, CachedModelsRecord>();
    const { cacheKey } = await import("../src/cache.js");
    const key = cacheKey("custom", "https://x.test/m");
    seed.set(key, {
      fetchedAt: 0,
      ttlSeconds: 1, // old TTL stored on disk
      etag: "v1",
      models: [openRouterEntry]
    });

    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));
    const config = withProvider("custom", {
      options: {
        meta: {
          modelsInfoUrl: "https://x.test/m",
          modelsInfoTtlSeconds: 7200 // bumped in config
        }
      },
      models: { "model-a": {} }
    });

    await enrichConfig(config, {
      cache: memoryCache(seed),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_000_000
    });

    expect(seed.get(key)?.ttlSeconds).toBe(7200);
  });
});

describe("startCacheRefreshSchedulers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns no handles when there are no providers at all", () => {
    expect(
      startCacheRefreshSchedulers({}, { cache: memoryCache(), logger: silentLogger() })
    ).toEqual([]);
  });

  it("skips a provider that hasn't opted into meta.modelsInfoUrl", () => {
    const config = withProvider("bare", {
      options: { baseURL: "https://x.test" },
      models: { "model-a": {} }
    });
    expect(
      startCacheRefreshSchedulers(config, { cache: memoryCache(), logger: silentLogger() })
    ).toEqual([]);
  });

  it("refreshes on the meta.modelsInfoTtlSeconds cadence, unconditionally — not gated by cache freshness", async () => {
    // Seed a cache entry that is NOT expired (fetchedAt === "now"). loadRecord
    // would skip the network call for a fresh entry like this; the scheduler
    // must fetch anyway, since a background refresh's entire point is to
    // notice upstream changes before the cache would naturally go stale.
    const { cacheKey } = await import("../src/cache.js");
    const fixedNow = 500;
    const seed = new Map<string, CachedModelsRecord>();
    seed.set(cacheKey("custom", "https://x.test/m"), {
      fetchedAt: fixedNow,
      ttlSeconds: 1,
      etag: "v1",
      models: [openRouterEntry]
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));
    const config = withProvider("custom", {
      options: { meta: { modelsInfoUrl: "https://x.test/m", modelsInfoTtlSeconds: 1 } },
      models: {}
    });

    const handles = startCacheRefreshSchedulers(config, {
      cache: memoryCache(seed),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => fixedNow
    });
    expect(handles).toHaveLength(1);

    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); // modelsInfoTtlSeconds: 1 -> 1000ms interval
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("starts one independent scheduler per opted-in provider", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const config: EnrichConfigInput = {
      provider: {
        fast: {
          options: { meta: { modelsInfoUrl: "https://x.test/fast", modelsInfoTtlSeconds: 1 } },
          models: {}
        },
        slow: {
          options: { meta: { modelsInfoUrl: "https://x.test/slow", modelsInfoTtlSeconds: 10 } },
          models: {}
        }
      }
    };

    const handles = startCacheRefreshSchedulers(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(handles).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // only "fast" has ticked so far

    await vi.advanceTimersByTimeAsync(9000);
    expect(fetchImpl).toHaveBeenCalledTimes(11); // "fast" ticked 9 more times, "slow" once
  });

  it("stop() halts further refreshes for that provider", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const config = withProvider("custom", {
      options: { meta: { modelsInfoUrl: "https://x.test/m", modelsInfoTtlSeconds: 1 } },
      models: {}
    });

    const [handle] = startCacheRefreshSchedulers(config, {
      cache: memoryCache(),
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    handle.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
