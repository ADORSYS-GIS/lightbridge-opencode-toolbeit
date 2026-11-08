import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "@opencode/plugin/effect";
import { FileCacheStore, type Logger } from "@vymalo/opencode-auth-core/lib";
import { Effect, Logger as EffectLogger, References } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  collectManagedProviders,
  createOpencodeRepoAuthPlugin,
  type OpenCodePluginFactoryOptions,
  OpencodeRepoAuthPlugin,
  PLUGIN_ID
} from "../src/opencode.js";
import { HUMAN_IDENTITY } from "../src/plugin.js";
import { createSilentLogger, makeJsonResponse } from "./helpers.js";

type AnyHook = (event: Record<string, unknown>) => Effect.Effect<void>;

interface RecordingLogger extends Logger {
  events: Array<{ level: string; event: string; fields?: unknown }>;
}

function createRecordingLogger(): RecordingLogger {
  const events: RecordingLogger["events"] = [];
  const log = (level: string) => (event: string, fields?: unknown) => {
    events.push({ level, event, fields });
  };
  return {
    events,
    trace: log("trace"),
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error")
  };
}

interface ProviderFixture {
  id: string;
  settings?: Record<string, unknown>;
  integrationID?: string;
}

interface Harness {
  hooks: Map<string, AnyHook>;
  /** Run the registered provider transform over a fresh editor. */
  transform: (providers: ProviderFixture[]) => void;
  /** Fire `model.request` for a provider; returns the (mutated) headers. */
  modelRequest: (
    providerID: string,
    headers?: Record<string, string>
  ) => Promise<Record<string, string>>;
}

function fakeCtx(options: Record<string, unknown>, directory: string) {
  const hooks = new Map<string, AnyHook>();
  let transformCb: ((editor: unknown) => void) | undefined;
  const registration = Effect.succeed({ dispose: Effect.void });
  const ctx = {
    options,
    location: { directory },
    provider: {
      transform: (cb: (editor: unknown) => void) => {
        transformCb = cb;
        return registration;
      }
    },
    session: {
      hook: (name: string, cb: AnyHook) => {
        hooks.set(name, cb);
        return registration;
      }
    }
  } as unknown as Plugin.Context;
  return { ctx, hooks, transformCb: () => transformCb };
}

function editorOf(providers: ProviderFixture[]) {
  return { list: () => providers.map((provider) => ({ provider })) };
}

function run(plugin: Plugin.Plugin, ctx: Plugin.Context) {
  return Effect.runPromise(Effect.scoped(plugin.effect(ctx)));
}

async function start(
  factory: OpenCodePluginFactoryOptions,
  ctxOptions: Record<string, unknown> = {}
): Promise<Harness> {
  const cwd = factory.cwd ?? (await mkdtemp(join(tmpdir(), "repo-auth-oc-nogit-")));
  const fake = fakeCtx(ctxOptions, cwd);
  await run(createOpencodeRepoAuthPlugin({ ...factory, cwd }), fake.ctx);
  return {
    hooks: fake.hooks,
    transform: (providers) => {
      const cb = fake.transformCb();
      if (!cb) {
        throw new Error("provider.transform was not registered");
      }
      cb(editorOf(providers));
    },
    modelRequest: async (providerID, headers = {}) => {
      const hook = fake.hooks.get("model.request");
      if (!hook) {
        throw new Error("model.request was not registered");
      }
      await Effect.runPromise(hook({ model: { providerID, id: "m" }, headers }));
      return headers;
    }
  };
}

function repoAuthSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repoAuth: {
      projectId: "proj-123",
      issuer: "https://idp.example.com/realms/acme",
      clientId: "opencode-cli",
      scopes: ["openid", "offline_access"],
      authFlow: "device_code",
      tokenEndpoint: "https://idp.example.com/realms/acme/protocol/openid-connect/token",
      deviceAuthorizationEndpoint:
        "https://idp.example.com/realms/acme/protocol/openid-connect/auth/device",
      pkce: false,
      ...overrides
    }
  };
}

