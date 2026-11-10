import type { Plugin } from "@opencode/plugin/effect";
import { Effect, Exit, Queue, Scope, Stream } from "effect";

import {
  createLightbridgePlugin,
  type LightbridgePluginFactoryOptions,
  type LightbridgeRegisterHandle
} from "../src/opencode.js";
import { createSilentLogger } from "./helpers.js";

/** A provider as a user would declare it (v2 `Provider.Info`). */
export interface SourceProvider {
  id: string;
  name?: string;
  package?: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
}

interface Rec {
  provider: Record<string, unknown> & { id: string };
  models: Map<string, Record<string, unknown>>;
}

/**
 * In-memory stand-in for the host's `ProviderEditor`, mirroring the contract
 * the shared helpers rely on. A fresh editor is built per transform pass from
 * the user-declared sources, as a host re-running its pipeline would.
 */
export function createEditor(sources: SourceProvider[]) {
  const records = new Map<string, Rec>();
  for (const source of sources) {
    records.set(source.id, {
      provider: {
        name: source.id,
        activation: "auto",
        package: "aisdk:@ai-sdk/openai-compatible",
        ...structuredClone(source)
      },
      models: new Map()
    });
  }

  const editor = {
    list: () => [...records.values()],
    get: (id: string) => records.get(id),
    add: (input: { info: Rec["provider"]; models: Array<Record<string, unknown>> }) => {
      records.set(input.info.id, {
        provider: structuredClone(input.info),
        models: new Map(input.models.map((model) => [String(model.id), model]))
      });
    },
    update: (id: string, fn: (provider: Rec["provider"]) => void) => {
      const record = records.get(id);
      if (!record) {
        return;
      }
      const draft = structuredClone(record.provider);
      fn(draft);
      record.provider = draft;
    },
    remove: (id: string) => {
      records.delete(id);
    },
    models: {
      set: (id: string, models: Array<Record<string, unknown>>) => {
        const record = records.get(id);
        if (record) {
          record.models = new Map(models.map((model) => [String(model.id), model]));
        }
      },
      update: () => {},
      remove: () => {}
    }
  };
  return { editor, records };
}

/** What the plugin registered on the host's integration domain. */
export interface RegisteredIntegrations {
  /** Integration id -> display name. */
  names: Map<string, string>;
  /** Every oauth method registration, in registration order. */
  // biome-ignore lint/suspicious/noExplicitAny: a duck-typed host registration
  methods: Array<Record<string, any>>;
}

type AnyHook = (event: Record<string, unknown>) => Effect.Effect<void>;

export interface Harness {
  /** Registered hooks, keyed `<domain>.<name>` (e.g. `session.model.request`). */
  hooks: Map<string, AnyHook>;
  /** Run the registered provider transform on a fresh editor. */
  runTransform(): void;
  provider(id: string): Rec | undefined;
  reloads(): number;
  /** Replace the user-declared providers for later transform passes. */
  setSources(sources: SourceProvider[]): void;
  /** Push a host event into the plugin's `event.subscribe` stream. */
  emit(event: Record<string, unknown>): Promise<void>;
  /** Wait for the `register` module's queued build. */
  settle(): Promise<void>;
  engine: LightbridgeRegisterHandle["engine"];
  close(): Promise<void>;
  /** Invoke a hook and wait for it; rejects with the hook's defect, if any. */
  call(key: string, event: Record<string, unknown>): Promise<void>;
  hasHook(key: string): boolean;
  /** Run the registered integration transform on a fresh in-memory editor. */
  integrations(): RegisteredIntegrations;
}

export interface StartOptions {
  options?: Record<string, unknown>;
  sources?: SourceProvider[];
  factory?: Partial<LightbridgePluginFactoryOptions>;
  plugin?: Plugin.Plugin;
  /** Wrap the plugin Effect (e.g. to provide a recording Logger). */
  provide?: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export async function startPlugin(start: StartOptions = {}): Promise<Harness> {
  let handle: LightbridgeRegisterHandle | undefined;
  const plugin =
    start.plugin ??
    createLightbridgePlugin({
      logger: createSilentLogger(),
      registerProcessHandlers: false,
      ...start.factory,
      onRegister: (h) => {
        handle = h;
        start.factory?.onRegister?.(h);
      }
    });

  const hooks = new Map<string, AnyHook>();
  let transformCb: ((editor: unknown) => void) | undefined;
  let sources = start.sources ?? [];
  let last: ReturnType<typeof createEditor> | undefined;
  let reloads = 0;
  let integrationCb: ((editor: unknown) => void) | undefined;
  const registration = Effect.succeed({ dispose: Effect.void });
  const events = await Effect.runPromise(Queue.unbounded<Record<string, unknown>>());

  const runTransform = () => {
    last = createEditor(sources);
    transformCb?.(last.editor);
  };

  const hookOf = (domain: string) => (name: string, cb: AnyHook) => {
    hooks.set(`${domain}.${name}`, cb);
    return registration;
  };

  const ctx = {
    options: start.options ?? {},
    location: { directory: "/repo", project: { id: "toolbelt" } },
    provider: {
      transform: (cb: (editor: unknown) => void) => {
        transformCb = cb;
        return registration;
      },
      reload: () =>
        Effect.sync(() => {
          reloads += 1;
          runTransform();
        })
    },
    integration: {
      transform: (cb: (editor: unknown) => void) => {
        integrationCb = cb;
        return registration;
      }
    },
    event: { subscribe: () => Stream.fromQueue(events) },
    session: { hook: hookOf("session") },
    tool: { hook: hookOf("tool") },
    permission: { hook: hookOf("permission") }
  } as unknown as Plugin.Context;

  const scope = await Effect.runPromise(Scope.make());
  const run = Scope.provide(scope)(plugin.effect(ctx));
  await Effect.runPromise(start.provide ? start.provide(run) : run);

  return {
    hooks,
    runTransform,
    provider: (id) => last?.records.get(id),
    reloads: () => reloads,
    setSources(next) {
      sources = next;
    },
    async emit(event) {
      await Effect.runPromise(Queue.offer(events, event));
      // Let the forked subscriber drain.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async settle() {
      await handle?.settled();
    },
    engine: () => handle?.engine(),
    async close() {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
    async call(key, event) {
      const hook = hooks.get(key);
      if (!hook) {
        throw new Error(`hook not registered: ${key}`);
      }
      await Effect.runPromise(hook(event));
    },
    hasHook: (key) => hooks.has(key),
    integrations() {
      const names = new Map<string, string>();
      const methods: RegisteredIntegrations["methods"] = [];
      integrationCb?.({
        list: () => [],
        get: () => undefined,
        remove: () => {},
        update: (id: string, fn: (ref: { id: string; name: string }) => void) => {
          const ref = { id, name: id };
          fn(ref);
          names.set(id, ref.name);
        },
        method: {
          list: () => [],
          remove: () => {},
          // biome-ignore lint/suspicious/noExplicitAny: a duck-typed host registration
          update: (registration: Record<string, any>) => {
            methods.push(registration);
            if (!names.has(String(registration.integrationID))) {
              names.set(String(registration.integrationID), String(registration.integrationID));
            }
          }
        }
      });
      return { names, methods };
    }
  };
}
