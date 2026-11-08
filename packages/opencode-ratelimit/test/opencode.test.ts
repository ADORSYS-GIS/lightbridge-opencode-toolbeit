import type { Plugin } from "@opencode/plugin/effect";
import { Effect, Logger } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOpencodeRatelimitPlugin,
  OpencodeRatelimitPlugin,
  PLUGIN_ID
} from "../src/opencode.js";
import type { RateLimiter } from "../src/plugin.js";

type AnyHook = (event: Record<string, unknown>) => Effect.Effect<void>;

interface FakeCtx {
  ctx: Plugin.Context;
  hooks: Map<string, AnyHook>;
  transform: () => ((editor: unknown) => void) | undefined;
}

function fakeCtx(options: Record<string, unknown> = {}): FakeCtx {
  const hooks = new Map<string, AnyHook>();
  let transformCb: ((editor: unknown) => void) | undefined;
  const registration = Effect.succeed({ dispose: Effect.void });
  const ctx = {
    options,
    provider: {
      transform: (cb: (editor: unknown) => void) => {
        transformCb = cb;
        return registration;
      }
    },
    session: {
      hook: (name: string, cb: AnyHook) => {
        hooks.set(name, cb);
        return registration;
      }
    }
  } as unknown as Plugin.Context;
  return { ctx, hooks, transform: () => transformCb };
}

function editorOf(providers: Array<{ id: string; settings?: Record<string, unknown> }>) {
  return { list: () => providers.map((provider) => ({ provider })) };
}

const model = { providerID: "gw", id: "kimi" };

function run(plugin: Plugin.Plugin, ctx: Plugin.Context) {
  return Effect.runPromise(Effect.scoped(plugin.effect(ctx)));
}

