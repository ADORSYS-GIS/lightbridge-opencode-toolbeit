import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { Effect, Logger, References } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { TokenSet } from "@vymalo/opencode-auth-core/lib";
import type { TokenSource } from "@vymalo/opencode-core-otel";

import type { LightbridgePluginFactoryOptions } from "../src/opencode.js";
import { createLightbridgePlugin, PLUGIN_ID } from "../src/opencode.js";
import type {
  LightbridgeRuntimeFactory,
  LightbridgeRuntimeLike,
  LightbridgeRuntimeOptions
} from "../src/plugin.js";
import { startPlugin } from "./harness.js";
import { createRecordingLogger, createSilentLogger, makeAuth } from "./helpers.js";

function makeToken(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "shared-project-token",
    tokenType: "Bearer",
    expiresAt: Date.now() + 300_000,
    ...overrides
  };
}

interface SpyRuntime extends LightbridgeRuntimeLike {
  calls: Array<{ interactive?: boolean } | undefined>;
}

function makeSpyRuntime(
  impl?: (options?: { interactive?: boolean }) => Promise<TokenSet>
): SpyRuntime {
  const calls: SpyRuntime["calls"] = [];
  return {
    calls,
    getProjectToken: async (options) => {
      calls.push(options);
      return impl ? impl(options) : makeToken();
    }
  };
}

/** Builds a `runtimeFactory` that always returns `runtime` and records each construction. */
function fixedRuntimeFactory(runtime: LightbridgeRuntimeLike): {
  factory: LightbridgeRuntimeFactory;
  built: LightbridgeRuntimeOptions[];
} {
  const built: LightbridgeRuntimeOptions[] = [];
  const factory: LightbridgeRuntimeFactory = (_auth, _projectId, options) => {
    built.push(options);
    return runtime;
  };
  return { factory, built };
}

const NO_EXPORTERS = { trace: () => undefined, metric: () => undefined, log: () => undefined };

function start(
  options: Record<string, unknown>,
  factory: Partial<LightbridgePluginFactoryOptions> = {}
) {
  return startPlugin({
    options,
    factory: { deferredTimeoutMs: 5, exporters: NO_EXPORTERS, ...factory }
  });
}

const requestEvent = (providerID: string, headers: Record<string, string> = {}) => ({
  model: { id: "glm-5", providerID },
  headers
});

describe("plugin identity", () => {
  it("uses the stable id vymalo.lightbridge", () => {
    expect(PLUGIN_ID).toBe("vymalo.lightbridge");
    expect(createLightbridgePlugin().id).toBe("vymalo.lightbridge");
  });
});

describe("createLightbridgePlugin — config validation", () => {
  it("registers nothing (and does not throw) on malformed options", async () => {
    const logger = createRecordingLogger();
    const harness = await start({ gateway: { providers: ["gateway"] } }, { logger });
    expect(harness.hooks.size).toBe(0);
    expect(logger.events.some((e) => e.event === "lightbridge_config_invalid")).toBe(true);
  });
});

describe("createLightbridgePlugin — auth-only (inert)", () => {
  it("activates no module when only `auth` is configured", async () => {
    const logger = createRecordingLogger();
    const harness = await start({ auth: makeAuth() }, { logger });
    expect(harness.hooks.size).toBe(0);
    expect(logger.events.some((e) => e.event === "lightbridge_plugin_ready")).toBe(true);
  });
});

