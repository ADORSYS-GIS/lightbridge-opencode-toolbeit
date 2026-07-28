import type { PluginInput } from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CacheStore } from "../src/cache.js";
import type { Logger } from "../src/logging.js";
import { createOpencodeModelsInfoPlugin } from "../src/opencode.js";
import type { CachedModelsRecord } from "../src/types.js";

function silentLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function memoryCache(): CacheStore {
  const store = new Map<string, CachedModelsRecord>();
  return {
    get: async (key) => store.get(key),
    put: async (key, record) => void store.set(key, record)
  };
}

function fakePluginInput(): PluginInput {
  return { client: { app: { log: async () => undefined } } } as unknown as PluginInput;
}

function okResponse(): Response {
  return new Response(JSON.stringify({ data: [] }), { status: 200 });
}

describe("createOpencodeModelsInfoPlugin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a refresh scheduler on config, ticking on the provider's modelsInfoTtlSeconds cadence", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const plugin = createOpencodeModelsInfoPlugin({
      logger: silentLogger(),
      cache: memoryCache(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const hooks = await plugin(fakePluginInput());

    const config = {
      provider: {
        custom: {
          options: { meta: { modelsInfoUrl: "https://x.test/m", modelsInfoTtlSeconds: 1 } },
          models: { "model-a": {} }
        }
      }
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal SDKConfig stand-in for the test
    await hooks.config?.(config as any);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // initial enrichConfig fetch (cold cache)

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // scheduler tick refreshed the cache
  });

  it("dispose() stops the scheduler so no further ticks fire", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const plugin = createOpencodeModelsInfoPlugin({
      logger: silentLogger(),
      cache: memoryCache(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const hooks = await plugin(fakePluginInput());

    const config = {
      provider: {
        custom: {
          options: { meta: { modelsInfoUrl: "https://x.test/m", modelsInfoTtlSeconds: 1 } },
          models: { "model-a": {} }
        }
      }
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal SDKConfig stand-in for the test
    await hooks.config?.(config as any);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await hooks.dispose?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a rebuilt config stops the prior scheduler instead of leaking a duplicate", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const plugin = createOpencodeModelsInfoPlugin({
      logger: silentLogger(),
      cache: memoryCache(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const hooks = await plugin(fakePluginInput());

    const config = {
      provider: {
        custom: {
          options: { meta: { modelsInfoUrl: "https://x.test/m", modelsInfoTtlSeconds: 1 } },
          models: { "model-a": {} }
        }
      }
    };
    // OpenCode re-runs `config` on certain config edits — simulate that here.
    // biome-ignore lint/suspicious/noExplicitAny: minimal SDKConfig stand-in for the test
    await hooks.config?.(config as any);
    // biome-ignore lint/suspicious/noExplicitAny: minimal SDKConfig stand-in for the test
    await hooks.config?.(config as any);
    // Second call's cache is already fresh (same frozen fake-timer instant),
    // so only the first call actually hits the network.
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    // Exactly one more tick — if the first scheduler leaked, this would be 2.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
