import { join } from "node:path";

import {
  createJsonConsoleLogger,
  DEFAULT_TOKEN_EXPIRY_SKEW_MS,
  resolveCacheRoot,
  TokenRuntime,
  validateAuthConfig,
  type Logger,
  type TokenSet
} from "@vymalo/opencode-auth-core/lib";

import type { RepoAuthConfig } from "./config.js";

/**
 * The plugin is identity-keyed by the *human* — the single person whose one
 * interactive login (device-code / authorization-code) grounds every project
 * exchange. v1 is single-IdP, so the identity is a constant; if multi-IdP ever
 * lands, derive `issuer|clientId` instead.
 */
export const HUMAN_IDENTITY = "human";

export const DEFAULT_CACHE_NAMESPACE = "opencode-repo-auth";

export interface RepoAuthPluginOptions {
  logger?: Logger;
  fetchImpl?: typeof fetch;
  onAuthorizationUrl?: (url: string) => Promise<void> | void;
  /** Override the cache root (defaults to the OS cache dir convention). */
  cacheDir?: string;
  tokenExpirySkewMs?: number;
}

/**
 * Whether a cached project token is usable. Deliberately *not* routed through
 * auth-core's `OAuthClient.isTokenValid`: that check treats a missing
 * `expiresAt` as non-expiring for interactive flows, but the project token has
 * **no refresh token** — an undefined or passed lifetime must trigger a
 * re-exchange (the machine-flow policy), otherwise a 401 after the server
 * revoked it becomes a permanent failure rather than a one round trip.
 */
export function isProjectTokenUsable(
  token: TokenSet | undefined,
  skewMs: number
): token is TokenSet {
  if (!token?.accessToken) {
    return false;
  }
  if (token.expiresAt === undefined) {
    return false;
  }
  return Date.now() + skewMs < token.expiresAt;
}

/**
 * Repo-auth runtime over `@vymalo/opencode-auth-core`'s `TokenRuntime`.
 * Owns two token kinds, both persisted by auth-core's `FileCacheStore` under
 * the plugin's cache namespace (OS cache dir, `0o600`, atomic rename):
 *
 *   - the **human root** (`<cacheDir>/human.json`) — what `ensure` /
 *     `refresh` produces; carries the `offline_access` refresh token that makes
 *     re-exchange automatic ("model b"); never sent to the gateway.
 *   - the **project token** (`<cacheDir>/human-<hash(projectId)>.json`) — the
 *     SPI-sealed RFC 8693 exchange result consumed by the gateway; short-lived,
 *     no refresh token, so renewal is always a fresh exchange from the human
 *     root, never a "refreshed" project token (which would lose the project
 *     claims).
 *
 * The plugin keeps only in-memory state; no `cache.ts` of its own.
 */
export class RepoAuthPlugin {
  private readonly runtime: TokenRuntime;
  private readonly logger: Logger;
  private readonly tokenExpirySkewMs: number;
  private inFlightExchange?: Promise<TokenSet>;

  constructor(
    readonly config: RepoAuthConfig,
    options: RepoAuthPluginOptions = {}
  ) {
    this.logger = options.logger ?? createJsonConsoleLogger("info");
    this.tokenExpirySkewMs =
      typeof options.tokenExpirySkewMs === "number" &&
      Number.isFinite(options.tokenExpirySkewMs) &&
      options.tokenExpirySkewMs > 0
        ? options.tokenExpirySkewMs
        : DEFAULT_TOKEN_EXPIRY_SKEW_MS;

    this.runtime = new TokenRuntime(
      HUMAN_IDENTITY,
      // Validate once at construction so a malformed auth block fails early
      // with auth-core's field-level errors (defaults applied: authFlow →
      // authorization_code, pkce → true).
      validateAuthConfig(config.auth),
      {
        logger: this.logger,
        fetchImpl: options.fetchImpl,
        onAuthorizationUrl: options.onAuthorizationUrl,
        cacheDir: options.cacheDir ?? join(resolveCacheRoot(), DEFAULT_CACHE_NAMESPACE),
        tokenExpirySkewMs: this.tokenExpirySkewMs
      }
    );
  }

  get projectId(): string {
    return this.config.projectId;
  }

  /**
   * Ensure the human root token. Config-time callers pass `{interactive:false}`
   * so a first-ever login never blocks boot on a browser/device-code prompt;
   * per-request callers allow it (the first chat is the natural moment to log
   * in). A stale-but-refreshable token is refreshed silently via its
   * `offline_access` refresh token.
   */
  async ensureHumanToken(options: { interactive?: boolean } = {}): Promise<TokenSet> {
    const token = await this.runtime.ensure({ interactive: options.interactive });
    this.logger.debug("repo_auth_human_token_ensured", {
      present: Boolean(token.accessToken)
    });
    return token;
  }

  /** Non-network read of the cached project token, if any. */
  async getCachedProjectToken(): Promise<TokenSet | undefined> {
    return this.runtime.getExchangedByKey(this.projectId);
  }

  /**
   * Resolve a *usable* project token — "model b":
   *
   *   cached usable? ──yes──▶ return it (repo_auth_exchange_cache_hit)
   *         │ no
   *         ▼
   *   ensure human root (refresh-only; interactive never used here)
   *         ▼
   *   exchangeTo(projectId, humanToken, { project_id })   ← ONE POST, no audience
   *         ▼
   *   cache under human-<hash(projectId)> + return
   *
   * The project token is **never refreshed**; re-exchange is the canonical
   * renewal. Fails closed: an exchange failure (non-member, resolver error,
   * network) throws `repo_auth_exchange_failed` — the caller injects no header
   * and the gateway 401s, which is correct (matches the SPI's fail-closed
   * semantics). The plugin never invents a token.
   *
   * `interactive` controls only the human-root derivation for a *re-exchange*:
   * config-time callers keep it `false` (a first-ever login must not block
   * boot), while `chat.headers` callers default to `true` so the first chat
   * request can open the device-code / browser flow.
   *
   * Concurrent callers (parallel chat headers, config warmup racing a request)
   * share the in-flight exchange: the first cache-missing caller kicks it off
   * and the rest await the same promise, so there is at most one exchange POST
   * and at most one interactive prompt per cache-miss window.
   */
  async resolveProjectToken(options: { interactive?: boolean } = {}): Promise<TokenSet> {
    const cached = await this.getCachedProjectToken();
    if (isProjectTokenUsable(cached, this.tokenExpirySkewMs)) {
      this.logger.trace("repo_auth_exchange_cache_hit", { projectId: this.projectId });
      return cached;
    }
    this.logger.trace("repo_auth_exchange_cache_miss", { projectId: this.projectId });

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
    const human = await this.ensureHumanToken({ interactive: options.interactive });
    this.logger.info("repo_auth_exchange_started", { projectId: this.projectId });
    try {
      const exchanged = await this.runtime.exchangeTo(this.projectId, human.accessToken, {
        project_id: this.projectId
      });
      this.logger.info("repo_auth_exchange_success", { projectId: this.projectId });
      return exchanged;
    } catch (error) {
      this.logger.error("repo_auth_exchange_failed", {
        projectId: this.projectId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /** Drop the on-disk human + project tokens for this identity. */
  async reset(): Promise<void> {
    await this.runtime.reset();
  }
}

/** Absolute path to the repo-auth cache directory (for diagnostics / tests). */
export function repoAuthCacheDir(cacheRoot: string): string {
  return join(cacheRoot, DEFAULT_CACHE_NAMESPACE);
}
