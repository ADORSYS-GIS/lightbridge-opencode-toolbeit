import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type CacheStore, FileCacheStore } from "../../src/cache.js";
import type { Logger } from "../../src/logging.js";
import {
  createModelsInfoEngine,
  type ListedModel,
  type ModelEditorLike
} from "../../src/plugin.js";

const INTEGRATION_URL = process.env.INTEGRATION_MODELS_INFO_URL;

function logger(): Logger {
  // Silence everything by default; flip to console for debugging.
  const noop = () => undefined;
  return { trace: noop, debug: noop, info: noop, warn: noop, error: noop };
}

/** The sentinel-filled model `@vymalo/opencode-provider-sync` discovery produces. */
function placeholder(id: string): ListedModel {
  return {
    id,
    modelID: id,
    name: id,
    capabilities: { tools: false, input: [], output: [] },
    limit: { context: 0, output: 0 },
    cost: []
  };
}

/**
 * Drive the engine the way the host does: one transform pass (starts the
 * load), wait for the catalog, a second pass (what `ctx.model.reload()` runs).
 */
async function enrich(
  providerId: string,
  settings: Record<string, unknown>,
  modelIds: string[],
  deps: { cache: CacheStore; logger: Logger }
): Promise<Map<string, ListedModel>> {
  const models = modelIds.map(placeholder);
  const editor: ModelEditorLike = {
    list: () => models,
    update: (_provider, id, fn) => {
      const model = models.find((m) => m.id === id);
      if (model) {
        fn(model);
      }
    },
    remove: () => undefined,
    provider: { list: () => [{ provider: { id: providerId, settings } }] }
  };
  const engine = createModelsInfoEngine({ ...deps, scheduler: () => ({ stop: () => undefined }) });
  engine.transform(editor);
  await engine.idle();
  engine.transform(editor);
  engine.dispose();
  return new Map(models.map((m) => [m.id, m]));
}

describe.skipIf(!INTEGRATION_URL)("models-info ↔ WireMock integration", () => {
  let cacheDir: string;

  beforeAll(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "opencode-models-info-int-"));
  });

  afterAll(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("populates limit / cost / capabilities from a live OpenRouter-shaped endpoint", async () => {
    const cache = new FileCacheStore(cacheDir);
    const out = await enrich(
      "wiremock",
      { modelsInfoUrl: INTEGRATION_URL },
      ["anthropic/claude-3.5-sonnet", "openai/gpt-4o", "test/text-only"],
      { cache, logger: logger() }
    );

    const sonnet = out.get("anthropic/claude-3.5-sonnet");
    expect(sonnet?.limit).toEqual({ context: 200_000, output: 8192 });
    expect(sonnet?.cost[0]).toMatchObject({ input: 3, output: 15, cache: { read: 0.3 } });
    expect(sonnet?.capabilities.tools).toBe(true);
    expect(sonnet?.capabilities.input).toContain("image");

    const gpt = out.get("openai/gpt-4o");
    expect(gpt?.capabilities.input).toContain("image");

    const textOnly = out.get("test/text-only");
    expect(textOnly?.capabilities.input).toEqual(["text"]);
    expect(textOnly?.cost).toEqual([{ input: 0, output: 0, cache: { read: 0, write: 0 } }]);
  });

  it("uses the disk cache on the second run and round-trips through 304", async () => {
    const cache = new FileCacheStore(cacheDir);
    const settings = { modelsInfoUrl: INTEGRATION_URL, modelsInfoTtlSeconds: 1 };
    const ids = ["anthropic/claude-3.5-sonnet"];

    // First call seeds the cache + persists the ETag from WireMock.
    await enrich("etag", settings, ids, { cache, logger: logger() });

    // Wait past the 1-second TTL so the plugin must re-fetch — WireMock's
    // ETag rule then answers with 304, and the cached models are reused.
    await new Promise((r) => setTimeout(r, 1100));

    const out = await enrich("etag", settings, ids, { cache, logger: logger() });
    expect(out.get(ids[0] as string)?.limit).toEqual({ context: 200_000, output: 8192 });
  });

  it("forwards modelsInfoHeaders — confirmed by the authenticated WireMock stub", async () => {
    const cache = new FileCacheStore(cacheDir);
    const url = new URL(INTEGRATION_URL ?? "");
    url.searchParams.set("auth", "required");

    const out = await enrich(
      "authed",
      {
        modelsInfoUrl: url.toString(),
        modelsInfoHeaders: { Authorization: "Bearer integration-test-token" }
      },
      ["anthropic/claude-3.5-sonnet"],
      { cache, logger: logger() }
    );

    expect(out.get("anthropic/claude-3.5-sonnet")?.limit).toEqual({
      context: 200_000,
      output: 8192
    });
  });

  it("falls through to a 401 error result when the required Bearer header is missing", async () => {
    const cache = new FileCacheStore(await mkdtemp(join(tmpdir(), "no-auth-")));
    const url = new URL(INTEGRATION_URL ?? "");
    url.searchParams.set("auth", "required");

    let lastWarn: { event: string; fields?: Record<string, unknown> } | undefined;
    const recordingLogger: Logger = {
      ...logger(),
      warn: (event, fields) => {
        lastWarn = { event, fields: fields as Record<string, unknown> };
      }
    };

    const out = await enrich(
      "noauth",
      { modelsInfoUrl: url.toString() },
      ["anthropic/claude-3.5-sonnet"],
      {
        cache,
        logger: recordingLogger
      }
    );

    expect(lastWarn?.event).toBe("models_info_fetch_failed_no_cache");
    expect(String(lastWarn?.fields?.error ?? "")).toMatch(/401/);
    // No cache + failed fetch → the model keeps its placeholder sentinels.
    expect(out.get("anthropic/claude-3.5-sonnet")?.limit).toEqual({ context: 0, output: 0 });
  });
});
