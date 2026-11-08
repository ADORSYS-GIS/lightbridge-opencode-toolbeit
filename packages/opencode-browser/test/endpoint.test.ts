import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSocketFactory } from "../src/agent-client.js";
import { createEndpoint } from "../src/endpoint.js";
import type { Logger } from "../src/logging.js";
import type { BridgeTransport, TransportHandlers } from "../src/transport.js";

const noopLogger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };

class OkTransport implements BridgeTransport {
  listen(_opts: { host: string; port: number }, _handlers: TransportHandlers): Promise<void> {
    return Promise.resolve();
  }
  stop(): void {}
}

class ThrowingTransport implements BridgeTransport {
  // Mirrors the old Bun-only transport failing under Node.
  listen(): Promise<void> {
    return Promise.reject(
      new Error("the opencode-browser bridge requires the Bun runtime (Bun.serve not found)")
    );
  }
  stop(): void {}
}

// Guest path can't connect in these tests — forces the host outcome to be decisive.
const failingSocket: AgentSocketFactory = () => {
  throw new Error("no guest socket in test");
};

const baseOpts = {
  host: "127.0.0.1",
  port: 4517,
  token: "secret",
  timeoutMs: 500,
  reelectMs: 999_999
};

describe("createEndpoint election", () => {
  it("becomes host and fires onHost when the bind succeeds", async () => {
    let hosted = 0;
    const endpoint = await createEndpoint(
      { ...baseOpts, onHost: () => hosted++ },
      {
        logger: noopLogger,
        createServerTransport: () => new OkTransport(),
        createAgentSocket: failingSocket
      }
    );

    expect(endpoint.mode()).toBe("host");
    expect(hosted).toBe(1);
    endpoint.shutdown();
  });

  it("degrades instead of crashing when the host transport throws (non-Bun runtime)", async () => {
    // Before the fix this threw straight out of the plugin factory ("failed to
    // load plugin"). Now it must resolve and fall through to (failed) guest +
    // re-election — never throw, and never end up host.
    let hosted = 0;
    const endpoint = await createEndpoint(
      { ...baseOpts, onHost: () => hosted++ },
      {
        logger: noopLogger,
        createServerTransport: () => new ThrowingTransport(),
        createAgentSocket: failingSocket
      }
    );

    expect(endpoint.mode()).not.toBe("host");
    expect(hosted).toBe(0);
    endpoint.shutdown();
  });
});

describe("createEndpoint guest handshake timeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("threads connectTimeoutMs through to the AgentClient", async () => {
    const closeSpy = vi.fn();
    // Bind loses (EADDRINUSE), socket opens but the broker never answers `ready`.
    const addrInUse = Object.assign(new Error("in use"), { code: "EADDRINUSE" });
    class BusyTransport implements BridgeTransport {
      listen(): Promise<void> {
        return Promise.reject(addrInUse);
      }
      stop(): void {}
    }
    const silentSocket: AgentSocketFactory = () => ({ send() {}, close: closeSpy });

    let done = false;
    const pending = createEndpoint(
      { ...baseOpts, connectTimeoutMs: 1234 },
      {
        logger: noopLogger,
        createServerTransport: () => new BusyTransport(),
        createAgentSocket: silentSocket
      }
    ).then((e) => {
      done = true;
      return e;
    });

    await vi.advanceTimersByTimeAsync(1233);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const endpoint = await pending;
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(endpoint.mode()).toBe("electing");
    endpoint.shutdown();
  });
});
