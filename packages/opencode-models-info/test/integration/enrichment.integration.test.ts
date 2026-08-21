import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FileCacheStore } from "../../src/cache.js";
import type { Logger } from "../../src/logging.js";
import { enrichConfig, type EnrichConfigInput } from "../../src/plugin.js";

const INTEGRATION_URL = process.env.INTEGRATION_MODELS_INFO_URL;

function logger(): Logger {
  // Silence everything by default; flip to console for debugging.
  const noop = () => undefined;
  return { trace: noop, debug: noop, info: noop, warn: noop, error: noop };
}

describe.skipIf(!INTEGRATION_URL)("models-info ↔ WireMock integration", () => {
  let cacheDir: string;

  beforeAll(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "opencode-models-info-int-"));
  });

  afterAll(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("populates limit / cost / capability flags from a live OpenRouter-shaped endpoint", async () => {
    const cache = new FileCacheStore(cacheDir);
    const config: EnrichConfigInput = {
      provider: {
        wiremock: {
          options: { meta: { modelsInfoUrl: INTEGRATION_URL } },
          models: {
            "anthropic/claude-3.5-sonnet": {},
            "openai/gpt-4o": {},
            "test/text-only": {}
          }
        }
      }
    };

    await enrichConfig(config, { cache, logger: logger() });

    const sonnet = config.provider?.wiremock.models?.["anthropic/claude-3.5-sonnet"] as
      | Record<string, unknown>
      | undefined;
    expect(sonnet?.limit).toEqual({ context: 200_000, output: 8192 });
    expect(sonnet?.cost).toMatchObject({ input: 3, output: 15, cache_read: 0.3 });
    expect(sonnet?.tool_call).toBe(true);
    expect(sonnet?.attachment).toBe(true);
    expect(sonnet?.name).toBe("Anthropic: Claude 3.5 Sonnet");

    const gpt = config.provider?.wiremock.models?.["openai/gpt-4o"] as
      | Record<string, unknown>
      | undefined;
    expect(gpt?.reasoning).toBe(true);
    expect(gpt?.attachment).toBe(true);

    const textOnly = config.provider?.wiremock.models?.["test/text-only"] as
      | Record<string, unknown>
      | undefined;
    expect(textOnly?.attachment).toBeUndefined();
    expect(textOnly?.cost).toEqual({ input: 0, output: 0 });
  });

  it("uses the disk cache on the second run and round-trips through 304", async () => {
    const cache = new FileCacheStore(cacheDir);

    // First call seeds the cache + persists the ETag from WireMock.
    const first: EnrichConfigInput = {
      provider: {
        etag: {
          options: { meta: { modelsInfoUrl: INTEGRATION_URL, modelsInfoTtlSeconds: 1 } },
          models: { "anthropic/claude-3.5-sonnet": {} }
        }
      }
    };
    await enrichConfig(first, { cache, logger: logger() });

    // Wait past the 1-second TTL so the plugin must re-fetch — WireMock's
    // ETag rule then answers with 304, and the cached models are reused.
    await new Promise((r) => setTimeout(r, 1100));

    const second: EnrichConfigInput = {
      provider: {
        etag: {
          options: { meta: { modelsInfoUrl: INTEGRATION_URL, modelsInfoTtlSeconds: 1 } },
          models: { "anthropic/claude-3.5-sonnet": {} }
        }
      }
    };
    await enrichConfig(second, { cache, logger: logger() });

    const enriched = second.provider?.etag.models?.["anthropic/claude-3.5-sonnet"] as
      | Record<string, unknown>
      | undefined;
    expect(enriched?.limit).toEqual({ context: 200_000, output: 8192 });
  });

  it("forwards provider headers — confirmed by the authenticated WireMock stub", async () => {
    const cache = new FileCacheStore(cacheDir);
    const url = new URL(INTEGRATION_URL ?? "");
    url.searchParams.set("auth", "required");

    const config: EnrichConfigInput = {
      provider: {
        authed: {
          options: {
            meta: {
              modelsInfoUrl: url.toString(),
              modelsInfoHeaders: { Authorization: "Bearer integration-test-token" }
            }
          },
          models: { "anthropic/claude-3.5-sonnet": {} }
        }
      }
    };

    await enrichConfig(config, { cache, logger: logger() });

    const enriched = config.provider?.authed.models?.["anthropic/claude-3.5-sonnet"] as
      | Record<string, unknown>
      | undefined;
    expect(enriched?.limit).toEqual({ context: 200_000, output: 8192 });
  });

  it("falls through to a 401 error result when the required Bearer header is missing", async () => {
    const cache = new FileCacheStore(await mkdtemp(join(tmpdir(), "no-auth-")));
    const url = new URL(INTEGRATION_URL ?? "");
    url.searchParams.set("auth", "required");

    let lastWarn: { event: string; fields?: Record<string, unknown> } | undefined;
    const recordingLogger: Logger = {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: (event, fields) => {
        lastWarn = { event, fields: fields as Record<string, unknown> };
      },
      error: () => undefined
    };

    const config: EnrichConfigInput = {
      provider: {
        noauth: {
          options: { meta: { modelsInfoUrl: url.toString() } },
          models: { "anthropic/claude-3.5-sonnet": {} }
        }
      }
    };

    await enrichConfig(config, { cache, logger: recordingLogger });

    expect(lastWarn?.event).toBe("models_info_fetch_failed_no_cache");
    expect(String(lastWarn?.fields?.error ?? "")).toMatch(/401/);
    // No cache + failed fetch → model entry stays bare.
    const untouched = config.provider?.noauth.models?.["anthropic/claude-3.5-sonnet"] as
      | Record<string, unknown>
      | undefined;
    expect(untouched).toEqual({});
  });
});
