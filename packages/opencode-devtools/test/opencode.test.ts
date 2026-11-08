import type { Plugin } from "@opencode/plugin/effect";
import { Effect, Logger, References } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDevtoolsPlugin, OpencodeDevtoolsPlugin, PLUGIN_ID } from "../src/opencode.js";
import type { Logger as PluginLogger } from "../src/logging.js";
import { resolveOptions } from "../src/options.js";

function fakeLogger(): PluginLogger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface RegisteredTool {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options?: { namespace?: string };
  execute: (input: unknown, context: unknown) => Effect.Effect<unknown, unknown>;
}

interface FakeCtx {
  ctx: Plugin.Context;
  transformed: () => boolean;
  namespaces: Array<{ name: string; description: string }>;
  tools: RegisteredTool[];
  /** Run the registered `tool.transform` callback against the recording editor. */
  apply: () => void;
}

function fakeCtx(options: Record<string, unknown> = {}): FakeCtx {
  const namespaces: FakeCtx["namespaces"] = [];
  const tools: RegisteredTool[] = [];
  let cb: ((editor: unknown) => void) | undefined;
  const ctx = {
    options,
    tool: {
      transform: (callback: (editor: unknown) => void) => {
        cb = callback;
        return Effect.succeed({ dispose: Effect.void });
      }
    }
  } as unknown as Plugin.Context;
  return {
    ctx,
    transformed: () => cb !== undefined,
    namespaces,
    tools,
    apply: () =>
      cb?.({
        namespace: (ns: FakeCtx["namespaces"][number]) => namespaces.push(ns),
        add: (tool: RegisteredTool) => tools.push(tool)
      })
  };
}

function run(plugin: Plugin.Plugin, ctx: Plugin.Context) {
  return Effect.runPromise(Effect.scoped(plugin.effect(ctx)));
}

const exposed = (t: RegisteredTool) => `${t.options?.namespace}_${t.name}`;

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OPENCODE_LOG_LEVEL;
});

describe("resolveOptions", () => {
  it("applies defaults (http opt-in, off)", () => {
    const o = resolveOptions(undefined);
    expect(o.enabled).toBe(true);
    expect(o.groups).toEqual(["math", "codec", "crypto", "datetime", "convert"]);
    expect(o.http.allowPrivateNetwork).toBe(false);
    expect(o.http.timeoutMs).toBe(30000);
  });

  it("filters invalid groups and dedups, falling back when empty", () => {
    expect(resolveOptions({ groups: ["math", "nope", "math"] }).groups).toEqual(["math"]);
    expect(resolveOptions({ groups: ["bogus"] }).groups).toEqual([
      "math",
      "codec",
      "crypto",
      "datetime",
      "convert"
    ]);
    expect(resolveOptions({ groups: "math" }).groups).toHaveLength(5);
  });

  it("honours http overrides", () => {
    const o = resolveOptions({
      groups: ["http"],
      http: { allowPrivateNetwork: true, timeoutMs: 5000 }
    });
    expect(o.groups).toEqual(["http"]);
    expect(o.http.allowPrivateNetwork).toBe(true);
    expect(o.http.timeoutMs).toBe(5000);
  });

  it("ignores a non-positive timeout", () => {
    expect(resolveOptions({ http: { timeoutMs: 0 } }).http.timeoutMs).toBe(30000);
  });

  it("can be disabled", () => {
    expect(resolveOptions({ enabled: false }).enabled).toBe(false);
  });
});

