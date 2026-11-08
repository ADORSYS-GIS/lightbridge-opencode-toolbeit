import type { Plugin } from "@opencode/plugin/effect";
import type { Logger } from "@vymalo/opencode-core-otel";
import { Deferred, Effect, Exit, Queue, Scope, Stream } from "effect";

export function silentLogger(): Logger & { events: Array<[string, unknown]> } {
  const events: Array<[string, unknown]> = [];
  const push =
    (level: string) =>
    (event: string, fields?: unknown): void => {
      events.push([`${level}:${event}`, fields]);
    };
  return {
    events,
    trace: push("trace"),
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error")
  };
}

type Item = { barrier: Deferred.Deferred<void> } | { event: unknown };

/**
 * A controllable `ctx.event.subscribe` stream.
 *
 * `emit` resolves only after every event it offered has been *handled* by the
 * plugin: the barrier is read off the queue on the next pull, which the
 * consumer only makes once it finished the previous element. No sleeps, no
 * polling.
 */
export function eventFeed() {
  const queue = Effect.runSync(Queue.unbounded<Item>());
  let subscribed = 0;
  let closed = 0;
  let lastTypes: ReadonlyArray<string> | undefined;

  const stream = Stream.fromEffectRepeat(Queue.take(queue)).pipe(
    Stream.mapEffect((item) =>
      "barrier" in item
        ? Deferred.succeed(item.barrier, undefined).pipe(Effect.as([] as unknown[]))
        : Effect.succeed([item.event])
    ),
    Stream.flattenIterable,
    Stream.ensuring(
      Effect.sync(() => {
        closed += 1;
      })
    )
  );

  return {
    subscribe: (input?: { types?: ReadonlyArray<string> }) => {
      subscribed += 1;
      lastTypes = input?.types;
      return stream;
    },
    async emit(...events: unknown[]): Promise<void> {
      const barrier = Effect.runSync(Deferred.make<void>());
      for (const event of events) {
        Effect.runSync(Queue.offer(queue, { event }));
      }
      Effect.runSync(Queue.offer(queue, { barrier }));
      await Effect.runPromise(Deferred.await(barrier));
    },
    stats: () => ({ subscribed, closed, types: lastTypes })
  };
}

type AnyHook = (event: never) => Effect.Effect<void>;

export interface FakeCtx {
  ctx: Plugin.Context;
  feed: ReturnType<typeof eventFeed>;
  /** Registered hooks, keyed `session:prompt`, `tool:execute.after`, … */
  registered: () => string[];
  run: (key: string, event: Record<string, unknown>) => Promise<void>;
}

export function fakeCtx(options: Record<string, unknown> = {}): FakeCtx {
  const hooks = new Map<string, AnyHook>();
  const feed = eventFeed();
  const registration = Effect.succeed({ dispose: Effect.void });
  const domain = (prefix: string) => ({
    hook: (name: string, callback: AnyHook) => {
      hooks.set(`${prefix}:${name}`, callback);
      return registration;
    }
  });
  const ctx = {
    options,
    app: { name: "opencode", version: "2.2.6", channel: "latest" },
    location: {
      directory: "/repo",
      project: { id: "toolbelt", directory: "/repo", canonical: "/repo" }
    },
    event: { subscribe: feed.subscribe },
    session: domain("session"),
    tool: domain("tool"),
    permission: domain("permission")
  } as unknown as Plugin.Context;

  return {
    ctx,
    feed,
    registered: () => [...hooks.keys()].sort(),
    run: async (key, event) => {
      const hook = hooks.get(key);
      if (!hook) {
        throw new Error(`hook not registered: ${key}`);
      }
      await Effect.runPromise(hook(event as never));
    }
  };
}

/** Run the plugin in a scope the test can close explicitly. */
export async function start(plugin: Plugin.Plugin, ctx: Plugin.Context) {
  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(Scope.provide(plugin.effect(ctx), scope));
  return { close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}

// ------------------------------------------------------------ v2 event fixtures

const created = 1_000;

export const events = {
  sessionCreated: (sessionID = "ses_1", extra: Record<string, unknown> = {}) => ({
    type: "session.created",
    created,
    data: { sessionID, location: { directory: "/repo" }, ...extra }
  }),
  sessionIdle: (sessionID = "ses_1") => ({ type: "session.idle", created, data: { sessionID } }),
  stepStarted: (overrides: Record<string, unknown> = {}) => ({
    type: "session.step.started",
    created,
    data: {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      agent: "build",
      model: { id: "kimi-k2.6", providerID: "camer-digital" },
      started: 1_000,
      ...overrides
    }
  }),
  stepEnded: (overrides: Record<string, unknown> = {}, at = 3_500) => ({
    type: "session.step.ended",
    created: at,
    data: {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      finish: "stop",
      cost: 0.0125,
      tokens: { input: 1200, output: 340, reasoning: 88, cache: { read: 9600, write: 400 } },
      ...overrides
    }
  }),
  stepFailed: (overrides: Record<string, unknown> = {}, at = 2_000) => ({
    type: "session.step.failed",
    created: at,
    data: {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      error: { type: "ProviderError", message: "boom", status: 503 },
      ...overrides
    }
  })
};
