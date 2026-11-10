import { join } from "node:path";

import {
  createJsonConsoleLogger,
  DEFAULT_TOKEN_EXPIRY_SKEW_MS,
  resolveStateRoot,
  TokenRuntime,
  type AuthServerConfig,
  type DeviceSignIn,
  type Logger,
  type TokenSet
} from "@vymalo/opencode-auth-core/lib";
import { ServerCredentialStore } from "@vymalo/opencode-provider-sync/lib";

/**
 * Identity for the exchanged project-token store. Kept as a constant, not
 * `auth.id`, because the exchanged-token key has always been derived from this
 * literal, independent of the configured IdP's `id`.
 */
export const LIGHTBRIDGE_IDENTITY = "lightbridge";

/**
 * Own namespace for the exchanged-token store — separate from oauth2/repo-auth/
 * otel's. It sits under the durable STATE root (ADR-0022): a project token is a
 * credential, and is re-exchangeable only while the human root token survives.
 */
export const EXCHANGE_STATE_NAMESPACE = "opencode-lightbridge";

/**
 * ADR-0017: the human ROOT token lives in the SAME credential file
 * `@vymalo/opencode-oauth2` uses for a server of this id —
 * `<stateRoot>/opencode-oauth2/opencode-oauth2-model-sync/<id>.json`
 * (ADR-0022 moved the root from the cache dir to the state dir; the relative
 * path is unchanged). This is what lets a developer who configures the same
 * IdP (`auth.id` == an oauth2 `servers[].id`, same issuer/clientId) log in ONCE
 * and have both plugins read/write the same on-disk credential. The literals
 * are pinned here (not imported from `@vymalo/opencode-oauth2`, which
 * lightbridge does not depend on) — see `docs/adr/0017-lightbridge-all-in-one.md`
 * for the shared-contract rationale. The discovered-model list for that server
 * is a separate record in the CACHE root, owned by whichever engine syncs it.
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
  /** Override the STATE root (defaults to the OS state dir convention, ADR-0022) —
   *  both the shared root-token store and the exchange-only store are joined
   *  from this. Test seam; production callers omit it. */
  stateDir?: string;
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
  /**
   * A usable gateway/OTEL bearer. NEVER interactive (ADR-0023): when no usable
   * token exists it rejects with `InteractiveAuthRequiredError` and the caller
   * fails closed. The only way a human signs in is `beginDeviceSignIn`, driven
   * from the host's Connect dialog.
   */
  getProjectToken(): Promise<TokenSet>;
  /** The shared human/IdP root token, refresh-only (never interactive). */
  ensureRootToken(): Promise<TokenSet>;
  /** Request a device code for the Connect dialog; `complete` polls and stores. */
  beginDeviceSignIn(): Promise<DeviceSignIn>;
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
 * the SAME credential record `ProviderModelSyncEngine` uses (see
 * `ROOT_CACHE_SEGMENT`/`ROOT_CACHE_NAMESPACE` above) — mirroring the override
 * pattern in `@vymalo/opencode-provider-sync`'s
 * `ProviderModelSyncEngine.buildTokenRuntime`, but WITHOUT running that
 * engine's scheduler/model-discovery — this is a read/refresh-only participant
 * in the shared credential file, not a second poller (see ADR-0017's
 * double-scheduling guard, enforced inside the engine itself for the `register`
 * path). It never touches the model-cache record, so a lightbridge-side write
 * can no longer clobber oauth2's discovered models.
 *
 * `stateDir` is the credential store's directory, so the cross-process refresh
 * lock (`<stateDir>/locks/<id>.lock`) sits beside the token it guards and is
 * the very lock oauth2's engine takes for the same id.
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
  credentials: ServerCredentialStore,
  options: LightbridgeRuntimeOptions
): TokenRuntime {
  return new TokenRuntime(serverId, auth, {
    logger: options.logger,
    fetchImpl: options.fetchImpl,
    onAuthorizationUrl: options.onAuthorizationUrl,
    tokenExpirySkewMs: options.tokenExpirySkewMs,
    serviceLabel: "opencode-lightbridge",
    stateDir: credentials.directory,
    getCached: async () => (await credentials.load(serverId))?.token,
    setCached: async (token) => {
      await credentials.save(serverId, token, Date.now());
    },
    // Compare-and-clear of a refresh token the IdP rejected is done by
    // TokenRuntime under the lock; this only performs the removal.
    clearCached: async () => {
      await credentials.remove(serverId);
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
 * lives in the SAME credential file `@vymalo/opencode-oauth2` writes for a
 * server of this id (`ROOT_CACHE_SEGMENT`/`ROOT_CACHE_NAMESPACE`, under the
 * durable state root — ADR-0022), so configuring both plugins against the same
 * IdP (`auth.id` matching an oauth2 `servers[].id`, same issuer/clientId) means
 * logging in once.
 */
export class LightbridgeRuntime implements LightbridgeRuntimeLike {
  private readonly rootRuntime: TokenRuntime;
  private readonly sharedStore: ServerCredentialStore;
  private readonly exchangeRuntime: TokenRuntime;
  private readonly logger: Logger;
  private readonly tokenExpirySkewMs: number;
  private readonly exchange: boolean;
  private readonly stateRoot: string;
  private readonly serverId: string;
  /** Token-cache key: the project id, or `DEFAULT_PROJECT_KEY` when unset. */
  private readonly projectKey: string;
  private inFlightExchange?: Promise<TokenSet>;

  constructor(
    auth: AuthServerConfig,
    private readonly projectId: string | undefined,
    options: LightbridgeRuntimeOptions = {}
  ) {
    this.serverId = auth.id;
    this.projectKey = projectId ?? DEFAULT_PROJECT_KEY;
    this.logger = options.logger ?? createJsonConsoleLogger("info");
    this.exchange = options.exchange ?? false;
    this.stateRoot = options.stateDir ?? resolveStateRoot();
    this.tokenExpirySkewMs =
      typeof options.tokenExpirySkewMs === "number" &&
      Number.isFinite(options.tokenExpirySkewMs) &&
      options.tokenExpirySkewMs > 0
        ? options.tokenExpirySkewMs
        : DEFAULT_TOKEN_EXPIRY_SKEW_MS;

    this.sharedStore = new ServerCredentialStore(rootStateDir(this.stateRoot), this.logger);
    this.rootRuntime = buildSharedRootTokenRuntime(this.serverId, auth, this.sharedStore, options);

    // The exchange-only runtime keeps its OWN dedicated, lightbridge-exclusive
    // store (unchanged location/shape) — there is no oauth2 equivalent for a
    // project-scoped exchanged token, so nothing to share here.
    this.exchangeRuntime = new TokenRuntime(LIGHTBRIDGE_IDENTITY, auth, {
      logger: this.logger,
      fetchImpl: options.fetchImpl,
      onAuthorizationUrl: options.onAuthorizationUrl,
      stateDir: lightbridgeStateDir(this.stateRoot),
      tokenExpirySkewMs: this.tokenExpirySkewMs,
      serviceLabel: "opencode-lightbridge"
    });
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
  async getProjectToken(): Promise<TokenSet> {
    if (!this.exchange) {
      return this.rootRuntime.ensure({ interactive: false });
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

    const exchange = this.performExchange();
    this.inFlightExchange = exchange;
    try {
      return await exchange;
    } finally {
      if (this.inFlightExchange === exchange) {
        this.inFlightExchange = undefined;
      }
    }
  }

  private async performExchange(): Promise<TokenSet> {
    const human = await this.rootRuntime.ensure({ interactive: false });
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

  /** See {@link LightbridgeRuntimeLike.ensureRootToken}. */
  async ensureRootToken(): Promise<TokenSet> {
    return this.rootRuntime.ensure({ interactive: false });
  }

  /**
   * The ONLY interactive entry point (ADR-0023): the root runtime requests a
   * device code and, on `complete`, stores the result through the shared
   * credential file's single writer (`setCached` under the refresh lock).
   */
  async beginDeviceSignIn(): Promise<DeviceSignIn> {
    return this.rootRuntime.beginDeviceSignIn();
  }

  /**
   * Drop the cached tokens for this identity: the exchanged project token
   * entirely (its own exclusive store), and the shared root credential. The
   * discovered-model record is a separate file in the cache root and is not
   * touched, so oauth2's models survive a lightbridge-side logout.
   */
  async reset(): Promise<void> {
    await this.exchangeRuntime.reset();
    await this.sharedStore.remove(this.serverId);
  }
}

/** Absolute path to the lightbridge-exclusive (exchanged-token) STATE directory. */
export function lightbridgeStateDir(stateRoot: string): string {
  return join(stateRoot, EXCHANGE_STATE_NAMESPACE);
}

/** Absolute path to the SHARED root-credential STATE directory (ADR-0017, ADR-0022). */
export function rootStateDir(stateRoot: string): string {
  return join(stateRoot, ROOT_CACHE_SEGMENT, ROOT_CACHE_NAMESPACE);
}

/** Absolute path to the SHARED discovered-model CACHE directory (disposable; ADR-0022). */
export function rootCacheDir(cacheRoot: string): string {
  return join(cacheRoot, ROOT_CACHE_SEGMENT, ROOT_CACHE_NAMESPACE);
}
