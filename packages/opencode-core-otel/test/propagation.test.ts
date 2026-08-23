import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import { installTracePropagation } from "../src/propagation.js";
import { harness, silentLogger } from "./helpers.js";

function captureFetch(): { calls: Array<{ url: string; headers: Headers }>; impl: typeof fetch } {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers ?? {}) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { calls, impl };
}

/** A live span whose context can be injected as a parent. */
function liveContext() {
  const env = harness();
  const span = env.providers.tracer?.startSpan("chat test");
  if (!span) {
    throw new Error("tracer not built");
  }
  return trace.setSpan(ROOT_CONTEXT, span);
}

describe("installTracePropagation", () => {
  it("injects traceparent into provider requests", async () => {
    const { calls, impl } = captureFetch();
    const config = { provider: { openai: { options: {} as Record<string, unknown> } } };
    const context = liveContext();

    const wrapped = installTracePropagation(config, {
      getContext: () => context,
      logger: silentLogger(),
      fetchImpl: impl
    });
    expect(wrapped).toBe(1);

    await (config.provider.openai.options.fetch as typeof fetch)("https://api.example/v1/chat");
    expect(calls[0]?.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  it("sends the request untouched when there is no context", async () => {
    const { calls, impl } = captureFetch();
    const config = { provider: { openai: { options: {} as Record<string, unknown> } } };

    installTracePropagation(config, {
      getContext: () => undefined,
      logger: silentLogger(),
      fetchImpl: impl
    });

    await (config.provider.openai.options.fetch as typeof fetch)("https://api.example/v1/chat");
    expect(calls[0]?.headers.get("traceparent")).toBeNull();
  });

  it("composes with a fetch another plugin already installed", async () => {
    const { calls, impl } = captureFetch();
    let delegated = false;
    const existing: typeof fetch = async (input, init) => {
      delegated = true;
      return impl(input, init);
    };
    const config = {
      provider: { openai: { options: { fetch: existing } as Record<string, unknown> } }
    };

    installTracePropagation(config, { getContext: () => liveContext(), logger: silentLogger() });
    await (config.provider.openai.options.fetch as typeof fetch)("https://api.example/v1/chat");

    expect(delegated).toBe(true);
    expect(calls[0]?.headers.get("traceparent")).toBeTruthy();
  });

  it("never clobbers a traceparent the caller already set", async () => {
    const { calls, impl } = captureFetch();
    const config = { provider: { openai: { options: {} as Record<string, unknown> } } };
    installTracePropagation(config, {
      getContext: () => liveContext(),
      logger: silentLogger(),
      fetchImpl: impl
    });

    const upstream = "00-11111111111111111111111111111111-2222222222222222-01";
    await (config.provider.openai.options.fetch as typeof fetch)("https://api.example/v1/chat", {
      headers: { traceparent: upstream }
    });
    expect(calls[0]?.headers.get("traceparent")).toBe(upstream);
  });

  it("preserves other request options", async () => {
    const { calls, impl } = captureFetch();
    const config = { provider: { openai: { options: {} as Record<string, unknown> } } };
    installTracePropagation(config, {
      getContext: () => liveContext(),
      logger: silentLogger(),
      fetchImpl: impl
    });

    await (config.provider.openai.options.fetch as typeof fetch)("https://api.example/v1/chat", {
      headers: { authorization: "Bearer token" }
    });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer token");
  });

  it("wraps every provider and tolerates a config with none", () => {
    const logger = silentLogger();
    const config = {
      provider: {
        a: { options: {} as Record<string, unknown> },
        b: { options: {} as Record<string, unknown> },
        c: undefined
      }
    };
    expect(installTracePropagation(config, { getContext: () => undefined, logger })).toBe(2);
    expect(installTracePropagation({}, { getContext: () => undefined, logger })).toBe(0);
  });
});
