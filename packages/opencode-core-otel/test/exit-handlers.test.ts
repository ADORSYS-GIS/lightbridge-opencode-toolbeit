import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { deferredAttribute } from "../src/deferred.js";
import {
  DEFAULT_SHUTDOWN_DEADLINE_MS,
  type ExitProcessLike,
  type ExitSignal,
  type ExitTimers,
  registerExitHandlers
} from "../src/exit-handlers.js";
import type { TelemetryProviders } from "../src/providers.js";
import { silentLogger } from "./helpers.js";

/** A stand-in for `process`: real EventEmitter semantics, a recorded `kill`. */
class FakeProcess extends EventEmitter implements ExitProcessLike {
  readonly pid = 4242;
  readonly kills: Array<{ pid: number; signal: ExitSignal }> = [];
  killImpl: () => void = () => {};

  override listeners(event: string | symbol): Array<(...args: never[]) => void> {
    return super.listeners(event) as Array<(...args: never[]) => void>;
  }

  kill(pid: number, signal: ExitSignal): boolean {
    this.kills.push({ pid, signal });
    this.killImpl();
    return true;
  }
}

/** Manually-driven deadline timers. */
class FakeTimers implements ExitTimers {
  private nextId = 1;
  readonly active = new Map<number, { callback: () => void; ms: number }>();
  readonly cleared: number[] = [];

  set(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.active.set(id, { callback, ms });
    return id;
  }

  clear(handle: unknown): void {
    this.cleared.push(handle as number);
    this.active.delete(handle as number);
  }

