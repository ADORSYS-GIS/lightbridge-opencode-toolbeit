import { randomUUID } from "node:crypto";

import {
  createJsonConsoleLogger,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_TOKEN_EXPIRY_SKEW_MS,
  isInteractiveAuthRequiredError,
  SignInNotifier,
  TokenRuntime,
  type AuthServerConfig,
  type Logger,
  type LogLevel,
  type OAuthAuthFlow,
  type SignInReporter,
  type SubjectTokenSource,
  type TokenSet
} from "@vymalo/opencode-auth-core/lib";
import {
  ServerStateStore,
  resolveCacheDir,
  resolveStateDir,
  type StoredCredential,
  type StoredModels
} from "./cache.js";
import { fetchModels } from "./model-discovery.js";
import { diffModels, normalizeModelList } from "./model-normalization.js";
import { startScheduler, type SchedulerHandle } from "./scheduler.js";
import type { CachedServerState, NormalizedModel, ServerSnapshot } from "./types.js";

/**
 * A single provider/server the engine keeps in sync — the shape a consumer's
 * OWN config layer (oauth2's `validateConfig`, or a future lightbridge
 * equivalent) is expected to have already normalized/defaulted before handing
 * it to the engine. The engine does no auth-subset validation of its own
 * (issuer/client/scopes/flow checks live in each consumer's config module,
 * layered on `@vymalo/opencode-auth-core`'s `validateAuthConfig`).
 */
export interface ProviderServerConfig {
  id: string;
  name: string;
  issuer: string;
  baseURL: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  syncIntervalMinutes: number;
  nameOverrides: Record<string, string>;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  jwksUri?: string;
  redirectPort?: number;
  authFlow: OAuthAuthFlow;
  pkce: boolean;
  subjectTokenSource?: SubjectTokenSource;
  tokenExchangeAudience?: string;
}

export interface ProviderSyncEngineConfigInput {
  servers: ProviderServerConfig[];
  /**
   * Sub-directory of the engine's cache root a consumer's servers are grouped
   * under. Defaults to a generic namespace — every real consumer should set
   * this explicitly (oauth2 does, via its own `validateConfig` default).
   */
  cacheNamespace?: string;
  httpTimeoutMs?: number;
  tokenExpirySkewMs?: number;
  logLevel?: LogLevel;
}

interface ResolvedEngineConfig {
  servers: ProviderServerConfig[];
  cacheNamespace: string;
  httpTimeoutMs: number;
  tokenExpirySkewMs: number;
  logLevel: LogLevel;
}

interface ServerRuntime {
  state: CachedServerState;
  scheduler?: SchedulerHandle;
  tokenRuntime?: TokenRuntime;
  /** Whether THIS engine instance holds the scheduler-ownership claim for this server id. */
  ownsScheduler?: boolean;
}

interface StartOptions {
  warmup?: boolean;
  /**
   * Whether warmup is allowed to open a browser / start the device-code poll
   * for first-time auth on uncached `authorization_code` / `device_code`
   * providers. Defaults to "TTY detected" — interactive in real terminals,
   * non-interactive in CI/headless contexts so startup never hangs on a
   * callback that will never arrive.
   */
  interactive?: boolean;
}

