import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import {
  FileCacheStore,
  hashCacheKey,
  type Logger,
  type TokenSet
} from "@vymalo/opencode-auth-core/lib";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createOpencodeRepoAuthPlugin } from "../../src/opencode.js";

const TOKEN_URL = process.env.INTEGRATION_REPO_AUTH_TOKEN_URL;

// The sealed bearer WireMock hands back for proj-123 (see
// test-env/wiremock/mappings/repo-auth-token.json).
const SEALED_MEMBER_TOKEN = "eyJhbGciOiJSUzI1NiJ9.sealed-project-bearer-for-proj-123.sig";

type OpenCodeConfig = Parameters<NonNullable<Hooks["config"]>>[0];

function logger(): Logger {
  // Silence everything by default; flip to console for debugging.
  const noop = () => undefined;
  return { trace: noop, debug: noop, info: noop, warn: noop, error: noop };
}

function pluginInput(): PluginInput {
  return { client: { app: { log: async () => undefined } } } as unknown as PluginInput;
}

function repoAuthMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const origin = new URL(TOKEN_URL ?? "http://127.0.0.1:18080").origin;
  return {
    projectId: "proj-123",
    issuer: "https://idp.example.com/realms/acme",
    clientId: "opencode-cli",
    scopes: ["openid", "offline_access"],
    authFlow: "device_code",
    pkce: false,
    tokenEndpoint: TOKEN_URL,
    deviceAuthorizationEndpoint: `${origin}/realms/acme/protocol/openid-connect/auth/device`,
    ...overrides
  };
}

function configWithProvider(providerId: string, meta: Record<string, unknown>): OpenCodeConfig {
  return {
    provider: {
      [providerId]: {
        options: { meta: { repoAuth: meta } },
        models: { "test/model": {} }
      }
    }
  } as OpenCodeConfig;
}

interface StartedPlugin {
  chatHeaders: NonNullable<Hooks["chat.headers"]>;
  /** The config object the config hook mutated (stamped Authorization). */
  mutatedConfig: OpenCodeConfig;
}

async function startPlugin(
  cacheDir: string,
  providerId: string,
  meta: Record<string, unknown>
): Promise<StartedPlugin> {
  const hooks = await createOpencodeRepoAuthPlugin({
    logger: logger(),
    cacheDir,
    cwd: tmpdir()
  })(pluginInput());
  const configHook = hooks.config;
  const chatHeaders = hooks["chat.headers"];
  if (!configHook || !chatHeaders) {
    throw new Error("plugin did not register config / chat.headers hooks");
  }
  const mutatedConfig = configWithProvider(providerId, meta);
  await configHook(mutatedConfig);
  return { chatHeaders, mutatedConfig };
}

function humanToken(): TokenSet {
  return {
    accessToken: "human-root-access-token",
    tokenType: "Bearer",
    refreshToken: "human-root-refresh-token",
    expiresAt: Date.now() + 3_600_000
  };
}

function stampedAuthorization(config: OpenCodeConfig, providerKey: string): string | undefined {
  const provider = config.provider?.[providerKey] as
    | { options?: { headers?: Record<string, string> } }
    | undefined;
  return provider?.options?.headers?.Authorization;
}

interface JournalEntry {
  body: string;
  status: number;
}

/**
 * Fetch WireMock's request journal, filtered to token-endpoint POSTs. Note:
 * WireMock serves events newest-first — never rely on array position, always
 * filter by content.
 */
async function exchangeJournal(origin: string): Promise<JournalEntry[]> {
  const res = await fetch(`${origin}/__admin/requests`);
  const payload = (await res.json()) as {
    requests?: Array<{
      request: { method?: string; url?: string; bodyAsString?: string; body?: string };
      response?: { status?: number };
    }>;
  };
  return (payload.requests ?? [])
    .filter(
      (entry) =>
        entry.request.method === "POST" &&
        (entry.request.url ?? "").includes("/protocol/openid-connect/token")
    )
    .map((entry) => ({
      body: decodeURIComponent(entry.request.bodyAsString ?? entry.request.body ?? ""),
      status: entry.response?.status ?? 0
    }));
}