function parseFormBody(init?: RequestInit): URLSearchParams {
  const body = init?.body;
  if (body instanceof URLSearchParams) {
    return body;
  }
  return new URLSearchParams(String(body ?? ""));
}

async function seedHuman(cacheDir: string): Promise<void> {
  await new FileCacheStore(cacheDir).save(HUMAN_IDENTITY, {
    accessToken: "human-token",
    tokenType: "Bearer",
    refreshToken: "human-refresh",
    expiresAt: Date.now() + 3600_000
  });
}

const tmp = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createOpencodeRepoAuthPlugin", () => {
  it("has a stable id", () => {
    expect(PLUGIN_ID).toBe("vymalo.repo-auth");
    expect(createOpencodeRepoAuthPlugin().id).toBe(PLUGIN_ID);
    expect(OpencodeRepoAuthPlugin.id).toBe(PLUGIN_ID);
  });

  it("registers a provider transform and a model.request hook, nothing else", async () => {
    const harness = await start({ logger: createSilentLogger() });
    expect([...harness.hooks.keys()]).toEqual(["model.request"]);
  });

  it("injects the project bearer per request on a managed provider", async () => {
    const cacheDir = await tmp("repo-auth-oc-chat-");
    await seedHuman(cacheDir);
    const harness = await start({
      logger: createSilentLogger(),
      cacheDir,
      fetchImpl: async () =>
        makeJsonResponse({ access_token: "chat-scoped", token_type: "Bearer", expires_in: 300 })
    });
    harness.transform([{ id: "gateway", settings: repoAuthSettings() }]);

    const headers = await harness.modelRequest("gateway");
    expect(headers.Authorization).toBe("Bearer chat-scoped");
  });

  it("overwrites a pre-existing Authorization on a managed provider (project bearer wins)", async () => {
    const cacheDir = await tmp("repo-auth-oc-wins-");
    await seedHuman(cacheDir);
    const harness = await start({
      logger: createSilentLogger(),
      cacheDir,
      fetchImpl: async () =>
        makeJsonResponse({ access_token: "chat-scoped", token_type: "Bearer", expires_in: 300 })
    });
    harness.transform([{ id: "gateway", settings: repoAuthSettings() }]);

    const headers = await harness.modelRequest("gateway", { Authorization: "Bearer user-set" });
    expect(headers.Authorization).toBe("Bearer chat-scoped");
  });

  it("leaves non-managed providers untouched and never calls the network", async () => {
    const cacheDir = await tmp("repo-auth-oc-other-");
    const harness = await start({
      logger: createSilentLogger(),
      cacheDir,
      fetchImpl: async () => {
        throw new Error("fetch must not be called for an unmanaged provider");
      }
    });
    harness.transform([
      { id: "gateway", settings: repoAuthSettings() },
      { id: "some-other-provider" }
    ]);

    const headers = await harness.modelRequest("some-other-provider");
    expect(headers.Authorization).toBeUndefined();
  });

  it("does not resolve any token inside the transform (no I/O, sync and cheap)", async () => {
    const cacheDir = await tmp("repo-auth-oc-sync-");
    await seedHuman(cacheDir);
    const fetchImpl = vi.fn(async () => makeJsonResponse({}));
    const harness = await start({ logger: createSilentLogger(), cacheDir, fetchImpl });

    harness.transform([{ id: "gateway", settings: repoAuthSettings() }]);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED: an exchange error injects no header and the hook resolves", async () => {
    const cacheDir = await tmp("repo-auth-oc-failclosed-");
    await seedHuman(cacheDir);
    const logger = createRecordingLogger();
    const harness = await start({
      logger,
      cacheDir,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 404 })
    });
    harness.transform([{ id: "gateway", settings: repoAuthSettings() }]);

    const headers: Record<string, string> = {};
    await expect(harness.modelRequest("gateway", headers)).resolves.toBe(headers);

    expect(headers.Authorization).toBeUndefined();
    expect(Object.keys(headers)).toEqual([]);
    expect(logger.events.some((e) => e.event === "repo_auth_exchange_failed")).toBe(true);
    expect(logger.events.some((e) => e.event === "repo_auth_model_request_no_bearer")).toBe(true);
  });

  it("FAILS CLOSED: a network error injects no header", async () => {
    const cacheDir = await tmp("repo-auth-oc-failclosed-net-");
    await seedHuman(cacheDir);
    const harness = await start({
      logger: createSilentLogger(),
      cacheDir,
      fetchImpl: async () => {
        throw new Error("connection refused");
      }
    });
    harness.transform([{ id: "gateway", settings: repoAuthSettings() }]);

    const headers = await harness.modelRequest("gateway");
    expect(headers.Authorization).toBeUndefined();
  });

  it("FAILS CLOSED: a cold cache (no human token) injects no header", async () => {
    const cacheDir = await tmp("repo-auth-oc-cold-");
    const harness = await start({
      logger: createSilentLogger(),
      cacheDir,
      fetchImpl: async () => {
        throw new Error("no network in this test");
      }
    });
    harness.transform([{ id: "gateway", settings: repoAuthSettings() }]);

    const headers = await harness.modelRequest("gateway");
    expect(headers.Authorization).toBeUndefined();
  });

  it("skips a provider without projectId, emitting a warning, and injects nothing", async () => {
    const cacheDir = await tmp("repo-auth-oc-nopid-");
    const logger = createRecordingLogger();
    const harness = await start({
      logger,
      cacheDir,
      fetchImpl: async () => makeJsonResponse({})
    });
    harness.transform([
      {
        id: "gateway",
        settings: { repoAuth: { issuer: "https://idp.example.com", clientId: "c", scopes: ["s"] } }
      }
    ]);

    expect(logger.events.some((e) => e.event === "repo_auth_skipped_no_project_id")).toBe(true);
    expect((await harness.modelRequest("gateway")).Authorization).toBeUndefined();
  });

  it("skips a provider carrying settings.oauth2, emitting a warning", async () => {
    const cacheDir = await tmp("repo-auth-oc-conflict-");
    const logger = createRecordingLogger();
    const harness = await start({
      logger,
      cacheDir,
      fetchImpl: async () => makeJsonResponse({})
    });
    harness.transform([
      {
        id: "gateway",
        settings: {
          ...repoAuthSettings(),
          oauth2: { issuer: "https://other.example.com", clientId: "c", scopes: ["s"] }
        }
      }
    ]);

    expect(logger.events.some((e) => e.event === "repo_auth_skipped_oauth2_provider")).toBe(true);
    expect((await harness.modelRequest("gateway")).Authorization).toBeUndefined();
  });

  it("skips a provider owned by an Integration (OAuth-managed), emitting a warning", async () => {
    const cacheDir = await tmp("repo-auth-oc-integration-");
    const logger = createRecordingLogger();
    const harness = await start({
      logger,
      cacheDir,
      fetchImpl: async () => makeJsonResponse({})
    });
    harness.transform([
      { id: "gateway", settings: repoAuthSettings(), integrationID: "integration-1" }
    ]);

    expect(logger.events.some((e) => e.event === "repo_auth_skipped_oauth2_provider")).toBe(true);
    expect((await harness.modelRequest("gateway")).Authorization).toBeUndefined();
  });

  it("skips a malformed repoAuth block but still manages the remaining providers", async () => {
    const cacheDir = await tmp("repo-auth-oc-malformed-");
    await seedHuman(cacheDir);
    const logger = createRecordingLogger();
    const harness = await start({
      logger,
      cacheDir,
      fetchImpl: async () =>
        makeJsonResponse({ access_token: "ok-token", token_type: "Bearer", expires_in: 300 })
    });
    harness.transform([
      // Well-formed projectId but no issuer/clientId/scopes → parse throws; the
      // provider is skipped, not the whole transform.
      { id: "gateway", settings: { repoAuth: { projectId: "proj-123" } } },
      { id: "healthy", settings: repoAuthSettings() }
    ]);

    expect(logger.events.some((e) => e.event === "repo_auth_skipped_malformed")).toBe(true);
    expect((await harness.modelRequest("gateway")).Authorization).toBeUndefined();
    expect((await harness.modelRequest("healthy")).Authorization).toBe("Bearer ok-token");
  });

  it("skips a provider whose auth block fails validation and injects nothing", async () => {
    const cacheDir = await tmp("repo-auth-oc-invalid-auth-");
    await seedHuman(cacheDir);
    const logger = createRecordingLogger();
    const harness = await start({
      logger,
      cacheDir,
      fetchImpl: async () =>
        makeJsonResponse({ access_token: "ok-token", token_type: "Bearer", expires_in: 300 })
    });
    // client_credentials needs a clientSecret → RepoAuthPlugin ctor rejects.
    harness.transform([
      { id: "bad", settings: repoAuthSettings({ authFlow: "client_credentials" }) }
    ]);

    expect(logger.events.some((e) => e.event === "repo_auth_skipped_invalid_auth")).toBe(true);
    expect((await harness.modelRequest("bad")).Authorization).toBeUndefined();
  });

  it("keeps only the first IdP group when providers disagree (single-IdP v1 guard)", async () => {
    const cacheDir = await tmp("repo-auth-oc-2idp-");
    await seedHuman(cacheDir);
    const logger = createRecordingLogger();
    const captured: string[] = [];
    const harness = await start({
      logger,
      cacheDir,
      fetchImpl: async (_input, init) => {
        const body = parseFormBody(init);
        if (body.get("grant_type") === "urn:ietf:params:oauth:grant-type:token-exchange") {
          captured.push(body.get("project_id") ?? "");
        }
        return makeJsonResponse({ access_token: "tok", token_type: "Bearer", expires_in: 300 });
      }
    });
    harness.transform([
      { id: "first", settings: repoAuthSettings() },
      {
        id: "second",
        settings: repoAuthSettings({
          projectId: "proj-456",
          issuer: "https://other-idp.example.com/realms/x"
        })
      }
    ]);

    expect(logger.events.some((e) => e.event === "repo_auth_multiple_idps_unsupported")).toBe(true);
    await harness.modelRequest("first");
    await harness.modelRequest("second");
    expect(captured).toEqual(["proj-123"]);
  });

  it("reuses the runtime when the managed set is unchanged, drops it when opt-in vanishes", async () => {
    const cacheDir = await tmp("repo-auth-oc-reuse-");
    await seedHuman(cacheDir);
    const logger = createRecordingLogger();
    const harness = await start({
      logger,
      cacheDir,
      fetchImpl: async () =>
        makeJsonResponse({ access_token: "tok", token_type: "Bearer", expires_in: 300 })
    });
    const providers = [{ id: "gateway", settings: repoAuthSettings() }];

    harness.transform(providers);
    harness.transform(providers);
    expect(logger.events.filter((e) => e.event === "repo_auth_runtime_reused")).toHaveLength(1);

    harness.transform([{ id: "gateway", settings: repoAuthSettings({ projectId: "proj-2" }) }]);
    expect(
      logger.events.find(
        (e) =>
          e.event === "repo_auth_runtime_rebuild" &&
          (e.fields as { reason?: string }).reason === "signature_changed"
      )
    ).toBeDefined();

    harness.transform([{ id: "gateway" }]);
    expect((await harness.modelRequest("gateway")).Authorization).toBeUndefined();
  });

  it("logs the repo's git origin once at load (log-only)", async () => {
    const cwd = await tmp("repo-auth-oc-git-");
    await mkdir(join(cwd, ".git"));
    await writeFile(
      join(cwd, ".git", "config"),
      '[remote "origin"]\n\turl = https://example.com/acme/repo.git\n'
    );
    const logger = createRecordingLogger();
    await start({ logger, cwd });

    const resolved = logger.events.find((e) => e.event === "repo_auth_remote_resolved");
    expect(resolved?.fields).toMatchObject({ remote: expect.stringContaining("acme/repo") });
  });

  it("traces a missing git origin when cwd is not a repo", async () => {
    const logger = createRecordingLogger();
    await start({ logger });
    expect(logger.events.some((e) => e.event === "repo_auth_remote_missing")).toBe(true);
  });
});

