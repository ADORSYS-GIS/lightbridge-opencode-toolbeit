import { createHash } from "node:crypto";

import { cacheKey, type CacheStore, FileCacheStore, isExpired } from "./cache.js";
import { parseModelsInfoSettings } from "./config.js";
import { fetchOpenRouterModels } from "./fetcher.js";
import type { Logger } from "./logging.js";
import {
  applyMetadata,
  type EnrichableModel,
  isTextOnlyModality,
  mapOpenRouterEntry
} from "./mapping.js";
import { type SchedulerHandle, startScheduler } from "./scheduler.js";
import type { CachedModelsRecord, ModelsInfoSettings, OpenRouterModel } from "./types.js";

/** The slice of a provider record this plugin reads (`ProviderRecord.provider`). */
export interface ProviderEntry {
  id: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** A model as the editor lists it: `Model.Info`'s id fields plus the enrichable slice. */
export type ListedModel = EnrichableModel & { id: string; modelID?: string };

/**
 * The structural slice of OpenCode's `ModelEditor` the engine uses. The real
 * editor is assignable to it; tests drive it with a plain object.
 */
export interface ModelEditorLike {
  list(providerID?: string): readonly ListedModel[];
  update(providerID: string, modelID: string, update: (model: EnrichableModel) => void): void;
  remove(providerID: string, modelID: string): void;
  readonly provider: {
    list(): readonly { readonly provider: ProviderEntry }[];
  };
}

export interface EnrichDeps {
  cache: CacheStore;
  logger: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * Called when a provider's catalog changed after the model transform last
   * ran. The plugin wires it to `ctx.model.reload()`; the transform is
   * synchronous, so a catalog that arrives late can only reach the models by
   * asking the host to run the transform again.
   */
  onChange?: () => void;
  /** Override the periodic-refresh scheduler (tests). */
  scheduler?: typeof startScheduler;
}

export interface ModelsInfoEngine {
  /**
   * The `ctx.model.transform` callback body. Synchronous and cheap: reconciles
   * the opted-in set, kicks off any catalog load that is missing, and applies
   * whatever catalogs are already in memory. Never awaits.
   */
  transform(editor: ModelEditorLike): void;
  /**
   * Read-only observation from a `ctx.provider.transform`: remembers each
   * provider's headers so the model transform can fall back to them when
   * `ModelEditor.provider` does not reflect provider-domain transforms.
   */
  observeProviders(entries: readonly ProviderEntry[]): void;
  /** Resolves once every in-flight catalog load has settled. */
  idle(): Promise<void>;
  /** Stop every scheduler. Loads still in flight no longer call `onChange`. */
  dispose(): void;
}

interface ProviderState {
  providerId: string;
  opts: ModelsInfoSettings;
  /** What a refetch depends on. A change here discards the state and starts over. */
  signature: string;
  /** Latest provider headers (rotating bearer); read at fetch time, never keyed. */
  headers: Record<string, string> | undefined;
  /** Header fingerprint of the last load attempt — drives retry-on-new-credential. */
  attemptedHeaderSig: string | undefined;
  record: CachedModelsRecord | undefined;
  fingerprint: string | undefined;
  loading: Promise<void> | undefined;
  scheduler: SchedulerHandle | undefined;
}

export function createModelsInfoEngine(deps: EnrichDeps): ModelsInfoEngine {
  const states = new Map<string, ProviderState>();
  const observed = new Map<string, Record<string, string>>();
  const pending = new Set<Promise<void>>();
  const schedule = deps.scheduler ?? startScheduler;
  let disposed = false;

  const stopState = (state: ProviderState): void => {
    state.scheduler?.stop();
    state.scheduler = undefined;
  };

  /** Adopt a record; fire `onChange` only when the catalog content moved. */
  const adopt = (state: ProviderState, record: CachedModelsRecord): void => {
    if (states.get(state.providerId) !== state) {
      return; // superseded while the fetch was in flight
    }
    const fingerprint = fingerprintOf(record);
    const changed = fingerprint !== state.fingerprint;
    state.record = record;
    state.fingerprint = fingerprint;
    if (changed && !disposed) {
      deps.logger.debug("models_info_catalog_changed", {
        providerId: state.providerId,
        sourceModels: record.models.length
      });
      deps.onChange?.();
    }
  };

  const load = (state: ProviderState): void => {
    state.attemptedHeaderSig = headerSignature(state.headers);
    const task = loadRecord(state.providerId, state.opts, state.headers, deps)
      .then((record) => {
        if (record) {
          adopt(state, record);
        } else {
          deps.logger.trace("models_info_no_record", { providerId: state.providerId });
        }
      })
      .catch((error: unknown) => {
        deps.logger.error("models_info_enrichment_failed", {
          providerId: state.providerId,
          error: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        state.loading = undefined;
        pending.delete(task);
      });
    state.loading = task;
    pending.add(task);
  };

  const sync = (entries: readonly ProviderEntry[]): void => {
    const seen = new Set<string>();
    for (const entry of entries) {
      const opts = parseModelsInfoSettings(entry.settings);
      deps.logger.trace("models_info_provider_settings_parsed", {
        providerId: entry.id,
        hasModelsInfoUrl: Boolean(opts)
      });
      if (!opts) {
        continue;
      }
      seen.add(entry.id);

      // The bearer another plugin stamped. The model domain's own view of the
      // provider wins; fall back to what a provider-domain transform observed.
      const own = nonEmpty(entry.headers);
      const headers = own ?? observed.get(entry.id);
      deps.logger.trace("models_info_provider_headers_resolved", {
        providerId: entry.id,
        source: own ? "model-domain" : headers ? "provider-domain" : "none",
        hasAuthorization: hasAuthorization(headers),
        hasMetaHeaders: Boolean(opts.modelsInfoHeaders)
      });

      const signature = JSON.stringify([
        opts.modelsInfoUrl,
        opts.modelsInfoTtlSeconds,
        opts.modelsInfoTimeoutMs,
        opts.modelsInfoHeaders ?? null
      ]);
      let state = states.get(entry.id);
      if (!state || state.signature !== signature) {
        if (state) {
          stopState(state);
        }
        state = {
          providerId: entry.id,
          opts,
          signature,
          headers,
          attemptedHeaderSig: undefined,
          record: undefined,
          fingerprint: undefined,
          loading: undefined,
          scheduler: undefined
        };
        states.set(entry.id, state);
        const created = state;
        const intervalMs = opts.modelsInfoTtlSeconds * 1000;
        deps.logger.trace("models_info_refresh_scheduler_started", {
          providerId: entry.id,
          intervalMs
        });
        created.scheduler = schedule({
          intervalMs,
          logger: deps.logger,
          taskName: `models-info-refresh:${entry.id}`,
          run: async () => {
            const record = await refreshProviderCache(
              created.providerId,
              created.opts,
              created.headers,
              deps
            );
            if (record) {
              adopt(created, record);
            }
          }
        });
        load(state);
        continue;
      }

      state.opts = opts;
      state.headers = headers;
      // A load that found nothing (typically a 401 before the bearer landed)
      // is retried exactly when a different credential shows up — never in a
      // loop, since a repeat failure leaves the catalog unchanged.
      if (
        !state.record &&
        !state.loading &&
        headerSignature(headers) !== state.attemptedHeaderSig
      ) {
        load(state);
      }
    }

    for (const [providerId, state] of states) {
      if (!seen.has(providerId)) {
        stopState(state);
        states.delete(providerId);
      }
    }
  };

  const apply = (editor: ModelEditorLike): void => {
    for (const state of states.values()) {
      if (!state.record) {
        continue;
      }
      enrichProvider(editor, state, state.record, deps.logger);
    }
  };

  return {
    transform(editor) {
      deps.logger.trace("models_info_enrich_start", {});
      sync(editor.provider.list().map((record) => record.provider));
      apply(editor);
    },
    observeProviders(entries) {
      for (const entry of entries) {
        const headers = nonEmpty(entry.headers);
        if (headers) {
          observed.set(entry.id, headers);
        } else {
          observed.delete(entry.id);
        }
      }
    },
    async idle() {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    },
    dispose() {
      disposed = true;
      for (const state of states.values()) {
        stopState(state);
      }
      states.clear();
    }
  };
}

function enrichProvider(
  editor: ModelEditorLike,
  state: ProviderState,
  record: CachedModelsRecord,
  logger: Logger
): void {
  const { providerId, opts } = state;
  try {
    const models = [...editor.list(providerId)];
    if (models.length === 0) {
      logger.debug("models_info_provider_skipped_no_models", { providerId });
      return;
    }
    const byId = new Map<string, OpenRouterModel>(record.models.map((m) => [m.id, m]));
    const overwrite = opts.modelsInfoOverwrite ? new Set(opts.modelsInfoOverwrite) : undefined;
    logger.trace("models_info_match_table_built", {
      providerId,
      sourceModels: record.models.length,
      overwriteFields: overwrite ? [...overwrite] : []
    });

    const tally = { enriched: 0, hidden: 0 };
    for (const model of models) {
      const outcome = reconcileModel(editor, model, { providerId, byId, opts, overwrite, logger });
      if (outcome !== "skipped") {
        tally[outcome] += 1;
      }
    }
    logger.trace("models_info_provider_done", {
      providerId,
      enrichedCount: tally.enriched,
      hiddenCount: tally.hidden,
      totalModels: models.length
    });
    logger.debug("models_info_enriched", {
      providerId,
      enrichedCount: tally.enriched,
      hiddenCount: tally.hidden,
      totalModels: models.length,
      sourceModels: record.models.length
    });
  } catch (error) {
    // A transform callback must never throw into the host — surface it loudly
    // so a mapping bug isn't silently no-op'd per provider.
    logger.error("models_info_enrichment_failed", {
      providerId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

interface ReconcileContext {
  providerId: string;
  byId: Map<string, OpenRouterModel>;
  opts: ModelsInfoSettings;
  overwrite: ReadonlySet<string> | undefined;
  logger: Logger;
}

type ReconcileOutcome = "enriched" | "hidden" | "skipped";

/**
 * Decide one model's fate against the catalog and apply it — merge, remove, or
 * leave untouched — returning what happened for the caller's tally. Three
 * independent gates:
 *   - `modelsInfoHideTextOnly` OR `modelsInfoHideUnmatched` — a model absent
 *     from the catalog entirely gets removed. Either flag alone is enough;
 *     `modelsInfoHideTextOnly` has triggered this since 0.10.0 (unchanged,
 *     for backward compat with existing adopters) — `modelsInfoHideUnmatched`
 *     exists for a consumer that wants catalog-authoritative *membership*
 *     WITHOUT also pulling in modality-based hiding.
 *   - `modelsInfoHideInternal` — a matched model the catalog flags
 *     `internal: true` gets removed. Independent of the above: modality and
 *     internal/restricted status are unrelated signals.
 *   - `modelsInfoHideTextOnly` — a matched model the catalog reports as
 *     text-in/text-out only gets removed. Unchanged from 0.10.0.
 */
function reconcileModel(
  editor: ModelEditorLike,
  model: ListedModel,
  ctx: ReconcileContext
): ReconcileOutcome {
  const { providerId, byId, opts, overwrite, logger } = ctx;
  const modelId = model.id;
  const declaredId = model.modelID !== modelId ? model.modelID : undefined;
  const matchById = byId.has(modelId);
  const match = byId.get(modelId) ?? (declaredId ? byId.get(declaredId) : undefined);

  if (!match) {
    if (!opts.modelsInfoHideTextOnly && !opts.modelsInfoHideUnmatched) {
      logger.trace("models_info_model_unmatched", { providerId, modelId, declaredId });
      return "skipped";
    }
    editor.remove(providerId, modelId);
    logger.debug("models_info_model_hidden_unmatched", { providerId, modelId, declaredId });
    return "hidden";
  }

  logger.trace("models_info_model_matched", {
    providerId,
    modelId,
    matchedBy: matchById ? "id" : "declaredId"
  });

  if (opts.modelsInfoHideInternal && match.internal === true) {
    editor.remove(providerId, modelId);
    logger.debug("models_info_model_hidden_internal", { providerId, modelId });
    return "hidden";
  }

  const derived = mapOpenRouterEntry(match, overwrite);

  if (opts.modelsInfoHideTextOnly && isTextOnlyModality(derived)) {
    editor.remove(providerId, modelId);
    logger.debug("models_info_model_hidden_text_only", { providerId, modelId });
    return "hidden";
  }

  editor.update(providerId, modelId, (target) => {
    const { applied, skipped } = applyMetadata(target, derived, overwrite);
    logger.trace("models_info_model_merge", {
      providerId,
      modelId,
      derivedFields: Object.keys(derived),
      appliedFields: applied,
      skippedFields: skipped
    });
  });
  return "enriched";
}

async function loadRecord(
  providerId: string,
  opts: ModelsInfoSettings,
  providerHeaders: Record<string, string> | undefined,
  deps: EnrichDeps
): Promise<CachedModelsRecord | undefined> {
  // Cache key is keyed on the user-specified `modelsInfoHeaders` (NOT the
  // provider's rotating auth header) — so switching tenants busts the cache,
  // but an OAuth2 token rotation does not thrash it. See cacheKey() docstring.
  const key = cacheKey(providerId, opts.modelsInfoUrl, opts.modelsInfoHeaders);
  deps.logger.trace("models_info_cache_key_computed", { providerId, key });
  const now = deps.now ? deps.now() : Date.now();
  const cached = await deps.cache.get(key);
  deps.logger.trace("models_info_cache_lookup", {
    providerId,
    found: Boolean(cached),
    expired: cached ? isExpired(cached, now) : undefined
  });

  if (cached && !isExpired(cached, now)) {
    deps.logger.debug("models_info_cache_hit", {
      providerId,
      url: opts.modelsInfoUrl,
      ageMs: now - cached.fetchedAt
    });
    return cached;
  }

  return fetchAndCache(providerId, opts, providerHeaders, deps, key, cached, now);
}

/**
 * Unconditionally revalidates a provider's catalog against the network
 * (still honoring the `ETag`, so an unchanged catalog is a cheap `304`) and
 * writes the result back to the cache — regardless of whether the current
 * entry is still within its TTL. This is the periodic-refresh path:
 * `loadRecord`'s TTL fast-path exists to avoid a network call on every launch,
 * but a background scheduler's entire point is to go check anyway.
 */
async function refreshProviderCache(
  providerId: string,
  opts: ModelsInfoSettings,
  providerHeaders: Record<string, string> | undefined,
  deps: EnrichDeps
): Promise<CachedModelsRecord | undefined> {
  const key = cacheKey(providerId, opts.modelsInfoUrl, opts.modelsInfoHeaders);
  const now = deps.now ? deps.now() : Date.now();
  const cached = await deps.cache.get(key);
  return fetchAndCache(providerId, opts, providerHeaders, deps, key, cached, now);
}

async function fetchAndCache(
  providerId: string,
  opts: ModelsInfoSettings,
  providerHeaders: Record<string, string> | undefined,
  deps: EnrichDeps,
  key: string,
  cached: CachedModelsRecord | undefined,
  now: number
): Promise<CachedModelsRecord | undefined> {
  const headers = buildFetchHeaders(opts, providerHeaders);
  deps.logger.trace("models_info_fetch_start", {
    providerId,
    url: opts.modelsInfoUrl,
    hasHeaders: Boolean(headers),
    hasConditional: Boolean(cached?.etag)
  });
  const result = await fetchOpenRouterModels({
    url: opts.modelsInfoUrl,
    headers,
    timeoutMs: opts.modelsInfoTimeoutMs,
    etag: cached?.etag,
    fetchImpl: deps.fetchImpl
  });
  deps.logger.trace("models_info_fetch_result", {
    providerId,
    status: result.status,
    count: result.models?.length
  });

  if (result.status === "ok" && result.models) {
    const next: CachedModelsRecord = {
      fetchedAt: now,
      ttlSeconds: opts.modelsInfoTtlSeconds,
      etag: result.etag,
      models: result.models
    };
    // Disk write is best-effort — a read-only $HOME / cache dir shouldn't
    // make us throw away a perfectly good fresh response.
    await safePut(deps, key, next, providerId, opts.modelsInfoUrl);
    deps.logger.info("models_info_fetched", {
      providerId,
      url: opts.modelsInfoUrl,
      count: result.models.length
    });
    return next;
  }

  if (result.status === "not-modified" && cached) {
    // Apply the CURRENT TTL from config — a tightened TTL should take effect on
    // the next revalidation, not on the next full 200 fetch (which might be
    // 24h away).
    const refreshed: CachedModelsRecord = {
      ...cached,
      fetchedAt: now,
      ttlSeconds: opts.modelsInfoTtlSeconds
    };
    await safePut(deps, key, refreshed, providerId, opts.modelsInfoUrl);
    deps.logger.debug("models_info_not_modified", {
      providerId,
      url: opts.modelsInfoUrl
    });
    return refreshed;
  }

  if (cached) {
    deps.logger.warn("models_info_fetch_failed_using_stale", {
      providerId,
      url: opts.modelsInfoUrl,
      error: result.error,
      ageMs: now - cached.fetchedAt
    });
    return cached;
  }

  // HTTP 401 here usually means the provider's bearer had not been stamped yet
  // (see docs/models-info.md#auth-composition).
  deps.logger.warn("models_info_fetch_failed_no_cache", {
    providerId,
    url: opts.modelsInfoUrl,
    error: result.error
  });
  return undefined;
}

/**
 * Merge the provider's resolved request headers with the
 * `settings.modelsInfoHeaders`. The latter wins on conflict so a user can
 * override e.g. a dynamic `Authorization` header for the metadata endpoint
 * specifically.
 */
function buildFetchHeaders(
  opts: ModelsInfoSettings,
  providerHeaders: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!providerHeaders && !opts.modelsInfoHeaders) {
    return undefined;
  }
  return {
    ...(providerHeaders ?? {}),
    ...(opts.modelsInfoHeaders ?? {})
  };
}

async function safePut(
  deps: EnrichDeps,
  key: string,
  record: CachedModelsRecord,
  providerId: string,
  url: string
): Promise<void> {
  try {
    await deps.cache.put(key, record);
  } catch (error) {
    deps.logger.warn("models_info_cache_write_failed", {
      providerId,
      url,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/** Non-empty string headers only; `undefined` when there are none. */
function nonEmpty(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function hasAuthorization(headers: Record<string, string> | undefined): boolean {
  return headers
    ? Object.keys(headers).some((key) => key.toLowerCase() === "authorization")
    : false;
}

function headerSignature(headers: Record<string, string> | undefined): string {
  return headers ? JSON.stringify(Object.entries(headers).sort()) : "";
}

function fingerprintOf(record: CachedModelsRecord): string {
  return createHash("sha1").update(JSON.stringify(record.models)).digest("hex");
}

export { FileCacheStore };
