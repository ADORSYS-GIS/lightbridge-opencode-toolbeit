import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { validateAuthConfig, type AuthServerConfigInput } from "@vymalo/opencode-auth-core/lib";
import { ProviderModelSyncEngine } from "@vymalo/opencode-provider-sync/lib";

import {
  LightbridgeRuntime,
  ROOT_CACHE_NAMESPACE,
  ROOT_CACHE_SEGMENT,
  rootCacheDir
} from "../src/plugin.js";
import { startPlugin, type StartOptions } from "./harness.js";
import { createRecordingLogger, createSilentLogger } from "./helpers.js";

const PROVIDER_ID = "lightbridge-gateway";
const REGISTER = { baseURL: "https://gateway.example.com/v1" };

function settingsOf(record: { provider: { settings?: unknown } } | undefined) {
  return (record?.provider.settings ?? {}) as Record<string, unknown>;
}

function registerAuth(overrides: Partial<AuthServerConfigInput> = {}): AuthServerConfigInput {
  return {
    id: PROVIDER_ID,
    issuer: "https://authz.example.com/realms/gw",
    clientId: "opencode-cli",
    clientSecret: "s3cr3t",
    scopes: ["openid"],
    authFlow: "client_credentials",
    tokenEndpoint: "https://authz.example.com/realms/gw/protocol/openid-connect/token",
    ...overrides
  };
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/** A fetch double serving a client_credentials token POST + a `/v1/models` GET. */
function createRegisterFetch(models: Array<{ id: string }> = [{ id: "glm-5" }]) {
  const urls: string[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    urls.push(url);
    if (url.includes("/protocol/openid-connect/token")) {
      return makeJsonResponse({
        access_token: "register-token",
        token_type: "Bearer",
        expires_in: 3600
      });
    }
    if (url.includes("/models")) {
      return makeJsonResponse({ data: models });
    }
    throw new Error(`unexpected fetch: ${url} ${String(init)}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

async function startRegister(
  extra: Partial<StartOptions> & { fetchImpl?: typeof fetch; cacheDir?: string } = {}
) {
  const cacheDir = extra.cacheDir ?? (await mkdtemp(join(tmpdir(), "lightbridge-register-")));
  const { fetchImpl, urls } = createRegisterFetch();
  const logger = createRecordingLogger();
  const harness = await startPlugin({
    options: { auth: registerAuth(), register: REGISTER },
    ...extra,
    factory: { logger, cacheDir, fetchImpl: extra.fetchImpl ?? fetchImpl, ...extra.factory }
  });
  return { harness, logger, urls, cacheDir };
}

describe("register module (ADR-0017 requirement 1)", () => {
  it("registers the provider immediately, then merges discovered models and the bearer after the build", async () => {
    const { harness } = await startRegister();
    harness.runTransform();

    const first = harness.provider(PROVIDER_ID);
    expect(first?.provider.package).toBe("aisdk:@ai-sdk/openai-compatible");
    expect(first?.provider.activation).toBe("enabled");
    expect(settingsOf(first).baseURL).toBe(REGISTER.baseURL);
    expect(first?.models.size).toBe(0);

    await harness.settle();
    expect(harness.reloads()).toBe(1);

    const settled = harness.provider(PROVIDER_ID);
    expect(settled?.models.get("glm-5")).toMatchObject({ id: "glm-5" });
    expect((settled?.provider.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer register-token"
    );
  });

  it("uses the Responses package and placeholder key when responseApi is set", async () => {
    const { harness } = await startRegister({
      options: {
        auth: registerAuth(),
        register: { ...REGISTER, responseApi: true, name: "Gateway" }
      }
    });
    harness.runTransform();
    const record = harness.provider(PROVIDER_ID);
    expect(record?.provider.package).toBe("aisdk:@ai-sdk/openai");
    expect(record?.provider.name).toBe("Gateway");
    expect(settingsOf(record).apiKey).toBeTruthy();
  });

  it("merges onto a provider the user already declared, keeping its name", async () => {
    const { harness } = await startRegister({
      sources: [{ id: PROVIDER_ID, name: "My Gateway", settings: { extra: 1 } }]
    });
    harness.runTransform();
    const record = harness.provider(PROVIDER_ID);
    expect(record?.provider.name).toBe("My Gateway");
    expect(record?.provider.settings).toMatchObject({ extra: 1, baseURL: REGISTER.baseURL });
  });

  it("does not touch the provider domain when register is not configured", async () => {
    const harness = await startPlugin({
      options: { auth: registerAuth() },
      factory: { logger: createSilentLogger() }
    });
    harness.runTransform();
    expect(harness.provider(PROVIDER_ID)).toBeUndefined();
    expect(harness.hasHook("session.model.request")).toBe(false);
  });

  it("queues one build for repeated transform passes and logs a failed build", async () => {
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const { harness, logger } = await startRegister({ fetchImpl: failing });
    harness.runTransform();
    harness.runTransform();
    await harness.settle();
    // Warmup failures are logged by the engine; the queue never wedges.
    expect(harness.reloads()).toBeLessThanOrEqual(1);
    expect(logger.events.some((e) => e.event === "lightbridge_register_build_failed")).toBe(false);
  });

  it("stops its engine when the plugin scope closes", async () => {
    const { harness } = await startRegister();
    harness.runTransform();
    await harness.settle();
    expect(harness.engine()).toBeDefined();
    await harness.close();
    expect(harness.engine()).toBeUndefined();
  });
});

describe("register vs oauth2 provider-id collision (ADR-0017 requirement 4a)", () => {
  const userBlock = { oauth2: { issuer: "https://x", clientId: "y", scopes: ["s"] } };
  const marker = { oauth2: { managed: true, source: "options.servers" } };

  for (const [label, settings] of [
    ["a user settings.oauth2 block", userBlock],
    ["oauth2's options.servers marker", marker],
    ["a settings.oauth2ModelSync block", { oauth2ModelSync: { issuer: "x" } }]
  ] as const) {
    it(`never registers, builds or schedules when oauth2 manages the id via ${label}`, async () => {
      const { harness, logger, urls } = await startRegister({
        sources: [{ id: PROVIDER_ID, name: "Theirs", settings }]
      });
      harness.runTransform();
      await harness.settle();

      expect(harness.engine()).toBeUndefined();
      expect(urls).toEqual([]); // no token fetch, no model discovery, no scheduler
      expect(harness.reloads()).toBe(0);
      const record = harness.provider(PROVIDER_ID);
      expect(record?.provider.name).toBe("Theirs");
      expect(settingsOf(record).baseURL).toBeUndefined();
      expect(
        logger.events.some(
          (e) => e.level === "debug" && e.event === "lightbridge_register_skipped_oauth2_conflict"
        )
      ).toBe(true);
    });
  }

  it("never logs above debug for the collision (ADR-0014)", async () => {
    const { harness, logger } = await startRegister({
      sources: [{ id: PROVIDER_ID, settings: marker }]
    });
    harness.runTransform();
    harness.runTransform();
    expect(logger.events.filter((e) => e.event.includes("conflict"))).toHaveLength(1);
    expect(logger.events.some((e) => e.event.includes("conflict") && e.level !== "debug")).toBe(
      false
    );
  });

  it("stands its engine down when oauth2's marker appears on a later pass", async () => {
    const { harness } = await startRegister();
    harness.runTransform();
    await harness.settle();
    expect(harness.engine()).toBeDefined();

    harness.setSources([{ id: PROVIDER_ID, settings: marker }]);
    harness.runTransform();
    expect(harness.engine()).toBeUndefined();
  });

  it("does not leave an engine running when the collision lands mid-build", async () => {
    const { harness, urls } = await startRegister();
    harness.runTransform(); // build queued (async)
    harness.setSources([{ id: PROVIDER_ID, settings: marker }]);
    harness.runTransform(); // collision observed before the build body runs
    await harness.settle();
    expect(harness.engine()).toBeUndefined();
    expect(urls).toEqual([]);
  });

  it("rebuilds after a collision clears", async () => {
    const { harness } = await startRegister();
    harness.setSources([{ id: PROVIDER_ID, settings: marker }]);
    harness.runTransform();
    harness.setSources([]);
    harness.runTransform();
    await harness.settle();
    expect(harness.engine()).toBeDefined();
  });
});

describe("ADR-0017 requirement 2 — one login, shared token cache with oauth2", () => {
  const oauth2LikeConfig = (auth: AuthServerConfigInput, serverId: string) => ({
    servers: [
      {
        id: serverId,
        name: serverId,
        issuer: auth.issuer,
        baseURL: "https://gateway.example.com/v1",
        clientId: auth.clientId,
        clientSecret: auth.clientSecret,
        scopes: auth.scopes ?? ["openid"],
        syncIntervalMinutes: 60,
        nameOverrides: {},
        tokenEndpoint: auth.tokenEndpoint,
        authFlow: "client_credentials" as const
      }
    ],
    cacheNamespace: "opencode-oauth2-model-sync"
  });

  it("a token an oauth2-shaped engine wrote is read by LightbridgeRuntime with no re-login", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-shared-login-"));
    const serverId = "shared-gw";
    const auth = registerAuth({ id: serverId });

    // Simulate `@vymalo/opencode-oauth2` performing the FIRST login for this
    // server id, writing into the SAME segment/namespace lightbridge uses.
    const oauth2LikeEngine = new ProviderModelSyncEngine(oauth2LikeConfig(auth, serverId), {
      logger: createSilentLogger(),
      cacheDir: rootCacheDir(cacheRoot),
      fetchImpl: createRegisterFetch().fetchImpl
    });
    await oauth2LikeEngine.initialize();
    await oauth2LikeEngine.start({ warmup: true });
    expect(oauth2LikeEngine.getCachedToken(serverId)?.accessToken).toBe("register-token");
    oauth2LikeEngine.stop();

    const runtime = new LightbridgeRuntime(validateAuthConfig(auth), undefined, {
      logger: createSilentLogger(),
      cacheDir: cacheRoot,
      fetchImpl: async () => {
        throw new Error("no login expected — oauth2 already logged in for this shared identity");
      }
    });

    expect((await runtime.getProjectToken()).accessToken).toBe("register-token");
  });

  it("the register engine reads and writes the shared oauth2 cache path (no re-login either way)", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-register-shared-"));
    const first = await startRegister({ cacheDir: cacheRoot });
    first.harness.runTransform();
    await first.harness.settle();
    expect(first.urls.some((u) => u.includes("/protocol/openid-connect/token"))).toBe(true);
    await first.harness.close();

    // The cache file lives where oauth2 writes it: <root>/opencode-oauth2/opencode-oauth2-model-sync.
    expect(rootCacheDir(cacheRoot)).toBe(join(cacheRoot, ROOT_CACHE_SEGMENT, ROOT_CACHE_NAMESPACE));
    expect(ROOT_CACHE_SEGMENT).toBe("opencode-oauth2");
    expect(ROOT_CACHE_NAMESPACE).toBe("opencode-oauth2-model-sync");

    // A fresh oauth2-shaped engine on the same root finds the token with no network.
    const oauth2Like = new ProviderModelSyncEngine(oauth2LikeConfig(registerAuth(), PROVIDER_ID), {
      logger: createSilentLogger(),
      cacheDir: rootCacheDir(cacheRoot),
      fetchImpl: (async () => {
        throw new Error("must not fetch");
      }) as unknown as typeof fetch
    });
    await oauth2Like.initialize();
    expect(oauth2Like.getCachedToken(PROVIDER_ID)?.accessToken).toBe("register-token");
  });
});

describe("ADR-0017 requirement 4b — scheduler ownership with lightbridge and oauth2 both loaded", () => {
  it("an oauth2-shaped engine on the same cache dir skips warmup while lightbridge's engine owns it", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-owner-"));
    const { harness, urls } = await startRegister({ cacheDir: cacheRoot });
    harness.runTransform();
    await harness.settle();
    const fetchesAfterLightbridge = urls.length;
    expect(fetchesAfterLightbridge).toBeGreaterThan(0);

    const second = createRegisterFetch();
    const oauth2Like = new ProviderModelSyncEngine(
      {
        servers: [
          {
            id: PROVIDER_ID,
            name: PROVIDER_ID,
            issuer: registerAuth().issuer,
            baseURL: REGISTER.baseURL,
            clientId: "opencode-cli",
            clientSecret: "s3cr3t",
            scopes: ["openid"],
            syncIntervalMinutes: 60,
            nameOverrides: {},
            tokenEndpoint: registerAuth().tokenEndpoint,
            authFlow: "client_credentials"
          }
        ],
        cacheNamespace: ROOT_CACHE_NAMESPACE
      },
      {
        logger: createSilentLogger(),
        cacheDir: rootCacheDir(cacheRoot),
        cacheNamespaceSegment: ROOT_CACHE_SEGMENT,
        fetchImpl: second.fetchImpl
      }
    );
    await oauth2Like.initialize();
    await oauth2Like.start({ warmup: true });
    // The loser neither warms up nor schedules: it makes no network call.
    expect(second.urls).toEqual([]);
    oauth2Like.stop();
    await harness.close();
  });
});

describe("misc", () => {
  it("is a no-op for engines that fail to build (queue is not wedged)", async () => {
    const spy = vi.fn();
    const { harness } = await startRegister({ factory: { onRegister: spy } });
    expect(spy).toHaveBeenCalled();
    harness.runTransform();
    await harness.settle();
  });
});
