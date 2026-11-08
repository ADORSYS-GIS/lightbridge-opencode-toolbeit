import type { DeferredAttribute } from "./deferred.js";
import type { Logger } from "./logging.js";
import { describeError, type TelemetryProviders } from "./providers.js";

/**
 * Process-exit draining for the OTel plugins, shared by `@vymalo/opencode-otel`
 * and `@vymalo/opencode-lightbridge` ([ADR-0018](../../../docs/adr/0018-exit-handlers-reraise-the-signal.md)).
 *
 * Why this is more than "flush on exit": the plugin API has no dispose hook that
 * runs on a signal, so buffered telemetry is only saved by listening for the
 * signal ourselves. But installing a SIGINT/SIGTERM listener **replaces the
 * runtime's default action** (terminate). A listener that drains and then
 * returns leaves the process alive — `opencode serve` ignored SIGTERM in 15/15
 * measured runs and needed SIGKILL. So a handler that was the only thing
 * overriding the default has to give the default back: flush, remove itself,
 * and re-raise the same signal so the process ends with the right status.
 *
 * Who owns the signal decides what we do:
 *
 * - **Nobody else listens** — we are the sole override. Shut the providers down
 *   (bounded), remove our listeners, re-raise the signal.
 * - **The host listens** (e.g. `opencode run`'s footer handles SIGINT and may
 *   ignore it while an editor is open) — a signal does not mean the process is
 *   ending. Only flush (bounded), keep the providers alive and our listener
 *   registered, and never kill: the host owns shutdown.
 *
 * Nothing here writes to the terminal (ADR-0014); outcomes are logged at debug.
 */

/** Signals whose default "terminate" action our listeners would otherwise replace. */
export type ExitSignal = "SIGINT" | "SIGTERM";

/** How long a signal-driven shutdown/flush may take before we stop waiting. */
export const DEFAULT_SHUTDOWN_DEADLINE_MS = 2_000;

const EXIT_SIGNALS: readonly ExitSignal[] = ["SIGINT", "SIGTERM"];

/**
 * The slice of `process` the handlers use, injectable so tests never signal (or
 * kill) the test runner. `NodeJS.Process` satisfies it.
 */
export interface ExitProcessLike {
  readonly pid: number;
  on(event: ExitSignal, listener: () => void): unknown;
  once(event: "beforeExit", listener: () => void): unknown;
  removeListener(event: ExitSignal | "beforeExit", listener: () => void): unknown;
  listeners(event: ExitSignal): readonly object[];
  kill(pid: number, signal: ExitSignal): unknown;
}

/** Injectable timer pair (the deadline), so tests control time. */
export interface ExitTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ExitHandlerOptions {
  /**
   * Prefix for every event this registers, so the log stream says which plugin
   * emitted it: `otel` → `otel_shutdown_failed`, `otel_exit_reraised`, …
   */
  eventPrefix: string;
  /** Bound on a signal-driven shutdown or flush. Default {@link DEFAULT_SHUTDOWN_DEADLINE_MS}. */
  deadlineMs?: number;
  /** Defaults to the real `process`. */
  host?: ExitProcessLike;
  /** Defaults to `setTimeout`/`clearTimeout`. */
  timers?: ExitTimers;
}

/**
 * One registration, seen by its siblings. Hosts can load a plugin more than once
 * per process (one instance per project directory, or two plugins from this
 * suite side by side), and each registration sees the others' listeners on the
 * signal. Without this tag they would all read as "the host owns it", and no
 * registration would ever hand the default action back.
 */
interface GroupMember {
  /** A shutdown-and-reraise is in flight. */
  pending(): boolean;
  /** Withdraw every listener and timer; the group is exiting. */
  stop(): void;
}

const GROUP_MEMBER = Symbol.for("@vymalo/opencode-core-otel/exit-handler");

function memberOf(listener: object): GroupMember | undefined {
  const member = Reflect.get(listener, GROUP_MEMBER) as Partial<GroupMember> | undefined;
  return typeof member?.pending === "function" && typeof member.stop === "function"
    ? (member as GroupMember)
    : undefined;
}

const realTimers: ExitTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

type Phase = "idle" | "flushing" | "draining" | "done";
type Outcome = "done" | "deadline";

/**
 * Register the drain. Returns a function that withdraws every listener this
 * registered (plugins ignore it; tests use it for cleanup).
 */