  /** Let every outstanding deadline expire. */
  expire(): void {
    for (const [id, timer] of [...this.active]) {
      this.active.delete(id);
      timer.callback();
    }
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks and immediates run, without touching the fake timers. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface FakeProviders extends Pick<TelemetryProviders, "forceFlush" | "shutdown"> {
  forceFlush: ReturnType<typeof vi.fn<() => Promise<void>>>;
  shutdown: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function makeProviders(
  overrides: { shutdown?: () => Promise<void>; forceFlush?: () => Promise<void> } = {}
): FakeProviders {
  return {
    forceFlush: vi.fn(overrides.forceFlush ?? (() => Promise.resolve())),
    shutdown: vi.fn(overrides.shutdown ?? (() => Promise.resolve()))
  };
}

function setup(providers: FakeProviders = makeProviders()) {
  const host = new FakeProcess();
  const timers = new FakeTimers();
  const logger = silentLogger();
  const attribute = deferredAttribute(60_000, (() => 0) as unknown as typeof setTimeout);
  const abandon = vi.spyOn(attribute, "abandon");
  const stop = registerExitHandlers(providers, logger, [attribute], {
    eventPrefix: "test",
    host,
    timers
  });
  return { host, timers, logger, providers, abandon, stop };
}

const events = (logger: ReturnType<typeof silentLogger>): string[] =>
  logger.events.map(([name]) => name);

function listenerTotals(host: FakeProcess): Record<string, number> {
  return {
    beforeExit: host.listenerCount("beforeExit"),
    SIGINT: host.listenerCount("SIGINT"),
    SIGTERM: host.listenerCount("SIGTERM")
  };
}

describe("registerExitHandlers — registration", () => {
  it("installs one listener per exit event and nothing else", () => {
    const { host } = setup();
    expect(listenerTotals(host)).toEqual({ beforeExit: 1, SIGINT: 1, SIGTERM: 1 });
  });

  it("returns a disposer that withdraws every listener and any in-flight deadline", async () => {
    const providers = makeProviders({ shutdown: () => new Promise(() => {}) });
    const { host, timers, stop } = setup(providers);
    host.emit("SIGTERM");
    expect(timers.active.size).toBe(1);

    stop();

    expect(listenerTotals(host)).toEqual({ beforeExit: 0, SIGINT: 0, SIGTERM: 0 });
    expect(timers.active.size).toBe(0);
    host.emit("SIGTERM"); // nothing is listening any more
    await flush();
    expect(host.kills).toEqual([]);
  });

  it("defaults to the real process and real timers", async () => {
    const before = {
      beforeExit: process.listenerCount("beforeExit"),
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM")
    };
    const stop = registerExitHandlers(makeProviders(), silentLogger(), [], {
      eventPrefix: "test"
    });
    expect(process.listenerCount("beforeExit")).toBe(before.beforeExit + 1);
    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM + 1);
    stop();
    expect(process.listenerCount("beforeExit")).toBe(before.beforeExit);
    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
  });

  it("falls back to the real timers for the deadline", async () => {
    const providers = makeProviders({ shutdown: () => new Promise(() => {}) });
    const host = new FakeProcess();
    const logger = silentLogger();
    registerExitHandlers(providers, logger, [], { eventPrefix: "test", host, deadlineMs: 5 });
    host.emit("SIGTERM");
    await vi.waitFor(() => expect(host.kills).toHaveLength(1));
    expect(events(logger)).toContain("debug:test_shutdown_deadline_exceeded");
  });

  it("exposes the default deadline the plugins rely on", () => {
    expect(DEFAULT_SHUTDOWN_DEADLINE_MS).toBe(2_000);
    const { timers, host } = setup(makeProviders({ shutdown: () => new Promise(() => {}) }));
    host.emit("SIGTERM");
    expect([...timers.active.values()].map((timer) => timer.ms)).toEqual([2_000]);
  });
});

describe("registerExitHandlers — beforeExit", () => {
  it("drains exactly once and never kills", async () => {
    const { host, providers, abandon } = setup();
    host.emit("beforeExit", 0);
    host.emit("beforeExit", 0); // `once`: the second emit finds no listener
    await flush();

    expect(providers.shutdown).toHaveBeenCalledTimes(1);
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(providers.forceFlush).not.toHaveBeenCalled();
    expect(host.kills).toEqual([]);
    expect(host.listenerCount("beforeExit")).toBe(0);
  });

  it("settles the deferred attributes before it shuts down", async () => {
    const order: string[] = [];
    const attribute = deferredAttribute(60_000, (() => 0) as unknown as typeof setTimeout);
    vi.spyOn(attribute, "abandon").mockImplementation(() => order.push("abandon"));
    const providers = makeProviders({
      shutdown: () => {
        order.push("shutdown");
        return Promise.resolve();
      }
    });
    const host = new FakeProcess();
    registerExitHandlers(providers, silentLogger(), [attribute], { eventPrefix: "test", host });
    host.emit("beforeExit", 0);
    expect(order).toEqual(["abandon", "shutdown"]);
  });

  it("logs a failed shutdown under the caller's prefix and does not throw", async () => {
    const providers = makeProviders({
      shutdown: () => Promise.reject(new Error("collector down"))
    });
    const { host, logger } = setup(providers);
    host.emit("beforeExit", 0);
    await flush();
    expect(logger.events).toContainEqual([
      "warn:test_shutdown_failed",
      { error: "collector down" }
    ]);
  });

  it("survives a shutdown that throws synchronously", async () => {
    const providers = makeProviders({
      shutdown: () => {
        throw new Error("sync boom");
      }
    });
    const { host, logger } = setup(providers);
    host.emit("beforeExit", 0);
    await flush();
    expect(logger.events).toContainEqual(["warn:test_shutdown_failed", { error: "sync boom" }]);
  });
});

describe("registerExitHandlers — we are the only listener (shutdown and re-raise)", () => {
  it("drains once, then re-raises the same signal after shutdown resolves", async () => {
    const shutdown = deferred();
    const { host, providers, abandon, logger } = setup(
      makeProviders({ shutdown: () => shutdown.promise })
    );

    host.emit("SIGTERM");
    await flush();
    expect(providers.shutdown).toHaveBeenCalledTimes(1);
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(host.kills).toEqual([]); // still draining: do not kill the final export

    shutdown.resolve();
    await flush();

    expect(host.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(providers.forceFlush).not.toHaveBeenCalled();
    // Our listeners are gone, so the re-raised signal hits the default action.
    expect(listenerTotals(host)).toEqual({ beforeExit: 0, SIGINT: 0, SIGTERM: 0 });
    expect(events(logger)).toContain("debug:test_exit_reraised");
  });

  it("re-raises SIGINT as SIGINT", async () => {
    const { host } = setup();
    host.emit("SIGINT");
    await flush();
    expect(host.kills).toEqual([{ pid: 4242, signal: "SIGINT" }]);
  });

  it("re-raises once the deadline passes if shutdown hangs", async () => {
    const { host, timers, logger } = setup(
      makeProviders({ shutdown: () => new Promise(() => {}) })
    );

    host.emit("SIGTERM");
    await flush();
    expect(host.kills).toEqual([]);

    timers.expire();
    await flush();

    expect(host.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(logger.events).toContainEqual([
      "debug:test_shutdown_deadline_exceeded",
      { signal: "SIGTERM", deadlineMs: 2_000 }
    ]);
  });

  it("clears the deadline timer when shutdown wins the race", async () => {
    const { host, timers } = setup();
    host.emit("SIGTERM");
    await flush();
    expect(timers.cleared).toHaveLength(1);
    expect(timers.active.size).toBe(0);
  });

  it("still re-raises when shutdown fails", async () => {
    const providers = makeProviders({ shutdown: () => Promise.reject(new Error("boom")) });
    const { host, logger } = setup(providers);
    host.emit("SIGTERM");
    await flush();
    expect(host.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(events(logger)).toContain("warn:test_shutdown_failed");
  });

  it("re-raises immediately on a second signal while still draining", async () => {
    const { host, timers, providers } = setup(
      makeProviders({ shutdown: () => new Promise(() => {}) })
    );

    host.emit("SIGINT");
    await flush();
    expect(host.kills).toEqual([]);

    host.emit("SIGINT"); // the user is insisting
    expect(host.kills).toEqual([{ pid: 4242, signal: "SIGINT" }]);
    expect(providers.shutdown).toHaveBeenCalledTimes(1); // no second drain
    expect(listenerTotals(host)).toEqual({ beforeExit: 0, SIGINT: 0, SIGTERM: 0 });

    // The abandoned deadline must not fire a second kill.
    expect(timers.active.size).toBe(0);
    timers.expire();
    await flush();
    expect(host.kills).toHaveLength(1);
  });

  it("starts only one drain for a burst of different signals", async () => {
    const shutdown = deferred();
    const { host, providers } = setup(makeProviders({ shutdown: () => shutdown.promise }));
    host.emit("SIGTERM");
    host.emit("SIGINT"); // second signal while draining → insists; still no second drain
    await flush();
    expect(providers.shutdown).toHaveBeenCalledTimes(1);
    expect(host.kills).toEqual([{ pid: 4242, signal: "SIGINT" }]);
  });

  it("re-raises right away if an earlier beforeExit already shut everything down", async () => {
    const { host, providers } = setup();
    host.emit("beforeExit", 0);
    await flush();
    host.emit("SIGTERM");
    await flush();
    expect(providers.shutdown).toHaveBeenCalledTimes(1);
    expect(host.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  it("logs, and does not throw, when the re-raise itself fails", async () => {
    const { host, logger } = setup();
    host.killImpl = () => {
      throw new Error("EPERM");
    };
    host.emit("SIGTERM");
    await flush();
    expect(logger.events).toContainEqual([
      "warn:test_exit_reraise_failed",
      { signal: "SIGTERM", error: "EPERM" }
    ]);
  });

  it("does not re-raise if a host handler appears while it is draining", async () => {
    const shutdown = deferred();
    const { host, logger } = setup(makeProviders({ shutdown: () => shutdown.promise }));

    host.emit("SIGTERM");
    await flush();
    host.on("SIGTERM", () => {}); // the host takes the signal over mid-drain
    shutdown.resolve();
    await flush();

    expect(host.kills).toEqual([]);
    expect(events(logger)).toContain("debug:test_exit_deferred_to_host");
    expect(host.listenerCount("SIGTERM")).toBe(2); // ours stays registered
  });

  it("leaves a repeated signal to the host if it took the signal over mid-drain", async () => {
    const { host } = setup(makeProviders({ shutdown: () => new Promise(() => {}) }));
    host.emit("SIGTERM");
    await flush();
    host.on("SIGTERM", () => {});
    host.emit("SIGTERM");
    expect(host.kills).toEqual([]); // the host's handler decides, not us
  });
});

describe("registerExitHandlers — the host owns the signal (flush only)", () => {
  it("flushes without shutting down, keeps its listener, and never kills", async () => {
    const { host, providers, abandon, logger } = setup();
    const hostHandler = vi.fn();
    host.on("SIGINT", hostHandler);

    host.emit("SIGINT");
    await flush();

    expect(hostHandler).toHaveBeenCalledTimes(1);
    expect(providers.forceFlush).toHaveBeenCalledTimes(1);
    expect(providers.shutdown).not.toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled(); // abandoning is permanent; we may live on
    expect(host.kills).toEqual([]);
    expect(host.listenerCount("SIGINT")).toBe(2); // ours is still registered
    expect(logger.events).toContainEqual([
      "debug:test_exit_deferred_to_host",
      { signal: "SIGINT", listeners: 1 }
    ]);
  });

  it("bounds the flush with the deadline and keeps going afterwards", async () => {
    const providers = makeProviders({ forceFlush: () => new Promise(() => {}) });
    const { host, timers, logger } = setup(providers);
    host.on("SIGINT", () => {});

    host.emit("SIGINT");
    await flush();
    timers.expire();
    await flush();

    expect(logger.events).toContainEqual([
      "debug:test_flush_deadline_exceeded",
      { signal: "SIGINT", deadlineMs: 2_000 }
    ]);
    expect(host.kills).toEqual([]);

    // Back to idle: a later signal flushes again.
    host.emit("SIGINT");
    await flush();
    expect(providers.forceFlush).toHaveBeenCalledTimes(2);
  });

  it("starts one flush per burst of signals", async () => {
    const flushDone = deferred();
    const providers = makeProviders({ forceFlush: () => flushDone.promise });
    const { host } = setup(providers);
    host.on("SIGINT", () => {});

    host.emit("SIGINT");
    host.emit("SIGINT");
    host.emit("SIGINT");
    expect(providers.forceFlush).toHaveBeenCalledTimes(1);

    flushDone.resolve();
    await flush();
    host.emit("SIGINT"); // the burst is over
    expect(providers.forceFlush).toHaveBeenCalledTimes(2);
  });

  it("logs a failed flush and survives it", async () => {
    const providers = makeProviders({ forceFlush: () => Promise.reject(new Error("flush boom")) });
    const { host, logger } = setup(providers);
    host.on("SIGTERM", () => {});

    host.emit("SIGTERM");
    await flush();

    expect(logger.events).toContainEqual([
      "warn:test_flush_failed",
      { signal: "SIGTERM", error: "flush boom" }
    ]);
    expect(host.kills).toEqual([]);
  });

  it("survives a flush that throws synchronously", async () => {
    const providers = makeProviders({
      forceFlush: () => {
        throw new Error("sync flush");
      }
    });
    const { host, logger } = setup(providers);
    host.on("SIGTERM", () => {});
    host.emit("SIGTERM");
    await flush();
    expect(logger.events).toContainEqual([
      "warn:test_flush_failed",
      { signal: "SIGTERM", error: "sync flush" }
    ]);
  });

  it("takes the shutdown and re-raise path once the host has removed its handler", async () => {
    const { host, providers, logger } = setup();
    const hostHandler = vi.fn();
    host.on("SIGINT", hostHandler);

    host.emit("SIGINT"); // the host ignores it (e.g. an editor is open): flush only
    await flush();
    expect(providers.forceFlush).toHaveBeenCalledTimes(1);
    expect(providers.shutdown).not.toHaveBeenCalled();
    expect(host.kills).toEqual([]);

    host.removeListener("SIGINT", hostHandler); // the host lets go of the signal
    host.emit("SIGINT");
    await flush();

    expect(providers.shutdown).toHaveBeenCalledTimes(1);
    expect(host.kills).toEqual([{ pid: 4242, signal: "SIGINT" }]);
    expect(events(logger)).toContain("debug:test_exit_reraised");
    expect(listenerTotals(host)).toEqual({ beforeExit: 0, SIGINT: 0, SIGTERM: 0 });
  });

  it("supersedes an in-flight flush with a drain once the host lets go", async () => {
    const providers = makeProviders({ forceFlush: () => new Promise(() => {}) });
    const { host } = setup(providers);
    const hostHandler = vi.fn();
    host.on("SIGINT", hostHandler);

    host.emit("SIGINT"); // flush hangs
    await flush();
    host.removeListener("SIGINT", hostHandler);
    host.emit("SIGINT"); // now we are alone: shut down and re-raise
    await flush();

    expect(providers.shutdown).toHaveBeenCalledTimes(1);
    expect(host.kills).toEqual([{ pid: 4242, signal: "SIGINT" }]);
  });

  it("does not flush a provider that an earlier beforeExit already shut down", async () => {
    const { host, providers } = setup();
    host.on("SIGINT", () => {});
    host.emit("beforeExit", 0);
    await flush();

    host.emit("SIGINT");
    await flush();

    expect(providers.forceFlush).not.toHaveBeenCalled();
    expect(providers.shutdown).toHaveBeenCalledTimes(1);
    expect(host.kills).toEqual([]);
  });

  it("treats a handler for the OTHER signal as no owner", async () => {
    const { host, providers } = setup();
    host.on("SIGINT", () => {}); // the host handles Ctrl-C only
    host.emit("SIGTERM");
    await flush();
    expect(providers.shutdown).toHaveBeenCalledTimes(1);
    expect(host.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });
});

describe("registerExitHandlers — several registrations in one process", () => {
  function setupTwo(first: FakeProviders, second: FakeProviders) {
    const host = new FakeProcess();
    const timers = new FakeTimers();
    const logger = silentLogger();
    const options = { eventPrefix: "test", host, timers };
    registerExitHandlers(first, logger, [], options);
    registerExitHandlers(second, logger, [], options);
    return { host, timers, logger };
  }

  it("does not mistake its siblings for the host, and kills only after all have drained", async () => {
    const firstDone = deferred();
    const secondDone = deferred();
    const first = makeProviders({ shutdown: () => firstDone.promise });
    const second = makeProviders({ shutdown: () => secondDone.promise });
    const { host } = setupTwo(first, second);
    expect(host.listenerCount("SIGTERM")).toBe(2);

    host.emit("SIGTERM");
    await flush();
    expect(first.shutdown).toHaveBeenCalledTimes(1);
    expect(second.shutdown).toHaveBeenCalledTimes(1);
    expect(first.forceFlush).not.toHaveBeenCalled();

    firstDone.resolve(); // one finished, the other is still flushing its last batch
    await flush();
    expect(host.kills).toEqual([]);

    secondDone.resolve();
    await flush();
    expect(host.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(listenerTotals(host)).toEqual({ beforeExit: 0, SIGINT: 0, SIGTERM: 0 });
  });

  it("kills exactly once when the second to finish is the first to have started", async () => {
    const firstDone = deferred();
    const first = makeProviders({ shutdown: () => firstDone.promise });
    const second = makeProviders();
    const { host } = setupTwo(first, second);

    host.emit("SIGINT");
    await flush();
    expect(host.kills).toEqual([]); // the first registration is still draining
    firstDone.resolve();
    await flush();
    expect(host.kills).toEqual([{ pid: 4242, signal: "SIGINT" }]);
  });

  it("a second signal ends the whole group at once, exactly one kill", async () => {
    const first = makeProviders({ shutdown: () => new Promise(() => {}) });
    const second = makeProviders({ shutdown: () => new Promise(() => {}) });
    const { host, timers } = setupTwo(first, second);

    host.emit("SIGTERM");
    await flush();
    host.emit("SIGTERM");

    expect(host.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(listenerTotals(host)).toEqual({ beforeExit: 0, SIGINT: 0, SIGTERM: 0 });
    expect(timers.active.size).toBe(0);
  });

  it("both flush (and neither shuts down) when a real host listener is present", async () => {
    const first = makeProviders();
    const second = makeProviders();
    const { host } = setupTwo(first, second);
    host.on("SIGINT", () => {});

    host.emit("SIGINT");
    await flush();

    expect(first.forceFlush).toHaveBeenCalledTimes(1);
    expect(second.forceFlush).toHaveBeenCalledTimes(1);
    expect(first.shutdown).not.toHaveBeenCalled();
    expect(second.shutdown).not.toHaveBeenCalled();
    expect(host.kills).toEqual([]);
  });
});
