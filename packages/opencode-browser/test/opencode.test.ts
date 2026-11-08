import type { Plugin } from "@opencode/plugin/effect";
import { Effect, Logger, References, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSocketFactory } from "../src/agent-client.js";
import { encodeFrame, PROTOCOL_VERSION } from "../src/protocol.js";
import type { BridgeTransport, TransportHandlers } from "../src/transport.js";

/**
 * A guest socket factory that throws synchronously so `AgentClient.connect()`
 * rejects instead of hanging forever waiting for a `ready` frame.
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

import { createBrowserPlugin, OpencodeBrowserPlugin, PLUGIN_ID } from "../src/opencode.js";
import { readBridgeFile, writeBridgeFile } from "../src/token-file.js";

/** A transport that "binds" instantly (no real socket) → host election wins. */
class FakeTransport implements BridgeTransport {
  readonly stop = vi.fn();
  listen(_opts: { host: string; port: number }, _handlers: TransportHandlers): Promise<void> {
    return Promise.resolve();
  }
}
const fakeAgentSocket: AgentSocketFactory = () => ({ send() {}, close() {} });

interface FakeEditor {
  add: ReturnType<typeof vi.fn>;
}

interface FakeCtx {
  ctx: Plugin.Context;
  transforms: Array<(editor: FakeEditor) => void>;
  /** Run every registered `tool.transform` against a fresh editor. */
  names(): string[];
  editors(): FakeEditor[];
}

function fakeCtx(options: Record<string, unknown> = {}): FakeCtx {
  const transforms: Array<(editor: FakeEditor) => void> = [];
  const editors: FakeEditor[] = [];
  const ctx = {
    options,
    location: { directory: "/proj", project: { id: "p", directory: "/proj", canonical: "/proj" } },
    tool: {
      transform: (cb: (editor: FakeEditor) => void) => {
        transforms.push(cb);
        return Effect.succeed({ dispose: Effect.void });
      }
    }
  } as unknown as Plugin.Context;
  return {
    ctx,
    transforms,
    editors: () => editors,
    names: () => {
      const editor: FakeEditor = { add: vi.fn() };
      editors.push(editor);
      for (const cb of transforms) {
        cb(editor);
      }
      return editor.add.mock.calls.map((c) => (c[0] as { name: string }).name);
    }
  };
}

function silentLogger() {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function load(
  options: Record<string, unknown> = {},
  factory: Parameters<typeof createBrowserPlugin>[0] = {}
) {
  const fake = fakeCtx(options);
  const logger = silentLogger();
  const transport = new FakeTransport();
  const plugin = createBrowserPlugin({
    createServerTransport: () => transport,
    createAgentSocket: fakeAgentSocket,
    generateToken: () => "generated-token",
    logger,
    ...factory
  });
  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(plugin.effect(fake.ctx).pipe(Scope.provide(scope)));
  return { fake, logger, transport, scope };
}

const close = (scope: Scope.Closeable) => Effect.runPromise(Scope.close(scope, Effect.void));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createBrowserPlugin", () => {
  it("has the stable plugin id", () => {
    expect(PLUGIN_ID).toBe("vymalo.browser");
    expect(createBrowserPlugin().id).toBe(PLUGIN_ID);
    expect(OpencodeBrowserPlugin.id).toBe(PLUGIN_ID);
  });

  it("registers the default groups' tools through tool.transform", async () => {
    const { fake, scope } = await load();
    const names = fake.names();
    expect(names).toContain("browser_open"); // control
    expect(names).toContain("browser_snapshot"); // page
    expect(names).not.toContain("browser_eval"); // debug opt-in
    expect(names).not.toContain("browser_request_feedback"); // interactive opt-in
    await close(scope);
  });

  it("re-registers the full set on every transform run (provider/tool reloads)", async () => {
    const { fake, scope } = await load();
    const first = fake.names();
    const second = fake.names();
    expect(second).toEqual(first);
    await close(scope);
  });

  it("registers debug + interactive tools when those groups are enabled", async () => {
    const { fake, scope } = await load({ groups: ["page", "control", "debug", "interactive"] });
    const names = fake.names();
    expect(names).toContain("browser_eval");
    expect(names).toContain("browser_request_feedback");
    await close(scope);
  });

  it("falls back to defaults for an invalid groups option", async () => {
    const { fake, scope } = await load({ groups: ["bogus", 123] });
    const names = fake.names();
    expect(names).toContain("browser_open");
    expect(names).not.toContain("browser_eval");
    await close(scope);
  });

  it("registers no tools and starts no bridge when disabled", async () => {
    const listen = vi.fn(() => Promise.resolve());
    const { fake, logger } = await load(
      { enabled: false },
      { createServerTransport: () => ({ listen, stop() {} }) }
    );
    expect(fake.transforms).toHaveLength(0);
    expect(listen).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("browser_plugin_disabled", {});
  });

  it("advertises a generated token through the logger, but not an explicit one", async () => {
    const generated = await load();
    expect(generated.logger.info).toHaveBeenCalledWith(
      "browser_bridge_token",
      expect.objectContaining({ paste_into_extension: "generated-token", source: "generated" })
    );

    const explicit = await load({ token: "my-secret" });
    const events = explicit.logger.info.mock.calls.map((c) => c[0]);
    expect(events).not.toContain("browser_bridge_token");
    await close(generated.scope);
    await close(explicit.scope);
  });

  it("treats an empty token as not provided", async () => {
    const { logger, scope } = await load({ token: "" });
    expect(logger.info).toHaveBeenCalledWith("browser_bridge_token", expect.any(Object));
    await close(scope);
  });

  describe("host token persistence (bridge.json)", () => {
    beforeEach(() => {
      vi.mocked(writeBridgeFile).mockClear();
      vi.mocked(readBridgeFile).mockReset().mockReturnValue(null);
    });

    it("rewrites bridge.json when the file points at a stale port (keeps discovery in sync)", async () => {
      vi.mocked(readBridgeFile).mockReturnValueOnce({ port: 9999, token: "generated-token" });
      const { scope } = await load(); // default port 4517
      expect(writeBridgeFile).toHaveBeenCalledWith(4517, "generated-token");
      await close(scope);
    });

    it("writes an explicit token over a stale file value (operator config wins)", async () => {
      vi.mocked(readBridgeFile).mockReturnValueOnce({ port: 4517, token: "old-generated" });
      const { scope } = await load({ token: "my-secret" });
      expect(writeBridgeFile).toHaveBeenCalledWith(4517, "my-secret");
      await close(scope);
    });

    it("does not rewrite bridge.json when the file already matches our port and token", async () => {
      vi.mocked(readBridgeFile).mockReturnValueOnce({ port: 4517, token: "generated-token" });
      const { scope } = await load();
      expect(writeBridgeFile).not.toHaveBeenCalled();
      await close(scope);
    });
  });
});

