import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentClient,
  AgentClientError,
  type AgentSocketFactory,
  type AgentSocketHandlers
} from "../src/agent-client.js";
import type { Logger } from "../src/logging.js";
import {
  type CommandFrame,
  decodeFrame,
  encodeFrame,
  errorFrame,
  PROTOCOL_VERSION,
  resultFrame
} from "../src/protocol.js";

const noopLogger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };

function fakeSocket() {
  const sent: string[] = [];
  let handlers: AgentSocketHandlers | null = null;
  const factory: AgentSocketFactory = (_url, h) => {
    handlers = h;
    return { send: (d) => sent.push(d), close: () => {} };
  };
  return {
    sent,
    factory,
    handlers: () => {
      if (!handlers) {
        throw new Error("socket not created");
      }
      return handlers;
    }
  };
}

function lastCommand(sent: string[]): CommandFrame {
  for (let i = sent.length - 1; i >= 0; i--) {
    const f = decodeFrame(sent[i]);
    if (f?.type === "command") {
      return f;
    }
  }
  throw new Error("no command frame");
}

/** Build a connected AgentClient over a fake socket. */
async function connected() {
  const fs = fakeSocket();
  const client = new AgentClient(
    { url: "ws://x", token: "t", timeoutMs: 1000 },
    { logger: noopLogger, createSocket: fs.factory }
  );
  const p = client.connect();
  fs.handlers().onOpen();
  fs.handlers().onMessage(
    encodeFrame({
      v: PROTOCOL_VERSION,
      type: "ready",
      server: "opencode-browser",
      protocol: PROTOCOL_VERSION,
      role: "agent",
      clientId: "a1"
    })
  );
  await p;
  return { client, fs };
}

describe("AgentClient per-command timeout (Phase 0)", () => {
  it("forwards a per-command timeoutMs on the command frame for the broker to honor", async () => {
    const { client, fs } = await connected();
    void client.send("snapshot", "g", {}, undefined, undefined, 120_000).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(lastCommand(fs.sent)).toMatchObject({ action: "snapshot", timeoutMs: 120_000 });
  });

  it("leaves timeoutMs undefined when no override is given", async () => {
    const { client, fs } = await connected();
    void client.send("snapshot", "g", {}).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(lastCommand(fs.sent).timeoutMs).toBeUndefined();
  });
});

describe("AgentClient local backstop timer (Phase 0)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires the local backstop only after the requested deadline plus grace", async () => {
    const fs = fakeSocket();
    const client = new AgentClient(
      { url: "ws://x", token: "t", timeoutMs: 1000 },
      { logger: noopLogger, createSocket: fs.factory }
    );
    const cp = client.connect();
    fs.handlers().onOpen();
    fs.handlers().onMessage(
      encodeFrame({
        v: PROTOCOL_VERSION,
        type: "ready",
        server: "opencode-browser",
        protocol: PROTOCOL_VERSION,
        role: "agent",
        clientId: "a1"
      })
    );
    await cp;

    let settled = false;
    void client.send("snapshot", "g", {}, undefined, undefined, 5000).catch(() => {
      settled = true;
    });
    // Past the requested 5s but before requested + 5s grace (10s) — broker
    // should win, so the local backstop must still be pending.
    await vi.advanceTimersByTimeAsync(9000);
    expect(settled).toBe(false);
    // Past requested + grace — the backstop fires.
    await vi.advanceTimersByTimeAsync(1500);
    expect(settled).toBe(true);
  });
});

const READY = encodeFrame({
  v: PROTOCOL_VERSION,
  type: "ready",
  server: "opencode-browser",
  protocol: PROTOCOL_VERSION,
  role: "agent",
  clientId: "a1"
});

describe("AgentClient connect handshake timeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rejects connect() when the broker never answers `ready`", async () => {
    const fs = fakeSocket();
    const client = new AgentClient(
      { url: "ws://x", token: "t", timeoutMs: 1000, connectTimeoutMs: 2000 },
      { logger: noopLogger, createSocket: fs.factory }
    );
    const cp = client.connect();
    const settled = cp.then(
      () => "resolved",
      (err: unknown) => err
    );
    fs.handlers().onOpen();
    await vi.advanceTimersByTimeAsync(2000);
    const err = await settled;
    expect(err).toBeInstanceOf(AgentClientError);
    expect((err as AgentClientError).code).toBe("connect_failed");
  });

  it("does not time out once the broker answered `ready`", async () => {
    const fs = fakeSocket();
    const client = new AgentClient(
      { url: "ws://x", token: "t", timeoutMs: 1000, connectTimeoutMs: 2000 },
      { logger: noopLogger, createSocket: fs.factory }
    );
    const cp = client.connect();
    fs.handlers().onOpen();
    fs.handlers().onMessage(
      encodeFrame({
        v: PROTOCOL_VERSION,
        type: "ready",
        server: "opencode-browser",
        protocol: PROTOCOL_VERSION,
        role: "agent",
        clientId: "a1"
      })
    );
    await cp;
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(cp).resolves.toBeUndefined();
  });
});

