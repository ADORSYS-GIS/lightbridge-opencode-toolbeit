import { join } from "node:path";

import {
  createJsonConsoleLogger,
  DEFAULT_TOKEN_EXPIRY_SKEW_MS,
  resolveCacheRoot,
  TokenRuntime,
  type AuthServerConfig,
  type Logger,
  type TokenSet
} from "@vymalo/opencode-auth-core/lib";
import {
  FileCacheStore as SharedFileCacheStore,
  type CachedServerState
} from "@vymalo/opencode-provider-sync/lib";

import { migrateRootTokenIfNeeded } from "./migration.js";

/**
 * Legacy identity for the exchanged project-token store (UNCHANGED by
 * ADR-0017 — see `migration.ts`'s module doc for why only the ROOT token
 * relocated). Kept as a constant, not `auth.id`, because the exchanged-token
 * cache key has always been derived from this literal, independent of the
 * configured IdP's `id`.
 */
export const LIGHTBRIDGE_IDENTITY = "lightbridge";

/** Own cache namespace for the exchanged-token store — separate from oauth2/repo-auth/otel's. */
export const DEFAULT_CACHE_NAMESPACE = "opencode-lightbridge";

/**
 * ADR-0017: the human ROOT token now lives in the SAME cache file
 * `@vymalo/opencode-oauth2` uses for a server of this id —
 * `<cacheRoot>/opencode-oauth2/opencode-oauth2-model-sync/<id>.json`, a fused
 * `CachedServerState` (token + discovered models). This is what lets a
 * developer who configures the same IdP (`auth.id` == an oauth2 `servers[].id`,
 * same issuer/clientId) log in ONCE and have both plugins read/write the same
 * on-disk state. The literals are pinned here (not imported from
 * `@vymalo/opencode-oauth2`, which lightbridge does not depend on) — see
 * `docs/adr/0017-lightbridge-all-in-one.md` for the shared-contract rationale.
 */
export const ROOT_CACHE_SEGMENT = "opencode-oauth2";
export const ROOT_CACHE_NAMESPACE = "opencode-oauth2-model-sync";

/**
 * Cache key for the default-project token — used when no `projectId` is
 * configured, so the exchange sends no `project_id` and the backend mints a
 * token for the caller's default project (ADR-0012). Distinct from any real
 * project id so the two never collide in the token cache.
 */
export const DEFAULT_PROJECT_KEY = "__default__";

export interface LightbridgeRuntimeOptions {
  logger?: Logger;
  fetchImpl?: typeof fetch;
  onAuthorizationUrl?: (url: string) => Promise<void> | void;
  /** Override the cache ROOT (defaults to the OS cache dir convention) — both
   *  the shared root-token store and the exchange-only store are joined from
   *  this. Test seam; production callers omit it. */
  cacheDir?: string;
  tokenExpirySkewMs?: number;
  /**
   * Whether to perform the RFC 8693 exchange (ADR-0012) rather than use the
   * IdP access token directly as the bearer. Defaults to `false` (ADR-0017).
   */
  exchange?: boolean;
}

/**
 * The minimal surface `opencode.ts` needs from the shared runtime — narrow on
 * purpose so tests can inject a spy/fake without constructing a real
 * `TokenRuntime` (no network, no disk).
 */
export interface LightbridgeRuntimeLike {
  getProjectToken(options?: { interactive?: boolean }): Promise<TokenSet>;
  reset?(): Promise<void>;
}

/**
 * Builds a `LightbridgeRuntimeLike` for a given `(auth, projectId)` pair.
 * `projectId` is optional — `undefined` mints a default-project token.
 */
export type LightbridgeRuntimeFactory = (
  auth: AuthServerConfig,
  projectId: string | undefined,
  options: LightbridgeRuntimeOptions
) => LightbridgeRuntimeLike;

/**
 * Whether a cached project token is usable. The project token carries no
 * refresh token, so an undefined `expiresAt` must be treated as expired
 * (re-exchange), never as non-expiring.
 */
function isProjectTokenUsable(token: TokenSet | undefined, skewMs: number): token is TokenSet {
  if (!token?.accessToken) {
    return false;
  }
  if (token.expiresAt === undefined) {
    return false;
  }
  return Date.now() + skewMs < token.expiresAt;
}

