import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cacheKey, type CacheStore } from "../src/cache.js";
import type { Logger } from "../src/logging.js";
import type { EnrichableModel } from "../src/mapping.js";
import {
  createModelsInfoEngine,
  type EnrichDeps,
  type ListedModel,
  type ModelEditorLike,
  type ProviderEntry
} from "../src/plugin.js";
import type { CachedModelsRecord, OpenRouterModel } from "../src/types.js";

function silentLogger(): Logger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function memoryCache(seed: Map<string, CachedModelsRecord> = new Map()): CacheStore {
  return {
    get: async (key) => seed.get(key),
    put: async (key, record) => void seed.set(key, record)
  };
}

/**
 * What `@vymalo/opencode-provider-sync` writes for a discovered model: every
 * `Model.Info` field present, the unknowns filled with sentinels.
 */
function placeholder(id: string, over: Partial<ListedModel> = {}): ListedModel {
  return {
    id,
    modelID: id,
    name: id,
    capabilities: { tools: false, input: [], output: [] },
    limit: { context: 0, output: 0 },
    cost: [],
    ...over
  };
}

interface Harness {
  editor: ModelEditorLike;
  models: Map<string, ListedModel[]>;
  removed: string[];
}

function harness(providers: ProviderEntry[], models: Record<string, ListedModel[]>): Harness {
  const store = new Map(Object.entries(models).map(([id, list]) => [id, [...list]]));
  const removed: string[] = [];
  const editor: ModelEditorLike = {
    list: (providerID) => (providerID ? (store.get(providerID) ?? []) : [...store.values()].flat()),
    update: (providerID, modelID, fn) => {
      const model = store.get(providerID)?.find((m) => m.id === modelID);
      if (model) {
        fn(model as EnrichableModel);
      }
    },
    remove: (providerID, modelID) => {
      removed.push(`${providerID}/${modelID}`);
      const list = store.get(providerID) ?? [];
      store.set(
        providerID,
        list.filter((m) => m.id !== modelID)
      );
    },
    provider: { list: () => providers.map((provider) => ({ provider })) }
  };
  return { editor, models: store, removed };
}

const entry: OpenRouterModel = {
  id: "model-a",
  name: "Model A",
  context_length: 128_000,
  pricing: { prompt: "0.000003", completion: "0.000015" },
  top_provider: { max_completion_tokens: 4096 },
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  supported_parameters: ["tools", "temperature"]
};

const textOnly: OpenRouterModel = {
  id: "text-only",
  architecture: { input_modalities: ["text"], output_modalities: ["text"] }
};

function catalog(...models: OpenRouterModel[]): Response {
  return new Response(JSON.stringify({ data: models }), { status: 200 });
}

function setup(
  providers: ProviderEntry[],
  models: Record<string, ListedModel[]>,
  fetchImpl: ReturnType<typeof vi.fn>,
  over: Partial<EnrichDeps> = {}
) {
  const h = harness(providers, models);
  const onChange = vi.fn();
  const logger = silentLogger();
  const engine = createModelsInfoEngine({
    cache: memoryCache(),
    logger,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => 0,
    onChange,
    ...over
  });
  /** First pass starts the load (no data yet); second pass is what `reload()` triggers. */
  const settle = async () => {
    h.editor.provider.list();
    engine.transform(h.editor);
    await engine.idle();
    engine.transform(h.editor);
  };
  return { ...h, engine, onChange, logger, settle };
}

const gw = (
  settings: Record<string, unknown> = {},
  headers?: Record<string, string>
): ProviderEntry[] => [
  {
    id: "gw",
    settings: { baseURL: "https://x.test/v1", modelsInfoUrl: "https://x.test/m", ...settings },
    headers
  }
];

const model = (s: ReturnType<typeof setup>, id = "model-a") =>
  s.models.get("gw")?.find((m) => m.id === id) as ListedModel;

