import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileCacheStore } from "../src/cache.js";
import { createOpencodeOauth2Plugin } from "../src/opencode.js";
import type { NormalizedModel } from "../src/types.js";
import { createSilentLogger } from "./helpers.js";

const SERVER_ID = "example-ai";

interface RecordedCall {
  url: string;
  grantType?: string;
}

interface FetchRecorder {
  calls: RecordedCall[];
  refreshCalls(): RecordedCall[];
  impl: typeof fetch;
}

/**
 * A fetch double that records every outbound call (and the `grant_type` of any
 * form-encoded token request) so a test can assert that a cross-process token
 * adoption happened WITHOUT a network round trip.
 *
 * The engine-level cross-process adoption tests (state-file re-read, rotation
 * adoption, fallback on missing/corrupt/stale state) now live in
 * `@vymalo/opencode-provider-sync`'s own `test/cross-process-token.test.ts`,
 * since that logic moved there (ADR-0016). This file keeps only the one case
 * that needs the FULL host-integration plugin (`createOpencodeOauth2Plugin`),
 * not just the engine.
 */
function createFetchRecorder(modelsPayload?: unknown): FetchRecorder {
  const calls: RecordedCall[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: unknown }).url);
    const body = typeof init?.body === "string" ? init.body : undefined;
    const grantType = body ? (new URLSearchParams(body).get("grant_type") ?? undefined) : undefined;
    calls.push({ url, grantType });

    if (modelsPayload !== undefined && url.includes("/models")) {
      return new Response(JSON.stringify(modelsPayload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    throw new Error(`unexpected network call in cross-process test: ${url}`);
  }) as unknown as typeof fetch;

  return {
    calls,
    refreshCalls: () => calls.filter((call) => call.grantType === "refresh_token"),
    impl
  };
}

async function writeStateFile(
  cacheDir: string,
  accessToken: string,
  refreshToken: string,
  updatedAt: number,
  models: NormalizedModel[] = [{ id: "glm-5", displayName: "GLM 5" }]
): Promise<void> {
  const store = new FileCacheStore(cacheDir);
  await store.ensureReady();
  await store.saveServerState({
    serverId: SERVER_ID,
    updatedAt,
    lastSyncAt: updatedAt,
    token: {
      accessToken,
      tokenType: "Bearer",
      refreshToken,
      expiresAt: Date.now() + 3_600_000
    },
    rawModels: models.map((model) => ({ id: model.id })),
    models
  });
}

async function tempCacheDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `opencode-oauth2-${name}-`));
}

describe("cross-process token state (shared cache file)", () => {
  it("injects the token another process rotated on the per-request chat.headers path", async () => {
    const cacheDir = await tempCacheDir("chat-headers");
    await writeStateFile(cacheDir, "process-a-initial", "refresh-1", Date.now() - 10_000);

    const recorder = createFetchRecorder();
    const factory = createOpencodeOauth2Plugin({
      cacheDir,
      logger: createSilentLogger(),
      fetchImpl: recorder.impl
    });

    const hooks = await factory({
      client: { app: { log: async () => ({ data: true }) } },
      project: { id: "project-1" },
      directory: process.cwd(),
      worktree: process.cwd(),
      serverUrl: new URL("http://127.0.0.1:3000"),
      $: {} as never
    } as never);

    const config: Record<string, unknown> = {
      provider: {
        [SERVER_ID]: {
          name: "Example AI",
          options: {
            baseURL: "https://api.example.com/v1",
            oauth2: {
              issuer: "https://auth.example.com",
              clientId: "opencode-client",
              scopes: ["openid", "offline_access"]
            }
          }
        }
      }
    };

    await hooks.config?.(config as never);

    // Process A rotates after this process already booted and cached state.
    await writeStateFile(cacheDir, "process-a-rotated", "refresh-2", Date.now());

    const output = { headers: {} as Record<string, string> };
    await hooks["chat.headers"]?.({ model: { providerID: SERVER_ID } } as never, output as never);

    expect(output.headers.Authorization).toBe("Bearer process-a-rotated");
  });
});
