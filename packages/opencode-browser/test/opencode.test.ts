import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSocketFactory } from "../src/agent-client.js";
import type { BridgeTransport, TransportHandlers } from "../src/transport.js";

/**
 * Mirrors the shape of endpoint.test.ts's `failingSocket` — a guest socket
 * factory that throws synchronously so `AgentClient.connect()`'s promise
 * auto-rejects instead of hanging forever waiting for a `ready` frame that a
 * dumb fake socket (like `fakeAgentSocket` below) would never deliver.
 */
const failingAgentSocket: AgentSocketFactory = () => {
  throw new Error("no guest socket in test");
};

// Isolate the shared-token state file so the factory never touches the real
// ~/Library/Application Support (…) bridge.json that a live OpenCode shares.
vi.mock("../src/token-file.js", () => ({
  resolveSharedToken: (_port: number, explicit: string | undefined, generate: () => string) =>
    explicit ? { token: explicit, source: "explicit" } : { token: generate(), source: "generated" },
  writeBridgeFile: vi.fn(),
  // No shared file yet, so the host writes + advertises its own token.
  readBridgeFile: vi.fn(() => null)
}));

import { createBrowserPlugin } from "../src/opencode.js";
import { readBridgeFile, writeBridgeFile } from "../src/token-file.js";

/** A transport that "binds" instantly (no real socket) → host election wins. */
class FakeTransport implements BridgeTransport {
  listen(_opts: { host: string; port: number }, _handlers: TransportHandlers): Promise<void> {
    return Promise.resolve();
  }
  stop(): void {}
}
const fakeAgentSocket: AgentSocketFactory = () => ({ send() {}, close() {} });

function fakeClient() {
  const log = vi.fn().mockResolvedValue(undefined);
  return { client: { app: { log } } as unknown as PluginInput["client"], log };
}

async function load(pluginOptions: PluginOptions | undefined, client = fakeClient()) {
  const plugin = createBrowserPlugin({
    createServerTransport: () => new FakeTransport(),
    createAgentSocket: fakeAgentSocket,
    generateToken: () => "generated-token"
  });
  const hooks = await plugin({ client: client.client } as PluginInput, pluginOptions);
  return { hooks, client };
}

describe("createBrowserPlugin", () => {
  it("registers the default groups' tools and a config hook", async () => {
    const { hooks } = await load(undefined);
    const names = Object.keys(hooks.tool ?? {});
    expect(names).toContain("browser_open"); // control
    expect(names).toContain("browser_snapshot"); // page
    expect(names).not.toContain("browser_eval"); // debug opt-in
    expect(names).not.toContain("browser_request_feedback"); // interactive opt-in
    expect(typeof hooks.config).toBe("function");
  });

  it("registers debug + interactive tools when those groups are enabled", async () => {
    const { hooks } = await load({ groups: ["page", "control", "debug", "interactive"] });
    const names = Object.keys(hooks.tool ?? {});
    expect(names).toContain("browser_eval");
    expect(names).toContain("browser_request_feedback");
  });

  it("falls back to defaults for an invalid groups option", async () => {
    const { hooks } = await load({ groups: ["bogus", 123] as unknown as string[] });
    const names = Object.keys(hooks.tool ?? {});
    expect(names).toContain("browser_open");
    expect(names).not.toContain("browser_eval");
  });

  it("registers no tools when disabled", async () => {
    const { hooks } = await load({ enabled: false });
    expect(hooks.tool).toBeUndefined();
    expect(typeof hooks.config).toBe("function");
    await expect(hooks.config?.({ logLevel: "DEBUG" } as never)).resolves.toBeUndefined();
  });

  it("advertises a generated token through the host logger, but not an explicit one", async () => {
    const generated = await load(undefined);
    const logged = generated.client.log.mock.calls.map((c) => c[0]?.body?.message);
    expect(logged).toContain("browser_bridge_token");

    const explicit = await load({ token: "my-secret" });
    const logged2 = explicit.client.log.mock.calls.map((c) => c[0]?.body?.message);
    expect(logged2).not.toContain("browser_bridge_token");
  });

  describe("host token persistence (bridge.json)", () => {
    beforeEach(() => {
      vi.mocked(writeBridgeFile).mockClear();
      vi.mocked(readBridgeFile).mockReset().mockReturnValue(null);
    });

    it("rewrites bridge.json when the file points at a stale port (keeps discovery in sync)", async () => {
      vi.mocked(readBridgeFile).mockReturnValueOnce({ port: 9999, token: "generated-token" });
      await load(undefined); // default port 4517
      expect(writeBridgeFile).toHaveBeenCalledWith(4517, "generated-token");
    });

    it("writes an explicit token over a stale file value (operator config wins)", async () => {
      vi.mocked(readBridgeFile).mockReturnValueOnce({ port: 4517, token: "old-generated" });
      await load({ token: "my-secret" });
      expect(writeBridgeFile).toHaveBeenCalledWith(4517, "my-secret");
    });

    it("does not rewrite bridge.json when the file already matches our port and token", async () => {
      vi.mocked(readBridgeFile).mockReturnValueOnce({ port: 4517, token: "generated-token" });
      await load(undefined);
      expect(writeBridgeFile).not.toHaveBeenCalled();
    });
  });

  it("config hook resolves and accepts a log level", async () => {
    const { hooks } = await load(undefined);
    await expect(hooks.config?.({ logLevel: "WARN" } as never)).resolves.toBeUndefined();
  });
});