describe("createLightbridgePlugin — gateway module", () => {
  const gatewayOptions = {
    auth: makeAuth(),
    gateway: { projectId: "proj-1", providers: ["gateway"] }
  };

  it("injects the shared bearer on a configured provider, replacing any header variant", async () => {
    const runtime = makeSpyRuntime();
    const { factory } = fixedRuntimeFactory(runtime);
    const harness = await start(gatewayOptions, { runtimeFactory: factory });

    const event = requestEvent("gateway", { authorization: "Bearer stale", "x-keep": "1" });
    await harness.call("session.model.request", event);
    expect(event.headers).toEqual({ "x-keep": "1", Authorization: "Bearer shared-project-token" });
    expect(runtime.calls).toEqual([{ interactive: true }]);
  });

  it("leaves an unmanaged provider untouched", async () => {
    const runtime = makeSpyRuntime();
    const { factory } = fixedRuntimeFactory(runtime);
    const harness = await start(gatewayOptions, { runtimeFactory: factory });

    const event = requestEvent("some-other", { Authorization: "Bearer theirs" });
    await harness.call("session.model.request", event);
    expect(event.headers.Authorization).toBe("Bearer theirs");
    expect(runtime.calls).toEqual([]);
  });

  it("fails closed: the request dies when the shared token cannot be produced", async () => {
    const logger = createRecordingLogger();
    const runtime = makeSpyRuntime(async () => {
      throw new Error("exchange failed");
    });
    const { factory } = fixedRuntimeFactory(runtime);
    const harness = await start(gatewayOptions, { logger, runtimeFactory: factory });

    // A stale bearer stamped on the record (e.g. by `register` or oauth2) must not ride out.
    const event = requestEvent("gateway", { Authorization: "Bearer stamped-stale" });
    await expect(harness.call("session.model.request", event)).rejects.toThrow("exchange failed");
    expect(logger.events.some((e) => e.event === "lightbridge_gateway_no_bearer")).toBe(true);
  });

  it("activates with the default project when projectId is omitted", async () => {
    const logger = createRecordingLogger();
    const runtime = makeSpyRuntime();
    const { factory } = fixedRuntimeFactory(runtime);
    const harness = await start(
      { auth: makeAuth(), gateway: { providers: ["gateway"] } },
      { logger, runtimeFactory: factory }
    );
    expect(logger.events.some((e) => e.event === "lightbridge_default_project")).toBe(true);
    const event = requestEvent("gateway");
    await harness.call("session.model.request", event);
    expect(event.headers.Authorization).toBe("Bearer shared-project-token");
  });

  it("defaults gateway.exchange to false and passes true through (ADR-0017)", async () => {
    const off = fixedRuntimeFactory(makeSpyRuntime());
    await start(gatewayOptions, { runtimeFactory: off.factory });
    expect(off.built[0]?.exchange).toBe(false);

    const on = fixedRuntimeFactory(makeSpyRuntime());
    await start(
      { auth: makeAuth(), gateway: { providers: ["gateway"], exchange: true } },
      { runtimeFactory: on.factory }
    );
    expect(on.built[0]?.exchange).toBe(true);
  });

  it("builds no runtime for a register-only config", async () => {
    const { factory, built } = fixedRuntimeFactory(makeSpyRuntime());
    await start(
      { auth: makeAuth(), register: { baseURL: "https://gw.example.com/v1" } },
      { runtimeFactory: factory, fetchImpl: (async () => new Response("{}")) as typeof fetch }
    );
    expect(built).toEqual([]);
  });
});

