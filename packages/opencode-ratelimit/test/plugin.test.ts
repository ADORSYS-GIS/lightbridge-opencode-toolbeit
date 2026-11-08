import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../src/logging.js";
import { collectOptIns, createRateLimiter, type RateLimiter } from "../src/plugin.js";
import type { RateLimitOptions, RateLimitScope, RateLimitTier } from "../src/types.js";

const NOW = 1_700_000_000_000;

function silentLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

/** Fake clock whose `sleep` advances time synchronously and resolves immediately. */
function fakeClock(start = NOW) {
  const ref = { t: start };
  return {
    now: () => ref.t,
    advance: (ms: number) => {
      ref.t += ms;
    },
    sleep: vi.fn(async (ms: number) => {
      ref.t += ms;
    })
  };
}

function makeOpts(
  over: {
    maxWaitMs?: number;
    maxRetries?: number;
    scope?: RateLimitScope;
    tiers?: RateLimitTier[];
  } = {}
): RateLimitOptions {
  const { maxWaitMs = 0, maxRetries = 5, scope = "provider", tiers } = over;
  return {
    enabled: true,
    scope,
    headerPrefix: "x-ratelimit",
    tiers: tiers ?? [{ maxResetSeconds: null, action: "wait", maxWaitMs, maxRetries }]
  };
}

function resp(status: number, headers: Record<string, string> = {}) {
  return { status, headers: new Headers(headers) };
}

function eventNames(spy: Logger[keyof Logger]): string[] {
  return (spy as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const P = { providerId: "p" };

interface Harness {
  logger: Logger;
  clock: ReturnType<typeof fakeClock>;
  limiter: RateLimiter;
}

function harness(opts: RateLimitOptions = makeOpts(), ids: string[] = ["p"]): Harness {
  const logger = silentLogger();
  const clock = fakeClock();
  const limiter = createRateLimiter({ logger, now: clock.now, sleep: clock.sleep });
  limiter.configure(new Map(ids.map((id) => [id, opts])));
  return { logger, clock, limiter };
}

const tiered = () =>
  makeOpts({
    tiers: [
      { maxResetSeconds: 120, action: "wait", maxWaitMs: 0, maxRetries: 3 }, // burst → wait
      { maxResetSeconds: null, action: "error", maxWaitMs: 0, maxRetries: 0 } // long → fail fast
    ]
  });

const cappedTiered = () =>
  makeOpts({
    tiers: [
      { maxResetSeconds: 120, action: "wait", maxWaitMs: 1_000, maxRetries: 3 },
      { maxResetSeconds: null, action: "error", maxWaitMs: 0, maxRetries: 0 }
    ]
  });

describe("RateLimiter basics", () => {
  it("logs the parsed quota without waiting on a healthy response", async () => {
    const h = harness();
    h.limiter.observe(
      P,
      resp(200, {
        "x-ratelimit-limit": "10",
        "x-ratelimit-remaining": "2",
        "x-ratelimit-reset": "30"
      })
    );
    await h.limiter.acquire(P);

    expect(h.clock.sleep).not.toHaveBeenCalled(); // healthy → gate not armed
    expect(h.logger.debug).toHaveBeenCalledWith(
      "ratelimit_quota",
      expect.objectContaining({ remaining: 2, limit: 10, resetSeconds: 30 })
    );
  });

  it("proactively throttles the next acquire after remaining hits 0", async () => {
    const h = harness();
    h.limiter.observe(P, resp(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "48" }));
    expect(h.clock.sleep).not.toHaveBeenCalled();

    await h.limiter.acquire(P); // gated

    expect(h.clock.sleep).toHaveBeenCalledTimes(1);
    expect(h.clock.sleep).toHaveBeenCalledWith(48_000);
    expect(eventNames(h.logger.info)).toContain("ratelimit_throttle_wait");
  });

  it("does nothing for a provider that has not opted in", async () => {
    const h = harness();
    const other = { providerId: "other" };
    h.limiter.observe(
      other,
      resp(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "48" })
    );
    await h.limiter.acquire(other);

    expect(h.clock.sleep).not.toHaveBeenCalled();
    expect(h.limiter.options("other")).toBeUndefined();
    expect(h.limiter.options("p")?.scope).toBe("provider");
  });

  it("does not wait when the clamped wait is zero", async () => {
    // maxWaitMs:1 with a cooldown already expired by the clock → no sleep.
    const h = harness();
    h.limiter.observe(P, resp(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "5" }));
    h.clock.advance(6_000);
    await h.limiter.acquire(P);
    expect(h.clock.sleep).not.toHaveBeenCalled();
  });

  it("survives a header parse that yields nothing", () => {
    const h = harness();
    h.limiter.observe(P, resp(200));
    expect(h.logger.debug).toHaveBeenCalledWith("ratelimit_quota", expect.any(Object));
  });
});

