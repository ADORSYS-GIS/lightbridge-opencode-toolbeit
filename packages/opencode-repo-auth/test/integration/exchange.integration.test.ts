import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "@opencode/plugin/effect";
import {
  FileCacheStore,
  hashCacheKey,
  type Logger,
  type TokenSet
} from "@vymalo/opencode-auth-core/lib";
import { Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createOpencodeRepoAuthPlugin } from "../../src/opencode.js";

const TOKEN_URL = process.env.INTEGRATION_REPO_AUTH_TOKEN_URL;

// The sealed bearer WireMock hands back for proj-123 (see
// test-env/wiremock/mappings/repo-auth-token.json).
const SEALED_MEMBER_TOKEN = "eyJhbGciOiJSUzI1NiJ9.sealed-project-bearer-for-proj-123.sig";

function logger(): Logger {
  // Silence everything by default; flip to console for debugging.
  const noop = () => undefined;
  return { trace: noop, debug: noop, info: noop, warn: noop, error: noop };
}

function repoAuthSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const origin = new URL(TOKEN_URL ?? "http://127.0.0.1:18080").origin;
  return {
    repoAuth: {
      projectId: "proj-123",
      issuer: "https://idp.example.com/realms/acme",
      clientId: "opencode-cli",
      scopes: ["openid", "offline_access"],
      authFlow: "device_code",
      pkce: false,
      tokenEndpoint: TOKEN_URL,
      deviceAuthorizationEndpoint: `${origin}/realms/acme/protocol/openid-connect/auth/device`,
      ...overrides
    }
  };
}

interface FakeProvider {
  id: string;
  settings: Record<string, unknown>;
  headers?: Record<string, string>;
}

interface StartedPlugin {
  /** The provider record as stamped by the transform (headers filled by the warmup). */
  provider: FakeProvider;
  /** Wait for the load-time bearer warmup (reloaded on success; a quiet wait on failure). */
  settle: (expectReload: boolean) => Promise<void>;
  /** Fire `model.request` for a provider and return the mutated headers. */
  modelRequest: (providerID: string) => Promise<Record<string, string>>;
}

async function startPlugin(
  stateDir: string,
  providerId: string,
  overrides: Record<string, unknown> = {}
): Promise<StartedPlugin> {
  let transformCb: ((editor: unknown) => void) | undefined;
  let modelRequestHook: ((event: Record<string, unknown>) => Effect.Effect<void>) | undefined;
  let reloads = 0;
  const provider: FakeProvider = { id: providerId, settings: repoAuthSettings(overrides) };
  const editor = {
    list: () => [{ provider }],
    get: () => ({ provider }),
    update: (_id: string, fn: (p: FakeProvider) => void) => fn(provider)
  };
  const registration = Effect.succeed({ dispose: Effect.void });
  const ctx = {
    options: {},
    location: { directory: tmpdir() },
    provider: {
      transform: (cb: (editor: unknown) => void) => {
        transformCb = cb;
        return registration;
      },
      reload: () =>
        Effect.sync(() => {
          reloads += 1;
          transformCb?.(editor);
        })
    },
    session: {
      hook: (name: string, cb: (event: Record<string, unknown>) => Effect.Effect<void>) => {
        if (name === "model.request") {
          modelRequestHook = cb;
        }
        return registration;
      }
    }
  } as unknown as Plugin.Context;

  await Effect.runPromise(
    Effect.scoped(
      createOpencodeRepoAuthPlugin({ logger: logger(), stateDir, cwd: tmpdir() }).effect(ctx)
    )
  );
  if (!transformCb || !modelRequestHook) {
    throw new Error("plugin did not register provider.transform / model.request");
  }
  transformCb(editor);
  const hook = modelRequestHook;
  return {
    provider,
    settle: async (expectReload) => {
      for (let i = 0; i < 100 && expectReload && reloads === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!expectReload) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    },
    modelRequest: async (providerID) => {
      const headers: Record<string, string> = { ...provider.headers };
      await Effect.runPromise(hook({ model: { providerID, id: "test/model" }, headers }));
      return headers;
    }
  };
}