export interface ProviderModelSyncEngineOptions {
  logger?: Logger;
  fetchImpl?: typeof fetch;
  onAuthorizationUrl?: (url: string) => Promise<void> | void;
  /**
   * Exact directory for the DISPOSABLE discovered-model cache. Defaults to
   * `<cacheRoot>/<segment>/<cacheNamespace>`.
   */
  cacheDir?: string;
  /**
   * Exact directory for CREDENTIALS (the OAuth token and its `locks/` refresh
   * lock) — the durable state dir, never the OS cache dir (ADR-0022). Defaults
   * to `<stateRoot>/<segment>/<cacheNamespace>`.
   */
  stateDir?: string;
  /**
   * The on-disk segment (`<root>/<segment>/<cacheNamespace>`) this engine
   * instance's servers are stored under, under BOTH the cache root (models)
   * and the state root (credentials). Identifies the *consuming plugin* (e.g.
   * `"opencode-oauth2"`), not the engine itself — every real consumer should
   * set this explicitly so its on-disk location is stable across the plugin's
   * own history, and so plugins sharing a login resolve the same credential
   * file. Ignored for whichever of `cacheDir` / `stateDir` is set.
   */
  cacheNamespaceSegment?: string;
  /**
   * Label the runtime's default `TokenRuntime` HTTP calls carry (surfaced in
   * a handful of auth-core log events). Defaults to a generic engine label.
   */
  serviceLabel?: string;
  /**
   * Where a needed sign-in is reported (ADR-0021): a plain-TS seam the plugin
   * adapter implements over `ctx.integration`. Optional and best-effort — the
   * engine never imports the plugin API, and a failing reporter never fails a
   * sync or a request.
   */
  signInReporter?: SignInReporter;
  /**
   * Share one notifier with another `TokenRuntime` user for the same server
   * (lightbridge's root runtime), so a login completed through either clears the
   * notice the other raised. Takes precedence over `signInReporter`.
   */
  signInNotifier?: SignInNotifier;
}

const DEFAULT_CACHE_NAMESPACE = "provider-sync";
const DEFAULT_CACHE_SEGMENT = "opencode-provider-sync";
const DEFAULT_SERVICE_LABEL = "opencode-provider-sync";

/**
 * Process-wide scheduler-ownership registry, keyed by `<cacheDir>::<serverId>`.
 *
 * Two `ProviderModelSyncEngine` instances in ONE process can legitimately
 * target the same on-disk cache file — that's the whole point of the shared
 * segment/namespace convention (`@vymalo/opencode-lightbridge`'s register
 * module deliberately points at oauth2's cache location so one login serves
 * both plugins). But if BOTH instances also start a scheduler for that same
 * server id, they independently poll the same model-discovery endpoint and
 * write the same cache file on staggered ticks — wasted network traffic and
 * log noise, a failure mode the existing cross-process reconciliation logic
 * (`readCachedToken`) was never designed for (that logic assumes the *other*
 * writer is a different OS process, not a sibling engine instance sharing this
 * process's event loop).
 *
 * `start()` claims ownership of each server id it is about to schedule;
 * `stop()` releases whatever this instance holds. A losing instance simply
 * skips its own warmup sync + scheduler for that id (never throws) — it still
 * serves cached reads and on-demand `ensureAccessToken`/`syncServer` calls,
 * which are already safe to run concurrently (file-lock-coordinated refresh,
 * idempotent GETs), so its owner is not left without a token. Keyed by
 * `cacheDir` (not just `serverId`) so two engines in different cache
 * directories for the *same* server id — a deliberately non-shared
 * setup — never contend.
 */
const schedulerOwnersByKey = new Map<string, string>();

function schedulerOwnershipKey(cacheDir: string, serverId: string): string {
  return `${cacheDir}::${serverId}`;
}

function claimSchedulerOwnership(cacheDir: string, serverId: string, ownerId: string): boolean {
  const key = schedulerOwnershipKey(cacheDir, serverId);
  const existing = schedulerOwnersByKey.get(key);
  if (existing && existing !== ownerId) {
    return false;
  }
  schedulerOwnersByKey.set(key, ownerId);
  return true;
}

function releaseSchedulerOwnership(cacheDir: string, serverId: string, ownerId: string): void {
  const key = schedulerOwnershipKey(cacheDir, serverId);
  if (schedulerOwnersByKey.get(key) === ownerId) {
    schedulerOwnersByKey.delete(key);
  }
}

function resolveConfig(input: ProviderSyncEngineConfigInput): ResolvedEngineConfig {
  if (!input || !Array.isArray(input.servers) || input.servers.length === 0) {
    throw new Error("servers must be a non-empty array");
  }

  return {
    servers: input.servers,
    cacheNamespace:
      typeof input.cacheNamespace === "string" && input.cacheNamespace.trim().length > 0
        ? input.cacheNamespace.trim()
        : DEFAULT_CACHE_NAMESPACE,
    httpTimeoutMs:
      typeof input.httpTimeoutMs === "number" &&
      Number.isFinite(input.httpTimeoutMs) &&
      input.httpTimeoutMs > 0
        ? input.httpTimeoutMs
        : DEFAULT_HTTP_TIMEOUT_MS,
    tokenExpirySkewMs:
      typeof input.tokenExpirySkewMs === "number" &&
      Number.isFinite(input.tokenExpirySkewMs) &&
      input.tokenExpirySkewMs > 0
        ? input.tokenExpirySkewMs
        : DEFAULT_TOKEN_EXPIRY_SKEW_MS,
    logLevel: input.logLevel ?? DEFAULT_LOG_LEVEL
  };
}