describe("RateLimiter.decideRetry", () => {
  it("backs off on a 429 under a wait tier", () => {
    const h = harness();
    h.limiter.observe(P, resp(429, { "x-ratelimit-reset": "5" }));

    expect(h.limiter.decideRetry(P, { status: 429 }, 0)).toEqual({ retry: true, delay: 5_000 });
    expect(eventNames(h.logger.warn)).toContain("ratelimit_429_backoff");
  });

  it("gives up once attempt reaches maxRetries", () => {
    const h = harness(makeOpts({ maxRetries: 2 }));
    h.limiter.observe(P, resp(429, { "x-ratelimit-reset": "5" }));

    expect(h.limiter.decideRetry(P, { status: 429 }, 0).retry).toBe(true);
    expect(h.limiter.decideRetry(P, { status: 429 }, 1).retry).toBe(true);
    expect(h.limiter.decideRetry(P, { status: 429 }, 2)).toEqual({ retry: false });
    expect(eventNames(h.logger.error)).toContain("ratelimit_giveup");
  });

  it("falls back to Retry-After when no x-ratelimit-reset is present", () => {
    const h = harness();
    h.limiter.observe(P, resp(429, { "retry-after": "5" }));

    expect(h.limiter.decideRetry(P, { status: 429 }, 0)).toEqual({ retry: true, delay: 5_000 });
  });

  it("falls back to the error's retryAfterMs when no response was observed", () => {
    const h = harness();
    expect(h.limiter.decideRetry(P, { status: 429, retryAfterMs: 7_000 }, 0)).toEqual({
      retry: true,
      delay: 7_000
    });
  });

  it("uses the default backoff when nothing says how long to wait", () => {
    const h = harness();
    expect(h.limiter.decideRetry(P, { status: 429 }, 0)).toEqual({ retry: true, delay: 1_000 });
  });

  it("caps a long wait at maxWaitMs", () => {
    const h = harness(makeOpts({ maxWaitMs: 1_000 }));
    h.limiter.observe(P, resp(429, { "x-ratelimit-reset": "60" }));

    expect(h.limiter.decideRetry(P, { status: 429 }, 0)).toEqual({ retry: true, delay: 1_000 });
  });

  it("treats maxWaitMs of 0 as unlimited", () => {
    const h = harness(makeOpts({ maxWaitMs: 0 }));
    h.limiter.observe(P, resp(429, { "x-ratelimit-reset": "60" }));

    expect(h.limiter.decideRetry(P, { status: 429 }, 0)).toEqual({ retry: true, delay: 60_000 });
  });

  it("declines a non-429 status", () => {
    const h = harness();
    expect(h.limiter.decideRetry(P, { status: 500 }, 0)).toEqual({ retry: false });
    expect(h.limiter.decideRetry(P, {}, 0)).toEqual({ retry: false });
  });

  it("declines for an unmanaged provider", () => {
    const h = harness();
    expect(h.limiter.decideRetry({ providerId: "other" }, { status: 429 }, 0)).toEqual({
      retry: false
    });
  });
});

