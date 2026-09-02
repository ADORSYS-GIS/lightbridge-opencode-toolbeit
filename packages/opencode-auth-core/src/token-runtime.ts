import { join } from "node:path";

import { FileCacheStore, hashCacheKey, resolveCacheDir } from "./cache.js";
import type { AuthServerConfig } from "./config.js";
import { validateAuthConfig } from "./config.js";
import type { FileLock } from "./lock.js";
import { DEFAULT_LOCK_STALE_MS, acquireFileLock } from "./lock.js";
import type { Logger } from "./logging.js";
import { createJsonConsoleLogger } from "./logging.js";
import { OAuthClient, RefreshTokenError } from "./oauth/client.js";
import type { TokenSet } from "./types.js";

export interface TokenRuntimeOptions {
  logger?: Logger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onAuthorizationUrl?: (url: string) => Promise<void> | void;
  tokenExpirySkewMs?: number;
  /**
   * Cache namespace for the identity-keyed on-disk token cache. Default
   * `"tokens"`. Ignored when `getCached` / `setCached` are supplied.
   */
  cacheNamespace?: string;
  cacheDir?: string;
  /**
   * Override the cached-token read. When supplied, the runtime stores nothing
   * on disk itself; the caller owns persistence (e.g. oauth2's fused
   * CachedServerState). Defaults to reading from this runtime's file cache.
   *
   * These overrides cover only the **identity-root token** (what `ensure` /
   * `refresh` produce). Exchanged tokens always live in this runtime's default
   * file store under a derived `identity-<hash(identity:key)>` key — see
   * `exchangeTo` / `exchangeToAudience` — because the override interface carries
   * no exchange-key dimension and routing an exchanged token through it would
   * clobber the caller's root token (e.g. overwrite oauth2's
   * `CachedServerState.token`).
   */
  getCached?: () => Promise<TokenSet | undefined>;
  /**
   * Override the cached-token write. See `getCached`.
   */
  setCached?: (token: TokenSet) => Promise<void>;
  /**
   * How long a cross-process refresh lock may sit untouched before another
   * process treats it as abandoned and breaks it. Default 30s — it must
   * exceed `timeoutMs` (the HTTP timeout of the refresh the lock guards,
   * 15s by default) so a slow-but-alive holder is never robbed of its lock.
   * The total wait is bounded at this value plus a small margin, after which
   * the runtime proceeds unlocked rather than hanging the caller.
   */
  lockStaleMs?: number;
}

/**
 * Identity-keyed token lifecycle. A `TokenRuntime` is scoped to a single
 * `identity` (e.g. a provider server id, or a repo Source id for repo-auth)
 * and holds exactly one `OAuthClient` + a persistent file cache for that
 * identity. This is the shared primitive both plugins build on: "give me a
 * valid token for this identity, refreshing / exchanging as needed."
 */
export class TokenRuntime {
  private readonly identity: string;
  private readonly config: AuthServerConfig;
  private readonly client: OAuthClient;
  private readonly cacheStore: FileCacheStore;
  private readonly logger: Logger;
  private readonly getCachedOverride?: () => Promise<TokenSet | undefined>;
  private readonly setCachedOverride?: (token: TokenSet) => Promise<void>;
  private readonly lockStaleMs: number;
  /**
   * In-process single-flight slot. Every concurrent `ensure` that finds the
   * cached token unusable joins the one refresh already running for this
   * runtime instead of sending its own — N callers, one refresh token
   * presented once.
   */
  private inFlight?: Promise<TokenSet>;
  private lockUnwritableLogged = false;

  constructor(identity: string, auth: AuthServerConfig, options: TokenRuntimeOptions = {}) {
    this.identity = identity;
    this.config = validateAuthConfig(auth);
    this.logger = options.logger ?? createJsonConsoleLogger("info");
    this.getCachedOverride = options.getCached;
    this.setCachedOverride = options.setCached;

    this.lockStaleMs =
      typeof options.lockStaleMs === "number" &&
      Number.isFinite(options.lockStaleMs) &&
      options.lockStaleMs > 0
        ? options.lockStaleMs
        : DEFAULT_LOCK_STALE_MS;

    const cacheDir = options.cacheDir ?? resolveCacheDir(options.cacheNamespace ?? "tokens");
    this.cacheStore = new FileCacheStore(cacheDir, this.logger);

    this.client = new OAuthClient(this.config, {
      fetchImpl: options.fetchImpl,
      logger: this.logger,
      timeoutMs: options.timeoutMs ?? 15_000,
      onAuthorizationUrl: options.onAuthorizationUrl,
      tokenExpirySkewMs: options.tokenExpirySkewMs
    });
  }

  private cacheKey(): string {
    return this.identity;
  }

  /**
   * File-cache key for an exchanged token. The identity prefix is joined to a
   * hash of the *identity:key pair* with a `-` (not `:`): NTFS reserves `:` in
   * filenames and POSIX treats `/` as a separator, so a raw key (an audience
   * URL, a project id, …) or even a `:`-joined identity prefix would silently
   * break the on-disk path on some platforms. Hashing the pair keeps different
   * identities's exchanges for the same `key` from colliding. See
   * `hashCacheKey`.
   */
  private exchangeCacheKey(key: string): string {
    return `${this.identity}-${hashCacheKey(`${this.identity}:${key}`)}`;
  }

