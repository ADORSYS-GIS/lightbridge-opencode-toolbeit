import type { PluginInput } from "@opencode-ai/plugin";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { describe, expect, it, vi } from "vitest";

import { createOtelPlugin } from "../src/opencode.js";
import { assistantMessage, silentLogger } from "./helpers.js";

function pluginInput(): PluginInput {
  return {
    client: { app: { log: vi.fn().mockResolvedValue(undefined) } },
    project: { id: "toolbelt" },
    directory: "/repo",
    worktree: "/repo"
  } as unknown as PluginInput;
}

async function load(options: Record<string, unknown>, env: Record<string, string> = {}) {
  const logger = silentLogger();
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const hooks = await createOtelPlugin({
    logger,
    env,
    registerProcessHandlers: false,
    hostInfo: { hostname: "test-host", version: "0.12.0" },
    exporters: { trace: () => spans, log: () => logs, metric: () => undefined }
  })(pluginInput(), options);
  return { hooks, logger, spans, logs };
}

describe("createOtelPlugin", () => {
  it("stays inert and registers no observers when unconfigured", async () => {
    const { hooks, logger } = await load({});
    expect(hooks.event).toBeUndefined();
    expect(hooks["tool.execute.before"]).toBeUndefined();
    expect(hooks.config).toBeDefined();
    expect(logger.events).toContainEqual([
      "info:otel_plugin_inactive",
      { enabled: true, reason: "no_exporter_configured" }
    ]);
  });

  it("reports being switched off explicitly", async () => {
    const { logger } = await load({ endpoint: "http://localhost:4318", enabled: false });
    expect(logger.events).toContainEqual([
      "info:otel_plugin_inactive",
      { enabled: false, reason: "disabled" }
    ]);
  });

  it("registers the observing hooks once configured", async () => {
    const { hooks } = await load({ endpoint: "http://localhost:4318" });
    expect(hooks.event).toBeDefined();
    expect(hooks["chat.message"]).toBeDefined();
    expect(hooks["tool.execute.before"]).toBeDefined();
    expect(hooks["tool.execute.after"]).toBeDefined();
  });

  it("records an end-to-end session through the hooks", async () => {
    const { hooks, spans } = await load({ endpoint: "http://localhost:4318" });

    await hooks.event?.({
      event: { type: "session.created", properties: { info: { id: "ses_1" } } }
    } as never);
    await hooks["tool.execute.before"]?.({
      tool: "edit",
      sessionID: "ses_1",
      callID: "c1"
    } as never);
    await hooks["tool.execute.after"]?.(
      { tool: "edit", sessionID: "ses_1", callID: "c1", args: {} } as never,
      { title: "", output: "ok", metadata: {} } as never
    );
    await hooks.event?.({
      event: { type: "message.updated", properties: { info: assistantMessage() } }
    } as never);
    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: "ses_1" } }
    } as never);

    const names = spans.getFinishedSpans().map((span) => span.name);
    expect(names).toContain("execute_tool edit");
    expect(names).toContain("chat kimi-k2.6");
    expect(names).toContain("invoke_agent opencode");
  });

  it("wraps provider fetch for trace propagation in the config hook", async () => {
    const { hooks } = await load({ endpoint: "http://localhost:4318" });
    const hostConfig = {
      logLevel: "INFO",
      provider: { openai: { options: {} as Record<string, unknown> } }
    };
    await hooks.config?.(hostConfig as never);
    expect(typeof hostConfig.provider.openai.options.fetch).toBe("function");
  });

  it("leaves provider fetch alone when propagation is off", async () => {
    const { hooks } = await load({
      endpoint: "http://localhost:4318",
      propagateTraceContext: false
    });
    const hostConfig = { provider: { openai: { options: {} as Record<string, unknown> } } };
    await hooks.config?.(hostConfig as never);
    expect(hostConfig.provider.openai.options.fetch).toBeUndefined();
  });

  it("activates from the environment alone", async () => {
    const { hooks } = await load({}, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" });
    expect(hooks.event).toBeDefined();
  });

  it("never lets a hook throw into the host", async () => {
    const { hooks } = await load({ endpoint: "http://localhost:4318" });
    await expect(hooks.event?.({ event: { type: "bogus" } } as never)).resolves.toBeUndefined();
    await expect(
      hooks.event?.({ event: { type: "session.diff", properties: {} } } as never)
    ).resolves.toBeUndefined();
  });

  it("tracks the host log level through the config hook", async () => {
    const { hooks } = await load({ endpoint: "http://localhost:4318" });
    await expect(hooks.config?.({ logLevel: "DEBUG" } as never)).resolves.toBeUndefined();
    await expect(hooks.config?.({} as never)).resolves.toBeUndefined();
  });
});

describe("host logging", () => {
  it("pipes its own diagnostics through client.app.log", async () => {
    const input = pluginInput();
    await createOtelPlugin({
      env: {},
      registerProcessHandlers: false
    })(input, {});

    const log = input.client.app.log as unknown as ReturnType<typeof vi.fn>;
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          service: "opencode-otel-plugin",
          level: "info",
          message: "otel_plugin_inactive"
        })
      })
    );
  });

  it("reaches every log level of the default logger", async () => {
    const input = pluginInput();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const hooks = await createOtelPlugin({
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" },
      registerProcessHandlers: false,
      // Forcing one signal to fail exercises the warn path.
      exporters: {
        trace: () => {
          throw new Error("no exporter");
        },
        metric: () => undefined,
        log: () => new InMemoryLogRecordExporter()
      }
    })(input, {});
    // The config hook logs at debug, and propagation logs at trace.
    await hooks.config?.({
      logLevel: "DEBUG",
      provider: { openai: { options: {} } }
    } as never);

    const log = input.client.app.log as unknown as ReturnType<typeof vi.fn>;
    const messages = log.mock.calls.map((call) => call[0]?.body?.message);
    expect(messages).toContain("otel_plugin_enabled");
    expect(messages).toContain("otel_traces_init_failed");
    expect(messages).toContain("otel_trace_propagation_ready");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("detects the hostname itself when none is supplied", async () => {
    const hooks = await createOtelPlugin({
      logger: silentLogger(),
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" },
      registerProcessHandlers: false,
      exporters: {
        trace: () => undefined,
        metric: () => undefined,
        log: () => new InMemoryLogRecordExporter()
      }
    })(pluginInput(), {});
    expect(hooks.event).toBeDefined();
  });

  it("survives a host log call that rejects", async () => {
    const input = pluginInput();
    (input.client.app.log as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("host down")
    );
    await expect(
      createOtelPlugin({ env: {}, registerProcessHandlers: false })(input, {})
    ).resolves.toBeDefined();
  });
});

describe("exit handling", () => {
  it("drains telemetry on beforeExit, exactly once", async () => {
    const before = process.listenerCount("beforeExit");

    await createOtelPlugin({
      logger: silentLogger(),
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" },
      exporters: {
        trace: () => undefined,
        metric: () => undefined,
        log: () => new InMemoryLogRecordExporter()
      }
    })(pluginInput(), {});

    expect(process.listenerCount("beforeExit")).toBe(before + 1);
    try {
      process.emit("beforeExit", 0);
      process.emit("beforeExit", 0);
    } finally {
      // `once` handlers self-remove, but SIGINT/SIGTERM were never fired.
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const [handler] = process.listeners(signal).slice(-1);
        if (handler) {
          process.removeListener(signal, handler as never);
        }
      }
    }
    // The `once` handler removed itself, so a second beforeExit is a no-op.
    expect(process.listenerCount("beforeExit")).toBe(before);
  });
});