describe("tiers", () => {
  it("waits + retries on a 429 whose reset falls in a wait tier", () => {
    const h = harness(tiered());
    h.limiter.observe(P, resp(429, { "x-ratelimit-reset": "60" })); // ≤120 → wait tier

    expect(h.limiter.decideRetry(P, { status: 429 }, 0)).toEqual({ retry: true, delay: 60_000 });
    expect(eventNames(h.logger.warn)).toContain("ratelimit_429_backoff");
  });

  it("fails fast on a 429 whose reset falls in an error tier", async () => {
    const h = harness(tiered());
    h.limiter.observe(P, resp(429, { "x-ratelimit-reset": "2592000" })); // 30d → error tier

    expect(h.limiter.decideRetry(P, { status: 429 }, 0)).toEqual({ retry: false });
    expect(eventNames(h.logger.warn)).toContain("ratelimit_failfast");
    await h.limiter.acquire(P);
    expect(h.clock.sleep).not.toHaveBeenCalled(); // no wait either
  });

  it("does not arm the gate on remaining:0 when the reset is in an error tier", async () => {
    const h = harness(tiered());
    h.limiter.observe(
      P,
      resp(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2592000" })
    );

    await h.limiter.acquire(P);

    expect(h.clock.sleep).not.toHaveBeenCalled(); // next request will hit a real 429
  });

  it("handles a real Envoy header set (multi-policy limit, 429 reset=11)", () => {
    // Exact headers observed from the live gateway.
    const REAL = {
      "x-envoy-upstream-service-time": "8266",
      "x-ratelimit-limit": "200, 200;w=60, 200000;w=60, 50000000;w=2592000",
      "x-ratelimit-remaining": "199",
      "x-ratelimit-reset": "11"
    };
    const h = harness(tiered());
    h.limiter.observe(P, resp(429, REAL)); // reset 11 ≤ 120 → wait tier

    expect(h.limiter.decideRetry(P, { status: 429 }, 0)).toEqual({ retry: true, delay: 11_000 });
    expect(h.logger.debug).toHaveBeenCalledWith(
      "ratelimit_quota",
      expect.objectContaining({ limit: 200, remaining: 199, resetSeconds: 11 })
    );
  });

  it("classifies a Retry-After-only 429 by its delay (long → error tier)", () => {
    const h = harness(tiered());
    h.limiter.observe(P, resp(429, { "retry-after": "2592000" }));

    expect(h.limiter.decideRetry(P, { status: 429 }, 0)).toEqual({ retry: false });
    expect(eventNames(h.logger.warn)).toContain("ratelimit_failfast");
  });

  it("classifies an unobserved error.retryAfterMs by its delay too", () => {
    const h = harness(tiered());
    expect(h.limiter.decideRetry(P, { status: 429, retryAfterMs: 2_592_000_000 }, 0)).toEqual({
      retry: false
    });
  });

  it("clears a stale wait cooldown when failing fast on an error-tier 429", async () => {
    // Two identical providers: arm both, fail fast on one, and compare.
    const h = harness(cappedTiered(), ["a", "b"]);
    const arm = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" };
    h.limiter.observe({ providerId: "a" }, resp(200, arm));
    h.limiter.observe({ providerId: "b" }, resp(200, arm));

    h.limiter.observe({ providerId: "a" }, resp(429, { "x-ratelimit-reset": "2592000" }));

    await h.limiter.acquire({ providerId: "a" });
    expect(h.clock.sleep).not.toHaveBeenCalled(); // stale cooldown dropped
    await h.limiter.acquire({ providerId: "b" });
    expect(h.clock.sleep).toHaveBeenCalledWith(1_000); // control: still armed (capped)
  });

  it("clears a stale wait cooldown on a non-429 error-tier remaining:0", async () => {
    const h = harness(cappedTiered(), ["a", "b"]);
    const arm = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" };
    h.limiter.observe({ providerId: "a" }, resp(200, arm));
    h.limiter.observe({ providerId: "b" }, resp(200, arm));

    h.limiter.observe(
      { providerId: "a" },
      resp(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2592000" })
    );

    await h.limiter.acquire({ providerId: "a" });
    expect(h.clock.sleep).not.toHaveBeenCalled(); // error tier must not leave the gate armed
    await h.limiter.acquire({ providerId: "b" });
    expect(h.clock.sleep).toHaveBeenCalledTimes(1);
  });

  it("a wait-tier 429 arms the gate for other callers", async () => {
    const h = harness(tiered());
    h.limiter.observe(P, resp(429, { "x-ratelimit-reset": "30" }));

    await h.limiter.acquire(P);

    expect(h.clock.sleep).toHaveBeenCalledWith(30_000);
  });
});

describe("scope", () => {
  const exhausted = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "48" };

  it("model: gates only the exhausted model, not its siblings", async () => {
    const h = harness(makeOpts({ scope: "model" }));
    const a = { providerId: "p", modelID: "model-a" };
    const b = { providerId: "p", modelID: "model-b" };

    h.limiter.observe(a, resp(200, exhausted));
    await h.limiter.acquire(b); // different bucket → not gated
    expect(h.clock.sleep).not.toHaveBeenCalled();

    await h.limiter.acquire(a); // bucket A is in cooldown → waits
    expect(h.clock.sleep).toHaveBeenCalledTimes(1);
    expect(h.clock.sleep).toHaveBeenCalledWith(48_000);
  });

  it("model: falls back to the provider bucket when no model id is given", async () => {
    const h = harness(makeOpts({ scope: "model" }));
    h.limiter.observe(P, resp(200, exhausted));
    await h.limiter.acquire(P);
    expect(h.clock.sleep).toHaveBeenCalledWith(48_000);
  });

  it("provider: shares one bucket across models", async () => {
    const h = harness(makeOpts({ scope: "provider" }));
    h.limiter.observe({ providerId: "p", modelID: "model-a" }, resp(200, exhausted));

    await h.limiter.acquire({ providerId: "p", modelID: "model-b" });

    expect(h.clock.sleep).toHaveBeenCalledWith(48_000);
  });
});

describe("gate concurrency", () => {
  /** Manually-resolved sleeps, recorded in call order. */
  function manualSleep() {
    const sleptMs: number[] = [];
    const resolvers: Array<() => void> = [];
    const sleep = vi.fn((ms: number) => {
      sleptMs.push(ms);
      return new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
    });
    return { sleptMs, resolvers, sleep };
  }

  function manualHarness() {
    const clock = fakeClock();
    const ms = manualSleep();
    const limiter = createRateLimiter({
      logger: silentLogger(),
      now: clock.now,
      sleep: ms.sleep
    });
    limiter.configure(new Map([["p", makeOpts()]]));
    return { clock, limiter, ...ms };
  }

  it("shares a single timer across a concurrent burst during cooldown", async () => {
    const h = manualHarness();
    h.limiter.observe(P, resp(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "48" }));
    expect(h.sleep).not.toHaveBeenCalled(); // arming does not sleep

    const burst = Promise.all([
      h.limiter.acquire(P),
      h.limiter.acquire(P),
      h.limiter.acquire(P),
      h.limiter.acquire(P),
      h.limiter.acquire(P)
    ]);

    expect(h.sleep).toHaveBeenCalledTimes(1); // ONE shared timer for all 5

    h.clock.advance(48_000); // window elapses, so the re-check loop exits on resume
    h.resolvers[0]?.();
    await burst;

    expect(h.sleep).toHaveBeenCalledTimes(1); // no extra timer on re-check
  });

  it("re-waits when the cooldown window is extended mid-wait (longest wins)", async () => {
    const h = manualHarness();
    h.limiter.observe(P, resp(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3" }));

    const pending = h.limiter.acquire(P);
    await flush();
    expect(h.sleptMs).toEqual([3_000]); // first wait sized to the initial window

    // While the caller is parked on the first timer, another response extends
    // the window. The loop must re-check and wait the remainder, not return early.
    h.limiter.observe(P, resp(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "8" }));
    h.clock.advance(3_000);
    h.resolvers[0]?.();
    await flush();
    expect(h.sleptMs).toEqual([3_000, 5_000]); // re-checked → waited the extra 5s

    h.clock.advance(5_000);
    h.resolvers[1]?.();
    await pending;
  });

  it("does not hold a shorter-wait caller behind a longer in-flight shared timer", async () => {
    const h = manualHarness();
    h.limiter.observe(P, resp(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "100" }));

    const longCaller = h.limiter.acquire(P); // creates the 100s shared timer
    await flush();
    expect(h.sleptMs).toEqual([100_000]);

    // The window shrinks; a caller that joins now only needs 2s and must NOT be
    // forced to await the in-flight 100s shared timer.
    h.limiter.observe(P, resp(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2" }));
    const shortCaller = h.limiter.acquire(P);
    await flush();
    expect(h.sleptMs).toEqual([100_000, 2_000]); // its own 2s sleep, not the 100s one

    h.clock.advance(2_000);
    h.resolvers[1]?.(); // resolve the short caller's private timer
    await shortCaller; // completes without waiting 100s

    h.clock.advance(98_000);
    h.resolvers[0]?.();
    await longCaller;
  });

  it("aborts a wait cleanly when the signal is already aborted", async () => {
    const h = harness();
    h.limiter.observe(P, resp(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "48" }));

    const error = await h.limiter.acquire(P, AbortSignal.abort()).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect(eventNames(h.logger.warn)).toContain("ratelimit_wait_aborted");
  });

  it("aborts a wait that is aborted while parked on the timer", async () => {
    const h = manualHarness();
    h.limiter.observe(P, resp(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "48" }));
    const controller = new AbortController();

    const pending = h.limiter.acquire(P, controller.signal).then(
      () => null,
      (e: unknown) => e
    );
    await flush();
    controller.abort();

    expect(((await pending) as Error).name).toBe("AbortError");
  });

  it("completes a signal-carrying wait when the timer resolves first", async () => {
    const h = manualHarness();
    h.limiter.observe(P, resp(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "5" }));
    const pending = h.limiter.acquire(P, new AbortController().signal);
    await flush();
    h.clock.advance(5_000);
    h.resolvers[0]?.();
    await pending;
  });
});

