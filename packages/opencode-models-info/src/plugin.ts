import { cacheKey, type CacheStore, FileCacheStore, isExpired } from "./cache.js";
import { parseMetaOptions } from "./config.js";
import { fetchOpenRouterModels } from "./fetcher.js";
import type { Logger } from "./logging.js";
import { isTextOnlyModality, mapOpenRouterEntry, mergeIntoModel } from "./mapping.js";
import { type SchedulerHandle, startScheduler } from "./scheduler.js";
import type { CachedModelsRecord, MetaProviderOptions, OpenRouterModel } from "./types.js";

export type ProviderOptions = Record<string, unknown> | undefined;

export interface ProviderConfigLike {
  options?: Record<string, unknown>;
  models?: Record<string, Record<string, unknown>>;
}

export interface EnrichConfigInput {
  provider?: Record<string, ProviderConfigLike>;
}

export interface EnrichDeps {
  cache: CacheStore;
  logger: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Walk every provider in the assembled OpenCode config, fetch its
 * `meta.modelsInfoUrl` (if any) — honoring the cache — and merge derived
 * metadata onto each matching model entry. Runs providers in parallel; one
 * failure never blocks others.
 */
export async function enrichConfig(input: EnrichConfigInput, deps: EnrichDeps): Promise<void> {
  const providers = input.provider;
  if (!providers) {
    deps.logger.trace("models_info_enrich_no_providers", {});
    return;
  }

  deps.logger.trace("models_info_enrich_start", {
    providerCount: Object.keys(providers).length
  });

  await Promise.allSettled(
    Object.entries(providers).map(([providerId, providerConfig]) =>
      enrichProvider(providerId, providerConfig, deps)
    )
  );
}

/**
 * Start one background refresh scheduler per opted-in provider, keeping the
 * on-disk cache warm at `meta.modelsInfoTtlSeconds` cadence (the same knob
 * that already governs cache freshness — no separate interval to configure).
 *
 * `config` only runs at plugin load and on rare config-signature changes
 * (see docs/models-info.md#periodic-refresh), so a long-lived OpenCode
 * process would otherwise keep serving whatever the catalog looked like at
 * boot until it happens to restart. This closes that gap for the *next*
 * `config` run — it cannot push a live update into an already-open session,
 * since a config hook has no way to hot-patch a running one. Callers own the
 * returned handles' lifecycle: stop them when the config that produced them
 * is superseded (a rebuilt `config` hook) or the plugin is disposed.
 */
export function startCacheRefreshSchedulers(
  input: EnrichConfigInput,
  deps: EnrichDeps
): SchedulerHandle[] {
  const providers = input.provider;
  if (!providers) {
    return [];
  }

  const handles: SchedulerHandle[] = [];
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    const opts = parseMetaOptions(providerConfig?.options);
    if (!opts) {
      continue;
    }
    const providerHeaders = asHeaderMap(providerConfig?.options?.headers);
    const intervalMs = opts.modelsInfoTtlSeconds * 1000;
    deps.logger.trace("models_info_refresh_scheduler_started", { providerId, intervalMs });
    handles.push(
      startScheduler({
        intervalMs,
        logger: deps.logger,
        taskName: `models-info-refresh:${providerId}`,
        run: () => refreshProviderCache(providerId, opts, providerHeaders, deps)
      })
    );
  }
  return handles;
}