describe("placeholder (sentinel) handling — upstream-wins treats unknown as absent", () => {
  it("enriches a provider-sync placeholder in every field", async () => {
    const s = setup(
      gw(),
      { gw: [placeholder("model-a")] },
      vi.fn().mockResolvedValue(catalog(entry))
    );
    await s.settle();

    const m = model(s);
    // `name` is always a real string on a discovered model (provider-sync's
    // normalized display name), so as in v1 only modelsInfoOverwrite replaces it.
    expect(m.name).toBe("model-a");
    expect(m.limit).toEqual({ context: 128_000, output: 4096 });
    expect(m.cost).toEqual([{ input: 3, output: 15, cache: { read: 0, write: 0 } }]);
    expect(m.capabilities).toEqual({
      tools: true,
      temperature: true,
      input: ["text", "image"],
      output: ["text"]
    });
  });

  it("never overwrites real values — only the sentinel fields move", async () => {
    const real = placeholder("model-a", {
      name: "Hand named",
      limit: { context: 8000, output: 1000 },
      cost: [{ input: 9, output: 9, cache: { read: 1, write: 1 } }],
      capabilities: { tools: true, input: ["text"], output: ["text"], temperature: false }
    });
    const s = setup(gw(), { gw: [real] }, vi.fn().mockResolvedValue(catalog(entry)));
    await s.settle();

    expect(model(s)).toMatchObject({
      name: "Hand named",
      limit: { context: 8000, output: 1000 },
      cost: [{ input: 9, output: 9, cache: { read: 1, write: 1 } }],
      capabilities: { tools: true, input: ["text"], output: ["text"], temperature: false }
    });
  });

  it("fills only the fields that are still sentinels when the model is half-known", async () => {
    const half = placeholder("model-a", {
      limit: { context: 4096, output: 512 },
      capabilities: { tools: true, input: [], output: [] }
    });
    const s = setup(gw(), { gw: [half] }, vi.fn().mockResolvedValue(catalog(entry)));
    await s.settle();

    expect(model(s).limit).toEqual({ context: 4096, output: 512 }); // real: kept
    expect(model(s).cost).toHaveLength(1); // sentinel []: filled
    expect(model(s).capabilities.input).toEqual(["text", "image"]); // sentinel []: filled
  });

  it("treats limit {0,0} as absent but a partial zero as real", async () => {
    const s = setup(
      gw(),
      { gw: [placeholder("model-a", { limit: { context: 5000, output: 0 } })] },
      vi.fn().mockResolvedValue(catalog(entry))
    );
    await s.settle();
    expect(model(s).limit).toEqual({ context: 5000, output: 0 });
  });

  it("keeps the optional limit.input another plugin set when filling limit", async () => {
    const s = setup(
      gw(),
      { gw: [placeholder("model-a", { limit: { context: 0, output: 0, input: 7 } })] },
      vi.fn().mockResolvedValue(catalog(entry))
    );
    await s.settle();
    expect(model(s).limit).toEqual({ context: 128_000, output: 4096, input: 7 });
  });

  it("is idempotent across repeated transforms", async () => {
    const s = setup(
      gw(),
      { gw: [placeholder("model-a")] },
      vi.fn().mockResolvedValue(catalog(entry))
    );
    await s.settle();
    const first = JSON.stringify(model(s));
    s.engine.transform(s.editor);
    expect(JSON.stringify(model(s))).toBe(first);
  });

  it("modelsInfoOverwrite replaces a real value, sentinel or not", async () => {
    const s = setup(
      gw({ modelsInfoOverwrite: ["name", "limit"] }),
      {
        gw: [
          placeholder("model-a", { name: "Model A (normalized)", limit: { context: 1, output: 1 } })
        ]
      },
      vi.fn().mockResolvedValue(catalog(entry))
    );
    await s.settle();
    expect(model(s).name).toBe("Model A");
    expect(model(s).limit).toEqual({ context: 128_000, output: 4096 });
  });

  it("clears a stale tools:true under overwrite when the endpoint reports no tools", async () => {
    const noTools: OpenRouterModel = { ...entry, supported_parameters: ["temperature"] };
    const s = setup(
      gw({ modelsInfoOverwrite: ["tools"] }),
      {
        gw: [
          placeholder("model-a", {
            capabilities: { tools: true, input: ["text"], output: ["text"] }
          })
        ]
      },
      vi.fn().mockResolvedValue(catalog(noTools))
    );
    await s.settle();
    expect(model(s).capabilities.tools).toBe(false);
  });

  it("without overwrite, a tools:false sentinel stays false when the endpoint has no tools", async () => {
    const noTools: OpenRouterModel = { ...entry, supported_parameters: ["temperature"] };
    const s = setup(
      gw(),
      { gw: [placeholder("model-a")] },
      vi.fn().mockResolvedValue(catalog(noTools))
    );
    await s.settle();
    expect(model(s).capabilities.tools).toBe(false);
  });
});