/**
 * Engine-neutral provider registration + model-discovery runtime, extracted
 * from `@vymalo/opencode-oauth2` (which consumed it as `OAuth2ModelSyncPlugin`)
 * so a second plugin (`@vymalo/opencode-lightbridge`) can compose the same
 * cached-sync/scheduler/cross-process-token machinery without forking it.
 *
 * The engine intentionally does NOT know about:
 * - config-key literals (`pluginConfig.<key>`, `provider.options.<key>`) —
 *   those are each consumer's own config surface (see `opencode-helpers.ts`
 *   for the parsing helpers a consumer composes with its own key names);
 * - auth-subset validation — a consumer's own config module (layered on
 *   `@vymalo/opencode-auth-core`'s `validateAuthConfig`) hands the engine
 *   already-normalized `ProviderServerConfig` objects;
 * - the Responses-API SSE repair hook — that is gateway-specific and is
 *   injected by the caller via `opencode-helpers.ts`'s
 *   `applyResponsesApiOptions`, never imported here.
 */
export class ProviderModelSyncEngine {
  private readonly logger: Logger;
  private readonly config: ResolvedEngineConfig;
  private readonly cacheStore: ServerStateStore;
  private readonly runtimeByServer = new Map<string, ServerRuntime>();
  private readonly cacheDirPath: string;
  private readonly stateDirPath: string;
  private readonly signIn: SignInNotifier;
  /** Unique per-instance id for the scheduler-ownership registry (see above). */
  private readonly instanceId = randomUUID();
  private initialized = false;
  private started = false;

  constructor(
    configInput: ProviderSyncEngineConfigInput,
    private readonly options: ProviderModelSyncEngineOptions = {}
  ) {
    this.config = resolveConfig(configInput);
    this.logger = options.logger ?? createJsonConsoleLogger(this.config.logLevel);
    this.cacheDirPath =
      options.cacheDir ??
      resolveCacheDir(
        options.cacheNamespaceSegment ?? DEFAULT_CACHE_SEGMENT,
        this.config.cacheNamespace
      );
    this.stateDirPath =
      options.stateDir ??
      resolveStateDir(
        options.cacheNamespaceSegment ?? DEFAULT_CACHE_SEGMENT,
        this.config.cacheNamespace
      );
    this.cacheStore = new ServerStateStore(this.cacheDirPath, this.stateDirPath, this.logger);
    this.signIn = options.signInNotifier ?? new SignInNotifier(options.signInReporter, this.logger);
  }

  /** Resolves once every queued sign-in notice call has finished (tests, shutdown). */
  signInSettled(): Promise<void> {
    return this.signIn.settled();
  }

