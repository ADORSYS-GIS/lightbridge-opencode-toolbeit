import type { PluginInput } from "@opencode-ai/plugin";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { validateAuthConfig, type AuthServerConfigInput } from "@vymalo/opencode-auth-core/lib";
import { ProviderModelSyncEngine } from "@vymalo/opencode-provider-sync/lib";

import { createLightbridgePlugin } from "../src/opencode.js";
import { LightbridgeRuntime, rootCacheDir } from "../src/plugin.js";
import { createRecordingLogger, createSilentLogger } from "./helpers.js";

const PROVIDER_ID = "lightbridge-gateway";

function pluginInput(): PluginInput {
  return {
    client: { app: { log: vi.fn().mockResolvedValue(undefined) } },
    project: { id: "toolbelt" },
    directory: "/repo",
    worktree: "/repo"
  } as unknown as PluginInput;
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
function createRegisterFetch(models: Array<{ id: string }> = [{ id: "glm-5" }]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
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
}

describe("createLightbridgePlugin — register module (ADR-0017 requirement 1)", () => {
  it("registers the provider and merges discovered models into config.provider", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "lightbridge-register-"));
    const logger = createSilentLogger();
    const hooks = await createLightbridgePlugin({
      logger,
      registerProcessHandlers: false,
      cacheDir,
      fetchImpl: createRegisterFetch()
    })(pluginInput(), {
      auth: registerAuth(),
      register: { baseURL: "https://gateway.example.com/v1" }
    });

    const hostConfig: Record<string, unknown> = { logLevel: "INFO", provider: {} };
    await hooks.config?.(hostConfig as never);
    // Model discovery runs async inside the engine's warmup; allow it to settle.
    await hooks.config?.(hostConfig as never);

    const providers = hostConfig.provider as Record<
      string,
      { npm?: string; options?: Record<string, unknown>; models?: Record<string, unknown> }
    >;
    expect(providers[PROVIDER_ID]?.npm).toBe("@ai-sdk/openai-compatible");
    expect(providers[PROVIDER_ID]?.options?.baseURL).toBe("https://gateway.example.com/v1");
    expect(providers[PROVIDER_ID]?.models?.["glm-5"]).toBeDefined();
  });

  it("does not touch config.provider when register is not configured", async () => {
    const hooks = await createLightbridgePlugin({
      logger: createSilentLogger(),
      registerProcessHandlers: false
    })(pluginInput(), { auth: registerAuth() });

    const hostConfig: Record<string, unknown> = { logLevel: "INFO" };
    await hooks.config?.(hostConfig as never);
    expect(hostConfig.provider).toBeUndefined();
  });
});

describe("createLightbridgePlugin — register vs oauth2 provider-id collision (ADR-0017 requirement 4a)", () => {
  it("skips registering/owning a provider already managed by oauth2's pluginConfig channel", async () => {
    const logger = createRecordingLogger();
    const hooks = await createLightbridgePlugin({
      logger,
      registerProcessHandlers: false,
      fetchImpl: createRegisterFetch()
    })(pluginInput(), {
      auth: registerAuth(),
      register: { baseURL: "https://gateway.example.com/v1" }
    });

    const hostConfig: Record<string, unknown> = {
      logLevel: "INFO",
      provider: {},
      pluginConfig: { oauth2ModelSync: { servers: [{ id: PROVIDER_ID }] } }
    };
    await hooks.config?.(hostConfig as never);

    const providers = hostConfig.provider as Record<string, unknown>;
    expect(providers[PROVIDER_ID]).toBeUndefined();
    expect(
      logger.events.some(
        (e) => e.level === "debug" && e.event === "lightbridge_register_skipped_oauth2_conflict"
      )
    ).toBe(true);
  });

  it("skips registering/owning a provider oauth2 manages via provider.options.oauth2", async () => {
    const logger = createRecordingLogger();
    const hooks = await createLightbridgePlugin({
      logger,
      registerProcessHandlers: false,
      fetchImpl: createRegisterFetch()
    })(pluginInput(), {
      auth: registerAuth(),
      register: { baseURL: "https://gateway.example.com/v1" }
    });

    const hostConfig: Record<string, unknown> = {
      logLevel: "INFO",
      provider: {
        [PROVIDER_ID]: { options: { oauth2: { issuer: "x", clientId: "y", scopes: ["s"] } } }
      }
    };
    await hooks.config?.(hostConfig as never);

    const providers = hostConfig.provider as Record<string, { npm?: string }>;
    expect(providers[PROVIDER_ID]?.npm).toBeUndefined();
  });

  it("never logs above debug for the collision (ADR-0014: nothing reaches the terminal)", async () => {
    const logger = createRecordingLogger();
    const hooks = await createLightbridgePlugin({
      logger,
      registerProcessHandlers: false,
      fetchImpl: createRegisterFetch()
    })(pluginInput(), {
      auth: registerAuth(),
      register: { baseURL: "https://gateway.example.com/v1" }
    });

    const hostConfig: Record<string, unknown> = {
      logLevel: "INFO",
      pluginConfig: { oauth2ModelSync: { servers: [{ id: PROVIDER_ID }] } }
    };
    await hooks.config?.(hostConfig as never);

    expect(logger.events.some((e) => e.event.includes("conflict") && e.level !== "debug")).toBe(
      false
    );
  });
});

describe("ADR-0017 requirement 2 — one login, shared token cache with oauth2", () => {
  it("a token an oauth2-shaped ProviderModelSyncEngine wrote is read by LightbridgeRuntime with no re-login", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lightbridge-shared-login-"));
    const serverId = "shared-gw";
    const auth = registerAuth({ id: serverId });

    // Simulate `@vymalo/opencode-oauth2` performing the FIRST login for this
    // server id, writing into the SAME segment/namespace lightbridge now uses.
    const oauth2LikeEngine = new ProviderModelSyncEngine(
      {
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
            authFlow: "client_credentials"
          }
        ],
        cacheNamespace: "opencode-oauth2-model-sync"
      },
      {
        logger: createSilentLogger(),
        cacheDir: rootCacheDir(cacheRoot),
        fetchImpl: createRegisterFetch()
      }
    );
    await oauth2LikeEngine.initialize();
    await oauth2LikeEngine.start({ warmup: true });
    expect(oauth2LikeEngine.getCachedToken(serverId)?.accessToken).toBe("register-token");
    oauth2LikeEngine.stop();

    // Now lightbridge, configured against the SAME id/issuer/clientId, must
    // find that token WITHOUT any network call.
    const runtime = new LightbridgeRuntime(validateAuthConfig(auth), undefined, {
      logger: createSilentLogger(),
      cacheDir: cacheRoot,
      fetchImpl: async () => {
        throw new Error("no login expected — oauth2 already logged in for this shared identity");
      }
    });

    const token = await runtime.getProjectToken();
    expect(token.accessToken).toBe("register-token");
  });
});
