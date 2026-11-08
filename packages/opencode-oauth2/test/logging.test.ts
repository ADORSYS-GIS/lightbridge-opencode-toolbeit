import type { Plugin } from "@opencode/plugin/effect";
import { Effect, Exit, Logger, References, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureHostContext,
  createEffectLogger,
  LOG_LEVEL_PRIORITY,
  type LogLevel,
  resolveLogLevel,
  runInHost
} from "../src/logging.js";
import { createOpencodeOauth2Plugin } from "../src/opencode.js";

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

  it("maps TRACE to trace", () => {
    expect(resolveLogLevel("TRACE")).toBe("trace");
  });

  it("returns undefined for unknown / non-string input", () => {
    expect(resolveLogLevel("VERBOSE")).toBeUndefined();
    expect(resolveLogLevel(42)).toBeUndefined();
    expect(resolveLogLevel(undefined)).toBeUndefined();
  });
});

describe("LOG_LEVEL_PRIORITY", () => {
  it("ranks trace below debug (most verbose)", () => {
    expect(LOG_LEVEL_PRIORITY.trace).toBeLessThan(LOG_LEVEL_PRIORITY.debug);
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

    logger.warn("oauth2_refresh_failed", { providerId: "p" });
    logger.error("oauth2_sync_failed", { providerId: "p" });
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
    logger.warn("oauth2_refresh_failed", { providerId: "p", resetSeconds: 5 });
    logger.error("ev_error");
    await flush();

    expect(sink.map((c) => [c.level, c.message])).toEqual([
      ["Debug", ["ev_trace"]], // Effect has no tier below debug
      ["Debug", ["ev_debug"]],
      ["Info", ["ev_info"]],
      ["Warn", ["oauth2_refresh_failed"]],
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

    logger.warn("oauth2_refresh_failed", { providerId: "p" });
    await flush();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0]?.[0] as string)).toMatchObject({
      level: "warn",
      event: "oauth2_refresh_failed"
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

describe("runInHost", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs a detached effect inside the captured host context, not Effect's default logger", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink: Captured[] = [];
    const context = await hostContextWithCapture(sink);

    await runInHost(context, Effect.logWarning("oauth2_reload"));

    expect(sink.map((c) => [c.level, c.message])).toEqual([["Warn", ["oauth2_reload"]]]);
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("ADR-0014: the assembled plugin logs through the host context", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers the plugin's own records to the host logger and nothing to the terminal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.VYMALO_PLUGIN_CONSOLE_LOG;

    const sink: Captured[] = [];
    const recorder = Logger.make<unknown, void>((options) => {
      sink.push({
        level: options.logLevel,
        message: options.message as unknown[],
        annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) }
      });
    });

    let transform: ((editor: unknown) => void) | undefined;
    const registration = Effect.succeed({ dispose: Effect.void });
    const ctx = {
      options: { logLevel: "DEBUG" },
      provider: {
        transform: (cb: (editor: unknown) => void) => {
          transform = cb;
          return registration;
        },
        reload: () => Effect.void
      },
      session: { hook: () => registration }
    } as unknown as Plugin.Context;

    // No `logger` override: the plugin must capture the host context itself.
    const plugin = createOpencodeOauth2Plugin();
    const scope = await Effect.runPromise(Scope.make());
    await Effect.runPromise(
      Scope.provide(scope)(plugin.effect(ctx)).pipe(
        Effect.provide(Logger.layer([recorder], { mergeWithExisting: false })),
        Effect.provideService(References.MinimumLogLevel, "All")
      )
    );

    // An invalid provider config makes the plugin report an error from inside the
    // (synchronous) transform callback, long after the setup fiber has returned.
    const editor = {
      list: () => [
        {
          provider: {
            id: "bad",
            name: "bad",
            settings: {
              baseURL: "https://api.example.com/v1",
              oauth2: {
                issuer: "https://auth.example.com",
                clientId: "c",
                scopes: ["openid"],
                redirectPort: 70000
              }
            }
          }
        }
      ],
      get: () => undefined
    };
    transform?.(editor);
    await flush();

    const invalid = sink.find((c) => c.message[0] === "oauth2_config_invalid");
    expect(invalid?.level).toBe("Error");
    expect(String(invalid?.annotations.error)).toMatch(/redirectPort/);

    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
