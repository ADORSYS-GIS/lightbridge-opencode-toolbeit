import type { Context } from "@opentelemetry/api";
import { defaultTextMapSetter } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

import type { Logger } from "./logging.js";

export interface ProviderConfigLike {
  options?: Record<string, unknown>;
}

export interface PropagationConfigInput {
  provider?: Record<string, ProviderConfigLike | undefined>;
}

const propagator = new W3CTraceContextPropagator();

/**
 * Wrap every provider's `options.fetch` so outgoing model requests carry W3C
 * trace context, joining an OpenCode session and its gateway-side spans into
 * one trace.
 *
 * This is the same interception seam `@vymalo/opencode-ratelimit` uses — and it
 * composes the same way: the existing fetch is captured at install time and
 * delegated to, so stacking the two plugins in either order works.
 */
export function installTracePropagation(
  input: PropagationConfigInput,
  deps: { getContext: () => Context | undefined; logger: Logger; fetchImpl?: typeof fetch }
): number {
  const providers = input.provider;
  if (!providers) {
    return 0;
  }

  let wrapped = 0;
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (!providerConfig) {
      continue;
    }
    const options = (providerConfig.options ??= {});
    const delegate =
      typeof options.fetch === "function"
        ? (options.fetch as typeof fetch)
        : (deps.fetchImpl ?? globalThis.fetch);
    if (typeof delegate !== "function") {
      continue;
    }

    options.fetch = async (
      input_: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ): Promise<Response> => {
      const context = deps.getContext();
      if (!context) {
        return delegate(input_, init);
      }
      const carrier: Record<string, string> = {};
      propagator.inject(context, carrier, defaultTextMapSetter);
      if (Object.keys(carrier).length === 0) {
        return delegate(input_, init);
      }
      const headers = new Headers(init?.headers ?? {});
      // Never clobber an upstream traceparent — if something already set one,
      // it knows more about the request than we do.
      for (const [key, value] of Object.entries(carrier)) {
        if (!headers.has(key)) {
          headers.set(key, value);
        }
      }
      return delegate(input_, { ...init, headers });
    };
    wrapped += 1;
    deps.logger.trace("otel_trace_propagation_installed", { providerId });
  }

  return wrapped;
}