/**
 * Build the ONE shared root `TokenRuntime` for `serverId`, persisting through
 * the SAME fused `CachedServerState` shape+location `ProviderModelSyncEngine`
 * uses (see `ROOT_CACHE_SEGMENT`/`ROOT_CACHE_NAMESPACE` above) — mirroring the
 * override pattern in `@vymalo/opencode-provider-sync`'s
 * `ProviderModelSyncEngine.buildTokenRuntime` (extract `.token`, preserve
 * `.models`/`.rawModels` on write) but WITHOUT running that engine's
 * scheduler/model-discovery — this is a read/refresh-only participant in the
 * shared cache file, not a second poller (see ADR-0017's double-scheduling
 * guard, enforced inside the engine itself for the `register` path).
 *
 * Unlike `ProviderModelSyncEngine`, this performs no cross-process
 * "adopt-if-newer" reconciliation — every `getCached()` call here reads disk
 * fresh and takes it as-is. That is deliberately simpler (no in-memory
 * snapshot to reconcile against) and still safe: a momentarily unreadable/
 * missing file degrades to "no cached token" (a safe, if suboptimal,
 * fallback), and refreshes are still coordinated via `TokenRuntime`'s own
 * cross-process file lock.
 */
function buildSharedRootTokenRuntime(
  serverId: string,
  auth: AuthServerConfig,
  sharedStore: SharedFileCacheStore,
  options: LightbridgeRuntimeOptions
): TokenRuntime {
  return new TokenRuntime(serverId, auth, {
    logger: options.logger,
    fetchImpl: options.fetchImpl,
    onAuthorizationUrl: options.onAuthorizationUrl,
    tokenExpirySkewMs: options.tokenExpirySkewMs,
    serviceLabel: "opencode-lightbridge",
    getCached: async () => {
      const state = await sharedStore.loadServerState(serverId);
      return state?.token;
    },
    setCached: async (token) => {
      const existing = await sharedStore.loadServerState(serverId);
      const next: CachedServerState = {
        serverId,
        updatedAt: Date.now(),
        lastSyncAt: existing?.lastSyncAt,
        models: existing?.models ?? [],
        rawModels: existing?.rawModels ?? [],
        token
      };
      await sharedStore.saveServerState(next);
    }
  });
}

/**
 * The ONE shared runtime the umbrella plugin builds (ADR-0012, amended by
 * ADR-0017): a single human login, reused as the subject token for a
 * project-scoped RFC 8693 exchange (when `gateway.exchange` is `true`) or
 * used directly as the gateway/OTEL bearer (the new default) — consumed by
 * BOTH the gateway (`chat.headers`) and OTEL (`TokenSource.headers()`).
 *
 * The human root token itself is no longer lightbridge-exclusive storage: it
 * lives in the SAME cache file `@vymalo/opencode-oauth2` writes for a server
 * of this id (`ROOT_CACHE_SEGMENT`/`ROOT_CACHE_NAMESPACE`), so configuring
 * both plugins against the same IdP (`auth.id` matching an oauth2
 * `servers[].id`, same issuer/clientId) means logging in once. An upgrading
 * install's pre-existing root token is migrated in automatically — see
 * `migration.ts`.
 */
export class LightbridgeRuntime implements LightbridgeRuntimeLike {
  private readonly rootRuntime: TokenRuntime;
  private readonly sharedStore: SharedFileCacheStore;
  private readonly exchangeRuntime: TokenRuntime;
  private readonly logger: Logger;
  private readonly tokenExpirySkewMs: number;
  private readonly exchange: boolean;
  private readonly cacheRoot: string;
  private readonly serverId: string;
  /** Token-cache key: the project id, or `DEFAULT_PROJECT_KEY` when unset. */
  private readonly projectKey: string;
  private inFlightExchange?: Promise<TokenSet>;
  private migration?: Promise<void>;

  constructor(
    auth: AuthServerConfig,
    private readonly projectId: string | undefined,
    options: LightbridgeRuntimeOptions = {}
  ) {
    this.serverId = auth.id;
    this.projectKey = projectId ?? DEFAULT_PROJECT_KEY;
    this.logger = options.logger ?? createJsonConsoleLogger("info");
    this.exchange = options.exchange ?? false;
    this.cacheRoot = options.cacheDir ?? resolveCacheRoot();
    this.tokenExpirySkewMs =
      typeof options.tokenExpirySkewMs === "number" &&
      Number.isFinite(options.tokenExpirySkewMs) &&
      options.tokenExpirySkewMs > 0
        ? options.tokenExpirySkewMs
        : DEFAULT_TOKEN_EXPIRY_SKEW_MS;

    this.sharedStore = new SharedFileCacheStore(
      join(this.cacheRoot, ROOT_CACHE_SEGMENT, ROOT_CACHE_NAMESPACE),
      this.logger
    );
    this.rootRuntime = buildSharedRootTokenRuntime(this.serverId, auth, this.sharedStore, options);

    // The exchange-only runtime keeps its OWN dedicated, lightbridge-exclusive
    // store (unchanged location/shape) — there is no oauth2 equivalent for a
    // project-scoped exchanged token, so nothing to share here.
    this.exchangeRuntime = new TokenRuntime(LIGHTBRIDGE_IDENTITY, auth, {
      logger: this.logger,
      fetchImpl: options.fetchImpl,
      onAuthorizationUrl: options.onAuthorizationUrl,
      cacheDir: join(this.cacheRoot, DEFAULT_CACHE_NAMESPACE),
      tokenExpirySkewMs: this.tokenExpirySkewMs,
      serviceLabel: "opencode-lightbridge"
    });
  }