describe("transform lifecycle", () => {
  it("applies nothing on the first pass, fetches, then reloads exactly once", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(catalog(entry));
    const s = setup(gw(), { gw: [placeholder("model-a")] }, fetchImpl);

    s.engine.transform(s.editor);
    expect(model(s).limit).toEqual({ context: 0, output: 0 }); // transform never awaits
    expect(s.onChange).not.toHaveBeenCalled();

    await s.engine.idle();
    expect(s.onChange).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    s.engine.transform(s.editor); // what reload() triggers
    expect(model(s).limit).toEqual({ context: 128_000, output: 4096 });
    expect(s.onChange).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no refetch per transform
    s.engine.dispose();
  });

  it("does not fetch for a provider that has not opted in", async () => {
    const fetchImpl = vi.fn();
    const s = setup(
      [{ id: "gw", settings: { baseURL: "https://x.test" } }, { id: "bare" }],
      { gw: [placeholder("model-a")] },
      fetchImpl
    );
    await s.settle();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(model(s).limit).toEqual({ context: 0, output: 0 });
  });

  it("resolves a relative modelsInfoUrl against settings.baseURL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(catalog(entry));
    const s = setup(gw({ modelsInfoUrl: "models/info" }), { gw: [] }, fetchImpl);
    await s.settle();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://x.test/v1/models/info");
  });

  it("skips (but still loads) a provider with no models", async () => {
    const s = setup(gw(), { gw: [] }, vi.fn().mockResolvedValue(catalog(entry)));
    await s.settle();
    expect(s.logger.debug).toHaveBeenCalledWith(
      "models_info_provider_skipped_no_models",
      expect.objectContaining({ providerId: "gw" })
    );
  });

  it("matches by the upstream modelID when the listed id differs", async () => {
    const s = setup(
      gw(),
      { gw: [placeholder("local-alias", { modelID: "model-a" })] },
      vi.fn().mockResolvedValue(catalog(entry))
    );
    await s.settle();
    expect(model(s, "local-alias").limit).toEqual({ context: 128_000, output: 4096 });
  });

  it("drops state and stops refreshing when a provider opts out", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockResolvedValue(catalog());
      const providers = gw({ modelsInfoTtlSeconds: 1 });
      const s = setup(providers, { gw: [] }, fetchImpl);
      await s.settle();
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      providers.splice(0, 1); // the provider no longer opts in
      s.engine.transform(s.editor);
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the load when the url changes", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(catalog(entry));
    const providers = gw();
    const s = setup(providers, { gw: [placeholder("model-a")] }, fetchImpl);
    await s.settle();

    const first = providers[0] as ProviderEntry;
    providers[0] = { ...first, settings: { ...first.settings, modelsInfoUrl: "https://y.test/m" } };
    await s.settle();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://y.test/m");
  });

  it("applies updated hide flags without refetching", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(catalog(entry));
    const providers = gw();
    const s = setup(providers, { gw: [placeholder("model-a"), placeholder("ghost")] }, fetchImpl);
    await s.settle();
    expect(s.removed).toEqual([]);

    const first = providers[0] as ProviderEntry;
    providers[0] = { ...first, settings: { ...first.settings, modelsInfoHideUnmatched: true } };
    s.engine.transform(s.editor);
    expect(s.removed).toEqual(["gw/ghost"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("hiding", () => {
  const two = [placeholder("model-a"), placeholder("text-only"), placeholder("ghost")];

  it("modelsInfoHideTextOnly removes text-only and unmatched models", async () => {
    const s = setup(
      gw({ modelsInfoHideTextOnly: true }),
      { gw: two },
      vi.fn().mockResolvedValue(catalog(entry, textOnly))
    );
    await s.settle();
    expect(s.removed.sort()).toEqual(["gw/ghost", "gw/text-only"]);
    expect(model(s).limit.context).toBe(128_000);
  });

  it("keeps an unmatched model when no hide flag is set", async () => {
    const s = setup(gw(), { gw: two }, vi.fn().mockResolvedValue(catalog(entry, textOnly)));
    await s.settle();
    expect(s.removed).toEqual([]);
  });

  it("modelsInfoHideUnmatched removes only the unmatched, not a text-only match", async () => {
    const s = setup(
      gw({ modelsInfoHideUnmatched: true }),
      { gw: two },
      vi.fn().mockResolvedValue(catalog(entry, textOnly))
    );
    await s.settle();
    expect(s.removed).toEqual(["gw/ghost"]);
  });

  it("does not hide on modality when the catalog never reported modalities", async () => {
    const s = setup(
      gw({ modelsInfoHideTextOnly: true }),
      { gw: [placeholder("bare")] },
      vi.fn().mockResolvedValue(catalog({ id: "bare" }))
    );
    await s.settle();
    expect(s.removed).toEqual([]);
  });

  it("modelsInfoHideInternal removes an internal match and spares text-only externals", async () => {
    const internal: OpenRouterModel = { ...entry, id: "secret", internal: true };
    const s = setup(
      gw({ modelsInfoHideInternal: true }),
      { gw: [placeholder("secret"), placeholder("text-only"), placeholder("ghost")] },
      vi.fn().mockResolvedValue(catalog(internal, textOnly))
    );
    await s.settle();
    expect(s.removed).toEqual(["gw/secret"]);
  });

  it("does not remove an internal model unless modelsInfoHideInternal is set", async () => {
    const internal: OpenRouterModel = { ...entry, id: "secret", internal: true };
    const s = setup(
      gw(),
      { gw: [placeholder("secret")] },
      vi.fn().mockResolvedValue(catalog(internal))
    );
    await s.settle();
    expect(s.removed).toEqual([]);
  });
});

describe("cache, staleness and conditional requests", () => {
  const key = cacheKey("gw", "https://x.test/m");

  it("does not refetch when a non-expired cache entry exists, and does not reload", async () => {
    const seed = new Map<string, CachedModelsRecord>();
    seed.set(key, { fetchedAt: 0, ttlSeconds: 3600, models: [entry] });
    const fetchImpl = vi.fn();
    const s = setup(gw(), { gw: [placeholder("model-a")] }, fetchImpl, {
      cache: memoryCache(seed)
    });
    await s.settle();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(model(s).limit.context).toBe(128_000);
  });

  it("serves stale on fetch failure when a previous cache entry exists", async () => {
    const seed = new Map<string, CachedModelsRecord>();
    seed.set(key, { fetchedAt: 0, ttlSeconds: 1, etag: "v1", models: [entry] });
    const s = setup(
      gw(),
      { gw: [placeholder("model-a")] },
      vi.fn().mockResolvedValue(new Response("boom", { status: 502 })),
      { cache: memoryCache(seed), now: () => 1_000_000 }
    );
    await s.settle();
    expect(model(s).limit.context).toBe(128_000);
    expect(s.logger.warn).toHaveBeenCalledWith(
      "models_info_fetch_failed_using_stale",
      expect.objectContaining({ providerId: "gw" })
    );
  });

  it("reuses the cached models on 304 and refreshes fetchedAt", async () => {
    const seed = new Map<string, CachedModelsRecord>();
    seed.set(key, { fetchedAt: 0, ttlSeconds: 1, etag: "v1", models: [entry] });
    const s = setup(
      gw(),
      { gw: [placeholder("model-a")] },
      vi.fn().mockResolvedValue(new Response(null, { status: 304 })),
      { cache: memoryCache(seed), now: () => 9_000_000 }
    );
    await s.settle();
    expect(model(s).limit.context).toBe(128_000);
    expect(seed.get(key)?.fetchedAt).toBe(9_000_000);
  });

  it("applies the current TTL when refreshing a 304", async () => {
    const seed = new Map<string, CachedModelsRecord>();
    seed.set(key, { fetchedAt: 0, ttlSeconds: 86_400, etag: "v1", models: [entry] });
    const s = setup(
      gw({ modelsInfoTtlSeconds: 60 }),
      { gw: [] },
      vi.fn().mockResolvedValue(new Response(null, { status: 304 })),
      { cache: memoryCache(seed), now: () => 90_000_000 }
    );
    await s.settle();
    expect(seed.get(key)?.ttlSeconds).toBe(60);
  });

  it("treats a fully-filtered response as a parse error and serves stale cache", async () => {
    const seed = new Map<string, CachedModelsRecord>();
    seed.set(key, { fetchedAt: 0, ttlSeconds: 1, models: [entry] });
    const s = setup(
      gw(),
      { gw: [placeholder("model-a")] },
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ name: "no-id" }, { id: 42 }] }), { status: 200 })
        ),
      { cache: memoryCache(seed), now: () => 1_000_000 }
    );
    await s.settle();
    expect(model(s).limit.context).toBe(128_000);
  });

  it("still enriches, with a warning, when cache.put fails", async () => {
    const cache: CacheStore = {
      get: async () => undefined,
      put: async () => {
        throw new Error("read-only fs");
      }
    };
    const s = setup(
      gw(),
      { gw: [placeholder("model-a")] },
      vi.fn().mockResolvedValue(catalog(entry)),
      {
        cache
      }
    );
    await s.settle();
    expect(model(s).limit.context).toBe(128_000);
    expect(s.logger.warn).toHaveBeenCalledWith(
      "models_info_cache_write_failed",
      expect.objectContaining({ providerId: "gw", error: "read-only fs" })
    );
  });

  it("logs models_info_enrichment_failed instead of throwing when the cache explodes", async () => {
    const cache: CacheStore = {
      get: async () => {
        throw new Error("disk on fire");
      },
      put: async () => undefined
    };
    const s = setup(gw(), { gw: [placeholder("model-a")] }, vi.fn(), { cache });
    await s.settle();
    expect(s.logger.error).toHaveBeenCalledWith(
      "models_info_enrichment_failed",
      expect.objectContaining({ providerId: "gw", error: "disk on fire" })
    );
    expect(s.onChange).not.toHaveBeenCalled();
  });

  it("logs models_info_enrichment_failed (not a throw) when an editor call explodes", async () => {
    const s = setup(
      gw(),
      { gw: [placeholder("model-a")] },
      vi.fn().mockResolvedValue(catalog(entry))
    );
    s.engine.transform(s.editor);
    await s.engine.idle();
    s.editor.update = () => {
      throw new Error("editor gone");
    };
    s.engine.transform(s.editor);
    expect(s.logger.error).toHaveBeenCalledWith(
      "models_info_enrichment_failed",
      expect.objectContaining({ providerId: "gw", error: "editor gone" })
    );
  });
});

