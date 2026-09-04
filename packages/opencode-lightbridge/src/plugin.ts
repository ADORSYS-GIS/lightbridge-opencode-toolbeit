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

/**
 * Identity for the umbrella's single `TokenRuntime` (ADR-0012). Constant
 * because v1 is single-IdP, same rationale as repo-auth's `HUMAN_IDENTITY`.
 */
export const LIGHTBRIDGE_IDENTITY = "lightbridge";

/** Own cache namespace — separate from oauth2/repo-auth/otel's stores. */
export const DEFAULT_CACHE_NAMESPACE = "opencode-lightbridge";

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
  /** Override the cache root (defaults to the OS cache dir convention). */
  cacheDir?: string;
  tokenExpirySkewMs?: number;
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
 * Whether a cached project token is usable. Mirrors repo-auth's
 * `isProjectTokenUsable`: the project token carries no refresh token, so an
 * undefined `expiresAt` must be treated as expired (re-exchange), never as
 * non-expiring.
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
 * The ONE shared `TokenRuntime` the umbrella plugin builds (ADR-0012): a
 * single human login, reused as the subject token for a project-scoped RFC
 * 8693 exchange whose result is consumed by BOTH the gateway (`chat.headers`)
 * and OTEL (`TokenSource.headers()`) — that sharing is the entire point of
 * the plugin. Lifecycle mirrors `@vymalo/opencode-repo-auth`'s "model b"
 * (`RepoAuthPlugin.resolveProjectToken`): auth-core has no higher-level
 * primitive for this yet, so the umbrella keeps its own thin copy rather than
 * reaching into a sibling package's internals.
 */
export class LightbridgeRuntime implements LightbridgeRuntimeLike {
  private readonly runtime: TokenRuntime;
  private readonly logger: Logger;
  private readonly tokenExpirySkewMs: number;
  /** Token-cache key: the project id, or `DEFAULT_PROJECT_KEY` when unset. */
  private readonly projectKey: string;
  private inFlightExchange?: Promise<TokenSet>;

  constructor(
    auth: AuthServerConfig,
    private readonly projectId: string | undefined,
    options: LightbridgeRuntimeOptions = {}
  ) {
    this.projectKey = projectId ?? DEFAULT_PROJECT_KEY;
    this.logger = options.logger ?? createJsonConsoleLogger("info");
    this.tokenExpirySkewMs =
      typeof options.tokenExpirySkewMs === "number" &&
      Number.isFinite(options.tokenExpirySkewMs) &&
      options.tokenExpirySkewMs > 0
        ? options.tokenExpirySkewMs
        : DEFAULT_TOKEN_EXPIRY_SKEW_MS;

    this.runtime = new TokenRuntime(LIGHTBRIDGE_IDENTITY, auth, {
      logger: this.logger,
      fetchImpl: options.fetchImpl,
      onAuthorizationUrl: options.onAuthorizationUrl,
      cacheDir: options.cacheDir ?? join(resolveCacheRoot(), DEFAULT_CACHE_NAMESPACE),
      tokenExpirySkewMs: this.tokenExpirySkewMs,
      serviceLabel: "opencode-lightbridge"
    });
  }

  /** Non-network read of the cached project token, if any. */
  async getCachedProjectToken(): Promise<TokenSet | undefined> {
    return this.runtime.getExchangedByKey(this.projectKey);
  }

  /**
   * Resolve a usable project token, shared by every caller (gateway
   * `chat.headers`, OTEL `TokenSource.headers()`):
   *
   *   cached usable? ──yes──▶ return it
   *         │ no
   *         ▼
   *   ensure human root (refresh-only unless `interactive`)
   *         ▼
   *   exchangeTo(projectKey, humanToken, projectId ? { project_id } : {})
   *         ▼           (no projectId → backend picks the default project)
   *   cache + return
   *
   * Concurrent callers (a chat request racing an OTEL export) share the
   * in-flight exchange — at most one exchange POST per cache-miss window.
   * Never invents a token: an exchange failure propagates to the caller,
   * which is expected to fail closed (no header / empty `headers()`).
   */
  async getProjectToken(options: { interactive?: boolean } = {}): Promise<TokenSet> {
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
    const human = await this.runtime.ensure({ interactive: options.interactive });
    this.logger.info("lightbridge_exchange_started", { projectId: this.projectId ?? "(default)" });
    try {
      // No `projectId` → send no `project_id` param; the backend mints a token
      // for the caller's default project (ADR-0012).
      const exchanged = await this.runtime.exchangeTo(
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

  /** Drop the on-disk human + project tokens for this identity. */
  async reset(): Promise<void> {
    await this.runtime.reset();
  }
}

/** Absolute path to the lightbridge cache directory (for diagnostics / tests). */
export function lightbridgeCacheDir(cacheRoot: string): string {
  return join(cacheRoot, DEFAULT_CACHE_NAMESPACE);
}