  /**
   * One-time (per instance) migration of a pre-ADR-0017 root token into the
   * shared cache file — see `migration.ts`. Idempotent and cheap on every
   * call after the first (the underlying function also short-circuits once
   * the new location has ANY state).
   */
  private ensureMigrated(): Promise<void> {
    if (!this.migration) {
      this.migration = migrateRootTokenIfNeeded(
        this.cacheRoot,
        ROOT_CACHE_SEGMENT,
        ROOT_CACHE_NAMESPACE,
        this.serverId,
        this.logger
      ).catch((error) => {
        // Never fatal: worst case is a fresh login, same as a first-ever
        // install. Swallow so a migration hiccup can't break normal auth.
        this.logger.debug("lightbridge_root_migration_error", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    return this.migration;
  }

  /** Non-network read of the cached project token, if any. */
  async getCachedProjectToken(): Promise<TokenSet | undefined> {
    return this.exchangeRuntime.getExchangedByKey(this.projectKey);
  }

  /**
   * Resolve a usable gateway/OTEL bearer, shared by every caller (gateway
   * `chat.headers`, OTEL `TokenSource.headers()`).
   *
   * `gateway.exchange: false` (default, ADR-0017): the IdP access token IS
   * the bearer — just `ensure()` the shared root token (refresh-only unless
   * `interactive`).
   *
   * `gateway.exchange: true` (ADR-0012, unchanged):
   *
   *   cached exchanged token usable? ──yes──▶ return it
   *         │ no
   *         ▼
   *   ensure shared human root (refresh-only unless `interactive`)
   *         ▼
   *   exchangeTo(projectKey, humanToken, projectId ? { project_id } : {})
   *         ▼           (no projectId → backend picks the default project)
   *   cache + return
   *
   * Concurrent callers share the in-flight exchange in either mode. Never
   * invents a token: a failure propagates to the caller, which is expected to
   * fail closed (no header / empty `headers()`).
   */
  async getProjectToken(options: { interactive?: boolean } = {}): Promise<TokenSet> {
    await this.ensureMigrated();

    if (!this.exchange) {
      return this.rootRuntime.ensure({ interactive: options.interactive });
    }

    const cached = await this.getCachedProjectToken();
    if (isProjectTokenUsable(cached, this.tokenExpirySkewMs)) {
      this.logger.trace("lightbridge_exchange_cache_hit", { projectId: this.projectId });
      return cached;
    }
    this.logger.trace("lightbridge_exchange_cache_miss", { projectId: this.projectId });

    if (this.inFlightExchange) {
      return this.inFlightExchange;
    }

    const exchange = this.performExchange(options);
    this.inFlightExchange = exchange;
    try {
      return await exchange;
    } finally {
      if (this.inFlightExchange === exchange) {
        this.inFlightExchange = undefined;
      }
    }
  }

  private async performExchange(options: { interactive?: boolean }): Promise<TokenSet> {
    const human = await this.rootRuntime.ensure({ interactive: options.interactive });
    this.logger.info("lightbridge_exchange_started", { projectId: this.projectId ?? "(default)" });
    try {
      // No `projectId` → send no `project_id` param; the backend mints a token
      // for the caller's default project (ADR-0012).
      const exchanged = await this.exchangeRuntime.exchangeTo(
        this.projectKey,
        human.accessToken,
        this.projectId ? { project_id: this.projectId } : {}
      );
      this.logger.info("lightbridge_exchange_success", {
        projectId: this.projectId ?? "(default)"
      });
      return exchanged;
    } catch (error) {
      this.logger.error("lightbridge_exchange_failed", {
        projectId: this.projectId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Drop the cached tokens for this identity: the exchanged project token
   * entirely (its own exclusive store), and the shared root token's `token`
   * field only — NOT the whole shared cache file, which may also hold
   * `@vymalo/opencode-oauth2`'s discovered models for this server id and must
   * survive a lightbridge-side logout.
   */
  async reset(): Promise<void> {
    await this.exchangeRuntime.reset();
    const existing = await this.sharedStore.loadServerState(this.serverId);
    if (existing?.token) {
      await this.sharedStore.saveServerState({
        ...existing,
        updatedAt: Date.now(),
        token: undefined
      });
    }
  }
}

/** Absolute path to the lightbridge-exclusive (exchanged-token) cache directory. */
export function lightbridgeCacheDir(cacheRoot: string): string {
  return join(cacheRoot, DEFAULT_CACHE_NAMESPACE);
}

/** Absolute path to the SHARED root-token cache directory (ADR-0017). */
export function rootCacheDir(cacheRoot: string): string {
  return join(cacheRoot, ROOT_CACHE_SEGMENT, ROOT_CACHE_NAMESPACE);
}
