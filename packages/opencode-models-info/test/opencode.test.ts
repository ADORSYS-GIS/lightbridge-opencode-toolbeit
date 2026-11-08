import type { Plugin } from "@opencode/plugin/effect";
import { Effect, Exit, Logger, References, Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CacheStore } from "../src/cache.js";
import {
  createOpencodeModelsInfoPlugin,
  OpencodeModelsInfoPlugin,
  PLUGIN_ID
} from "../src/opencode.js";
import type { ListedModel, ModelsInfoEngine } from "../src/plugin.js";
import type { CachedModelsRecord } from "../src/types.js";

type ProviderCb = (editor: unknown) => void;

function fakeCtx(options: Record<string, unknown> = {}) {
  let providerCb: ProviderCb | undefined;
  let modelCb: ProviderCb | undefined;
  const reload = vi.fn(() => Effect.void);
  const registration = Effect.succeed({ dispose: Effect.void });
  const ctx = {
    options,
    provider: {
      transform: (cb: ProviderCb) => {
        providerCb = cb;
        return registration;
      }
    },
    model: {
      transform: (cb: ProviderCb) => {
        modelCb = cb;
        return registration;
      },
      reload
    }
  } as unknown as Plugin.Context;
  return { ctx, reload, provider: () => providerCb, model: () => modelCb };
}

function memoryCache(): CacheStore {
  const store = new Map<string, CachedModelsRecord>();
  return {
    get: async (key) => store.get(key),
    put: async (key, record) => void store.set(key, record)
  };
}

function silentLogger() {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const providerRecord = (headers?: Record<string, string>) => ({
  provider: {
    id: "gw",
    settings: { baseURL: "https://x.test/v1", modelsInfoUrl: "models" },
    headers
  }
});

function modelEditor(models: ListedModel[], headers?: Record<string, string>) {
  return {
    list: () => models,
    update: (_p: string, id: string, fn: (m: ListedModel) => void) => {
      const model = models.find((m) => m.id === id);
      if (model) {
        fn(model);
      }
    },
    remove: vi.fn(),
    provider: { list: () => [providerRecord(headers)] }
  };
}

const placeholder = (): ListedModel => ({
  id: "kimi",
  modelID: "kimi",
  name: "Kimi",
  capabilities: { tools: false, input: [], output: [] },
  limit: { context: 0, output: 0 },
  cost: []
});

const catalog = () =>
  new Response(
    JSON.stringify({
      data: [
        {
          id: "kimi",
          context_length: 200_000,
          top_provider: { max_completion_tokens: 8192 },
          supported_parameters: ["tools"]
        }
      ]
    }),
    { status: 200 }
  );

async function start(
  over: Parameters<typeof createOpencodeModelsInfoPlugin>[0] = {},
  options: Record<string, unknown> = {}
) {
  const fake = fakeCtx(options);
  let engine: ModelsInfoEngine | undefined;
  const plugin = createOpencodeModelsInfoPlugin({
    logger: silentLogger(),
    cache: memoryCache(),
    onEngine: (e) => {
      engine = e;
    },
    ...over
  });
  // A long-lived scope: closing it runs the plugin finalizer (engine.dispose).
  const scope = Scope.makeUnsafe();
  await Effect.runPromise(Effect.provideService(plugin.effect(fake.ctx), Scope.Scope, scope));
  return { fake, engine: engine as ModelsInfoEngine, scope };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createOpencodeModelsInfoPlugin", () => {
  it("has a stable id", () => {
    expect(PLUGIN_ID).toBe("vymalo.models-info");
    expect(createOpencodeModelsInfoPlugin().id).toBe(PLUGIN_ID);
    expect(OpencodeModelsInfoPlugin.id).toBe(PLUGIN_ID);
  });

  it("registers a model transform and a read-only provider transform", async () => {
    const { fake } = await start();
    expect(fake.model()).toBeTypeOf("function");
    expect(fake.provider()).toBeTypeOf("function");
  });

  it("enriches after the catalog lands: first transform fetches, reload() triggers the second", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => catalog());
    const { fake, engine } = await start({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const models = [placeholder()];
    const editor = modelEditor(models);

    fake.model()?.(editor);
    expect(models[0]?.limit).toEqual({ context: 0, output: 0 }); // transform never awaits
    await engine.idle();
    await Promise.resolve();

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://x.test/v1/models");
    expect(fake.reload).toHaveBeenCalledTimes(1);

    fake.model()?.(editor); // the host's reload re-runs the transform
    expect(models[0]?.limit).toEqual({ context: 200_000, output: 8192 });
    expect(models[0]?.capabilities.tools).toBe(true);
    engine.dispose();
  });

  it("hands the provider-domain Authorization to the catalog fetch when the model domain can't see it", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => catalog());
    const { fake, engine } = await start({ fetchImpl: fetchImpl as unknown as typeof fetch });

    // oauth2's bearer is visible to the provider-domain transform only.
    fake.provider()?.({ list: () => [providerRecord({ Authorization: "Bearer from-oauth2" })] });
    fake.model()?.(modelEditor([placeholder()], undefined));
    await engine.idle();

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer from-oauth2");
    engine.dispose();
  });

  it("prefers the model-domain view of the provider's Authorization when it has one", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => catalog());
    const { fake, engine } = await start({ fetchImpl: fetchImpl as unknown as typeof fetch });

    fake.provider()?.({ list: () => [providerRecord({ Authorization: "Bearer stale" })] });
    fake.model()?.(modelEditor([placeholder()], { Authorization: "Bearer fresh" }));
    await engine.idle();

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer fresh");
    engine.dispose();
  });

  it("disposes the engine (stopping schedulers) when the plugin scope closes", async () => {
    const fake = fakeCtx();
    let dispose: ReturnType<typeof vi.spyOn> | undefined;
    const plugin = createOpencodeModelsInfoPlugin({
      logger: silentLogger(),
      cache: memoryCache(),
      onEngine: (e) => {
        dispose = vi.spyOn(e, "dispose");
      }
    });
    const scope = Scope.makeUnsafe();
    await Effect.runPromise(Effect.provideService(plugin.effect(fake.ctx), Scope.Scope, scope));
    expect(dispose).not.toHaveBeenCalled();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe("the default logger runs on the host's context (ADR-0014)", () => {
  it("delivers the plugin's own records to the host logger, never the console", async () => {
    const records: Array<{ level: string; message: unknown[] }> = [];
    const recorder = Logger.make<unknown, void>((options) => {
      records.push({ level: options.logLevel, message: options.message as unknown[] });
    });
    const consoles = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {})
    ];

    const fake = fakeCtx({ logLevel: "info" });
    let engine: ModelsInfoEngine | undefined;
    const plugin = createOpencodeModelsInfoPlugin({
      cache: memoryCache(),
      fetchImpl: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch,
      onEngine: (e) => {
        engine = e;
      }
    });

    await Effect.runPromise(
      Effect.provideService(plugin.effect(fake.ctx), Scope.Scope, Scope.makeUnsafe()).pipe(
        Effect.provide(Logger.layer([recorder], { mergeWithExisting: false })),
        Effect.provideService(References.MinimumLogLevel, "All")
      )
    );

    // 401 with no cache: the warn the docs call out as the Authorization symptom.
    fake.model()?.(modelEditor([placeholder()]));
    await engine?.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    engine?.dispose();

    expect(records.map((r) => [r.level, r.message[0]])).toContainEqual([
      "Warn",
      "models_info_fetch_failed_no_cache"
    ]);
    for (const spy of consoles) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
