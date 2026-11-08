import { Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";

import { type CacheStore, FileCacheStore } from "./cache.js";
import {
  captureHostContext,
  createEffectLogger,
  DEFAULT_LOG_LEVEL,
  type Logger,
  type LogLevel,
  resolveLogLevel
} from "./logging.js";
import { createModelsInfoEngine, type ModelsInfoEngine, type ProviderEntry } from "./plugin.js";
import type { startScheduler } from "./scheduler.js";

/** Stable plugin id. v2 requires one and keys storage/registrations by it. */
export const PLUGIN_ID = "vymalo.models-info";

export interface OpenCodePluginFactoryOptions {
  /** Override the logger (tests). Defaults to the host's Effect logger. */
  logger?: Logger;
  fetchImpl?: typeof fetch;
  cache?: CacheStore;
  cacheDir?: string;
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Override the periodic-refresh scheduler (tests). */
  scheduler?: typeof startScheduler;
  /** Observe the engine the plugin built (tests). */
  onEngine?: (engine: ModelsInfoEngine) => void;
}

/** A provider record, reduced to the fields the engine reads. */
function toEntry(record: {
  readonly provider: { id: string; settings?: unknown; headers?: unknown };
}): ProviderEntry {
  const { provider } = record;
  return {
    id: provider.id,
    settings: provider.settings as Record<string, unknown> | undefined,
    headers: provider.headers as Record<string, string> | undefined
  };
}

/**
 * Build the OpenCode v2 plugin.
 *
 * Enrichment is registered with the **model domain**:
 * `ctx.model.transform(editor => …)`. Transform callbacks must be synchronous
 * and cheap, but the catalog fetch is async — so the transform never awaits. It
 * applies whichever catalogs are already in memory, and for an opted-in
 * provider with none it starts the load in the background; when that load
 * lands and the catalog actually changed, the plugin calls `ctx.model.reload()`
 * and the transform runs again with the data in hand. (v1's `config` hook could
 * simply `await` the fetch; that is the structural change.)
 *
 * The opt-in set can only be read from inside a transform
 * (`ModelEditor.provider` — `Provider.Info.settings.modelsInfoUrl`), so the
 * first fetch is initiated by the first transform run rather than before it.
 *
 * A second, read-only `ctx.provider.transform` records provider headers. It is
 * the fallback for the one unverified part of the cross-plugin Authorization
 * handoff: whether `ModelEditor.provider` reflects provider-domain transform
 * output (the bearer `oauth2` stamps on `Provider.Info.headers`).
 */
export function createOpencodeModelsInfoPlugin(
  factoryOptions: OpenCodePluginFactoryOptions = {}
): Plugin.Plugin {
  return Plugin.define({
    id: PLUGIN_ID,
    effect: Effect.fn(function* (ctx) {
      // v2 gives plugins no `config` object, so the v1 `config.logLevel`
      // channel is gone: take this plugin's own `logLevel` option first, then
      // the host's `OPENCODE_LOG_LEVEL`.
      const logLevel: LogLevel =
        resolveLogLevel(ctx.options.logLevel) ??
        resolveLogLevel(process.env.OPENCODE_LOG_LEVEL) ??
        DEFAULT_LOG_LEVEL;

      // Captured inside the plugin's own fiber so records (and the reload
      // below) run on the host's runtime, not a bare `Effect.runFork` — which
      // would log to the terminal (ADR-0014).
      const hostContext = yield* captureHostContext;
      const logger = factoryOptions.logger ?? createEffectLogger(hostContext, () => logLevel);

      const engine = createModelsInfoEngine({
        cache: factoryOptions.cache ?? new FileCacheStore(factoryOptions.cacheDir),
        logger,
        fetchImpl: factoryOptions.fetchImpl,
        now: factoryOptions.now,
        scheduler: factoryOptions.scheduler,
        onChange: () => {
          Effect.runFork(Effect.provideContext(ctx.model.reload(), hostContext));
        }
      });
      factoryOptions.onEngine?.(engine);
      yield* Effect.addFinalizer(() => Effect.sync(() => engine.dispose()));

      yield* ctx.provider.transform((editor) => {
        engine.observeProviders(editor.list().map(toEntry));
      });

      yield* ctx.model.transform((editor) => {
        engine.transform(editor);
      });
    })
  });
}

export const OpencodeModelsInfoPlugin: Plugin.Plugin = createOpencodeModelsInfoPlugin();

export default OpencodeModelsInfoPlugin;