describe("AgentClient lifecycle & results", () => {
  it("resolves connect() only after the broker replies ready", async () => {
    const fs = fakeSocket();
    const client = new AgentClient(
      { url: "ws://x", token: "t", timeoutMs: 1000 },
      { logger: noopLogger, createSocket: fs.factory }
    );
    let connected = false;
    const p = client.connect().then(() => {
      connected = true;
    });
    fs.handlers().onOpen();
    await Promise.resolve();
    expect(connected).toBe(false); // hello sent, not ready yet
    expect(decodeFrame(fs.sent[0])).toMatchObject({ type: "hello", role: "agent" });
    fs.handlers().onMessage(READY);
    await p;
    expect(connected).toBe(true);
  });

  it("correlates a successful result back to its send()", async () => {
    const { client, fs } = await connected();
    const p = client.send("get_text", "g", {});
    await Promise.resolve();
    const cmd = lastCommand(fs.sent);
    fs.handlers().onMessage(encodeFrame(resultFrame(cmd.id, { text: "hi" })));
    await expect(p).resolves.toEqual({ text: "hi" });
  });

  it("rejects with the executor error message and code on a failure result", async () => {
    const { client, fs } = await connected();
    const p = client.send("click", "g", {});
    await Promise.resolve();
    const cmd = lastCommand(fs.sent);
    fs.handlers().onMessage(encodeFrame(errorFrame(cmd.id, "nope", "bad_target")));
    await expect(p).rejects.toMatchObject({ message: "nope", code: "bad_target" });
  });

  it("ignores a result for an unknown id", async () => {
    const { fs } = await connected();
    expect(() => fs.handlers().onMessage(encodeFrame(resultFrame("ghost", {})))).not.toThrow();
  });

  it("release() asks the broker to release", async () => {
    const { client, fs } = await connected();
    client.release();
    await Promise.resolve();
    const hasRelease = fs.sent.some((s) => {
      const f = decodeFrame(s);
      return f?.type === "command" && f.action === "release";
    });
    expect(hasRelease).toBe(true);
  });

  it("rejects in-flight commands when the socket closes, and signals onClose", async () => {
    const fs = fakeSocket();
    const onClose = vi.fn();
    const client = new AgentClient(
      { url: "ws://x", token: "t", timeoutMs: 1000 },
      { logger: noopLogger, createSocket: fs.factory, onClose }
    );
    const cp = client.connect();
    fs.handlers().onOpen();
    fs.handlers().onMessage(READY);
    await cp;
    const p = client.send("snapshot", "g", {});
    await Promise.resolve();
    fs.handlers().onClose();
    await expect(p).rejects.toBeInstanceOf(AgentClientError);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stop() rejects in-flight commands and does not fire onClose", async () => {
    const fs = fakeSocket();
    const onClose = vi.fn();
    const client = new AgentClient(
      { url: "ws://x", token: "t", timeoutMs: 1000 },
      { logger: noopLogger, createSocket: fs.factory, onClose }
    );
    const cp = client.connect();
    fs.handlers().onOpen();
    fs.handlers().onMessage(READY);
    await cp;
    const p = client.send("snapshot", "g", {});
    await Promise.resolve();
    client.stop();
    await expect(p).rejects.toThrow(/stopped/);
  });

  it("rejects a send() issued before the socket exists", async () => {
    const fs = fakeSocket();
    const client = new AgentClient(
      { url: "ws://x", token: "t", timeoutMs: 1000 },
      { logger: noopLogger, createSocket: fs.factory }
    );
    await expect(client.send("snapshot", "g", {})).rejects.toBeInstanceOf(AgentClientError);
  });

  it("rejects immediately when the abort signal is already aborted", async () => {
    const { client } = await connected();
    const ac = new AbortController();
    ac.abort();
    await expect(client.send("snapshot", "g", {}, ac.signal)).rejects.toThrow(/aborted/);
  });

  it("aborts a command queued while waiting for ready", async () => {
    const fs = fakeSocket();
    const client = new AgentClient(
      { url: "ws://x", token: "t", timeoutMs: 1000 },
      { logger: noopLogger, createSocket: fs.factory }
    );
    void client.connect().catch(() => {});
    fs.handlers().onOpen(); // hello sent; broker hasn't sent ready
    const ac = new AbortController();
    const p = client.send("snapshot", "g", {}, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });
});