describe("scope close tears the bridge down", () => {
  it("stops the host transport (the listening socket) when the scope closes", async () => {
    const { transport, scope } = await load();
    expect(transport.stop).not.toHaveBeenCalled();

    await close(scope);

    expect(transport.stop).toHaveBeenCalledTimes(1);
  });

  it("closes the guest socket when the scope closes", async () => {
    const addrInUse = Object.assign(new Error("address already in use"), { code: "EADDRINUSE" });
    const guestClose = vi.fn();
    const guestSocket: AgentSocketFactory = (_url, handlers) => {
      queueMicrotask(() => {
        handlers.onOpen();
        handlers.onMessage(
          encodeFrame({
            v: PROTOCOL_VERSION,
            type: "ready",
            server: "opencode-browser",
            protocol: PROTOCOL_VERSION
          })
        );
      });
      return { send() {}, close: guestClose };
    };
    const { scope } = await load(
      {},
      {
        createServerTransport: () => ({ listen: () => Promise.reject(addrInUse), stop() {} }),
        createAgentSocket: guestSocket
      }
    );
    expect(guestClose).not.toHaveBeenCalled();

    await close(scope);

    expect(guestClose).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending re-election timer so nothing fires after the scope closes", async () => {
    vi.useFakeTimers();
    try {
      const listen = vi.fn(() => Promise.reject(new Error("bind exploded")));
      const { scope } = await load(
        {},
        {
          createServerTransport: () => ({ listen, stop() {} }),
          createAgentSocket: failingAgentSocket
        }
      );
      expect(listen).toHaveBeenCalledTimes(1);

      await close(scope);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(listen).toHaveBeenCalledTimes(1); // no re-election after close
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes its process exit safety net on a clean close (no listener leak)", async () => {
    const before = process.listenerCount("exit");
    const { scope } = await load();
    expect(process.listenerCount("exit")).toBe(before + 1);

    await close(scope);

    expect(process.listenerCount("exit")).toBe(before);
  });

  it("tolerates a shutdown that throws", async () => {
    const { scope } = await load(
      {},
      {
        createServerTransport: () => ({
          listen: () => Promise.resolve(),
          stop() {
            throw new Error("already closed");
          }
        })
      }
    );
    await expect(close(scope)).resolves.toBeUndefined();
  });

  it("the exit safety net shuts the endpoint down too", async () => {
    const { transport, scope } = await load();
    const listeners = process.listeners("exit");
    const onExit = listeners[listeners.length - 1] as () => void;

    onExit();

    expect(transport.stop).toHaveBeenCalledTimes(1);
    await close(scope);
  });
});

describe("log level resolution", () => {
  const previous = process.env.OPENCODE_LOG_LEVEL;
  afterEach(() => {
    if (previous === undefined) {
      delete process.env.OPENCODE_LOG_LEVEL;
    } else {
      process.env.OPENCODE_LOG_LEVEL = previous;
    }
  });

  /** Run the real (non-injected) logger path and return what the host saw. */
  async function hostRecords(options: Record<string, unknown>) {
    const sink: Array<{ level: string; message: string }> = [];
    const recorder = Logger.make<unknown, void>((o) => {
      sink.push({ level: o.logLevel, message: String((o.message as unknown[])[0]) });
    });
    const fake = fakeCtx(options);
    const plugin = createBrowserPlugin({
      createServerTransport: () => new FakeTransport(),
      createAgentSocket: fakeAgentSocket,
      generateToken: () => "generated-token"
    });
    const scope = await Effect.runPromise(Scope.make());
    await Effect.runPromise(
      plugin
        .effect(fake.ctx)
        .pipe(
          Scope.provide(scope),
          Effect.provide(Logger.layer([recorder], { mergeWithExisting: false })),
          Effect.provideService(References.MinimumLogLevel, "All")
        )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await close(scope);
    return sink;
  }

  it("defaults to info: the trace-level election records are dropped", async () => {
    delete process.env.OPENCODE_LOG_LEVEL;
    const records = await hostRecords({ token: "t" });
    expect(records.map((r) => r.message)).toContain("browser_endpoint_mode");
    expect(records.map((r) => r.message)).not.toContain("browser_election_start");
  });

  it("the plugin's own logLevel option unlocks trace", async () => {
    delete process.env.OPENCODE_LOG_LEVEL;
    const records = await hostRecords({ token: "t", logLevel: "debug" });
    expect(records.map((r) => r.message)).toContain("browser_election_start");
  });

  it("falls back to OPENCODE_LOG_LEVEL when the option is absent", async () => {
    process.env.OPENCODE_LOG_LEVEL = "DEBUG";
    const records = await hostRecords({ token: "t" });
    expect(records.map((r) => r.message)).toContain("browser_election_start");
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

  interface Captured {
    level: string;
    message: string;
    annotations: Record<string, unknown>;
  }

  /**
   * Loads the plugin WITHOUT injecting a `logger`, so the production
   * `captureHostContext` + `createEffectLogger` path runs inside a fiber whose
   * only logger records into the returned sink. The failed host bind logs a
   * real `warn`, then the failed guest schedules a real 500ms re-election —
   * fake timers keep that retry from bleeding into later tests.
   */
  async function loadWithHostLogger(transport: () => BridgeTransport, options = {}) {
    const sink: Captured[] = [];
    const recorder = Logger.make<unknown, void>((o) => {
      sink.push({
        level: o.logLevel,
        message: String((o.message as unknown[])[0]),
        annotations: { ...o.fiber.getRef(References.CurrentLogAnnotations) }
      });
    });
    const fake = fakeCtx(options);
    const plugin = createBrowserPlugin({
      createServerTransport: transport,
      createAgentSocket: failingAgentSocket,
      generateToken: () => "generated-token"
    });
    vi.useFakeTimers();
    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.runPromise(
        plugin
          .effect(fake.ctx)
          .pipe(
            Scope.provide(scope),
            Effect.provide(Logger.layer([recorder], { mergeWithExisting: false })),
            Effect.provideService(References.MinimumLogLevel, "All")
          )
      );
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
    await close(scope);
    return sink;
  }

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

  it("never mirrors a warn record (a failed host bind) to the console", async () => {
    await loadWithHostLogger(() => new ThrowingBindTransport());

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("delivers the warn record to the host Effect logger at its true severity", async () => {
    const sink = await loadWithHostLogger(() => new ThrowingBindTransport());

    const bind = sink.find((c) => c.message === "browser_endpoint_bind_error");
    expect(bind?.level).toBe("Warn");
    expect(bind?.annotations).toEqual({ message: "bind exploded" });
  });

  it("delivers an error record (a failed onHost callback) to the host logger, not the console", async () => {
    vi.mocked(writeBridgeFile).mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    const sink = await loadWithHostLogger(() => new FakeTransport());

    const failed = sink.find((c) => c.message === "browser_endpoint_onhost_error");
    expect(failed?.level).toBe("Error");
    expect(failed?.annotations).toEqual({ message: "disk full" });
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("advertises the pasteable token un-redacted (paste_into_extension dodges the redactor)", async () => {
    const sink = await loadWithHostLogger(() => new FakeTransport());

    const adv = sink.find((c) => c.message === "browser_bridge_token");
    expect(adv?.annotations).toMatchObject({
      paste_into_extension: "generated-token",
      source: "generated",
      mode: "host"
    });
  });

  it("restores the console mirror when VYMALO_PLUGIN_CONSOLE_LOG is set", async () => {
    process.env.VYMALO_PLUGIN_CONSOLE_LOG = "1";

    await loadWithHostLogger(() => new ThrowingBindTransport());

    expect(warn).toHaveBeenCalled();
  });
});