describe.skipIf(!TOKEN_URL)("repo-auth ↔ WireMock integration", () => {
  const cacheDirs: string[] = [];
  const origin = new URL(TOKEN_URL ?? "http://127.0.0.1:18080").origin;

  // Per-test journal isolation: each test starts from an empty serve-event
  // log, so exchange counts are exact regardless of test order.
  beforeEach(async () => {
    await fetch(`${origin}/__admin/requests`, { method: "DELETE" });
  });

  afterAll(async () => {
    await Promise.all(cacheDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeCacheDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "opencode-repo-auth-int-"));
    cacheDirs.push(dir);
    return dir;
  }

  it("exchanges the seeded human root for a sealed project bearer over real HTTP and stamps both hooks", async () => {
    const cacheDir = await makeCacheDir();
    await new FileCacheStore(cacheDir).save("human", humanToken());

    const started = await startPlugin(cacheDir, "gateway", repoAuthMeta());

    // Config-time warmup already exchanged over the wire and stamped the
    // provider headers with the sealed project bearer.
    expect(stampedAuthorization(started.mutatedConfig, "gateway")).toBe(
      `Bearer ${SEALED_MEMBER_TOKEN}`
    );

    // The per-request surface injects the same sealed bearer.
    const output = { headers: {} as Record<string, string> };
    await started.chatHeaders({ model: { providerID: "gateway" } }, output);
    expect(output.headers.Authorization).toBe(`Bearer ${SEALED_MEMBER_TOKEN}`);

    // The wire contract of that one exchange POST: RFC 8693 grant carrying the
    // human root as subject_token + the project_id, and NO audience param.
    const journal = await exchangeJournal(origin);
    expect(journal).toHaveLength(1);
    expect(journal[0].status).toBe(200);
    expect(journal[0].body).toContain("grant_type=urn:ietf:params:oauth:grant-type:token-exchange");
    expect(journal[0].body).toContain("subject_token=human-root-access-token");
    expect(journal[0].body).toContain("project_id=proj-123");
    expect(journal[0].body).not.toContain("audience");
  });

  it("reuses the cached project bearer without another exchange", async () => {
    const cacheDir = await makeCacheDir();
    await new FileCacheStore(cacheDir).save("human", humanToken());
    const started = await startPlugin(cacheDir, "gateway", repoAuthMeta());

    // The warmup exchange is the only request so far…
    expect(await exchangeJournal(origin)).toHaveLength(1);

    // …and both subsequent chat.headers calls are pure cache hits.
    const first = { headers: {} as Record<string, string> };
    await started.chatHeaders({ model: { providerID: "gateway" } }, first);
    const second = { headers: {} as Record<string, string> };
    await started.chatHeaders({ model: { providerID: "gateway" } }, second);

    expect(second.headers.Authorization).toBe(first.headers.Authorization);
    expect(await exchangeJournal(origin)).toHaveLength(1);
  });

  it("re-exchanges when only a stale project bearer is cached", async () => {
    const cacheDir = await makeCacheDir();
    await new FileCacheStore(cacheDir).save("human", humanToken());
    // Seed an expired exchanged token under the derived project key.
    const projectKey = `human-${hashCacheKey("human:proj-123")}`;
    await new FileCacheStore(cacheDir).save(projectKey, {
      accessToken: "stale-project-bearer",
      tokenType: "Bearer",
      expiresAt: Date.now() - 60_000
    });

    // Config-time warmup detects the stale bearer and re-exchanges…
    const started = await startPlugin(cacheDir, "gateway", repoAuthMeta());
    expect(stampedAuthorization(started.mutatedConfig, "gateway")).toBe(
      `Bearer ${SEALED_MEMBER_TOKEN}`
    );

    // …and the per-request surface then serves the fresh token from cache.
    const output = { headers: {} as Record<string, string> };
    await started.chatHeaders({ model: { providerID: "gateway" } }, output);
    expect(output.headers.Authorization).toBe(`Bearer ${SEALED_MEMBER_TOKEN}`);

    const journal = await exchangeJournal(origin);
    expect(journal).toHaveLength(1);
    expect(journal[0].status).toBe(200);
    expect(journal[0].body).toContain("project_id=proj-123");
    expect(journal[0].body).not.toContain("stale-project-bearer");
  });

  it("fails closed for a non-member project: no header, hook resolves", async () => {
    const cacheDir = await makeCacheDir();
    await new FileCacheStore(cacheDir).save("human", humanToken());
    // proj-999 misses the member mapping → WireMock's catch-all answers 403.
    const started = await startPlugin(
      cacheDir,
      "gateway-other",
      repoAuthMeta({ projectId: "proj-999" })
    );

    // Config-time warmup already failed (non-interactive) → nothing stamped.
    expect(stampedAuthorization(started.mutatedConfig, "gatewayOther")).toBeUndefined();

    // The per-request hook degrades to no header instead of throwing.
    const output = { headers: {} as Record<string, string> };
    await expect(
      started.chatHeaders({ model: { providerID: "gateway-other" } }, output)
    ).resolves.toBeUndefined();
    expect(output.headers.Authorization).toBeUndefined();

    // Both attempts (warmup + chat.headers) hit the endpoint and were refused.
    const journal = await exchangeJournal(origin);
    expect(journal).toHaveLength(2);
    for (const entry of journal) {
      expect(entry.status).toBe(403);
      expect(entry.body).toContain("project_id=proj-999");
    }
  });
});