function humanToken(): TokenSet {
  return {
    accessToken: "human-root-access-token",
    tokenType: "Bearer",
    refreshToken: "human-root-refresh-token",
    expiresAt: Date.now() + 3_600_000
  };
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

  it("exchanges the seeded human root for a sealed bearer over real HTTP, stamps it, and injects it per request", async () => {
    const stateDir = await makeCacheDir();
    await new FileCacheStore(stateDir).save("human", humanToken());

    const started = await startPlugin(stateDir, "gateway");
    await started.settle(true);

    // The load-time warmup exchanged (outside the transform) and the reload
    // stamped Provider.Info.headers with the sealed project bearer.
    expect(started.provider.headers?.Authorization).toBe(`Bearer ${SEALED_MEMBER_TOKEN}`);

    // The per-request surface injects the same sealed bearer from cache.
    const headers = await started.modelRequest("gateway");
    expect(headers.Authorization).toBe(`Bearer ${SEALED_MEMBER_TOKEN}`);

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
    const stateDir = await makeCacheDir();
    await new FileCacheStore(stateDir).save("human", humanToken());
    const started = await startPlugin(stateDir, "gateway");
    await started.settle(true);

    // The warmup exchange is the only request so far…
    expect(await exchangeJournal(origin)).toHaveLength(1);

    // …and both subsequent model requests are pure cache hits.
    const first = await started.modelRequest("gateway");
    const second = await started.modelRequest("gateway");

    expect(second.Authorization).toBe(first.Authorization);
    expect(await exchangeJournal(origin)).toHaveLength(1);
  });

  it("re-exchanges when only a stale project bearer is cached", async () => {
    const stateDir = await makeCacheDir();
    await new FileCacheStore(stateDir).save("human", humanToken());
    // Seed an expired exchanged token under the derived project key.
    const projectKey = `human-${hashCacheKey("human:proj-123")}`;
    await new FileCacheStore(stateDir).save(projectKey, {
      accessToken: "stale-project-bearer",
      tokenType: "Bearer",
      expiresAt: Date.now() - 60_000
    });

    // The warmup detects the stale bearer and re-exchanges…
    const started = await startPlugin(stateDir, "gateway");
    await started.settle(true);
    expect(started.provider.headers?.Authorization).toBe(`Bearer ${SEALED_MEMBER_TOKEN}`);

    // …and the per-request surface then serves the fresh token from cache.
    const headers = await started.modelRequest("gateway");
    expect(headers.Authorization).toBe(`Bearer ${SEALED_MEMBER_TOKEN}`);

    const journal = await exchangeJournal(origin);
    expect(journal).toHaveLength(1);
    expect(journal[0].status).toBe(200);
    expect(journal[0].body).toContain("project_id=proj-123");
    expect(journal[0].body).not.toContain("stale-project-bearer");
  });

  it("fails closed for a non-member project: nothing stamped, no header, hook resolves", async () => {
    const stateDir = await makeCacheDir();
    await new FileCacheStore(stateDir).save("human", humanToken());
    // proj-999 misses the member mapping → WireMock's catch-all answers 403.
    const started = await startPlugin(stateDir, "gateway-other", { projectId: "proj-999" });
    await started.settle(false);

    // The warmup failed (non-interactive) → nothing stamped.
    expect(started.provider.headers).toBeUndefined();

    // The per-request hook degrades to no header instead of throwing.
    const headers = await started.modelRequest("gateway-other");
    expect(headers.Authorization).toBeUndefined();

    // Both attempts (warmup + model.request) hit the endpoint and were refused.
    const journal = await exchangeJournal(origin);
    expect(journal).toHaveLength(2);
    for (const entry of journal) {
      expect(entry.status).toBe(403);
      expect(entry.body).toContain("project_id=proj-999");
    }
  });
});