describe("createLightbridgePlugin — otel module", () => {
  async function loadOtel(
    options: {
      runtime?: LightbridgeRuntimeLike;
      otel?: Record<string, unknown>;
      gateway?: Record<string, unknown>;
    } = {},
    factory: Partial<LightbridgePluginFactoryOptions> = {}
  ) {
    let capturedTokenSource: TokenSource | undefined;
    const spans = new InMemorySpanExporter();
    const logs = new InMemoryLogRecordExporter();
    const harness = await startPlugin({
      options: {
        auth: makeAuth(),
        gateway: options.gateway,
        projectId: "proj-1",
        otel: { endpoint: "http://localhost:4318", ...options.otel }
      },
      factory: {
        deferredTimeoutMs: 5,
        hostInfo: { hostname: "test-host", version: "0.14.1" },
        runtimeFactory: options.runtime
          ? () => options.runtime as LightbridgeRuntimeLike
          : undefined,
        exporters: {
          trace: (_config, tokenSource) => {
            capturedTokenSource = tokenSource;
            return spans;
          },
          log: () => logs,
          metric: () => undefined
        },
        ...factory
      }
    });
    return { harness, tokenSource: () => capturedTokenSource, spans, logs };
  }

  it("registers the observing hooks and passes a runtime-backed TokenSource", async () => {
    const { harness, tokenSource } = await loadOtel({ runtime: makeSpyRuntime() });
    for (const key of [
      "session.prompt",
      "session.context",
      "tool.execute.before",
      "tool.execute.after",
      "permission.evaluate",
      "session.http.request"
    ]) {
      expect(harness.hasHook(key)).toBe(true);
    }
    expect(tokenSource()).toBeDefined();
  });

  it("TokenSource.headers() returns the Bearer from the shared exchange", async () => {
    const runtime = makeSpyRuntime(async () => makeToken({ accessToken: "otel-token" }));
    const { tokenSource } = await loadOtel({ runtime });
    await expect(tokenSource()?.headers()).resolves.toEqual({ Authorization: "Bearer otel-token" });
    expect(runtime.calls).toEqual([{ interactive: false }]);
  });

  it("TokenSource.headers() degrades to undefined on an exchange failure (ADR-0015)", async () => {
    // `undefined`, not `{}`: the shared export gate in core-otel treats `{}` as
    // "export with no extra headers" and `undefined` as "skip the export".
    const runtime = makeSpyRuntime(async () => {
      throw new Error("exchange failed");
    });
    const { tokenSource } = await loadOtel({ runtime });
    await expect(tokenSource()?.headers()).resolves.toBeUndefined();
  });

  it("TokenSource.headers() resumes once a later exchange succeeds", async () => {
    let succeed = false;
    const runtime = makeSpyRuntime(async () => {
      if (!succeed) {
        throw new Error("exchange failed");
      }
      return makeToken({ accessToken: "recovered-token" });
    });
    const { tokenSource } = await loadOtel({ runtime });
    await expect(tokenSource()?.headers()).resolves.toBeUndefined();
    succeed = true;
    await expect(tokenSource()?.headers()).resolves.toEqual({
      Authorization: "Bearer recovered-token"
    });
  });

  it("invalidate() is a documented no-op", async () => {
    const { tokenSource } = await loadOtel({ runtime: makeSpyRuntime() });
    expect(() => tokenSource()?.invalidate()).not.toThrow();
  });

  it("stays inert (no observing hooks) when otel is unconfigured", async () => {
    const harness = await start({ auth: makeAuth() });
    expect(harness.hasHook("session.prompt")).toBe(false);
  });

  it("stays inert and says why when no exporter is configured", async () => {
    const logger = createRecordingLogger();
    const harness = await start(
      { auth: makeAuth(), otel: { enabled: false } },
      { logger, env: {} }
    );
    expect(harness.hasHook("session.prompt")).toBe(false);
    expect(logger.events.some((e) => e.event === "lightbridge_otel_inactive")).toBe(true);
  });

  it("logs that otel.tokenCommand is ignored, never silently", async () => {
    const logger = createRecordingLogger();
    await loadOtel(
      { runtime: makeSpyRuntime(), otel: { tokenCommand: "some-other-helper" } },
      { logger }
    );
    expect(logger.events.some((e) => e.event === "lightbridge_otel_token_command_ignored")).toBe(
      true
    );
  });

  it("says nothing when otel has no tokenCommand/tokenHeader/tokenPrefix set", async () => {
    const logger = createRecordingLogger();
    await loadOtel({ runtime: makeSpyRuntime() }, { logger });
    expect(logger.events.some((e) => e.event === "lightbridge_otel_token_command_ignored")).toBe(
      false
    );
  });

  it("injects trace context into outgoing model requests, never clobbering one", async () => {
    const { harness } = await loadOtel({ runtime: makeSpyRuntime() });
    await harness.emit({ type: "session.created", data: { sessionID: "ses_1" } });
    const [input, output] = [
      { sessionID: "ses_1", agent: "build", model: { id: "m", providerID: "p" } },
      { prompt: { text: "hello" } }
    ];
    await harness.call("session.prompt", { ...input, ...output });
    await harness.call("session.context", { ...input, options: { temperature: 0.3 } });

    const request = new Request("https://gw.example.com/v1/chat");
    await harness.call("session.http.request", { request });
    expect(request.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

    const upstream = new Request("https://gw.example.com/v1/chat", {
      headers: { traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" }
    });
    await harness.call("session.http.request", { request: upstream });
    expect(upstream.headers.get("traceparent")).toContain("aaaaaaaa");
  });

  it("skips trace propagation when there is no active chat context", async () => {
    const { harness } = await loadOtel({ runtime: makeSpyRuntime() });
    const request = new Request("https://gw.example.com/v1/chat");
    await harness.call("session.http.request", { request });
    expect(request.headers.has("traceparent")).toBe(false);
  });

  it("does not register propagation when propagateTraceContext is off", async () => {
    const { harness } = await loadOtel({
      runtime: makeSpyRuntime(),
      otel: { propagateTraceContext: false }
    });
    expect(harness.hasHook("session.http.request")).toBe(false);
  });

  it("drives the whole observing surface and exports a log record", async () => {
    const { harness, logs } = await loadOtel({ runtime: makeSpyRuntime() });
    const model = { id: "kimi-k2.6", providerID: "gateway" };

    await harness.emit({ type: "session.created", data: { sessionID: "ses_1" } });
    await harness.call("session.prompt", {
      sessionID: "ses_1",
      agent: "build",
      model,
      prompt: { text: "hi", files: [{}] }
    });
    await harness.call("session.context", {
      sessionID: "ses_1",
      agent: "build",
      model,
      options: { temperature: 0.3, maxTokens: 100 }
    });
    await harness.call("tool.execute.before", { tool: "edit", sessionID: "ses_1", id: "c1" });
    await harness.call("tool.execute.after", {
      tool: "edit",
      sessionID: "ses_1",
      id: "c1",
      status: "completed",
      result: { content: "ok" }
    });
    await harness.call("tool.execute.after", {
      tool: "bash",
      sessionID: "ses_1",
      id: "c2",
      status: "error"
    });
    await harness.call("permission.evaluate", {
      sessionID: "ses_1",
      action: "edit",
      effect: "allow"
    });
    await harness.emit({
      type: "session.step.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", agent: "build", model, started: 1 }
    });
    await harness.emit({
      type: "session.text.ended",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", text: "abcd" }
    });
    await harness.emit({
      type: "session.step.ended",
      created: 2000,
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        finish: "stop",
        cost: 0.01,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }
      }
    });
    await harness.emit({
      type: "session.execution.succeeded",
      data: { sessionID: "ses_1" }
    });

    await vi.waitFor(() => expect(logs.getFinishedLogRecords().length).toBeGreaterThan(0));
  });

  it("drains the exporters when the plugin scope closes", async () => {
    const { harness, logs } = await loadOtel({ runtime: makeSpyRuntime() });
    await harness.emit({ type: "session.created", data: { sessionID: "ses_1" } });
    await harness.close();
    await vi.waitFor(() => expect(logs.getFinishedLogRecords().length).toBeGreaterThanOrEqual(0));
  });
});

