import { describe, expect, it, vi } from "vitest";

import { createDevtoolsPlugin, resolveOptions } from "../src/opencode.js";
import type { Logger } from "../src/logging.js";

function fakeLogger(): Logger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const client = { app: { log: vi.fn().mockResolvedValue(undefined) } } as never;

type ToolMap = Record<
  string,
  { execute: (args: Record<string, unknown>, ctx: unknown) => unknown }
>;

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
});

describe("createDevtoolsPlugin", () => {
  it("registers tools when enabled", async () => {
    const plugin = createDevtoolsPlugin({ logger: fakeLogger() });
    const hooks = await plugin({ client } as never, { groups: ["math"] });
    expect(hooks.tool && Object.keys(hooks.tool)).toContain("math_eval");
  });

  it("registers no tools when disabled", async () => {
    const logger = fakeLogger();
    const plugin = createDevtoolsPlugin({ logger });
    const hooks = await plugin({ client } as never, { enabled: false });
    expect(hooks.tool).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith("devtools_plugin_disabled", {});
  });

  it("tracks the host log level via the config hook", async () => {
    const plugin = createDevtoolsPlugin({ logger: fakeLogger() });
    const hooks = await plugin({ client } as never, {});
    // Should not throw — the config hook just records the level.
    await hooks.config?.({ logLevel: "DEBUG" } as never);
  });

  it("uses the OpenCode-piped logger by default (smoke)", async () => {
    const plugin = createDevtoolsPlugin();
    const hooks = await plugin({ client } as never, { groups: ["codec"] });
    expect(hooks.tool).toBeDefined();
  });

  it("drives the real piped logger through trace, success and failure", async () => {
    const log = vi.fn().mockResolvedValue(undefined);
    const input = { client: { app: { log } } } as never;
    const plugin = createDevtoolsPlugin(); // no injected logger → real createOpenCodeLogger
    const hooks = await plugin(input, { groups: ["math"] });
    await hooks.config?.({ logLevel: "DEBUG" } as never); // unlock trace tier
    await (hooks.tool as ToolMap).math_eval.execute({ expression: "1+1" }, {} as never);
    await expect(
      (hooks.tool as ToolMap).math_eval.execute({ expression: 1 }, {} as never)
    ).rejects.toThrow();
    // enabled + trace + warn all routed to client.app.log
    const events = log.mock.calls.map(
      (call) => (call[0] as { body: { message: string } }).body.message
    );
    expect(events).toContain("devtools_plugin_enabled");
    expect(events).toContain("devtools_tool_failed");
  });
});

describe("ADR-0014: the plugin's own diagnostics never touch the terminal", () => {
  // devtools is one of the eight plugins ADR-0014 newly brings under the
  // no-terminal-mirror rule (ADR-0013 originally scoped this to opencode-otel
  // only). `devtools_tool_failed` (tools.ts, warn level) is the easiest real
  // warn-level record to force without mocking internals: drive `math_eval`
  // with a non-string expression so the handler throws.
  async function driveFailingTool() {
    const log = vi.fn().mockResolvedValue(undefined);
    const input = { client: { app: { log } } } as never;
    const plugin = createDevtoolsPlugin(); // no injected logger → real createOpenCodeLogger
    const hooks = await plugin(input, { groups: ["math"] });
    await expect(
      (hooks.tool as ToolMap).math_eval.execute({ expression: 1 }, {} as never)
    ).rejects.toThrow();
    return log;
  }

  it("never mirrors the warn record to the console fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await driveFailingTool();

    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    warn.mockRestore();
    log.mockRestore();
  });

  it("still forwards the warn record to client.app.log at its true level", async () => {
    const appLog = await driveFailingTool();

    expect(appLog).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          level: "warn",
          message: "devtools_tool_failed"
        })
      })
    );
  });

  it("restores the console mirror when VYMALO_PLUGIN_CONSOLE_LOG is set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const previous = process.env.VYMALO_PLUGIN_CONSOLE_LOG;
    process.env.VYMALO_PLUGIN_CONSOLE_LOG = "1";

    try {
      await driveFailingTool();
      expect(warn).toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.VYMALO_PLUGIN_CONSOLE_LOG;
      } else {
        process.env.VYMALO_PLUGIN_CONSOLE_LOG = previous;
      }
      warn.mockRestore();
    }
  });
});
