import type { PluginInput } from "@opencode-ai/plugin";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { describe, expect, it, vi } from "vitest";

import type { TokenSource } from "@vymalo/opencode-core-otel";
import type { TokenSet } from "@vymalo/opencode-auth-core/lib";

import { createLightbridgePlugin } from "../src/opencode.js";
import type { LightbridgeRuntimeFactory, LightbridgeRuntimeLike } from "../src/plugin.js";
import { createRecordingLogger, createSilentLogger, makeAuth } from "./helpers.js";

function pluginInput(): PluginInput {
  return {
    client: { app: { log: vi.fn().mockResolvedValue(undefined) } },
    project: { id: "toolbelt" },
    directory: "/repo",
    worktree: "/repo"
  } as unknown as PluginInput;
}

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

/** Builds a `runtimeFactory` that always returns `runtime` and counts calls. */
function fixedRuntimeFactory(runtime: LightbridgeRuntimeLike): {
  factory: LightbridgeRuntimeFactory;
  calls: number[];
} {
  const calls: number[] = [];
  const factory: LightbridgeRuntimeFactory = (_auth, _projectId, _options) => {
    calls.push(calls.length);
    return runtime;
  };
  return { factory, calls };
}

describe("createLightbridgePlugin — config validation", () => {
  it("returns inert hooks (only config) rather than throwing on malformed options", async () => {
    const logger = createRecordingLogger();
    const hooks = await createLightbridgePlugin({ logger, registerProcessHandlers: false })(
      pluginInput(),
      { gateway: { providers: ["gateway"] } } // missing `auth`
    );
    expect(hooks["chat.headers"]).toBeUndefined();
    expect(hooks.event).toBeUndefined();
    expect(hooks.config).toBeDefined();
    await expect(hooks.config?.({ logLevel: "INFO" } as never)).resolves.toBeUndefined();
    expect(logger.events.some((e) => e.event === "lightbridge_config_invalid")).toBe(true);
  });
});

describe("createLightbridgePlugin — auth-only (inert)", () => {
  it("activates neither module when only `auth` is configured", async () => {
    const logger = createRecordingLogger();
    const hooks = await createLightbridgePlugin({ logger, registerProcessHandlers: false })(
      pluginInput(),
      { auth: makeAuth() }
    );
    expect(hooks["chat.headers"]).toBeUndefined();
    expect(hooks.event).toBeUndefined();
    expect(hooks["tool.execute.before"]).toBeUndefined();
    expect(hooks.config).toBeDefined();
    expect(logger.events.some((e) => e.event === "lightbridge_plugin_ready")).toBe(true);
  });
});

describe("createLightbridgePlugin — gateway module", () => {
  it("injects the shared project bearer on a managed provider", async () => {
    const runtime = makeSpyRuntime();
    const { factory } = fixedRuntimeFactory(runtime);
    const hooks = await createLightbridgePlugin({
      logger: createSilentLogger(),
      registerProcessHandlers: false,
      runtimeFactory: factory
    })(pluginInput(), {
      auth: makeAuth(),
      gateway: { projectId: "proj-1", providers: ["gateway"] }
    });

    const output = { headers: {} as Record<string, string> };
    await hooks["chat.headers"]?.({ model: { providerID: "gateway" } } as never, output);
    expect(output.headers.Authorization).toBe("Bearer shared-project-token");
    expect(runtime.calls).toEqual([{ interactive: true }]);
  });

  it("leaves an unmanaged provider untouched", async () => {
    const runtime = makeSpyRuntime();
    const { factory } = fixedRuntimeFactory(runtime);
    const hooks = await createLightbridgePlugin({
      logger: createSilentLogger(),
      registerProcessHandlers: false,
      runtimeFactory: factory
    })(pluginInput(), {
      auth: makeAuth(),
      gateway: { projectId: "proj-1", providers: ["gateway"] }
    });

    const output = { headers: {} as Record<string, string> };
    await hooks["chat.headers"]?.({ model: { providerID: "some-other" } } as never, output);
    expect(output.headers.Authorization).toBeUndefined();
    expect(runtime.calls).toEqual([]);
  });

  it("fails closed: no header when the shared exchange rejects", async () => {
    const logger = createRecordingLogger();
    const runtime = makeSpyRuntime(async () => {
      throw new Error("exchange failed");
    });
    const { factory } = fixedRuntimeFactory(runtime);
    const hooks = await createLightbridgePlugin({
      logger,
      registerProcessHandlers: false,
      runtimeFactory: factory
    })(pluginInput(), {
      auth: makeAuth(),
      gateway: { projectId: "proj-1", providers: ["gateway"] }
    });

    const output = { headers: {} as Record<string, string> };
    await expect(
      hooks["chat.headers"]?.({ model: { providerID: "gateway" } } as never, output)
    ).resolves.toBeUndefined();
    expect(output.headers.Authorization).toBeUndefined();
    expect(logger.events.some((e) => e.event === "lightbridge_gateway_no_bearer")).toBe(true);
  });

  it("rejects (config-invalid, whole plugin inert) a gateway block missing projectId", async () => {
    // `gateway.projectId` is required by the type, but a served/JSON config
    // could still omit it at runtime — `parseLightbridgeOptions` throws, and
    // the factory degrades to inert hooks rather than a half-built plugin.
    const logger = createRecordingLogger();
    const hooks = await createLightbridgePlugin({ logger, registerProcessHandlers: false })(
      pluginInput(),
      { auth: makeAuth(), gateway: { providers: ["gateway"] } as never }
    );
    expect(hooks["chat.headers"]).toBeUndefined();
    expect(logger.events.some((e) => e.event === "lightbridge_config_invalid")).toBe(true);
  });

  it("warns (but activates otel) when otel needs a project token with none resolvable", async () => {
    const logger = createRecordingLogger();
    const hooks = await createLightbridgePlugin({
      logger,
      registerProcessHandlers: false,
      deferredTimeoutMs: 5,
      exporters: { trace: () => undefined, metric: () => undefined, log: () => undefined }
    })(pluginInput(), { auth: makeAuth(), otel: { endpoint: "http://localhost:4318" } });
    expect(hooks["chat.headers"]).toBeUndefined();
    expect(hooks.event).toBeDefined();
    expect(logger.events.some((e) => e.event === "lightbridge_missing_project_id")).toBe(true);
  });
});

