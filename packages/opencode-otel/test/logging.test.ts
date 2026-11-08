import { Effect, Logger, References } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LogLevel } from "@vymalo/opencode-core-otel";

import { captureHostContext, createEffectLogger, resolveLogLevel } from "../src/logging.js";

describe("resolveLogLevel", () => {
  it("maps DEBUG to the most-verbose trace tier", () => {
    expect(resolveLogLevel("DEBUG")).toBe("trace");
    expect(resolveLogLevel("debug")).toBe("trace");
  });

  it("maps the remaining host levels straight through", () => {
    expect(resolveLogLevel("INFO")).toBe("info");
    expect(resolveLogLevel("WARN")).toBe("warn");
    expect(resolveLogLevel("ERROR")).toBe("error");
  });

  it("returns undefined for unknown / non-string input", () => {
    expect(resolveLogLevel("VERBOSE")).toBeUndefined();
    expect(resolveLogLevel(42)).toBeUndefined();
    expect(resolveLogLevel(undefined)).toBeUndefined();
  });
});

interface Captured {
  level: string;
  message: unknown[];
  annotations: Record<string, unknown>;
}

/** Capture the Effect context of a fiber whose only logger records into `sink`. */
async function hostContextWithCapture(sink: Captured[]) {
  const recorder = Logger.make<unknown, void>((options) => {
    sink.push({
      level: options.logLevel,
      message: options.message as unknown[],
      annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) }
    });
  });
  return Effect.runPromise(
    captureHostContext.pipe(
      Effect.provide(Logger.layer([recorder], { mergeWithExisting: false })),
      // Effect's default minimum is Info; open it so debug records are observable.
      Effect.provideService(References.MinimumLogLevel, "All")
    )
  );
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ADR-0014: the plugin's own diagnostics never touch the terminal", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  const previous = process.env.VYMALO_PLUGIN_CONSOLE_LOG;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.VYMALO_PLUGIN_CONSOLE_LOG;
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.VYMALO_PLUGIN_CONSOLE_LOG;
    } else {
      process.env.VYMALO_PLUGIN_CONSOLE_LOG = previous;
    }
    vi.restoreAllMocks();
  });

  it("never mirrors a warn record to the console by default", async () => {
    const sink: Captured[] = [];
    const logger = createEffectLogger(await hostContextWithCapture(sink), () => "trace");

    logger.warn("otel_export_failed", { providerId: "p" });
    logger.error("otel_gave_up", { providerId: "p" });
    await flush();

    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("delivers the record to the host Effect logger at its true severity", async () => {
    const sink: Captured[] = [];
    const logger = createEffectLogger(await hostContextWithCapture(sink), () => "trace");

    logger.trace("ev_trace");
    logger.debug("ev_debug");
    logger.info("ev_info");
    logger.warn("otel_export_failed", { providerId: "p", resetSeconds: 5 });
    logger.error("ev_error");
    await flush();

    expect(sink.map((c) => [c.level, c.message])).toEqual([
      ["Debug", ["ev_trace"]], // Effect has no tier below debug
      ["Debug", ["ev_debug"]],
      ["Info", ["ev_info"]],
      ["Warn", ["otel_export_failed"]],
      ["Error", ["ev_error"]]
    ]);
    expect(sink[3]?.annotations).toEqual({ providerId: "p", resetSeconds: 5 });
  });

  it("applies the plugin's own minimum level before building a record", async () => {
    const sink: Captured[] = [];
    let min: LogLevel = "warn";
    const logger = createEffectLogger(await hostContextWithCapture(sink), () => min);

    logger.info("dropped");
    logger.warn("kept");
    min = "trace";
    logger.trace("now_kept");
    await flush();

    expect(sink.map((c) => c.message[0])).toEqual(["kept", "now_kept"]);
  });

  it("restores the console mirror when VYMALO_PLUGIN_CONSOLE_LOG is set", async () => {
    process.env.VYMALO_PLUGIN_CONSOLE_LOG = "1";
    const sink: Captured[] = [];
    const logger = createEffectLogger(await hostContextWithCapture(sink), () => "info");

    logger.warn("otel_export_failed", { providerId: "p" });
    await flush();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0]?.[0] as string)).toMatchObject({
      level: "warn",
      event: "otel_export_failed"
    });
    expect(sink).toHaveLength(1); // still delivered to the host logger too
  });

  it("redacts sensitive fields before they reach the host logger", async () => {
    const sink: Captured[] = [];
    const logger = createEffectLogger(await hostContextWithCapture(sink), () => "trace");

    logger.trace("ev", {
      token: "t",
      client_secret: "s",
      password: "p",
      authorization: "Bearer abc",
      providerId: "p"
    });
    await flush();

    expect(sink[0]?.annotations).toEqual({
      token: "[redacted]",
      client_secret: "[redacted]",
      password: "[redacted]",
      authorization: "[redacted]",
      providerId: "p"
    });
  });

  it("logs a record with no fields", async () => {
    const sink: Captured[] = [];
    const logger = createEffectLogger(await hostContextWithCapture(sink), () => "info");

    logger.info("bare");
    await flush();

    expect(sink[0]?.annotations).toEqual({});
  });
});
