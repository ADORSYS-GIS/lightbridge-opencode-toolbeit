import { FileCacheStore, resolveCacheDir } from "./cache.js";
import type { AuthServerConfig } from "./config.js";
import { validateAuthConfig } from "./config.js";
import type { Logger } from "./logging.js";
import { createJsonConsoleLogger } from "./logging.js";
import { OAuthClient } from "./oauth/client.js";
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
   * `refresh` produce). Audience-scoped exchange results always live in this
   * runtime's default file store under a `identity:audience` key — see
   * `exchangeToAudience` — because the override interface carries no audience
   * dimension and routing an exchanged token through it would clobber the
   * caller's root token (e.g. overwrite oauth2's `CachedServerState.token`).
   */
  getCached?: () => Promise<TokenSet | undefined>;
  /**
   * Override the cached-token write. See `getCached`.
   */
  setCached?: (token: TokenSet) => Promise<void>;
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

  constructor(identity: string, auth: AuthServerConfig, options: TokenRuntimeOptions = {}) {
    this.identity = identity;
    this.config = validateAuthConfig(auth);
    this.logger = options.logger ?? createJsonConsoleLogger("info");
    this.getCachedOverride = options.getCached;
    this.setCachedOverride = options.setCached;

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
   */
  async ensure(options: { interactive?: boolean } = {}): Promise<TokenSet> {
    const cached = await this.getCached();
    const token = await this.client.ensureToken(cached, { interactive: options.interactive });
    if (token.accessToken !== cached?.accessToken) {
      await this.persist(token);
    }
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
   * audience). The result is cached under a derived `identity:audience` key in
   * this runtime's default file store so a later `getExchanged` can return it
   * without re-exchanging.
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
    await this.cacheStore.save(`${this.cacheKey()}:${audience}`, token);
    return token;
  }

  async getExchanged(audience: string): Promise<TokenSet | undefined> {
    return this.cacheStore.load<TokenSet>(`${this.cacheKey()}:${audience}`);
  }

  async reset(): Promise<void> {
    await this.cacheStore.remove(this.cacheKey());
  }
}