describe("ADR-0014: the plugin's own diagnostics never touch the terminal", () => {
  // A transport whose `listen()` rejects with a non-EADDRINUSE error is the
  // simplest reliable way to exercise a real `warn` record
  // (`browser_endpoint_bind_error`, endpoint.ts) without a real bind failure.
  class ThrowingBindTransport implements BridgeTransport {
    listen(_opts: { host: string; port: number }, _handlers: TransportHandlers): Promise<void> {
      return Promise.reject(new Error("bind exploded"));
    }
    stop(): void {}
  }

  /**
   * Loads the plugin WITHOUT injecting a custom `logger`, so the real
   * (non-injected) `createOpenCodeLogger` from opencode.ts runs — the only
   * thing under test here. The host bind fails (a non-EADDRINUSE error), which
   * logs a real `warn` (`browser_endpoint_bind_error`) before falling through
   * to a guest connect that also fails fast via `failingAgentSocket`. The
   * failed guest then schedules a real 500ms reelect retry (endpoint.ts's
   * default `reelectMs`, not overridable from here) — fake timers keep that
   * retry from ever actually firing in the background and bleeding into a
   * later test once we switch back to real timers.
   */
  async function loadWithBindError() {
    const client = fakeClient();
    const plugin = createBrowserPlugin({
      createServerTransport: () => new ThrowingBindTransport(),
      createAgentSocket: failingAgentSocket,
      generateToken: () => "generated-token"
    });
    vi.useFakeTimers();
    try {
      const hooks = await plugin({ client: client.client } as PluginInput, undefined);
      return { hooks, client };
    } finally {
      vi.useRealTimers();
    }
  }

  it("never mirrors a warn record (a failed host bind) to the console fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await loadWithBindError();

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("still forwards the warn record to client.app.log at its true level", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { client } = await loadWithBindError();

    expect(client.log).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          service: "opencode-browser-plugin",
          level: "warn",
          message: "browser_endpoint_bind_error"
        })
      })
    );
    vi.restoreAllMocks();
  });

  it("never mirrors an error record (a failed onHost callback) to the console fallback, but still forwards it to client.app.log at its true level", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // `onHost` (advertiseToken in opencode.ts) calls `writeBridgeFile` — make it
    // throw so `endpoint.ts`'s `elect()` catches it and logs a real `error`
    // (`browser_endpoint_onhost_error`) through the real, non-injected logger.
    vi.mocked(writeBridgeFile).mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    const { client } = await load(undefined);

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(client.log).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          service: "opencode-browser-plugin",
          level: "error",
          message: "browser_endpoint_onhost_error"
        })
      })
    );
    vi.restoreAllMocks();
  });

  it("restores the console mirror when VYMALO_PLUGIN_CONSOLE_LOG is set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const previous = process.env.VYMALO_PLUGIN_CONSOLE_LOG;
    process.env.VYMALO_PLUGIN_CONSOLE_LOG = "1";

    try {
      await loadWithBindError();
      expect(warn).toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.VYMALO_PLUGIN_CONSOLE_LOG;
      } else {
        process.env.VYMALO_PLUGIN_CONSOLE_LOG = previous;
      }
      vi.restoreAllMocks();
    }
  });
});