describe("createLightbridgePlugin — otel module", () => {
  async function loadOtel(options: {
    runtime?: LightbridgeRuntimeLike;
    otel?: Record<string, unknown>;
    projectId?: string;
    gateway?: Record<string, unknown>;
  }) {
    const logger = createSilentLogger();
    let capturedTokenSource: TokenSource | undefined;
    const spans = new InMemorySpanExporter();
    const logs = new InMemoryLogRecordExporter();

    const runtimeFactory: LightbridgeRuntimeFactory | undefined = options.runtime
      ? () => options.runtime as LightbridgeRuntimeLike
      : undefined;

    const hooks = await createLightbridgePlugin({
      logger,
      registerProcessHandlers: false,
      deferredTimeoutMs: 5,
      hostInfo: { hostname: "test-host", version: "0.14.1" },
      runtimeFactory,
      exporters: {
        trace: (_config, tokenSource) => {
          capturedTokenSource = tokenSource;
          return spans;
        },
        log: () => logs,
        metric: () => undefined
      }
    })(pluginInput(), {
      auth: makeAuth(),
      gateway: options.gateway,
      projectId: options.projectId,
      otel: { endpoint: "http://localhost:4318", ...options.otel }
    });

    return { hooks, capturedTokenSource, spans, logs };
  }

  it("registers the observing hooks and passes a runtime-backed TokenSource", async () => {
    const runtime = makeSpyRuntime();
    const { hooks, capturedTokenSource } = await loadOtel({ runtime, projectId: "proj-1" });

    expect(hooks.event).toBeDefined();
    expect(hooks["chat.message"]).toBeDefined();
    expect(hooks["tool.execute.before"]).toBeDefined();
    expect(hooks["chat.params"]).toBeDefined();
    expect(hooks["permission.ask"]).toBeDefined();
    expect(hooks["experimental.text.complete"]).toBeDefined();
    expect(hooks["experimental.compaction.autocontinue"]).toBeDefined();
    expect(capturedTokenSource).toBeDefined();
  });

  it("TokenSource.headers() returns the Bearer from the shared exchange", async () => {
    const runtime = makeSpyRuntime(async () => makeToken({ accessToken: "otel-token" }));
    const { capturedTokenSource } = await loadOtel({ runtime, projectId: "proj-1" });

    await expect(capturedTokenSource?.headers()).resolves.toEqual({
      Authorization: "Bearer otel-token"
    });
    expect(runtime.calls).toEqual([{ interactive: false }]);
  });

  it("TokenSource.headers() degrades to {} on an exchange failure (never throws)", async () => {
    const runtime = makeSpyRuntime(async () => {
      throw new Error("exchange failed");
    });
    const { capturedTokenSource } = await loadOtel({ runtime, projectId: "proj-1" });

    await expect(capturedTokenSource?.headers()).resolves.toEqual({});
  });

  it("invalidate() is a documented no-op", async () => {
    const runtime = makeSpyRuntime();
    const { capturedTokenSource } = await loadOtel({ runtime, projectId: "proj-1" });
    expect(() => capturedTokenSource?.invalidate()).not.toThrow();
  });

  it("builds providers with no TokenSource when otel has no resolvable projectId", async () => {
    const { hooks, capturedTokenSource } = await loadOtel({});
    expect(hooks.event).toBeDefined();
    expect(capturedTokenSource).toBeUndefined();
  });

  it("stays inert (no observing hooks) when otel is unconfigured", async () => {
    const hooks = await createLightbridgePlugin({
      logger: createSilentLogger(),
      registerProcessHandlers: false
    })(pluginInput(), { auth: makeAuth() });
    expect(hooks.event).toBeUndefined();
  });

  it("propagates trace context through the config hook when otel traces are active", async () => {
    const runtime = makeSpyRuntime();
    const { hooks } = await loadOtel({ runtime, projectId: "proj-1" });
    const hostConfig = {
      logLevel: "INFO",
      provider: { openai: { options: {} as Record<string, unknown> } }
    };
    await hooks.config?.(hostConfig as never);
    expect(typeof hostConfig.provider.openai.options.fetch).toBe("function");
  });
});