  /**
   * Re-read the persisted credential and reconcile it with this process's
   * in-memory copy, returning the token the next ensure/refresh decision must
   * be made against.
   *
   * Several OpenCode processes share one
   * `<state>/<segment>/<namespace>/<serverId>.json`, and a refresh token
   * is single-use: whichever process refreshed last holds the only usable
   * chain. Serving the in-memory copy (loaded once in `initialize()` and never
   * re-read) made a second process replay an already-rotated refresh token,
   * which the IdP answers with reuse detection — revoking the chain and
   * logging BOTH processes out. So the credential file, not memory, is the
   * source of truth and is re-read on every cached-token read.
   *
   * Adoption rule: the persisted credential wins unless memory is strictly
   * newer (`persisted.updatedAt >= runtime.state.updatedAt`). On adoption the
   * model record is re-read too, so the in-memory snapshot moves as one (a
   * missing or invalid model record keeps the in-memory models). Memory is kept
   * when the credential is missing, unreadable, invalid or strictly older — a
   * file without a token cannot be more authoritative about a token it does
   * not have, and honouring it would force a needless interactive re-login.
   *
   * Refresh coordination itself (single-flight, the cross-process lock, the
   * retry after a rotated-token 400) is `TokenRuntime`'s job in auth-core; this
   * method only guarantees every `getCached()` it makes sees the disk.
   */
  private async readCachedToken(serverId: string): Promise<TokenSet | undefined> {
    const runtime = this.runtimeByServer.get(serverId);
    if (!runtime) {
      return undefined;
    }

    let persisted: StoredCredential | undefined;
    try {
      persisted = await this.cacheStore.credentials.load(serverId);
    } catch (error) {
      this.logger.debug("oauth2_cache_reread_failed", {
        serverId,
        error: error instanceof Error ? error.message : String(error)
      });
      return runtime.state.token;
    }

    if (!persisted) {
      this.logger.trace("oauth2_cache_reread_no_persisted_token", {
        serverId,
        hit: false,
        hasInMemoryToken: Boolean(runtime.state.token)
      });
      return runtime.state.token;
    }

    const memoryUpdatedAt = runtime.state.updatedAt;
    if (persisted.updatedAt < memoryUpdatedAt) {
      this.logger.trace("oauth2_cache_reread_stale", {
        serverId,
        persistedUpdatedAt: persisted.updatedAt,
        memoryUpdatedAt
      });
      return runtime.state.token;
    }

    const previousToken = runtime.state.token;
    const rotated =
      persisted.token.accessToken !== previousToken?.accessToken ||
      persisted.token.refreshToken !== previousToken?.refreshToken;

    // Same stamp and same token: nothing new to adopt, skip the model re-read.
    const changed = rotated || persisted.updatedAt > memoryUpdatedAt;
    let models: StoredModels | undefined;
    if (changed) {
      try {
        models = await this.cacheStore.models.load(serverId);
      } catch {
        models = undefined;
      }
    }

    runtime.state = {
      ...runtime.state,
      updatedAt: persisted.updatedAt,
      token: persisted.token,
      ...(models
        ? { lastSyncAt: models.lastSyncAt, models: models.models, rawModels: models.rawModels }
        : {})
    };

    if (rotated) {
      // Never log token material — only whether one was present, and when the
      // snapshots carrying them were written.
      this.logger.debug("oauth2_token_adopted_from_cache", {
        serverId,
        hadInMemoryToken: Boolean(previousToken),
        persistedUpdatedAt: persisted.updatedAt,
        memoryUpdatedAt,
        modelCount: runtime.state.models.length
      });
    }

    return persisted.token;
  }

  private buildTokenRuntime(serverId: string): TokenRuntime {
    const server = this.requireServerConfig(serverId);
    const authConfig: AuthServerConfig = {
      id: server.id,
      issuer: server.issuer,
      clientId: server.clientId,
      clientSecret: server.clientSecret,
      scopes: server.scopes,
      authorizationEndpoint: server.authorizationEndpoint,
      tokenEndpoint: server.tokenEndpoint,
      deviceAuthorizationEndpoint: server.deviceAuthorizationEndpoint,
      jwksUri: server.jwksUri,
      redirectPort: server.redirectPort,
      authFlow: server.authFlow,
      pkce: server.pkce,
      subjectTokenSource: server.subjectTokenSource,
      tokenExchangeAudience: server.tokenExchangeAudience
    };

    return new TokenRuntime(server.id, authConfig, {
      logger: this.logger,
      fetchImpl: this.options.fetchImpl,
      timeoutMs: this.config.httpTimeoutMs,
      onAuthorizationUrl: this.options.onAuthorizationUrl,
      tokenExpirySkewMs: this.config.tokenExpirySkewMs,
      serviceLabel: this.options.serviceLabel ?? DEFAULT_SERVICE_LABEL,
      ...this.signIn.hooksFor(server.id, server.name || server.id),
      // The refresh lock (`<stateDir>/locks/<id>.lock`) must sit beside the
      // credential it guards, in the durable state dir (ADR-0016, ADR-0022) —
      // never in the OS cache dir the model list lives in.
      stateDir: this.stateDirPath,
      // Delegate the token persistence to the credential store. The read goes
      // to DISK every time, not to the in-memory snapshot: see
      // `readCachedToken` for why (single-use refresh tokens shared across
      // processes).
      getCached: () => this.readCachedToken(serverId),
      setCached: async (token) => {
        const runtime = this.runtimeByServer.get(serverId);
        if (!runtime) {
          return;
        }
        // Built from the CURRENT in-memory state, which `readCachedToken` may
        // have just replaced with a newer persisted snapshot — so a write never
        // resurrects the pre-adoption models/rawModels.
        const next: CachedServerState = {
          ...runtime.state,
          updatedAt: Date.now(),
          token
        };
        // Credential only (and only ever from here, under TokenRuntime's refresh
        // lock): a token rotation must not rewrite the (disposable) model cache.
        await this.cacheStore.credentials.save(serverId, token, next.updatedAt);
        runtime.state = next;
      },
      // A refresh token the IdP rejected (400) is removed from the credential
      // file (compare-and-clear, under the lock, in TokenRuntime) so it is not
      // replayed on every later call.
      clearCached: async () => {
        await this.cacheStore.credentials.remove(serverId);
        // Memory is the fallback when the file is missing (readCachedToken), so
        // drop the dead token there too or it would be replayed from memory.
        const runtime = this.runtimeByServer.get(serverId);
        if (runtime) {
          runtime.state = { ...runtime.state, token: undefined };
        }
      }
    });
  }

