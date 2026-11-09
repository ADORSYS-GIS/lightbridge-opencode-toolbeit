import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "@opencode/plugin/effect";
import { Effect, Exit, Scope } from "effect";
import { vi } from "vitest";

import { ServerStateStore } from "../src/cache.js";
import {
  createOpencodeOauth2Plugin,
  type OAuth2RuntimeHandle,
  type OpenCodePluginFactoryOptions
} from "../src/opencode.js";
import { createSilentLogger } from "./helpers.js";

/** A provider as a user would declare it in `providers` (v2 `Provider.Info`). */
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
 * In-memory stand-in for the host's `ProviderEditor`. It mirrors the contract
 * the shared helpers rely on: `get`/`list`/`add`/`update`, and `models.set`
 * replacing a provider's whole model list. A fresh editor is built per
 * transform pass from the user-declared sources, exactly as a host that re-runs
 * its pipeline on `reload()` would.
 */
function createEditor(sources: SourceProvider[]) {
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

type AnyHook = (event: Record<string, unknown>) => Effect.Effect<void>;

export interface Harness {
  hooks: Map<string, AnyHook>;
  /** Run the registered provider transform on a fresh editor, as the host does on first load. */
  runTransform(): void;
  /** The providers produced by the most recent transform pass. */
  provider(id: string): Rec | undefined;
  /** How many times the plugin asked the host to reload providers. */
  reloads(): number;
  handle: OAuth2RuntimeHandle;
  /** Wait for the background build + warmup, then return the post-reload provider. */
  settle(): Promise<void>;
  close(): Promise<void>;
  /** Invoke a session hook and wait for it; rejects with the hook's defect, if any. */
  call(name: string, event: Record<string, unknown>): Promise<void>;
}

/**
 * The credential directory paired with a test's model-cache dir (ADR-0022):
 * a deterministic sibling, so call sites keep passing a single `cacheDir`.
 */
export function stateDirFor(cacheDir: string): string {
  return `${cacheDir}-state`;
}

export interface StartOptions {
  options?: Record<string, unknown>;
  sources?: SourceProvider[];
  cacheDir?: string;
  stateDir?: string;
  factory?: Partial<OpenCodePluginFactoryOptions>;
}

export async function startPlugin(start: StartOptions = {}): Promise<Harness> {
  const cacheDir = start.cacheDir ?? (await mkdtemp(join(tmpdir(), "opencode-v2-hook-")));
  let handle: OAuth2RuntimeHandle | undefined;
  const plugin = createOpencodeOauth2Plugin({
    cacheDir,
    stateDir: start.stateDir ?? stateDirFor(cacheDir),
    logger: createSilentLogger(),
    fetchImpl: async () => {
      throw new Error("fetch is not expected in these hook tests");
    },
    ...start.factory,
    onRuntime: (h) => {
      handle = h;
      start.factory?.onRuntime?.(h);
    }
  });

  const hooks = new Map<string, AnyHook>();
  let transformCb: ((editor: unknown) => void) | undefined;
  let last: ReturnType<typeof createEditor> | undefined;
  let reloads = 0;
  const registration = Effect.succeed({ dispose: Effect.void });

  const runTransform = () => {
    last = createEditor(start.sources ?? []);
    transformCb?.(last.editor);
  };

  const ctx = {
    options: start.options ?? {},
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
    session: {
      hook: (name: string, cb: AnyHook) => {
        hooks.set(name, cb);
        return registration;
      }
    }
  } as unknown as Plugin.Context;

  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(Scope.provide(scope)(plugin.effect(ctx)));

  const harness: Harness = {
    hooks,
    runTransform,
    provider: (id) => last?.records.get(id),
    reloads: () => reloads,
    get handle() {
      return handle as OAuth2RuntimeHandle;
    },
    async settle() {
      await (handle as OAuth2RuntimeHandle).settled();
    },
    async close() {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
    async call(name, event) {
      const hook = hooks.get(name);
      if (!hook) {
        throw new Error(`hook not registered: ${name}`);
      }
      await Effect.runPromise(hook(event));
    }
  };
  return harness;
}

/** Seed the shared on-disk cache with a valid token + one discovered model. */
export async function seedCache(
  cacheDir: string,
  overrides: { accessToken?: string; expiresAt?: number; serverId?: string } = {}
): Promise<void> {
  const cache = new ServerStateStore(cacheDir, stateDirFor(cacheDir));
  await cache.ensureReady();
  await cache.saveServerState({
    serverId: overrides.serverId ?? "example-ai",
    updatedAt: Date.now(),
    lastSyncAt: Date.now(),
    token: {
      accessToken: overrides.accessToken ?? "cached-access",
      tokenType: "Bearer",
      refreshToken: "cached-refresh",
      expiresAt: overrides.expiresAt ?? Date.now() + 60_000
    },
    rawModels: [{ id: "glm-5" }],
    models: [{ id: "glm-5", displayName: "GLM 5" }]
  });
}

export function recordingLogger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

export const OAUTH_BLOCK = {
  issuer: "https://auth.example.com",
  clientId: "opencode-client",
  scopes: ["openid", "offline_access"]
};

export const requestEvent = (providerID: string, headers: Record<string, string> = {}) => ({
  model: { id: "glm-5", providerID },
  headers
});
