import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import type { Hooks } from "@opencode-ai/plugin";
import { FileCacheStore, type Logger } from "@vymalo/opencode-auth-core/lib";

import { createOpencodeRepoAuthPlugin } from "../src/opencode.js";
import { HUMAN_IDENTITY } from "../src/plugin.js";
import { createSilentLogger, makeJsonResponse } from "./helpers.js";

type OpenCodeConfig = Parameters<NonNullable<Hooks["config"]>>[0];

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

async function instantiate(options: {
  logger?: Logger;
  fetchImpl?: typeof fetch;
  cacheDir: string;
  cwd: string;
}): Promise<NonNullable<Hooks>> {
  const plugin = createOpencodeRepoAuthPlugin(options);
  return plugin({ client: { app: { log: async () => undefined } } as never });
}

function makeConfig(provider: Record<string, unknown>): OpenCodeConfig {
  return {
    logLevel: "INFO",
    provider: provider as never
  };
}

function makeRepoAuthProviderOptions(): Record<string, unknown> {
  return {
    baseURL: "https://gateway.example.com/v1",
    meta: {
      repoAuth: {
        projectId: "proj-123",
        issuer: "https://idp.example.com/realms/acme",
        clientId: "opencode-cli",
        scopes: ["openid", "offline_access"],
        authFlow: "device_code",
        tokenEndpoint: "https://idp.example.com/realms/acme/protocol/openid-connect/token",
        deviceAuthorizationEndpoint:
          "https://idp.example.com/realms/acme/protocol/openid-connect/auth/device",
        pkce: false
      }
    }
  };
}