describe("createLightbridgePlugin — full otel hook surface", () => {
  it("drives every observing hook without throwing", async () => {
    const runtime = makeSpyRuntime();
    const logs = new InMemoryLogRecordExporter();
    const hooks = await createLightbridgePlugin({
      logger: createSilentLogger(),
      registerProcessHandlers: false,
      deferredTimeoutMs: 5,
      runtimeFactory: () => runtime,
      exporters: { trace: () => undefined, metric: () => undefined, log: () => logs }
    })(pluginInput(), {
      auth: makeAuth(),
      projectId: "proj-1",
      otel: { endpoint: "http://localhost:4318" }
    });

    await hooks.event?.({
      event: { type: "session.created", properties: { info: { id: "ses_1" } } }
    } as never);
    await hooks["chat.message"]?.({} as never, {} as never);
    await hooks["tool.execute.before"]?.({
      tool: "edit",
      sessionID: "ses_1",
      callID: "c1"
    } as never);
    await hooks["tool.execute.after"]?.(
      { tool: "edit", sessionID: "ses_1", callID: "c1", args: {} } as never,
      { title: "", output: "ok", metadata: {} } as never
    );
    await hooks["chat.params"]?.(
      { sessionID: "ses_1", agent: "build", model: { id: "kimi-k2.6" } } as never,
      { temperature: 0.3 } as never
    );
    await hooks["permission.ask"]?.(
      { id: "perm_1", sessionID: "ses_1", type: "edit" } as never,
      { status: "allow" } as never
    );
    await hooks["experimental.text.complete"]?.(
      { sessionID: "ses_1", messageID: "msg_1", partID: "p1" } as never,
      { text: "abcd" } as never
    );
    await hooks["experimental.compaction.autocontinue"]?.(
      { sessionID: "ses_1", overflow: true } as never,
      { enabled: true } as never
    );
    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: "ses_1" } }
    } as never);

    await vi.waitFor(() => expect(logs.getFinishedLogRecords().length).toBeGreaterThan(0));
  });
});

describe("createLightbridgePlugin — default logger + exit handling", () => {
  it("pipes diagnostics through client.app.log when no logger is injected", async () => {
    const input = pluginInput();
    await createLightbridgePlugin({ registerProcessHandlers: false })(input, { auth: makeAuth() });
    const log = input.client.app.log as unknown as ReturnType<typeof vi.fn>;
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ service: "opencode-lightbridge-plugin" })
      })
    );
  });

  it("registers exit handlers exactly once when otel is active and drains on beforeExit", async () => {
    const before = process.listenerCount("beforeExit");
    await createLightbridgePlugin({
      logger: createSilentLogger(),
      deferredTimeoutMs: 5,
      exporters: { trace: () => undefined, metric: () => undefined, log: () => undefined }
    })(pluginInput(), { auth: makeAuth(), otel: { endpoint: "http://localhost:4318" } });

    expect(process.listenerCount("beforeExit")).toBe(before + 1);
    try {
      process.emit("beforeExit", 0);
    } finally {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const [handler] = process.listeners(signal).slice(-1);
        if (handler) {
          process.removeListener(signal, handler as never);
        }
      }
    }
    expect(process.listenerCount("beforeExit")).toBe(before);
  });
});

describe("createLightbridgePlugin — one shared runtime across both modules", () => {
  it("builds the runtime exactly once and both modules call into the same instance", async () => {
    const runtime = makeSpyRuntime();
    const { factory, calls } = fixedRuntimeFactory(runtime);
    const spans = new InMemorySpanExporter();

    const hooks = await createLightbridgePlugin({
      logger: createSilentLogger(),
      registerProcessHandlers: false,
      deferredTimeoutMs: 5,
      runtimeFactory: factory,
      exporters: { trace: () => spans, log: () => undefined, metric: () => undefined }
    })(pluginInput(), {
      auth: makeAuth(),
      gateway: { projectId: "proj-1", providers: ["gateway"] },
      otel: { endpoint: "http://localhost:4318" }
    });

    expect(calls).toEqual([0]); // exactly one construction

    const output = { headers: {} as Record<string, string> };
    await hooks["chat.headers"]?.({ model: { providerID: "gateway" } } as never, output);
    await hooks.event?.({
      event: { type: "session.created", properties: { info: { id: "s1" } } }
    } as never);

    // Both the gateway hook and (indirectly, via the injected exporter/token
    // source seam exercised in the otel describe block above) the OTEL module
    // read the SAME runtime — evidenced by the single spy accumulating a call
    // from the gateway path here, and by `calls` proving only one runtime was
    // ever constructed for the whole plugin instance.
    expect(runtime.calls).toEqual([{ interactive: true }]);
  });
});