export function registerExitHandlers(
  providers: Pick<TelemetryProviders, "forceFlush" | "shutdown">,
  logger: Logger,
  deferred: readonly DeferredAttribute[],
  options: ExitHandlerOptions
): () => void {
  const host = options.host ?? process;
  const timers = options.timers ?? realTimers;
  const deadlineMs = Math.max(0, options.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS);
  const event = (name: string): string => `${options.eventPrefix}_${name}`;

  let phase: Phase = "idle";
  let shutdownPromise: Promise<void> | undefined;
  const pendingTimers = new Set<unknown>();

  // Shut the providers down exactly once, however many exits ask. Settle any
  // still-pending resource attribute first: exporters await those promises and
  // their timers are `unref`'d, so on `beforeExit` the timer may never fire and
  // the shutdown would hang, losing everything buffered.
  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      for (const attribute of deferred) {
        attribute.abandon();
      }
      shutdownPromise = new Promise<void>((resolve) => resolve(providers.shutdown())).catch(
        (error) => {
          logger.warn(event("shutdown_failed"), { error: describeError(error) });
        }
      );
    }
    return shutdownPromise;
  };

  // Never wait on telemetry longer than the deadline: a hung collector must not
  // turn "exit on SIGTERM" back into "needs SIGKILL". `work` never rejects.
  const settle = async (work: Promise<void>): Promise<Outcome> => {
    let handle: unknown;
    const outcome = await new Promise<Outcome>((resolve) => {
      handle = timers.set(() => resolve("deadline"), deadlineMs);
      pendingTimers.add(handle);
      void work.then(() => resolve("done"));
    });
    timers.clear(handle);
    pendingTimers.delete(handle);
    return outcome;
  };

  // Who else listens for this signal. `foreign` = the host or another plugin;
  // `peers` = other registrations of this very module.
  const survey = (signal: ExitSignal): { foreign: number; peers: GroupMember[] } => {
    const others = host.listeners(signal).filter((listener) => listener !== handlers[signal]);
    const peers = others.flatMap((listener) => memberOf(listener) ?? []);
    return { foreign: others.length - peers.length, peers };
  };

  const stop = (): void => {
    phase = "done";
    for (const handle of pendingTimers) {
      timers.clear(handle);
    }
    pendingTimers.clear();
    host.removeListener("beforeExit", onBeforeExit);
    for (const signal of EXIT_SIGNALS) {
      host.removeListener(signal, handlers[signal]);
    }
  };

  // Give the default action back: withdraw our listeners (and our siblings') so
  // nothing overrides it, then raise the very signal we received.
  const reraise = (signal: ExitSignal, peers: readonly GroupMember[]): void => {
    for (const peer of peers) {
      peer.stop();
    }
    stop();
    logger.debug(event("exit_reraised"), { signal });
    try {
      host.kill(host.pid, signal);
    } catch (error) {
      logger.warn(event("exit_reraise_failed"), { signal, error: describeError(error) });
    }
  };

  // The host owns the signal: it may be about to exit or may ignore it. Flush
  // what is buffered, keep everything alive, and never kill. Deferred
  // attributes are deliberately left alone — abandoning them is permanent, and
  // the deadline already bounds a flush that waits on one.
  const flushForHost = (signal: ExitSignal, listeners: number): void => {
    if (phase === "flushing") {
      return; // one flush per burst of signals
    }
    phase = "flushing";
    logger.debug(event("exit_deferred_to_host"), { signal, listeners });
    const work = shutdownPromise
      ? Promise.resolve() // already torn down (an earlier beforeExit); nothing left to flush
      : new Promise<void>((resolve) => resolve(providers.forceFlush())).catch((error) => {
          logger.warn(event("flush_failed"), { signal, error: describeError(error) });
        });
    void settle(work).then((outcome) => {
      if (phase !== "flushing") {
        return; // superseded by a drain, or withdrawn
      }
      if (outcome === "deadline") {
        logger.debug(event("flush_deadline_exceeded"), { signal, deadlineMs });
      }
      phase = "idle";
    });
  };

  const beginDrain = (signal: ExitSignal): void => {
    phase = "draining";
    void settle(shutdown()).then((outcome) => {
      if (phase !== "draining") {
        return; // a repeated signal or a sibling already ended it
      }
      if (outcome === "deadline") {
        logger.debug(event("shutdown_deadline_exceeded"), { signal, deadlineMs });
      }
      const { foreign, peers } = survey(signal);
      if (foreign > 0) {
        // A host handler appeared while we were draining: it owns the signal now.
        phase = "idle";
        logger.debug(event("exit_deferred_to_host"), { signal, listeners: foreign });
        return;
      }
      if (peers.some((peer) => peer.pending())) {
        // A sibling is still flushing; the last one to finish re-raises.
        phase = "idle";
        return;
      }
      reraise(signal, peers);
    });
  };

  const handleSignal = (signal: ExitSignal): void => {
    if (phase === "done") {
      return;
    }
    const { foreign, peers } = survey(signal);
    if (phase === "draining") {
      // Insistence: a second signal while we are mid-shutdown. Stop waiting.
      if (foreign === 0) {
        reraise(signal, peers);
      }
      return;
    }
    if (foreign > 0) {
      flushForHost(signal, foreign);
      return;
    }
    beginDrain(signal);
  };

  const onBeforeExit = (): void => {
    void shutdown();
  };

  const handlers: Record<ExitSignal, () => void> = {
    SIGINT: () => handleSignal("SIGINT"),
    SIGTERM: () => handleSignal("SIGTERM")
  };
  const member: GroupMember = { pending: () => phase === "draining", stop };

  host.once("beforeExit", onBeforeExit);
  for (const signal of EXIT_SIGNALS) {
    Object.defineProperty(handlers[signal], GROUP_MEMBER, { value: member });
    host.on(signal, handlers[signal]);
  }
  return stop;
}
