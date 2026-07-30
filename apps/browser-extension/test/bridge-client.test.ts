import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/db", () => ({ setStatus: vi.fn().mockResolvedValue(undefined) }));

import { BridgeClient, type BridgeClientDeps } from "../src/background/bridge-client";
import { setStatus } from "../src/shared/db";
import { decodeFrame, encodeFrame, PROTOCOL_VERSION } from "../src/shared/protocol";

type Handler = (e: { data?: string }) => void;

class FakeWS {
  static last: FakeWS | null = null;
  sent: string[] = [];
  closed = false;
  private readonly handlers: Record<string, Handler[]> = {};
  constructor(public url: string) {
    FakeWS.last = this;
  }
  addEventListener(type: string, fn: Handler): void {
    (this.handlers[type] ||= []).push(fn);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data?: string): void {
    for (const fn of this.handlers[type] ?? []) {
      fn({ data });
    }
  }
  lastFrame(type: string) {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const raw = this.sent[i];
      if (raw === undefined) continue;
      const f = decodeFrame(raw);
      if (f?.type === type) {
        return f;
      }
    }
    return null;
  }
}

function makeDeps(over: Partial<BridgeClientDeps> = {}): BridgeClientDeps {
  return {
    getConfig: vi.fn().mockResolvedValue({
      url: "ws://127.0.0.1:4517",
      token: "tok",
      id: "e1",
      label: "work",
      browser: "chrome"
    }),
    onCommand: vi.fn().mockResolvedValue({ ok: true }),
    onCancel: vi.fn(),
    executorKind: () => "cdp",
    clientName: "ext/chrome",
    ...over
  };
}

beforeEach(() => {
  (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
  FakeWS.last = null;
});
afterEach(() => {
  vi.clearAllMocks();
});

async function connected(deps = makeDeps()) {
  const client = new BridgeClient(deps);
  await client.connect();
  const ws = FakeWS.last as FakeWS;
  ws.emit("open");
  return { client, ws, deps };
}

describe("BridgeClient handshake", () => {
  it("sends a hello with role + identity once the socket opens", async () => {
    const { ws } = await connected();
    expect(ws.lastFrame("hello")).toMatchObject({
      type: "hello",
      token: "tok",
      role: "extension",
      id: "e1",
      label: "work",
      browser: "chrome"
    });
  });

  it("marks the status connected on ready", async () => {
    const { ws } = await connected();
    ws.emit(
      "message",
      encodeFrame({
        v: PROTOCOL_VERSION,
        type: "ready",
        server: "opencode-browser",
        protocol: PROTOCOL_VERSION
      })
    );
    await Promise.resolve();
    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "connected" }));
  });

  it("does not open a socket when no token is configured", async () => {
    const client = new BridgeClient(
      makeDeps({ getConfig: vi.fn().mockResolvedValue({ url: "ws://x", token: "" }) })
    );
    await client.connect();
    expect(FakeWS.last).toBeNull();
    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "error" }));
  });
});