describe("Authorization handoff", () => {
  const bearer = { Authorization: "Bearer t0" };

  it("forwards the model-domain provider headers into the fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(catalog(entry));
    const s = setup(gw({}, bearer), { gw: [] }, fetchImpl);
    await s.settle();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t0");
    expect(s.logger.trace).toHaveBeenCalledWith(
      "models_info_provider_headers_resolved",
      expect.objectContaining({ source: "model-domain", hasAuthorization: true })
    );
  });

  it("falls back to headers observed by a provider-domain transform", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(catalog(entry));
    const s = setup(gw(), { gw: [] }, fetchImpl);
    s.engine.observeProviders([{ id: "gw", headers: bearer }]);
    await s.settle();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t0");
    expect(s.logger.trace).toHaveBeenCalledWith(
      "models_info_provider_headers_resolved",
      expect.objectContaining({ source: "provider-domain" })
    );
  });

  it("treats absent headers as no credential, not an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(catalog(entry));
    const s = setup(gw(), { gw: [] }, fetchImpl);
    await s.settle();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(Object.keys(init.headers as object)).not.toContain("Authorization");
    expect(s.logger.error).not.toHaveBeenCalled();
  });

  it("lets settings.modelsInfoHeaders override the provider's Authorization", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(catalog(entry));
    const s = setup(
      gw({ modelsInfoHeaders: { Authorization: "Bearer metadata-only" } }, bearer),
      { gw: [] },
      fetchImpl
    );
    await s.settle();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer metadata-only");
  });

  it("forgets headers a provider no longer carries", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(catalog(entry));
    const s = setup(gw(), { gw: [] }, fetchImpl);
    s.engine.observeProviders([{ id: "gw", headers: bearer }]);
    s.engine.observeProviders([{ id: "gw" }]);
    await s.settle();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(Object.keys(init.headers as object)).not.toContain("Authorization");
  });

  it("retries a no-cache failure (401) once a credential appears, and reloads", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("no", { status: 401 }))
      .mockResolvedValueOnce(catalog(entry));
    const providers = gw();
    const s = setup(providers, { gw: [placeholder("model-a")] }, fetchImpl);

    s.engine.transform(s.editor);
    await s.engine.idle();
    expect(s.logger.warn).toHaveBeenCalledWith(
      "models_info_fetch_failed_no_cache",
      expect.objectContaining({ error: "HTTP 401" })
    );
    expect(s.onChange).not.toHaveBeenCalled();

    s.engine.transform(s.editor); // same (empty) credentials: no retry loop
    await s.engine.idle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    providers[0] = { ...(providers[0] as ProviderEntry), headers: bearer };
    s.engine.transform(s.editor);
    await s.engine.idle();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(s.onChange).toHaveBeenCalledTimes(1);
  });
});

