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

describe("ADR-0014: the plugin's own diagnostics never touch the terminal", () => {
  // client.app.log needs to be a spy (not just an async no-op) so we can
  // assert on what actually reached the host log.
  function spiedPluginInput(): PluginInput {
    return {
      client: { app: { log: vi.fn().mockResolvedValue(undefined) } }
    } as unknown as PluginInput;
  }

  // A fetch that always 502s, against a cold (empty) cache, is the simplest
  // reliable way to force a real `warn` record
  // (`models_info_fetch_failed_no_cache`) without waiting on a live catalog.
  function withFailingFetch() {
    return {
      cache: memoryCache(),
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response("boom", { status: 502 })) as unknown as typeof fetch
    };
  }

  function failingConfig() {
    return {
      provider: {
        custom: {
          options: { meta: { modelsInfoUrl: "https://x.test/m" } },
          models: { "model-a": {} }
        }
      }
    };
  }

  it("never mirrors a warn record to the console fallback", async () => {
    const input = spiedPluginInput();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    // No `logger:` option — this exercises the real, default
    // `createOpenCodeLogger`, not a test double.
    const plugin = createOpencodeModelsInfoPlugin(withFailingFetch());
    const hooks = await plugin(input);
    // biome-ignore lint/suspicious/noExplicitAny: minimal SDKConfig stand-in for the test
    await hooks.config?.(failingConfig() as any);

    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    warn.mockRestore();
    log.mockRestore();
  });

  it("still forwards the warn record to client.app.log at its true level", async () => {
    const input = spiedPluginInput();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const plugin = createOpencodeModelsInfoPlugin(withFailingFetch());
    const hooks = await plugin(input);
    // biome-ignore lint/suspicious/noExplicitAny: minimal SDKConfig stand-in for the test
    await hooks.config?.(failingConfig() as any);

    const log = input.client.app.log as unknown as ReturnType<typeof vi.fn>;
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          service: "opencode-models-info-plugin",
          level: "warn",
          message: "models_info_fetch_failed_no_cache"
        })
      })
    );
    vi.restoreAllMocks();
  });

  it("restores the console mirror when VYMALO_PLUGIN_CONSOLE_LOG is set", async () => {
    const input = spiedPluginInput();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const previous = process.env.VYMALO_PLUGIN_CONSOLE_LOG;
    process.env.VYMALO_PLUGIN_CONSOLE_LOG = "1";

    try {
      const plugin = createOpencodeModelsInfoPlugin(withFailingFetch());
      const hooks = await plugin(input);
      // biome-ignore lint/suspicious/noExplicitAny: minimal SDKConfig stand-in for the test
      await hooks.config?.(failingConfig() as any);
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