describe("BridgeClient frame routing", () => {
  it("runs a command and sends back the correlated result", async () => {
    const onCommand = vi.fn().mockResolvedValue({ url: "u" });
    const { ws } = await connected(makeDeps({ onCommand }));
    ws.emit(
      "message",
      encodeFrame({
        v: PROTOCOL_VERSION,
        type: "command",
        id: "x1",
        action: "open",
        group: "g",
        params: {}
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ id: "x1", action: "open" }));
    const result = ws.lastFrame("result");
    expect(result).toMatchObject({ id: "x1", ok: true, data: { url: "u" } });
  });

  it("sends an error result when the command handler throws", async () => {
    const onCommand = vi.fn().mockRejectedValue(new Error("boom"));
    const { ws } = await connected(makeDeps({ onCommand }));
    ws.emit(
      "message",
      encodeFrame({
        v: PROTOCOL_VERSION,
        type: "command",
        id: "x2",
        action: "click",
        group: "g",
        params: {}
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(ws.lastFrame("result")).toMatchObject({ id: "x2", ok: false });
  });

  it("routes a cancel frame to onCancel", async () => {
    const onCancel = vi.fn();
    const { ws } = await connected(makeDeps({ onCancel }));
    ws.emit("message", encodeFrame({ v: PROTOCOL_VERSION, type: "cancel", id: "x3" }));
    await Promise.resolve();
    expect(onCancel).toHaveBeenCalledWith("x3");
  });

  it("answers ping with pong", async () => {
    const { ws } = await connected();
    ws.emit("message", encodeFrame({ v: PROTOCOL_VERSION, type: "ping" }));
    expect(ws.lastFrame("pong")).toMatchObject({ type: "pong" });
  });
});

describe("BridgeClient handshake rejection", () => {
  it("on a bad-token rejection shows a neutral error and retries slowly (no flood)", async () => {
    vi.useFakeTimers();
    try {
      const { ws } = await connected();
      const firstWs = ws;
      ws.emit(
        "message",
        encodeFrame({ v: PROTOCOL_VERSION, type: "rejected", reason: "bad_token" })
      );
      await Promise.resolve();
      expect(setStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          state: "error",
          lastError: expect.stringContaining("restart the host")
        })
      );
      // After the close, it must NOT hammer: well before the slow retry window
      // (which would be the every-second flood under the old backoff), no new
      // socket is opened.
      ws.emit("close");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(FakeWS.last).toBe(firstWs); // still no flood
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-recovers: keeps retrying on the slow cadence until a good host returns", async () => {
    vi.useFakeTimers();
    try {
      const { ws } = await connected();
      const firstWs = ws;
      ws.emit(
        "message",
        encodeFrame({ v: PROTOCOL_VERSION, type: "rejected", reason: "bad_token" })
      );
      ws.emit("close");
      // At the slow-retry interval it dials again on its own — no manual
      // reconnect needed. This is the auto-heal after e.g. restarting the host.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeWS.last).not.toBe(firstWs); // a fresh socket was opened
    } finally {
      vi.useRealTimers();
    }
  });

  it("a successful ready after a rejection restores fast backoff", async () => {
    vi.useFakeTimers();
    try {
      const { ws } = await connected();
      ws.emit(
        "message",
        encodeFrame({ v: PROTOCOL_VERSION, type: "rejected", reason: "bad_token" })
      );
      ws.emit("close");
      await vi.advanceTimersByTimeAsync(60_000); // slow retry dials a new socket
      const retryWs = FakeWS.last as FakeWS;
      retryWs.emit("open");
      retryWs.emit(
        "message",
        encodeFrame({
          v: PROTOCOL_VERSION,
          type: "ready",
          server: "opencode-browser",
          protocol: PROTOCOL_VERSION
        })
      );
      await Promise.resolve();
      expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "connected" }));
      // A subsequent drop now uses fast backoff (1s), not the slow reject cadence.
      retryWs.emit("close");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(FakeWS.last).not.toBe(retryWs);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a manual reconnect() (re-paste / save) dials again immediately", async () => {
    vi.useFakeTimers();
    try {
      const { client, ws } = await connected();
      ws.emit(
        "message",
        encodeFrame({ v: PROTOCOL_VERSION, type: "rejected", reason: "bad_token" })
      );
      ws.emit("close");
      const before = FakeWS.last;
      await client.reconnect(); // the dashboard "save token" path — no 60s wait
      expect(FakeWS.last).not.toBe(before); // a new socket was created at once
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("BridgeClient disconnect", () => {
  it("closes the socket and reports disconnected", async () => {
    const onDisconnected = vi.fn();
    const { client, ws } = await connected(makeDeps({ onDisconnected }));
    client.disconnect();
    expect(ws.closed).toBe(true);
    expect(onDisconnected).toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "disconnected" }));
  });
});