describe("default sleep (real timers)", () => {
  const exhausted = (): Headers =>
    new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" });

  it("honours an abort signal already aborted or fired mid-sleep", async () => {
    const limiter = createRateLimiter({ logger: silentLogger() });
    limiter.configure(new Map([["p", makeOpts()]]));
    limiter.observe(P, { status: 200, headers: exhausted() });

    await expect(limiter.acquire(P, AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError"
    });

    const controller = new AbortController();
    const pending = limiter.acquire(P, controller.signal);
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("resolves after the real cooldown elapses", async () => {
    const limiter = createRateLimiter({ logger: silentLogger() });
    limiter.configure(new Map([["p", makeOpts()]]));
    limiter.observe(P, { status: 200, headers: exhausted() });
    const started = Date.now();

    await limiter.acquire(P);

    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });
});

describe("configure", () => {
  it("drops state for providers that are no longer opted in", async () => {
    const h = harness();
    h.limiter.observe(P, resp(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "48" }));

    h.limiter.configure(new Map()); // p dropped
    h.limiter.configure(new Map([["p", makeOpts()]])); // re-opted in, fresh state

    await h.limiter.acquire(P);
    expect(h.clock.sleep).not.toHaveBeenCalled();
  });

  it("keeps state for providers that stay opted in", async () => {
    const h = harness();
    h.limiter.observe(P, resp(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "48" }));

    h.limiter.configure(new Map([["p", makeOpts()]]));

    await h.limiter.acquire(P);
    expect(h.clock.sleep).toHaveBeenCalledWith(48_000);
  });

  it("drops per-model buckets along with their provider", async () => {
    const h = harness(makeOpts({ scope: "model" }));
    const a = { providerId: "p", modelID: "m" };
    h.limiter.observe(a, resp(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "48" }));

    h.limiter.configure(new Map());
    h.limiter.configure(new Map([["p", makeOpts({ scope: "model" })]]));

    await h.limiter.acquire(a);
    expect(h.clock.sleep).not.toHaveBeenCalled();
  });
});

describe("collectOptIns", () => {
  it("enables opted-in providers, skips the rest, and logs both", () => {
    const logger = silentLogger();

    const out = collectOptIns(
      [
        { id: "yes", settings: { rateLimit: {} } },
        { id: "no", settings: { baseURL: "https://x.test" } },
        { id: "bare" },
        { id: "off", settings: { rateLimit: { enabled: false } } }
      ],
      logger
    );

    expect([...out.keys()]).toEqual(["yes"]);
    expect(out.get("yes")?.scope).toBe("model");
    expect(eventNames(logger.info)).toContain("ratelimit_provider_enabled");
    expect(logger.info).toHaveBeenCalledWith("ratelimit_plugin_initialized", { providerCount: 1 });
    expect(eventNames(logger.debug).filter((e) => e === "ratelimit_provider_skipped")).toHaveLength(
      3
    );
  });
});