  private ensureTokenRuntime(serverId: string): TokenRuntime {
    const runtime = this.runtimeByServer.get(serverId);
    if (!runtime) {
      throw new Error(`runtime not initialized for server: ${serverId}`);
    }
    if (!runtime.tokenRuntime) {
      runtime.tokenRuntime = this.buildTokenRuntime(serverId);
    }
    return runtime.tokenRuntime;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.cacheStore.ensureReady();

    for (const server of this.config.servers) {
      const cached = await this.cacheStore.loadServerState(server.id);
      this.logger.trace("oauth2_cache_load", {
        serverId: server.id,
        hit: Boolean(cached),
        cachedModelCount: cached?.models.length ?? 0,
        hasCachedToken: Boolean(cached?.token)
      });
      const initialState: CachedServerState = cached ?? {
        serverId: server.id,
        updatedAt: Date.now(),
        models: [],
        rawModels: []
      };

      this.runtimeByServer.set(server.id, { state: initialState });
    }

    this.logger.debug("plugin_initialized", {
      serverCount: this.config.servers.length
    });

    this.initialized = true;
  }

  async start(options: StartOptions = {}): Promise<void> {
    if (this.started) {
      return;
    }

    await this.initialize();
    const warmup = options.warmup ?? true;
    // Warmup interactivity tracks the host process: an attached TTY (a real
    // terminal) means a user can complete an interactive flow, so warmup
    // allows browser/device-code paths if needed for first-time provider
    // setup. Without a TTY (CI, daemonized run, piped stdin) we stay
    // non-interactive so startup never hangs on a callback that will never
    // arrive. Callers can override explicitly via `interactive`.
    const interactiveWarmup =
      options.interactive ?? Boolean(process.stdin?.isTTY && process.stdout?.isTTY);

    this.logger.trace("oauth2_start", {
      serverCount: this.config.servers.length,
      warmup,
      interactiveWarmup
    });

    for (const server of this.config.servers) {
      const claimed = claimSchedulerOwnership(this.cacheDirPath, server.id, this.instanceId);
      if (!claimed) {
        // Another engine instance in THIS process already owns warmup+polling
        // for this exact cache file — see the scheduler-ownership registry
        // doc above. Never throws: this instance still serves cached reads
        // and on-demand ensureAccessToken/syncServer calls just fine.
        this.logger.debug("sync_scheduler_ownership_skipped", {
          serverId: server.id,
          reason: "already_owned_by_another_engine_instance_in_process"
        });
        continue;
      }

      const runtime = this.runtimeByServer.get(server.id);
      if (runtime) {
        runtime.ownsScheduler = true;
      }

      if (warmup) {
        try {
          await this.syncServer(server.id, { interactive: interactiveWarmup });
        } catch (error) {
          this.logger.warn("sync_startup_failed", {
            serverId: server.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      this.logger.trace("oauth2_scheduler_registered", {
        serverId: server.id,
        intervalMinutes: server.syncIntervalMinutes
      });
      const handle = startScheduler({
        intervalMs: Math.round(server.syncIntervalMinutes * 60_000),
        logger: this.logger,
        taskName: `sync:${server.id}`,
        run: async () => {
          await this.syncServer(server.id);
        }
      });

      if (runtime) {
        runtime.scheduler = handle;
      }
    }

    this.started = true;
  }

  stop(): void {
    for (const [serverId, runtime] of this.runtimeByServer.entries()) {
      runtime.scheduler?.stop();
      if (runtime.ownsScheduler) {
        releaseSchedulerOwnership(this.cacheDirPath, serverId, this.instanceId);
        runtime.ownsScheduler = false;
      }
    }

    this.started = false;
  }

  async syncAll(): Promise<ServerSnapshot[]> {
    const snapshots: ServerSnapshot[] = [];
    for (const server of this.config.servers) {
      snapshots.push(await this.syncServer(server.id));
    }
    return snapshots;
  }

  async syncServer(
    serverId: string,
    options: { interactive?: boolean } = {}
  ): Promise<ServerSnapshot> {
    const runtime = this.runtimeByServer.get(serverId);
    if (!runtime) {
      throw new Error(`runtime not initialized for server: ${serverId}`);
    }

    this.logger.debug("sync_start", { serverId, interactive: options.interactive !== false });
    const tokenRuntime = this.ensureTokenRuntime(serverId);

    const previousState = runtime.state;

    try {
      this.logger.trace("oauth2_sync_ensure_token", {
        serverId,
        hadCachedToken: Boolean(previousState.token),
        hadRefreshToken: Boolean(previousState.token?.refreshToken),
        interactive: options.interactive !== false
      });
      const token = await tokenRuntime.ensure({ interactive: options.interactive });
      this.logger.trace("oauth2_model_discovery_fetch_start", {
        serverId,
        baseURL: this.requireServerConfig(serverId).baseURL,
        tokenChanged: token.accessToken !== previousState.token?.accessToken
      });
      const rawModels = await fetchModels(this.requireServerConfig(serverId).baseURL, token, {
        fetchImpl: this.options.fetchImpl,
        timeoutMs: this.config.httpTimeoutMs,
        logger: this.logger
      });
      this.logger.trace("oauth2_model_discovery_fetch_finished", {
        serverId,
        rawModelCount: rawModels.length
      });

      const normalizedModels = normalizeModelList(
        rawModels,
        this.requireServerConfig(serverId).nameOverrides
      );
      // `previousState` is only the pre-ensure snapshot, used for the
      // added/removed/renamed diff. It is deliberately NOT the base of the
      // state we persist below.
      const diff = diffModels(previousState.models, normalizedModels);
      this.logger.trace("oauth2_model_discovery_normalized", {
        serverId,
        modelCount: normalizedModels.length,
        added: diff.added.length,
        removed: diff.removed.length,
        renamed: diff.renamed.length
      });

      // Model record ONLY. The credential is written exclusively by
      // `TokenRuntime` (`setCached`, under the refresh lock): `token` above is
      // from BEFORE the slow `/models` fetch, and writing it back could replace
      // a refresh token another process rotated meanwhile with a stale one that
      // carries a newer stamp, so the next refresh replays it and the IdP's
      // reuse detection revokes the whole chain.
      //
      // The in-memory state is based on the CURRENT `runtime.state` (which
      // `ensure()` / `readCachedToken` keep in step with the credential file)
      // and keeps its token and its `updatedAt` - the credential's stamp, which
      // a model sync must not advance.
      const nextState: CachedServerState = {
        ...runtime.state,
        lastSyncAt: Date.now(),
        rawModels,
        models: normalizedModels
      };

      await this.cacheStore.models.save(nextState);
      runtime.state = nextState;

      // Stay quiet on the steady-state happy path (no model changes), but
      // surface at `info` when the model set actually shifted so a clean
      // startup is silent while a meaningful change is still visible.
      const changed = diff.added.length + diff.removed.length + diff.renamed.length > 0;
      this.logger[changed ? "info" : "debug"]("sync_success", {
        serverId,
        modelCount: normalizedModels.length,
        added: diff.added.length,
        removed: diff.removed.length,
        renamed: diff.renamed.length
      });

      return {
        serverId,
        models: normalizedModels,
        lastSyncAt: nextState.lastSyncAt
      };
    } catch (error) {
      if (isInteractiveAuthRequiredError(error)) {
        // Expected, not a fault: non-interactive warmup (no TTY under
        // `--stdio`) refuses to open a login, so the provider's models stay
        // empty until the user logs in. A distinct event at `warn` keeps it
        // visible (the provider has no models) without filing it as an error.
        this.logger.warn("sync_skipped_needs_login", {
          serverId,
          error: error.message
        });
        this.signIn.needsLogin(serverId, this.requireServerConfig(serverId).name || serverId);
      } else {
        this.logger.error("sync_failed", {
          serverId,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      // Keep last-known-good state by not mutating runtime state.
      return {
        serverId,
        models: previousState.models,
        lastSyncAt: previousState.lastSyncAt
      };
    }
  }

  async ensureAccessToken(
    serverId: string,
    options: { interactive?: boolean } = {}
  ): Promise<TokenSet> {
    const runtime = this.runtimeByServer.get(serverId);
    if (!runtime) {
      throw new Error(`runtime not initialized for server: ${serverId}`);
    }

    const tokenRuntime = this.ensureTokenRuntime(serverId);

    // `interactive` is forwarded so config-time callers can ask for a
    // refresh-only ensure (`interactive: false`): a valid cached token is
    // returned as-is, a stale-but-refreshable one is refreshed, and anything
    // that would need a browser / device-code prompt throws instead of
    // blocking. The per-chat path leaves it unset so a real login can proceed.
    this.logger.trace("oauth2_ensure_access_token_start", {
      serverId,
      hadCachedToken: Boolean(runtime.state.token),
      hadRefreshToken: Boolean(runtime.state.token?.refreshToken),
      interactive: options.interactive !== false
    });
    const previousToken = runtime.state.token;
    const token = await tokenRuntime.ensure({ interactive: options.interactive });
    if (token.accessToken !== previousToken?.accessToken) {
      this.logger.trace("oauth2_ensure_access_token_refreshed", {
        serverId,
        present: Boolean(token.accessToken),
        expiresInSeconds:
          typeof token.expiresAt === "number"
            ? Math.max(0, Math.round((token.expiresAt - Date.now()) / 1000))
            : undefined
      });
    } else {
      this.logger.trace("oauth2_ensure_access_token_reused_cached", {
        serverId,
        present: Boolean(token.accessToken)
      });
    }

    return token;
  }

  async ensureServerReady(serverId: string): Promise<ServerSnapshot> {
    const runtime = this.runtimeByServer.get(serverId);
    if (!runtime) {
      throw new Error(`runtime not initialized for server: ${serverId}`);
    }

    if (!runtime.state.lastSyncAt || runtime.state.models.length === 0) {
      return this.syncServer(serverId);
    }

    return {
      serverId,
      models: runtime.state.models,
      lastSyncAt: runtime.state.lastSyncAt
    };
  }

  getServerModels(serverId: string): NormalizedModel[] {
    const runtime = this.runtimeByServer.get(serverId);
    if (!runtime) {
      throw new Error(`runtime not initialized for server: ${serverId}`);
    }

    return [...runtime.state.models];
  }

  getProviderModelMap(serverId: string): Record<string, { name: string }> {
    const models = this.getServerModels(serverId);
    return Object.fromEntries(models.map((model) => [model.id, { name: model.displayName }]));
  }

  getCachedToken(serverId: string): TokenSet | undefined {
    return this.runtimeByServer.get(serverId)?.state.token;
  }

  private requireServerConfig(serverId: string): ProviderServerConfig {
    const server = this.config.servers.find((item) => item.id === serverId);
    if (!server) {
      throw new Error(`unknown server id: ${serverId}`);
    }

    return server;
  }
}
