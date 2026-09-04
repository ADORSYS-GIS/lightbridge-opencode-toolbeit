import {
  createJsonConsoleLogger,
  TokenRuntime,
  type AuthServerConfig,
  type Logger,
  type TokenSet
} from "@vymalo/opencode-auth-core/lib";
import { FileCacheStore, resolveCacheDir } from "./cache.js";
import { type OAuth2ModelSyncConfigInput, validateConfig } from "./config.js";
import { fetchModels } from "./model-discovery.js";
import { diffModels, normalizeModelList } from "./model-normalization.js";
import { startScheduler, type SchedulerHandle } from "./scheduler.js";
import type { CachedServerState, NormalizedModel, ServerSnapshot } from "./types.js";

interface ServerRuntime {
  state: CachedServerState;
  scheduler?: SchedulerHandle;
  tokenRuntime?: TokenRuntime;
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

export interface PluginOptions {
  logger?: Logger;
  fetchImpl?: typeof fetch;
  onAuthorizationUrl?: (url: string) => Promise<void> | void;
  cacheDir?: string;
}

export class OAuth2ModelSyncPlugin {
  private readonly logger: Logger;
  private readonly config;
  private readonly cacheStore: FileCacheStore;
  private readonly runtimeByServer = new Map<string, ServerRuntime>();
  private initialized = false;
  private started = false;

  constructor(
    private readonly configInput: OAuth2ModelSyncConfigInput,
    private readonly options: PluginOptions = {}
  ) {
    this.config = validateConfig(this.configInput);
    this.logger = options.logger ?? createJsonConsoleLogger(this.config.logLevel);
    this.cacheStore = new FileCacheStore(
      options.cacheDir ?? resolveCacheDir(this.config.cacheNamespace),
      this.logger
    );
  }

  /**
   * Re-read the persisted per-server state and reconcile it with this
   * process's in-memory copy, returning the token the next ensure/refresh
   * decision must be made against.
   *
   * Several OpenCode processes share one
   * `<cache>/opencode-oauth2/<namespace>/<serverId>.json`, and a refresh token
   * is single-use: whichever process refreshed last holds the only usable
   * chain. Serving the in-memory copy (loaded once in `initialize()` and never
   * re-read) made a second process replay an already-rotated refresh token,
   * which the IdP answers with reuse detection — revoking the chain and
   * logging BOTH processes out. So the state file, not memory, is the source
   * of truth and is re-read on every cached-token read.
   *
   * Adoption rule: the persisted state wins unless memory is strictly newer
   * (`persisted.updatedAt >= runtime.state.updatedAt`), and it is adopted
   * WHOLESALE — token, models, rawModels, lastSyncAt together. A field-by-field
   * merge would pair one process's token with another's model list; the file is
   * a single consistent snapshot and is taken as one. Memory is kept when the
   * file is missing, unreadable, invalid, strictly older, or carries no token —
   * a tokenless file cannot be more authoritative about a token it does not
   * have, and honouring it would force a needless interactive re-login.
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

    let persisted: CachedServerState | undefined;
    try {
      persisted = await this.cacheStore.loadServerState(serverId);
    } catch (error) {
      this.logger.debug("oauth2_cache_reread_failed", {
        serverId,
        error: error instanceof Error ? error.message : String(error)
      });
      return runtime.state.token;
    }

    if (!persisted?.token) {
      this.logger.trace("oauth2_cache_reread_no_persisted_token", {
        serverId,
        hit: Boolean(persisted),
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

    runtime.state = persisted;

    if (rotated) {
      // Never log token material — only whether one was present, and when the
      // snapshots carrying them were written.
      this.logger.debug("oauth2_token_adopted_from_cache", {
        serverId,
        hadInMemoryToken: Boolean(previousToken),
        persistedUpdatedAt: persisted.updatedAt,
        memoryUpdatedAt,
        modelCount: persisted.models.length
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
      serviceLabel: "opencode-oauth2",
      // Delegate the token cache to oauth2's fused CachedServerState so the
      // on-disk location and shape are preserved (tests + existing installs).
      // The read goes to DISK every time, not to the in-memory snapshot: see
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
        await this.cacheStore.saveServerState(next);
        runtime.state = next;
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

      const runtime = this.runtimeByServer.get(server.id);
      if (runtime) {
        runtime.scheduler = handle;
      }
    }

    this.started = true;
  }

  stop(): void {
    for (const runtime of this.runtimeByServer.values()) {
      runtime.scheduler?.stop();
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

      // Base the write on the CURRENT in-memory state, not on `previousState`:
      // `ensure()` re-reads the shared state file and may have adopted a newer
      // snapshot another process wrote (see `readCachedToken`), and spreading
      // the pre-ensure snapshot would silently roll that back.
      const nextState: CachedServerState = {
        ...runtime.state,
        updatedAt: Date.now(),
        lastSyncAt: Date.now(),
        token,
        rawModels,
        models: normalizedModels
      };

      await this.cacheStore.saveServerState(nextState);
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
      this.logger.error("sync_failed", {
        serverId,
        error: error instanceof Error ? error.message : String(error)
      });

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

  private requireServerConfig(serverId: string) {
    const server = this.config.servers.find((item) => item.id === serverId);
    if (!server) {
      throw new Error(`unknown server id: ${serverId}`);
    }

    return server;
  }
}