function silentLogger() {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function setup(over: { now?: () => number; sleep?: () => Promise<void> } = {}) {
  const fake = fakeCtx();
  const logger = silentLogger();
  let limiter: RateLimiter | undefined;
  const plugin = createOpencodeRatelimitPlugin({
    logger,
    now: over.now,
    sleep: over.sleep,
    onLimiter: (l) => {
      limiter = l;
    }
  });
  await run(plugin, fake.ctx);
  return { fake, logger, limiter: limiter as RateLimiter };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createOpencodeRatelimitPlugin", () => {
  it("has a stable id", () => {
    expect(PLUGIN_ID).toBe("vymalo.ratelimit");
    expect(createOpencodeRatelimitPlugin().id).toBe(PLUGIN_ID);
    expect(OpencodeRatelimitPlugin.id).toBe(PLUGIN_ID);
  });

  it("registers the provider transform and the three session hooks", async () => {
    const { fake } = await setup();

    expect(fake.transform()).toBeTypeOf("function");
    expect([...fake.hooks.keys()].sort()).toEqual(["http.request", "http.response", "retry"]);
  });

  it("populates the opt-in set from settings.rateLimit", async () => {
    const { fake, limiter, logger } = await setup();

    fake.transform()?.(
      editorOf([
        { id: "gw", settings: { rateLimit: { scope: "provider" } } },
        { id: "plain", settings: { baseURL: "https://x.test" } },
        { id: "bare" }
      ])
    );

    expect(limiter.options("gw")?.scope).toBe("provider");
    expect(limiter.options("plain")).toBeUndefined();
    expect(limiter.options("bare")).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith("ratelimit_provider_enabled", expect.any(Object));
  });

  it("re-running the transform drops providers that opted out", async () => {
    const { fake, limiter } = await setup();
    fake.transform()?.(editorOf([{ id: "gw", settings: { rateLimit: {} } }]));
    expect(limiter.options("gw")).toBeDefined();

    fake.transform()?.(editorOf([{ id: "gw", settings: {} }]));

    expect(limiter.options("gw")).toBeUndefined();
  });

  it("http.response observes and http.request gates on the model's bucket", async () => {
    let t = 1_700_000_000_000;
    const sleep = vi.fn(async (ms: number) => {
      t += ms;
    });
    const { fake } = await setup({ now: () => t, sleep });
    fake.transform()?.(editorOf([{ id: "gw", settings: { rateLimit: {} } }]));

    const response = new Response(null, {
      status: 200,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "30" }
    });
    await Effect.runPromise(
      fake.hooks.get("http.response")?.({
        model,
        request: new Request("https://x.test"),
        response
      }) ?? Effect.void
    );
    expect(sleep).not.toHaveBeenCalled();

    const controller = new AbortController();
    await Effect.runPromise(
      fake.hooks.get("http.request")?.({
        model,
        request: new Request("https://x.test", { signal: controller.signal })
      }) ?? Effect.void
    );

    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it("http.request is a no-op for an unmanaged provider", async () => {
    const sleep = vi.fn(async () => {});
    const { fake } = await setup({ sleep });

    await Effect.runPromise(
      fake.hooks.get("http.request")?.({
        model,
        request: new Request("https://x.test")
      }) ?? Effect.void
    );

    expect(sleep).not.toHaveBeenCalled();
  });

  describe("retry hook", () => {
    const retryEvent = (error: Record<string, unknown>, attempt = 0) => ({
      model,
      error,
      attempt,
      decision: { retry: false } as { retry: boolean; delay?: number }
    });

    it("sets event.decision only when it decides to retry", async () => {
      const { fake } = await setup();
      fake.transform()?.(editorOf([{ id: "gw", settings: { rateLimit: {} } }]));
      const hook = fake.hooks.get("retry") as AnyHook;

      const event = retryEvent({ status: 429, retryAfterMs: 4_000 });
      await Effect.runPromise(hook(event));

      expect(event.decision).toEqual({ retry: true, delay: 4_000 });
    });

    it("leaves non-429 failures to the host's own policy", async () => {
      const { fake } = await setup();
      fake.transform()?.(editorOf([{ id: "gw", settings: { rateLimit: {} } }]));
      const hook = fake.hooks.get("retry") as AnyHook;
      const host = { retry: true, delay: 123 };

      const event = { ...retryEvent({ status: 500 }), decision: host };
      await Effect.runPromise(hook(event));

      expect(event.decision).toBe(host); // untouched
    });

    it("leaves a fail-fast (error tier) decision to the host without overriding", async () => {
      const { fake } = await setup();
      fake.transform()?.(
        editorOf([{ id: "gw", settings: { rateLimit: { tiers: [{ action: "error" }] } } }])
      );
      const hook = fake.hooks.get("retry") as AnyHook;
      const host = { retry: false };

      const event = { ...retryEvent({ status: 429 }), decision: host };
      await Effect.runPromise(hook(event));

      expect(event.decision).toBe(host);
    });
  });

  describe("logger selection and level resolution", () => {
    const previous = process.env.OPENCODE_LOG_LEVEL;
    afterEach(() => {
      if (previous === undefined) {
        delete process.env.OPENCODE_LOG_LEVEL;
      } else {
        process.env.OPENCODE_LOG_LEVEL = previous;
      }
    });

    async function captured(options: Record<string, unknown>) {
      const sink: Array<{ level: string; message: unknown[] }> = [];
      const recorder = Logger.make<unknown, void>((o) => {
        sink.push({ level: o.logLevel, message: o.message as unknown[] });
      });
      const fake = fakeCtx(options);
      await Effect.runPromise(
        Effect.scoped(createOpencodeRatelimitPlugin().effect(fake.ctx)).pipe(
          Effect.provide(Logger.layer([recorder], { mergeWithExisting: false }))
        )
      );
      return { fake, sink };
    }

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    it("ADR-0014: logs through the host Effect logger, never the console", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      delete process.env.VYMALO_PLUGIN_CONSOLE_LOG;
      const { fake, sink } = await captured({});

      // Provider opts in with an error tier, then a managed 429 fails fast
      // (a `warn` record).
      fake.transform()?.(
        editorOf([{ id: "gw", settings: { rateLimit: { tiers: [{ action: "error" }] } } }])
      );
      await Effect.runPromise(
        (fake.hooks.get("retry") as AnyHook)({
          model,
          error: { status: 429 },
          attempt: 0,
          decision: { retry: false }
        })
      );
      await flush();

      expect(warn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(sink).toContainEqual({ level: "Warn", message: ["ratelimit_failfast"] });
    });

    it("honours the plugin's logLevel option over OPENCODE_LOG_LEVEL", async () => {
      process.env.OPENCODE_LOG_LEVEL = "ERROR";
      const { fake, sink } = await captured({ logLevel: "INFO" });

      fake.transform()?.(editorOf([{ id: "gw", settings: { rateLimit: {} } }]));
      await flush();

      expect(sink.map((s) => s.message[0])).toContain("ratelimit_provider_enabled");
    });

    it("falls back to OPENCODE_LOG_LEVEL when the option is absent", async () => {
      process.env.OPENCODE_LOG_LEVEL = "ERROR";
      const { fake, sink } = await captured({});

      fake.transform()?.(editorOf([{ id: "gw", settings: { rateLimit: {} } }]));
      await flush();

      expect(sink).toEqual([]); // info records filtered by the plugin's own level
    });
  });
});