describe("createLightbridgePlugin — exit handling", () => {
  it("registers the shared exit handlers exactly once when otel is active and drains on beforeExit", async () => {
    const before = {
      beforeExit: process.listenerCount("beforeExit"),
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM")
    };
    await startPlugin({
      options: { auth: makeAuth(), otel: { endpoint: "http://localhost:4318" } },
      plugin: createLightbridgePlugin({
        logger: createSilentLogger(),
        deferredTimeoutMs: 5,
        exporters: NO_EXPORTERS
      })
    });

    expect(process.listenerCount("beforeExit")).toBe(before.beforeExit + 1);
    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM + 1);
    try {
      process.emit("beforeExit", 0);
    } finally {
      // Never fire a real signal here: ours would re-raise it at the test runner.
      // The re-raise semantics are tested against an injected process in
      // `@vymalo/opencode-core-otel` (test/exit-handlers.test.ts).
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const [handler] = process.listeners(signal).slice(-1);
        if (handler) {
          process.removeListener(signal, handler as never);
        }
      }
    }
    expect(process.listenerCount("beforeExit")).toBe(before.beforeExit);
    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
  });
});

describe("createLightbridgePlugin — one shared runtime across both modules", () => {
  it("builds the runtime exactly once; gateway and otel read the same instance", async () => {
    const runtime = makeSpyRuntime();
    const { factory, built } = fixedRuntimeFactory(runtime);
    const harness = await start(
      {
        auth: makeAuth(),
        gateway: { projectId: "proj-1", providers: ["gateway"] },
        otel: { endpoint: "http://localhost:4318" }
      },
      { runtimeFactory: factory }
    );
    expect(built).toHaveLength(1);

    await harness.call("session.model.request", requestEvent("gateway"));
    expect(runtime.calls).toEqual([{ interactive: true }]);
  });
});

describe("ADR-0014: the default logger writes to the host Effect logger, not the terminal", () => {
  it("delivers lightbridge_config_invalid to the host logger and never to the console", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const previous = process.env.VYMALO_PLUGIN_CONSOLE_LOG;
    delete process.env.VYMALO_PLUGIN_CONSOLE_LOG;

    const sink: Array<{ level: string; message: unknown[] }> = [];
    const recorder = Logger.make<unknown, void>((options) => {
      sink.push({ level: options.logLevel, message: options.message as unknown[] });
    });

    try {
      await startPlugin({
        // No injected logger: the production captureHostContext path.
        plugin: createLightbridgePlugin({ registerProcessHandlers: false }),
        options: { gateway: { providers: ["gateway"] } }, // missing `auth`
        provide: (effect) =>
          effect.pipe(
            Effect.provide(Logger.layer([recorder], { mergeWithExisting: false })),
            Effect.provideService(References.MinimumLogLevel, "All")
          )
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(
        sink.some((c) => c.level === "Error" && c.message[0] === "lightbridge_config_invalid")
      ).toBe(true);
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined) {
        process.env.VYMALO_PLUGIN_CONSOLE_LOG = previous;
      }
    }
  });
});