function readGateway(config: OpenCodeConfig): {
  options?: Record<string, unknown>;
  headers?: Record<string, string>;
} {
  const provider = (config.provider as Record<string, never>).gateway as {
    options?: Record<string, unknown>;
  };
  const headers = (provider.options?.headers ?? {}) as Record<string, string>;
  return { options: provider.options, headers };
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

describe("createOpencodeRepoAuthPlugin", () => {
  it("stamps the project bearer at config time on an opted-in provider", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "repo-auth-oc-stamp-"));
    const cwd = await mkdtemp(join(tmpdir(), "repo-auth-oc-nogit-"));
    await seedHuman(cacheDir);

    const hooks = await instantiate({
      logger: createSilentLogger(),
      fetchImpl: async () =>
        makeJsonResponse({ access_token: "project-bearer", token_type: "Bearer", expires_in: 300 }),
      cacheDir,
      cwd
    });

    const config = makeConfig({ gateway: { options: makeRepoAuthProviderOptions() } });
    await hooks.config?.(config);

    const headers = readGateway(config);
    expect(headers.headers?.Authorization).toBe("Bearer project-bearer");
  });

  it("never clobbers a user-set Authorization at config time", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "repo-auth-oc-user-"));
    const cwd = await mkdtemp(join(tmpdir(), "repo-auth-oc-nogit2-"));

    let called = 0;
    const hooks = await instantiate({
      logger: createSilentLogger(),
      fetchImpl: async () => {
        called += 1;
        return makeJsonResponse({
          access_token: "project-bearer",
          token_type: "Bearer",
          expires_in: 300
        });
      },
      cacheDir,
      cwd
    });

    const config = makeConfig({
      gateway: {
        options: {
          ...makeRepoAuthProviderOptions(),
          headers: { authorization: "Bearer user-supplied" }
        }
      }
    });
    await hooks.config?.(config);

    const gateway = readGateway(config);
    expect(gateway.options?.headers).toMatchObject({ authorization: "Bearer user-supplied" });
    const headers = (gateway.options?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(called).toBe(0);
  });

  it("skips a provider without projectId, emitting a warning, and injects nothing", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "repo-auth-oc-nopid-"));
    const cwd = await mkdtemp(join(tmpdir(), "repo-auth-oc-nogit3-"));
    const logger = createRecordingLogger();

    const hooks = await instantiate({
      logger,
      fetchImpl: async () => makeJsonResponse({}),
      cacheDir,
      cwd
    });
    const config = makeConfig({
      gateway: {
        options: {
          baseURL: "https://gateway.example.com/v1",
          meta: { repoAuth: { issuer: "https://idp.example.com", clientId: "c", scopes: ["s"] } }
        }
      }
    });
    await hooks.config?.(config);

    expect(logger.events.some((e) => e.event === "repo_auth_skipped_no_project_id")).toBe(true);
    expect(readGateway(config).options?.headers).toBeUndefined();
  });

  it("skips a provider also managed by oauth2, emitting a warning", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "repo-auth-oc-conflict-"));
    const cwd = await mkdtemp(join(tmpdir(), "repo-auth-oc-nogit4-"));
    const logger = createRecordingLogger();

    const hooks = await instantiate({
      logger,
      fetchImpl: async () => makeJsonResponse({}),
      cacheDir,
      cwd
    });
    const config = makeConfig({
      gateway: {
        options: {
          ...makeRepoAuthProviderOptions(),
          oauth2: { issuer: "https://other.example.com", clientId: "c", scopes: ["s"] }
        }
      }
    });
    await hooks.config?.(config);

    expect(logger.events.some((e) => e.event === "repo_auth_skipped_oauth2_provider")).toBe(true);
    expect(readGateway(config).options?.headers).toBeUndefined();
  });

  it("never triggers an interactive login at config time on a cold cache", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "repo-auth-oc-cold-"));
    const cwd = await mkdtemp(join(tmpdir(), "repo-auth-oc-nogit8-"));
    const logger = createRecordingLogger();

    const hooks = await instantiate({
      logger,
      cacheDir,
      cwd,
      fetchImpl: async () => {
        throw new Error("config-time warmup must not attempt interactive auth");
      }
    });
    const config = makeConfig({ gateway: { options: makeRepoAuthProviderOptions() } });

    await expect(hooks.config?.(config)).resolves.toBeUndefined();
    expect(readGateway(config).headers.Authorization).toBeUndefined();
    expect(
      logger.events.some((e) => e.event === "repo_auth_bearer_propagation_skipped_no_token")
    ).toBe(true);
  });

  it("skips a malformed repoAuth option but still manages the remaining providers", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "repo-auth-oc-malformed-"));
    const cwd = await mkdtemp(join(tmpdir(), "repo-auth-oc-nogit9-"));
    const logger = createRecordingLogger();
    await seedHuman(cacheDir);

    const hooks = await instantiate({
      logger,
      cacheDir,
      cwd,
      fetchImpl: async () =>
        makeJsonResponse({ access_token: "ok-token", token_type: "Bearer", expires_in: 300 })
    });
    const config = makeConfig({
      gateway: {
        options: {
          baseURL: "https://gateway.example.com/v1",
          // Well-formed projectId but no issuer/clientId/scopes → parse throws;
          // the provider is skipped, not the whole config hook.
          meta: { repoAuth: { projectId: "proj-123" } }
        }
      },
      healthy: { options: makeRepoAuthProviderOptions() }
    });
    await hooks.config?.(config);

    expect(logger.events.some((e) => e.event === "repo_auth_skipped_malformed")).toBe(true);

    const provider = (config.provider as Record<string, never>).healthy as {
      options?: Record<string, unknown>;
    };
    const headers = (provider.options?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ok-token");
  });

  it("keeps only the first IdP group when providers disagree (single-IdP v1 guard)", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "repo-auth-oc-2idp-"));
    const cwd = await mkdtemp(join(tmpdir(), "repo-auth-oc-nogit5-"));
    const logger = createRecordingLogger();
    const captured: string[] = [];
    await seedHuman(cacheDir);

    const hooks = await instantiate({
      logger,
      cacheDir,
      cwd,
      fetchImpl: async (_input, init) => {
        const body = parseFormBody(init);
        if (body.get("grant_type") === "urn:ietf:params:oauth:grant-type:token-exchange") {
          captured.push(body.get("project_id") ?? "");
        }
        return makeJsonResponse({ access_token: "tok", token_type: "Bearer", expires_in: 300 });
      }
    });

    const firstOptions = makeRepoAuthProviderOptions();
    const secondOptions: Record<string, unknown> = {
      ...firstOptions,
      meta: {
        repoAuth: {
          projectId: "proj-456",
          issuer: "https://other-idp.example.com/realms/x",
          clientId: "opencode-cli",
          scopes: ["openid", "offline_access"],
          authFlow: "device_code"
        }
      }
    };
    const config = makeConfig({
      first: { options: firstOptions },
      second: { options: secondOptions }
    });
    await hooks.config?.(config);

    expect(logger.events.some((e) => e.event === "repo_auth_multiple_idps_unsupported")).toBe(true);
    expect(captured).toEqual(["proj-123"]);
  });

  it("injects the project bearer per request on a managed provider (chat.headers)", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "repo-auth-oc-chat-"));
    const cwd = await mkdtemp(join(tmpdir(), "repo-auth-oc-nogit6-"));
    await seedHuman(cacheDir);

    const hooks = await instantiate({
      logger: createSilentLogger(),
      cacheDir,
      cwd,
      fetchImpl: async () =>
        makeJsonResponse({ access_token: "chat-scoped", token_type: "Bearer", expires_in: 300 })
    });

    const config = makeConfig({ gateway: { options: makeRepoAuthProviderOptions() } });
    await hooks.config?.(config);

    const output = { headers: {} as Record<string, string> };
    await hooks["chat.headers"]?.({ model: { providerID: "gateway" } }, output);

    expect(output.headers.Authorization).toBe("Bearer chat-scoped");
  });

  it("leaves non-managed providers untouched in chat.headers", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "repo-auth-oc-other-"));
    const cwd = await mkdtemp(join(tmpdir(), "repo-auth-oc-nogit7-"));

    const hooks = await instantiate({
      logger: createSilentLogger(),
      cacheDir,
      cwd,
      fetchImpl: async () => {
        throw new Error("fetch must not be called for an unmanaged provider");
      }
    });

    const config = makeConfig({ gateway: { options: makeRepoAuthProviderOptions() } });
    await hooks.config?.(config);
    const output = { headers: {} as Record<string, string> };
    await hooks["chat.headers"]?.({ model: { providerID: "some-other-provider" } }, output);

    expect(output.headers.Authorization).toBeUndefined();
  });
});
