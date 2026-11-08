import { createServer } from "node:net";
import type { Plugin } from "@opencode/plugin/effect";
import { Effect, Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

// Never touch the real per-user bridge.json.
vi.mock("../src/token-file.js", () => ({
  resolveSharedToken: (_port: number, explicit: string | undefined) => ({
    token: explicit ?? "t",
    source: "explicit"
  }),
  writeBridgeFile: vi.fn(),
  readBridgeFile: vi.fn(() => null)
}));

import { createBrowserPlugin } from "../src/opencode.js";

/** Ask the OS for a free loopback port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Resolves true when something is accepting connections on the port. */
function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once("open", () => {
      socket.terminate();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function ctxFor(options: Record<string, unknown>): Plugin.Context {
  return {
    options,
    location: { directory: "/p", project: { id: "p", directory: "/p", canonical: "/p" } },
    tool: { transform: () => Effect.succeed({ dispose: Effect.void }) }
  } as unknown as Plugin.Context;
}

async function start(port: number) {
  const plugin = createBrowserPlugin({
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
  });
  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(
    plugin.effect(ctxFor({ port, token: "tok", groups: ["page"] })).pipe(Scope.provide(scope))
  );
  return scope;
}

const stop = (scope: Scope.Closeable) => Effect.runPromise(Scope.close(scope, Effect.void));

describe("real ws bridge teardown", () => {
  const open: Scope.Closeable[] = [];
  afterEach(async () => {
    for (const scope of open.splice(0)) {
      await stop(scope);
    }
  });

  it("listens while the scope is open and releases the port when it closes", async () => {
    const port = await freePort();
    const scope = await start(port);
    open.push(scope);
    expect(await isListening(port)).toBe(true);

    await stop(scope);

    expect(await isListening(port)).toBe(false);
  });

  it("lets the next process elect itself host of the same port after a close", async () => {
    const port = await freePort();
    const first = await start(port);
    await stop(first);

    // A leaked listener would make this a guest of a zombie; a clean release
    // lets the second plugin win the bind and host.
    const second = await start(port);
    open.push(second);

    expect(await isListening(port)).toBe(true);
  });

  // KNOWN GAP (reported on the PR, deliberately not fixed here): `ws`'s
  // `WebSocketServer.close()` stops *listening* but leaves already-connected
  // sockets open, and `createNodeTransport().stop()` / `Broker.stop()` do not
  // end them. The port is released (asserted above), so the next process can
  // host, but a connected extension keeps a socket to the dead broker until it
  // notices. node-transport.ts / broker.ts are out of scope for the v2 port.
  // `it.fails` turns red the day the transport is fixed, as a prompt to make
  // this a plain assertion.
  it.fails("closes already-connected clients when the scope closes", async () => {
    const port = await freePort();
    const scope = await start(port);
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => client.once("open", resolve));
    let closed = false;
    client.once("close", () => {
      closed = true;
    });
    await stop(scope);
    await new Promise((resolve) => setTimeout(resolve, 300));
    client.terminate();
    expect(closed).toBe(true);
  });
});