describe("collectManagedProviders", () => {
  it("treats a settings-less provider as not opted in", () => {
    const logger = createRecordingLogger();
    const managed = collectManagedProviders([{ id: "plain" }], logger);
    expect(managed.size).toBe(0);
    expect(logger.events.some((e) => e.event === "repo_auth_provider_skipped")).toBe(true);
  });
});

describe("ADR-0014: the plugin's own diagnostics never touch the terminal", () => {
  interface Captured {
    level: string;
    message: unknown[];
    annotations: Record<string, unknown>;
  }

  // No `logger` is injected: the real captureHostContext → createEffectLogger
  // path runs, inside a fiber whose only logger records into `sink`.
  async function runPluginUnderRecorder(sink: Captured[]) {
    const recorder = EffectLogger.make<unknown, void>((options) => {
      sink.push({
        level: options.logLevel,
        message: options.message as unknown[],
        annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) }
      });
    });
    const cwd = await tmp("repo-auth-oc-adr0014-");
    const fake = fakeCtx({}, cwd);
    await Effect.runPromise(
      Effect.scoped(createOpencodeRepoAuthPlugin({ cwd }).effect(fake.ctx)).pipe(
        Effect.provide(EffectLogger.layer([recorder], { mergeWithExisting: false })),
        Effect.provideService(References.MinimumLogLevel, "All")
      )
    );
    // `repo_auth_skipped_no_project_id` is a real `warn` reachable purely
    // through config validation — no network, no cache seeding.
    fake.transformCb()?.(
      editorOf([
        {
          id: "gateway",
          settings: {
            repoAuth: { issuer: "https://idp.example.com", clientId: "c", scopes: ["s"] }
          }
        }
      ])
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("delivers the warn record to the host Effect logger and never to the console", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previous = process.env.VYMALO_PLUGIN_CONSOLE_LOG;
    delete process.env.VYMALO_PLUGIN_CONSOLE_LOG;

    try {
      const sink: Captured[] = [];
      await runPluginUnderRecorder(sink);

      const record = sink.find((c) => c.message[0] === "repo_auth_skipped_no_project_id");
      expect(record?.level).toBe("Warn");
      expect(record?.annotations).toEqual({ providerId: "gateway" });
      expect(warn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined) {
        process.env.VYMALO_PLUGIN_CONSOLE_LOG = previous;
      }
    }
  });

  it("restores the console mirror when VYMALO_PLUGIN_CONSOLE_LOG is set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const previous = process.env.VYMALO_PLUGIN_CONSOLE_LOG;
    process.env.VYMALO_PLUGIN_CONSOLE_LOG = "1";

    try {
      await runPluginUnderRecorder([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.VYMALO_PLUGIN_CONSOLE_LOG;
      } else {
        process.env.VYMALO_PLUGIN_CONSOLE_LOG = previous;
      }
    }
  });
});