  async getCached(): Promise<TokenSet | undefined> {
    if (this.getCachedOverride) {
      return this.getCachedOverride();
    }
    return this.cacheStore.load<TokenSet>(this.cacheKey());
  }

  private async persist(token: TokenSet): Promise<void> {
    if (this.setCachedOverride) {
      return this.setCachedOverride(token);
    }
    await this.cacheStore.save(this.cacheKey(), token);
  }

  /**
   * Ensure a valid token for this identity. Returns the cached token if still
   * valid, refreshes a stale-but-refreshable one, and performs an interactive
   * (browser / device-code) or machine flow otherwise.
   *
   * `interactive: false` refuses to open a browser / start device polling —
   * it throws instead, so config-time / warmup callers never block on a
   * callback that will never arrive.
   *
   * Refreshing is coordinated, because an IdP with single-use rotating refresh
   * tokens plus reuse detection (RFC 6819 §5.2.2.3) revokes the whole chain
   * when a rotated token is replayed — one replay logs every process out:
   *
   *   1. concurrent calls in this process share one in-flight refresh;
   *   2. across processes, the refresh runs under an advisory lock file in
   *      this runtime's cache directory;
   *   3. inside the lock the cache is re-read, so a token another process
   *      persisted meanwhile is adopted instead of refreshed again;
   *   4. a 4xx refusal triggers one more re-read (and one retry with a newer
   *      refresh token) before any interactive login is considered.
   *
   * The valid-cached-token fast path takes no lock at all.
   */
  async ensure(options: { interactive?: boolean } = {}): Promise<TokenSet> {
    const cached = await this.getCached();
    if (this.client.isTokenValid(cached)) {
      return cached as TokenSet;
    }

    const existing = this.inFlight;
    if (existing) {
      this.logger.debug("token_refresh_joined_in_flight", { identity: this.identity });
      return existing;
    }

    const pending = this.acquireCoordinated(cached, options.interactive).finally(() => {
      if (this.inFlight === pending) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = pending;
    return pending;
  }

  /**
   * Lock path for this identity's refresh. A sibling `locks/` directory of the
   * cache entries themselves, so two processes sharing a cache dir (the whole
   * point) share the lock, and so a cache directory that happens to be
   * unwritable for locks does not take the token cache down with it.
   */
  private lockPath(): string {
    return join(this.cacheStore.directory, "locks", `${this.cacheKey()}.lock`);
  }

  private async acquireRefreshLock(): Promise<FileLock> {
    const lock = await acquireFileLock(this.lockPath(), {
      staleMs: this.lockStaleMs,
      logger: this.logger,
      logFields: { identity: this.identity }
    });

    if (!lock.acquired) {
      // An unwritable lock directory is a permanent property of the
      // filesystem — warn once, then stay quiet rather than emitting a line
      // per request. A timeout is a transient event and always worth a line.
      const permanent = lock.reason === "unwritable";
      if (!permanent || !this.lockUnwritableLogged) {
        this.lockUnwritableLogged = this.lockUnwritableLogged || permanent;
        this.logger.warn("token_lock_unavailable", {
          identity: this.identity,
          reason: lock.reason
        });
      }
    }

    return lock;
  }

  /**
   * The refresh path proper, run under the advisory lock. `snapshot` is what
   * the caller already read before the lock was taken; it is only a fallback,
   * because the whole point of the re-read is that it may be stale.
   *
   * An interactive login runs under the lock too. That can outlast
   * `lockStaleMs` — by design: the lock then reads as abandoned and another
   * process breaks it, which is the right outcome, since a human sitting on a
   * browser prompt must not block every other process from refreshing.
   */
  private async acquireCoordinated(
    snapshot: TokenSet | undefined,
    interactive?: boolean
  ): Promise<TokenSet> {
    const lock = await this.acquireRefreshLock();
    try {
      const reread = await this.getCached();
      if (this.client.isTokenValid(reread)) {
        this.logger.info("token_refresh_adopted_persisted", {
          identity: this.identity,
          stage: "lock_entry"
        });
        return reread as TokenSet;
      }

      return await this.refreshOrLogin(reread ?? snapshot, interactive);
    } finally {
      await lock.release();
    }
  }

  private async refreshOrLogin(
    base: TokenSet | undefined,
    interactive?: boolean
  ): Promise<TokenSet> {
    let refreshAttempted = false;

    if (base?.refreshToken && this.client.usesRefreshToken()) {
      refreshAttempted = true;
      try {
        return await this.persisted(await this.client.refreshToken(base.refreshToken));
      } catch (error) {
        this.logger.warn("oauth_refresh_failed", {
          serverId: this.config.id,
          identity: this.identity,
          error: error instanceof Error ? error.message : String(error)
        });

        const rejected =
          error instanceof RefreshTokenError && error.status >= 400 && error.status < 500;
        if (rejected) {
          const recovered = await this.recoverFromRejectedRefresh(base);
          if (recovered) {
            return recovered;
          }
        }
      }
    }

    // A refresh token we already presented and that was refused (or that the
    // IdP has rotated away) must never be presented a second time — replaying
    // it is exactly what trips reuse detection. Strip it so the client's own
    // refresh branch is skipped and it goes straight to the login it needs.
    const fallback = refreshAttempted && base ? { ...base, refreshToken: undefined } : base;
    const token = await this.client.ensureToken(fallback, { interactive });
    if (token.accessToken !== base?.accessToken) {
      await this.persist(token);
    }
    return token;
  }

  /**
   * A 4xx on refresh usually means another process already rotated this chain
   * forward. Re-read once: adopt its access token if that is now valid, else
   * retry exactly once with the newer refresh token it persisted. Returns
   * `undefined` when nothing newer exists, leaving the caller to fall through
   * to its normal (interactive) login.
   */
  private async recoverFromRejectedRefresh(base: TokenSet): Promise<TokenSet | undefined> {
    const newer = await this.getCached();
    if (this.client.isTokenValid(newer)) {
      this.logger.info("token_refresh_adopted_persisted", {
        identity: this.identity,
        stage: "after_rejection"
      });
      return newer as TokenSet;
    }

    if (!newer?.refreshToken || newer.refreshToken === base.refreshToken) {
      return undefined;
    }

    this.logger.info("token_refresh_retry_with_newer", { identity: this.identity });
    try {
      return await this.persisted(await this.client.refreshToken(newer.refreshToken));
    } catch (error) {
      this.logger.warn("token_refresh_retry_failed", {
        identity: this.identity,
        error: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }

  private async persisted(token: TokenSet): Promise<TokenSet> {
    await this.persist(token);
    return token;
  }

  /**
   * Force a refresh of the offline root token. Machine flows re-acquire
   * immediately; interactive flows require an interactive call.
   */
  async refresh(options: { interactive?: boolean } = {}): Promise<TokenSet> {
    const token = await this.client.ensureToken(undefined, { interactive: options.interactive });
    await this.persist(token);
    return token;
  }

  /**
   * RFC 8693 token exchange to an explicit audience, presenting a caller
   * supplied subject token (e.g. the human's token, exchanged to a Source
   * audience). The result is cached under a derived
   * `identity-<hash(identity:audience)>` key in this runtime's default file
   * store so a later `getExchanged` can return it without re-exchanging.
   *
   * Note: unlike `ensure` / `refresh`, this always persists to the default file
   * store and does NOT route through the `getCached`/`setCached` overrides (the
   * overrides carry no audience dimension; routing an exchanged token through
   * them would clobber a caller's root token). A persistence-owning caller that
   * exchanges must copy the returned token into its own store via `getExchanged`
   * or its own handling.
   */
  async exchangeToAudience(audience: string, subjectToken: string): Promise<TokenSet> {
    const token = await this.client.exchangeToAudience(audience, subjectToken);
    await this.cacheStore.save(this.exchangeCacheKey(audience), token);
    return token;
  }

  async getExchanged(audience: string): Promise<TokenSet | undefined> {
    return this.cacheStore.load<TokenSet>(this.exchangeCacheKey(audience));
  }

  /**
   * RFC 8693 token exchange presenting a caller-supplied subject token plus
   * extra form parameters (e.g. `{ project_id: "proj-123" }`), cached under a
   * derived `identity-<hash(identity:key)>` key in this runtime's default file
   * store. The key is hashed via `hashCacheKey` for path-safety (see there) —
   * a raw key (a project id, an audience URL, …) is never used verbatim as a
   * filename, and neither is the identity separator (NTFS-unsafe `:`). Like
   * `exchangeToAudience`, this always persists to the default file store and
   * never routes through the `getCached`/`setCached` overrides.
   */
  async exchangeTo(
    key: string,
    subjectToken: string,
    extraParams?: Record<string, string>
  ): Promise<TokenSet> {
    const token = await this.client.exchange({ subjectToken, extraParams });
    await this.cacheStore.save(this.exchangeCacheKey(key), token);
    return token;
  }

  /**
   * Read the token produced by `exchangeTo` for `key`, if still persisted.
   */
  async getExchangedByKey(key: string): Promise<TokenSet | undefined> {
    return this.cacheStore.load<TokenSet>(this.exchangeCacheKey(key));
  }

  /**
   * Drop the identity root token and every exchanged token derived from it
   * (`identity-*` cache files). A bare remove of only the root would leave
   * still-valid exchanged tokens on disk — after a logout/re-login they'd be
   * served for the previous owner.
   */
  async reset(): Promise<void> {
    await this.cacheStore.remove(this.cacheKey());
    const exchangedKeys = await this.cacheStore.listKeys(`${this.identity}-`);
    await Promise.all(exchangedKeys.map((key) => this.cacheStore.remove(key)));
  }
}