async function enrichProvider(
  providerId: string,
  providerConfig: ProviderConfigLike | undefined,
  deps: EnrichDeps
): Promise<void> {
  try {
    if (!providerConfig) {
      deps.logger.trace("models_info_provider_no_config", { providerId });
      return;
    }
    const opts = parseMetaOptions(providerConfig.options);
    deps.logger.trace("models_info_provider_meta_parsed", {
      providerId,
      hasModelsInfoUrl: Boolean(opts)
    });
    if (!opts) {
      return;
    }
    const models = providerConfig.models;
    const modelCount = models ? Object.keys(models).length : 0;
    deps.logger.trace("models_info_provider_models_present", {
      providerId,
      hasModels: modelCount > 0,
      modelCount
    });
    if (!models || Object.keys(models).length === 0) {
      deps.logger.debug("models_info_provider_skipped_no_models", { providerId });
      return;
    }

    // Pull whatever headers the upstream config (oauth2 plugin, static API
    // key, etc.) has already attached to the provider; the meta-specific
    // `modelsInfoHeaders` win on conflict. This is what makes the plugin
    // truly auth-agnostic — we never need to know how the token was acquired.
    const providerHeaders = asHeaderMap(providerConfig.options?.headers);
    deps.logger.trace("models_info_provider_headers_resolved", {
      providerId,
      hasProviderHeaders: Boolean(providerHeaders),
      hasMetaHeaders: Boolean(opts.modelsInfoHeaders)
    });
    const record = await loadRecord(providerId, opts, providerHeaders, deps);
    if (!record) {
      deps.logger.trace("models_info_no_record", { providerId });
      return;
    }

    const byId = new Map<string, OpenRouterModel>(record.models.map((m) => [m.id, m]));
    const overwrite = opts.modelsInfoOverwrite ? new Set(opts.modelsInfoOverwrite) : undefined;
    deps.logger.trace("models_info_match_table_built", {
      providerId,
      sourceModels: record.models.length,
      overwriteFields: overwrite ? [...overwrite] : []
    });

    const totalModels = Object.keys(models).length;
    const tally = { enriched: 0, hidden: 0 };
    const reconcileCtx: ReconcileContext = { providerId, models, byId, opts, overwrite, deps };
    for (const [modelId, modelConfig] of Object.entries(models)) {
      const outcome = reconcileModel(modelId, modelConfig, reconcileCtx);
      if (outcome !== "skipped") {
        tally[outcome] += 1;
      }
    }
    const { enriched: enrichedCount, hidden: hiddenCount } = tally;

    deps.logger.trace("models_info_provider_done", {
      providerId,
      enrichedCount,
      hiddenCount,
      totalModels
    });
    deps.logger.debug("models_info_enriched", {
      providerId,
      enrichedCount,
      hiddenCount,
      totalModels,
      sourceModels: record.models.length
    });
  } catch (error) {
    // Promise.allSettled would otherwise swallow this — surface it loudly so
    // a broken cache disk or mapping bug isn't silently no-op'd per provider.
    deps.logger.error("models_info_enrichment_failed", {
      providerId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

interface ReconcileContext {
  providerId: string;
  models: Record<string, Record<string, unknown>>;
  byId: Map<string, OpenRouterModel>;
  opts: MetaProviderOptions;
  overwrite: ReadonlySet<string> | undefined;
  deps: EnrichDeps;
}

type ReconcileOutcome = "enriched" | "hidden" | "skipped";

/**
 * Decide one model's fate against the catalog and apply it in place —
 * merge, delete, or leave untouched — returning what happened for the
 * caller's tally. `modelsInfoHideTextOnly` governs both deletion paths: a
 * model absent from the catalog entirely, and a matched model the catalog
 * reports as text-in/text-out only. `modelsInfoHideInternal` is a separate,
 * independent deletion path for a matched model the catalog flags
 * `internal: true` — modality and internal/restricted status are unrelated
 * signals, and conflating them (routing "hide internal" through
 * `modelsInfoHideTextOnly`) hides legitimate text-only external models. It
 * does NOT extend the unmatched-model path — an unmatched model's status is
 * unknown, not "internal", so that stays governed solely by
 * `modelsInfoHideTextOnly`.
 */
function reconcileModel(
  modelId: string,
  modelConfig: Record<string, unknown>,
  ctx: ReconcileContext
): ReconcileOutcome {
  const { providerId, models, byId, opts, overwrite, deps } = ctx;
  const declaredId = typeof modelConfig.id === "string" ? modelConfig.id : undefined;
  const matchById = byId.has(modelId);
  const match = byId.get(modelId) ?? (declaredId ? byId.get(declaredId) : undefined);

  if (!match) {
    if (!opts.modelsInfoHideTextOnly) {
      deps.logger.trace("models_info_model_unmatched", { providerId, modelId, declaredId });
      return "skipped";
    }
    delete models[modelId];
    deps.logger.debug("models_info_model_hidden_unmatched", { providerId, modelId, declaredId });
    return "hidden";
  }

  deps.logger.trace("models_info_model_matched", {
    providerId,
    modelId,
    matchedBy: matchById ? "id" : "declaredId"
  });

  if (opts.modelsInfoHideInternal && match.internal === true) {
    delete models[modelId];
    deps.logger.debug("models_info_model_hidden_internal", { providerId, modelId });
    return "hidden";
  }

  const derived = mapOpenRouterEntry(match, overwrite);

  if (opts.modelsInfoHideTextOnly && isTextOnlyModality(derived.modalities)) {
    delete models[modelId];
    deps.logger.debug("models_info_model_hidden_text_only", { providerId, modelId });
    return "hidden";
  }

  const derivedFields = Object.keys(derived);
  const appliedFields = derivedFields.filter(
    (f) => modelConfig[f] === undefined || overwrite?.has(f)
  );
  const skippedFields = derivedFields.filter((f) => !appliedFields.includes(f));
  deps.logger.trace("models_info_model_merge", {
    providerId,
    modelId,
    derivedFields,
    appliedFields,
    skippedFields
  });
  mergeIntoModel(modelConfig, derived, overwrite);
  return "enriched";
}

async function loadRecord(
  providerId: string,
  opts: MetaProviderOptions,
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
 * entry is still within its TTL. This is the periodic-refresh path (see
 * {@link startCacheRefreshSchedulers}): `loadRecord`'s TTL fast-path exists
 * to avoid a network call from the `config` hook on every launch, but a
 * background scheduler's entire point is to go check anyway.
 */
async function refreshProviderCache(
  providerId: string,
  opts: MetaProviderOptions,
  providerHeaders: Record<string, string> | undefined,
  deps: EnrichDeps
): Promise<void> {
  const key = cacheKey(providerId, opts.modelsInfoUrl, opts.modelsInfoHeaders);
  const now = deps.now ? deps.now() : Date.now();
  const cached = await deps.cache.get(key);
  await fetchAndCache(providerId, opts, providerHeaders, deps, key, cached, now);
}

async function fetchAndCache(
  providerId: string,
  opts: MetaProviderOptions,
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
    // Apply the CURRENT TTL from config — a tightened TTL in opencode.json
    // should take effect on the next revalidation, not on the next full
    // 200 fetch (which might be 24h away).
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

  deps.logger.warn("models_info_fetch_failed_no_cache", {
    providerId,
    url: opts.modelsInfoUrl,
    error: result.error
  });
  return undefined;
}

/**
 * Merge the provider's resolved request headers with the meta-specific
 * `modelsInfoHeaders`. Meta wins on conflict so a user can override e.g. a
 * dynamic `Authorization` header for the metadata endpoint specifically.
 */
function buildFetchHeaders(
  opts: MetaProviderOptions,
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

function asHeaderMap(value: unknown): Record<string, string> | undefined {
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

export { FileCacheStore };