describe("log level resolution", () => {
  it("honours ctx.options.logLevel over OPENCODE_LOG_LEVEL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const previous = process.env.VYMALO_PLUGIN_CONSOLE_LOG;
    const previousLevel = process.env.OPENCODE_LOG_LEVEL;
    process.env.VYMALO_PLUGIN_CONSOLE_LOG = "1";
    process.env.OPENCODE_LOG_LEVEL = "ERROR";

    try {
      const cwd = await tmp("repo-auth-oc-level-");
      const fake = fakeCtx({ logLevel: "WARN" }, cwd);
      await Effect.runPromise(
        Effect.scoped(createOpencodeRepoAuthPlugin({ cwd }).effect(fake.ctx))
      );
      fake.transformCb()?.(
        editorOf([
          {
            id: "gateway",
            settings: { repoAuth: { issuer: "https://i.example", clientId: "c", scopes: ["s"] } }
          }
        ])
      );
      // WARN (option) lets the warn through even though env says ERROR.
      expect(warn).toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.VYMALO_PLUGIN_CONSOLE_LOG;
      } else {
        process.env.VYMALO_PLUGIN_CONSOLE_LOG = previous;
      }
      if (previousLevel === undefined) {
        delete process.env.OPENCODE_LOG_LEVEL;
      } else {
        process.env.OPENCODE_LOG_LEVEL = previousLevel;
      }
    }
  });
});