describe("reload signalling and periodic refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes on the modelsInfoTtlSeconds cadence, unconditionally", async () => {
    const seed = new Map<string, CachedModelsRecord>();
    seed.set(cacheKey("gw", "https://x.test/m"), {
      fetchedAt: 500,
      ttlSeconds: 1,
      etag: "v1",
      models: [entry]
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));
    const s = setup(gw({ modelsInfoTtlSeconds: 1 }), { gw: [] }, fetchImpl, {
      cache: memoryCache(seed),
      now: () => 500
    });
    await s.settle();
    expect(fetchImpl).not.toHaveBeenCalled(); // cache still fresh at boot

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(s.onChange).toHaveBeenCalledTimes(1); // 304s never change the catalog
    s.engine.dispose();
  });

  it("calls reload when a periodic refresh brings a different catalog", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(catalog(entry))
      .mockResolvedValue(catalog({ ...entry, context_length: 256_000 }));
    const s = setup(gw({ modelsInfoTtlSeconds: 1 }), { gw: [placeholder("model-a")] }, fetchImpl);
    await s.settle();
    expect(s.onChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(s.onChange).toHaveBeenCalledTimes(2);
    s.engine.transform(s.editor);
    // the placeholder was already filled with the first catalog's value; upstream-wins keeps it
    expect(model(s).limit.context).toBe(128_000);
    s.engine.dispose();
  });

  it("starts one independent scheduler per opted-in provider", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => catalog());
    const providers: ProviderEntry[] = [
      { id: "fast", settings: { modelsInfoUrl: "https://x.test/fast", modelsInfoTtlSeconds: 1 } },
      { id: "slow", settings: { modelsInfoUrl: "https://x.test/slow", modelsInfoTtlSeconds: 10 } }
    ];
    const s = setup(providers, {}, fetchImpl);
    await s.settle();
    expect(fetchImpl).toHaveBeenCalledTimes(2); // one boot load each

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // only "fast" has ticked
    await vi.advanceTimersByTimeAsync(9000);
    expect(fetchImpl).toHaveBeenCalledTimes(13); // fast x9 more, slow x1
    s.engine.dispose();
  });

  it("dispose() stops every scheduler and silences late loads", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => catalog(entry));
    const s = setup(gw({ modelsInfoTtlSeconds: 1 }), { gw: [placeholder("model-a")] }, fetchImpl);
    s.engine.transform(s.editor);
    s.engine.dispose(); // load still in flight
    await s.engine.idle();
    expect(s.onChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("accepts an injected scheduler", async () => {
    const stop = vi.fn();
    const scheduler = vi.fn().mockReturnValue({ stop });
    const s = setup(gw(), { gw: [] }, vi.fn().mockResolvedValue(catalog()), { scheduler });
    await s.settle();
    expect(scheduler).toHaveBeenCalledWith(
      expect.objectContaining({ taskName: "models-info-refresh:gw", intervalMs: 86_400_000 })
    );
    s.engine.dispose();
    expect(stop).toHaveBeenCalled();
  });
});