describe("createDevtoolsPlugin", () => {
  it("has a stable id", () => {
    expect(PLUGIN_ID).toBe("vymalo.devtools");
    expect(createDevtoolsPlugin().id).toBe(PLUGIN_ID);
    expect(OpencodeDevtoolsPlugin.id).toBe(PLUGIN_ID);
  });

  it("registers tools for ctx.options.groups through tool.transform", async () => {
    const fake = fakeCtx({ groups: ["math"] });
    const logger = fakeLogger();
    await run(createDevtoolsPlugin({ logger }), fake.ctx);

    expect(fake.transformed()).toBe(true);
    fake.apply();
    expect(fake.namespaces.map((n) => n.name)).toEqual(["math"]);
    expect(fake.tools.map(exposed)).toContain("math_eval");
    expect(fake.tools.some((t) => exposed(t).startsWith("codec_"))).toBe(false);
    expect(logger.info).toHaveBeenCalledWith("devtools_plugin_enabled", { groups: ["math"] });
  });

  it("defaults to the five offline groups; http is opt-in", async () => {
    const fake = fakeCtx();
    await run(createDevtoolsPlugin({ logger: fakeLogger() }), fake.ctx);
    fake.apply();
    expect(fake.namespaces.map((n) => n.name)).toEqual([
      "math",
      "codec",
      "crypto",
      "datetime",
      "convert"
    ]);
    expect(fake.tools.some((t) => exposed(t).startsWith("http_"))).toBe(false);
  });

  it("registers nothing when disabled", async () => {
    const fake = fakeCtx({ enabled: false });
    const logger = fakeLogger();
    await run(createDevtoolsPlugin({ logger }), fake.ctx);
    expect(fake.transformed()).toBe(false);
    expect(logger.info).toHaveBeenCalledWith("devtools_plugin_disabled", {});
  });

  it("runs registered tools over the injected context", async () => {
    const fake = fakeCtx({ groups: ["crypto"] });
    await run(
      createDevtoolsPlugin({
        logger: fakeLogger(),
        context: { randomBytes: (n: number) => Buffer.alloc(n, 1) }
      }),
      fake.ctx
    );
    fake.apply();
    const random = fake.tools.find((t) => exposed(t) === "crypto_random");
    const out = await Effect.runPromise(
      (random as RegisteredTool).execute({ bytes: 2 }, {}) as Effect.Effect<unknown>
    );
    expect(out).toEqual({ content: "0101" });
  });
});

interface Recorded {
  level: string;
  message: unknown[];
  annotations: Record<string, unknown>;
}

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
  });

  /**
   * Run the *real* plugin (default logger -> production `captureHostContext`)
   * inside a host that only has a recording Logger, then force a warn-level
   * record by calling a tool with a bad argument.
   */
  async function driveFailingTool(options: Record<string, unknown> = { groups: ["math"] }) {
    const sink: Recorded[] = [];
    const recorder = Logger.make<unknown, void>((o) => {
      sink.push({
        level: o.logLevel,
        message: o.message as unknown[],
        annotations: { ...o.fiber.getRef(References.CurrentLogAnnotations) }
      });
    });
    const fake = fakeCtx(options);
    await Effect.runPromise(
      Effect.scoped(OpencodeDevtoolsPlugin.effect(fake.ctx)).pipe(
        Effect.provide(Logger.layer([recorder], { mergeWithExisting: false })),
        Effect.provideService(References.MinimumLogLevel, "All")
      )
    );
    fake.apply();
    const evalTool = fake.tools.find((t) => exposed(t) === "math_eval") as RegisteredTool;
    await Effect.runPromiseExit(evalTool.execute({ expression: 1 }, {}) as Effect.Effect<unknown>);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return sink;
  }

  it("never mirrors the warn record to the console by default", async () => {
    await driveFailingTool();
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("delivers records to the host Effect logger at their true severity", async () => {
    const sink = await driveFailingTool();
    expect(sink.find((r) => r.message[0] === "devtools_plugin_enabled")).toMatchObject({
      level: "Info",
      annotations: { groups: ["math"] }
    });
    expect(sink.find((r) => r.message[0] === "devtools_tool_failed")).toMatchObject({
      level: "Warn",
      annotations: { tool: "math_eval" }
    });
  });

  it("takes the log level from options.logLevel, then OPENCODE_LOG_LEVEL", async () => {
    // options.logLevel=error gates the info "enabled" record out...
    const gated = await driveFailingTool({ groups: ["math"], logLevel: "error" });
    expect(gated.some((r) => r.message[0] === "devtools_plugin_enabled")).toBe(false);
    expect(gated.some((r) => r.message[0] === "devtools_tool_failed")).toBe(false);

    // ...and the host env var is the fallback when the option is absent.
    process.env.OPENCODE_LOG_LEVEL = "ERROR";
    const viaEnv = await driveFailingTool({ groups: ["math"] });
    expect(viaEnv.some((r) => r.message[0] === "devtools_plugin_enabled")).toBe(false);

    // DEBUG unlocks the trace tier (tool invoked/completed).
    delete process.env.OPENCODE_LOG_LEVEL;
    const verbose = await driveFailingTool({ groups: ["math"], logLevel: "DEBUG" });
    expect(verbose.some((r) => r.message[0] === "devtools_tool_invoked")).toBe(true);
  });

  it("restores the console mirror when VYMALO_PLUGIN_CONSOLE_LOG is set", async () => {
    process.env.VYMALO_PLUGIN_CONSOLE_LOG = "1";
    await driveFailingTool();
    expect(warn).toHaveBeenCalled();
  });
});
