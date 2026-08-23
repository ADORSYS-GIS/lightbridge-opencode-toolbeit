import type { AuthServerConfig, OAuthAuthFlow } from "../config.js";
import { DEFAULT_TOKEN_EXPIRY_SKEW_MS } from "../config.js";
import type { Logger } from "../logging.js";
import type { TokenSet } from "../types.js";
import { openExternalUrl } from "./browser.js";
import { acquireTokenViaDeviceCode } from "./device-code.js";
import { discoverOidcMetadata } from "./discovery.js";
import { readResponseBodyPreview, redactUrl, scrubSecrets } from "./http-utils.js";
import { startLocalCallbackServer } from "./local-callback.js";
import { generatePkcePair, generateStateToken } from "./pkce.js";
import { resolveSubjectToken } from "./subject-token.js";

interface OAuthClientOptions {
  fetchImpl?: typeof fetch;
  logger: Logger;
  timeoutMs: number;
  onAuthorizationUrl?: (url: string) => Promise<void> | void;
  tokenExpirySkewMs?: number;
}

interface ResolvedEndpoints {
  authorizationEndpoint?: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint?: string;
}

/**
 * Form-body fields that are protocol-level and must never be overridable by a
 * caller's `extraParams` on an RFC 8693 exchange.
 */
const RESERVED_EXCHANGE_PARAMS = new Set([
  "grant_type",
  "client_id",
  "client_secret",
  "scope",
  "subject_token",
  "subject_token_type"
]);

export function toTokenSet(
  payload: Record<string, unknown>,
  options?: {
    fallbackRefreshToken?: string;
    requireRefreshToken?: boolean;
  }
): TokenSet {
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("OAuth token response is missing access_token");
  }

  const tokenType =
    typeof payload.token_type === "string" && payload.token_type.length > 0
      ? payload.token_type
      : "Bearer";

  const expiresIn =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : undefined;
  const refreshToken =
    typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
      ? payload.refresh_token
      : options?.fallbackRefreshToken;

  if (options?.requireRefreshToken !== false && !refreshToken) {
    throw new Error("OAuth token response is missing refresh_token");
  }

  return {
    accessToken,
    tokenType,
    refreshToken: refreshToken as string,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined
  };
}

export class OAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly onAuthorizationUrl?: (url: string) => Promise<void> | void;
  private readonly tokenExpirySkewMs: number;

  constructor(
    private readonly server: AuthServerConfig,
    options: OAuthClientOptions
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs;
    this.onAuthorizationUrl = options.onAuthorizationUrl;
    this.tokenExpirySkewMs =
      typeof options.tokenExpirySkewMs === "number" &&
      Number.isFinite(options.tokenExpirySkewMs) &&
      options.tokenExpirySkewMs > 0
        ? options.tokenExpirySkewMs
        : DEFAULT_TOKEN_EXPIRY_SKEW_MS;
  }

  private isTokenValid(token?: TokenSet): boolean {
    if (!token?.accessToken) {
      return false;
    }

    if (!token.expiresAt) {
      // For machine-to-machine flows (client_credentials, jwt_bearer,
      // token_exchange), re-authentication is cheap (one POST + maybe a
      // subject-token fetch) and the spec allows but does not require
      // `expires_in`. Without a declared lifetime we cannot tell if the
      // server-side token has been revoked, so we re-acquire each time to
      // avoid persistent 401s after the server's idea of the token has
      // expired. User-interactive flows (authorization_code, device_code)
      // keep the old behavior — assume non-expiring when expires_in is
      // missing — because the cost of forcing an unnecessary browser dance
      // is high.
      const machineFlows: ReadonlyArray<OAuthAuthFlow> = [
        "client_credentials",
        "jwt_bearer",
        "token_exchange"
      ];
      return !machineFlows.includes(this.server.authFlow);
    }

    return Date.now() + this.tokenExpirySkewMs < token.expiresAt;
  }

  /**
   * POST to a token endpoint with an AbortController-backed timeout. Without
   * this, a stalled IdP would block the warmup path indefinitely (the plugin
   * runs token requests at config-hook time for cached/client_credentials
   * paths).
   */
  private async postWithTimeout(url: string, body: URLSearchParams): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async ensureToken(
    current?: TokenSet,
    options: { interactive?: boolean } = {}
  ): Promise<TokenSet> {
    if (this.isTokenValid(current)) {
      return current as TokenSet;
    }

    // Machine-to-machine flows never need a refresh token (they re-acquire
    // by re-presenting the platform identity / client secret) and are safe
    // to run during non-interactive warmup. Dispatch before the refresh
    // branch so we don't try to use a stale refresh token that the IdP may
    // not even have issued.
    if (this.server.authFlow === "client_credentials") {
      return this.loginClientCredentials();
    }
    if (this.server.authFlow === "jwt_bearer") {
      return this.loginJwtBearer();
    }
    if (this.server.authFlow === "token_exchange") {
      return this.loginTokenExchange();
    }

    if (current?.refreshToken) {
      try {
        const refreshed = await this.refreshToken(current.refreshToken);
        this.logger.debug("oauth_refresh_success", { serverId: this.server.id });
        return refreshed;
      } catch (error) {
        this.logger.warn("oauth_refresh_failed", {
          serverId: this.server.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // When called non-interactively (e.g. plugin warmup at config-hook time),
    // refuse to open a browser or block on device-code polling. Callers like
    // syncServer catch this and preserve cached state; the provider's models
    // stay empty in OpenCode until the user actually attempts a chat (which
    // calls ensureToken with the default interactive=true).
    if (options.interactive === false) {
      throw new Error(
        `interactive authentication required for server "${this.server.id}" (authFlow=${this.server.authFlow}) but called non-interactively`
      );
    }

    if (this.server.authFlow === "device_code") {
      return this.loginDeviceCode();
    }

    return this.loginInteractive();
  }

  private async loginClientCredentials(): Promise<TokenSet> {
    if (!this.server.clientSecret) {
      throw new Error("client_credentials flow requires clientSecret");
    }

    const endpoints = await this.resolveEndpoints();
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.server.clientId,
      client_secret: this.server.clientSecret
    });

    if (this.server.scopes.length > 0) {
      body.set("scope", this.server.scopes.join(" "));
    }

    this.logger.info("oauth_client_credentials_started", {
      serverId: this.server.id,
      // tokenEndpoint comes from user-supplied config (or OIDC discovery off
      // a user-supplied issuer); strip userinfo + query before logging so
      // configs like `https://user:pass@.../token` don't leak credentials.
      tokenEndpoint: redactUrl(endpoints.tokenEndpoint)
    });

    const response = await this.postWithTimeout(endpoints.tokenEndpoint, body);

    if (!response.ok) {
      const bodyPreview = await readResponseBodyPreview(response, 500);
      // Log the body separately so the logger's redaction can scrub matching
      // keys, and run it through scrubSecrets to also mask token-shaped
      // substrings that IdPs sometimes echo back inside arbitrary error text
      // (where field-name-based redaction wouldn't help). Never embed the
      // body in throw new Error(...) — callers log error.message verbatim.
      this.logger.error("oauth_client_credentials_failed", {
        serverId: this.server.id,
        status: response.status,
        bodyPreview: bodyPreview ? scrubSecrets(bodyPreview) : undefined
      });
      throw new Error(`client_credentials token request failed (${response.status})`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const token = toTokenSet(payload, { requireRefreshToken: false });

    this.logger.info("oauth_client_credentials_success", {
      serverId: this.server.id,
      hasExpiry: token.expiresAt !== undefined
    });

    return token;
  }

  private async loginJwtBearer(): Promise<TokenSet> {
    if (!this.server.subjectTokenSource) {
      throw new Error("jwt_bearer flow requires subjectTokenSource");
    }
    return this.postFederatedGrant({
      grantType: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      extraFields: (assertion) => ({ assertion }),
      eventPrefix: "oauth_jwt_bearer"
    });
  }

  private async loginTokenExchange(): Promise<TokenSet> {
    if (!this.server.subjectTokenSource) {
      throw new Error("token_exchange flow requires subjectTokenSource");
    }
    return this.postFederatedGrant({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      extraFields: (subjectToken) => {
        const fields: Record<string, string> = {
          subject_token: subjectToken,
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt"
        };
        if (this.server.tokenExchangeAudience) {
          fields.audience = this.server.tokenExchangeAudience;
        }
        return fields;
      },
      eventPrefix: "oauth_token_exchange"
    });
  }

  /**
   * Shared driver for jwt_bearer and token_exchange. Both grants:
   *   - resolve a platform-supplied JWT from `subjectTokenSource` (or take an
   *     explicitly supplied `subjectToken`, e.g. from exchangeToAudience)
   *   - POST it to the token endpoint with grant-specific form fields
   *   - get back an access token (refresh token is NOT expected for either)
   */
  private async postFederatedGrant(spec: {
    grantType: string;
    extraFields: (jwt: string) => Record<string, string>;
    eventPrefix: string;
    subjectToken?: string;
  }): Promise<TokenSet> {
    let subjectToken = spec.subjectToken;
    let subjectTokenSourceType: string | undefined;
    if (subjectToken === undefined) {
      const subjectTokenSource = this.server.subjectTokenSource;
      if (!subjectTokenSource) {
        // Caller already guards this; belt-and-braces for the type narrowing.
        throw new Error("federated flow requires subjectTokenSource");
      }
      subjectTokenSourceType = subjectTokenSource.type;
      subjectToken = await resolveSubjectToken(subjectTokenSource, {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs
      });
    }

    const endpoints = await this.resolveEndpoints();
    // `grant_type`/`client_id` are built LAST so a grant's `extraFields`
    // (and any `subject_token`/`extraParams` they carry) can never override
    // them — those base fields are protocol-level, not caller-tunable.
    const body = new URLSearchParams({
      ...spec.extraFields(subjectToken),
      grant_type: spec.grantType,
      client_id: this.server.clientId
    });
    if (this.server.scopes.length > 0) {
      body.set("scope", this.server.scopes.join(" "));
    }
    if (this.server.clientSecret) {
      // Confidential federated clients are permitted by Keycloak and many
      // others; some IdPs require both the assertion AND the client secret.
      body.set("client_secret", this.server.clientSecret);
    }

    this.logger.info(`${spec.eventPrefix}_started`, {
      serverId: this.server.id,
      tokenEndpoint: redactUrl(endpoints.tokenEndpoint),
      subjectTokenSource: subjectTokenSourceType ?? "explicit"
    });

    const response = await this.postWithTimeout(endpoints.tokenEndpoint, body);

    if (!response.ok) {
      const preview = await readResponseBodyPreview(response, 500);
      this.logger.error(`${spec.eventPrefix}_failed`, {
        serverId: this.server.id,
        status: response.status,
        bodyPreview: preview ? scrubSecrets(preview) : undefined
      });
      throw new Error(`${spec.grantType} request failed (${response.status})`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const token = toTokenSet(payload, { requireRefreshToken: false });

    this.logger.info(`${spec.eventPrefix}_success`, {
      serverId: this.server.id,
      hasExpiry: token.expiresAt !== undefined
    });

    return token;
  }

  /**
   * RFC 8693 token exchange presenting a caller-supplied subject token plus any
   * extra form parameters. Used by consumers (e.g. repo-auth, which exchanges a
   * human token to a `project_id`) that want to scope a token without
   * configuring a `subjectTokenSource`. Reuses the same federated-grant
   * machinery as the `token_exchange` authFlow. The form body is exactly
   * `grant_type=…token-exchange`, `client_id`, `subject_token`,
   * `subject_token_type`, plus `scope` / `client_secret` when configured and
   * every `extraParams` entry (e.g. `audience=…` or `project_id=…`). The
   * protocol-level fields — `grant_type`, `client_id`, `client_secret`,
   * `scope`, `subject_token`, `subject_token_type` — are reserved and silently
   * dropped from `extraParams` so a caller can never silently swap the subject
   * token or masquerade as another grant.
   */
  async exchange(params: {
    subjectToken: string;
    extraParams?: Record<string, string>;
  }): Promise<TokenSet> {
    const extraParams = Object.fromEntries(
      Object.entries(params.extraParams ?? {}).filter(([key]) => !RESERVED_EXCHANGE_PARAMS.has(key))
    );
    return this.postFederatedGrant({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      extraFields: () => ({
        subject_token: params.subjectToken,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        ...extraParams
      }),
      eventPrefix: "oauth_token_exchange",
      subjectToken: params.subjectToken
    });
  }

  /**
   * RFC 8693 token exchange to an explicit audience — convenience wrapper over
   * `exchange` that presents the `audience` form parameter. Kept as a
   * backward-compatible alias.
   */
  async exchangeToAudience(audience: string, subjectToken: string): Promise<TokenSet> {
    return this.exchange({ subjectToken, extraParams: { audience } });
  }

  /**
   * Resolve endpoints for the configured flow. Skips OIDC discovery entirely
   * when the explicit endpoints needed for the flow are all present in config
   * — discovery is unavailable on RFC 8414-only servers and on Keycloak
   * realms where the well-known doc is locked down.
   */
  private async resolveEndpoints(): Promise<ResolvedEndpoints> {
    const haveAllExplicit = this.hasExplicitEndpointsForFlow();
    if (haveAllExplicit) {
      return {
        authorizationEndpoint: this.server.authorizationEndpoint,
        tokenEndpoint: this.server.tokenEndpoint as string,
        deviceAuthorizationEndpoint: this.server.deviceAuthorizationEndpoint
      };
    }

    const metadata = await discoverOidcMetadata(this.server.issuer, this.fetchImpl, this.timeoutMs);

    const tokenEndpoint = this.server.tokenEndpoint ?? metadata.token_endpoint;
    const authorizationEndpoint =
      this.server.authorizationEndpoint ?? metadata.authorization_endpoint;
    const deviceAuthorizationEndpoint =
      this.server.deviceAuthorizationEndpoint ?? metadata.device_authorization_endpoint;

    if (this.server.authFlow === "authorization_code" && !authorizationEndpoint) {
      throw new Error(
        "authorization_code flow requires an authorization_endpoint (either configured or discovered)"
      );
    }
    if (this.server.authFlow === "device_code" && !deviceAuthorizationEndpoint) {
      throw new Error(
        "device_code flow requires a device_authorization_endpoint (either configured or discovered)"
      );
    }

    return {
      authorizationEndpoint,
      tokenEndpoint,
      deviceAuthorizationEndpoint
    };
  }

  private hasExplicitEndpointsForFlow(): boolean {
    if (!this.server.tokenEndpoint) {
      return false;
    }
    switch (this.server.authFlow) {
      case "client_credentials":
      case "jwt_bearer":
      case "token_exchange":
        return true;
      case "device_code":
        return Boolean(this.server.deviceAuthorizationEndpoint);
      default:
        return Boolean(this.server.authorizationEndpoint);
    }
  }

  private async refreshToken(refreshToken: string): Promise<TokenSet> {
    const endpoints = await this.resolveEndpoints();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.server.clientId
    });

    if (this.server.clientSecret) {
      body.set("client_secret", this.server.clientSecret);
    }

    const response = await this.postWithTimeout(endpoints.tokenEndpoint, body);

    if (!response.ok) {
      throw new Error(`refresh token exchange failed (${response.status})`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const nextToken = toTokenSet(payload, {
      fallbackRefreshToken: refreshToken,
      requireRefreshToken: true
    });

    return nextToken;
  }

  private async loginDeviceCode(): Promise<TokenSet> {
    const endpoints = await this.resolveEndpoints();
    if (!endpoints.deviceAuthorizationEndpoint) {
      throw new Error(
        "device_code flow requires a device_authorization_endpoint (either configured or discovered)"
      );
    }

    return acquireTokenViaDeviceCode({
      deviceAuthorizationEndpoint: endpoints.deviceAuthorizationEndpoint,
      tokenEndpoint: endpoints.tokenEndpoint,
      clientId: this.server.clientId,
      clientSecret: this.server.clientSecret,
      scopes: this.server.scopes,
      serverId: this.server.id,
      logger: this.logger,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      pkce: this.server.pkce
    });
  }

  private async loginInteractive(): Promise<TokenSet> {
    const endpoints = await this.resolveEndpoints();
    if (!endpoints.authorizationEndpoint) {
      // resolveEndpoints already guards this for authorization_code, but TS
      // sees the type as optional. Belt-and-braces.
      throw new Error(
        "authorization_code flow requires an authorization_endpoint (either configured or discovered)"
      );
    }
    const callbackServer = await startLocalCallbackServer(
      "/oauth2/callback",
      this.server.redirectPort
    );

    try {
      // PKCE on by default; opt out via the `pkce` server option for
      // non-compliant IdPs. Compliant servers ignore the extra parameters.
      const pkce = this.server.pkce !== false ? generatePkcePair() : undefined;
      const state = generateStateToken();
      const authorizeUrl = new URL(endpoints.authorizationEndpoint);

      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", this.server.clientId);
      authorizeUrl.searchParams.set("redirect_uri", callbackServer.redirectUri);
      authorizeUrl.searchParams.set("scope", this.server.scopes.join(" "));
      if (pkce) {
        authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
        authorizeUrl.searchParams.set("code_challenge_method", "S256");
      }
      authorizeUrl.searchParams.set("state", state);

      this.logger.info("oauth_login_started", {
        serverId: this.server.id,
        issuer: this.server.issuer,
        authorizationEndpoint: `${authorizeUrl.origin}${authorizeUrl.pathname}`
      });

      if (this.onAuthorizationUrl) {
        await this.onAuthorizationUrl(authorizeUrl.toString());
      } else {
        try {
          await openExternalUrl(authorizeUrl.toString());
        } catch (error) {
          this.logger.warn("oauth_open_browser_failed", {
            serverId: this.server.id,
            error: error instanceof Error ? error.message : String(error)
          });
          // Write the URL to stderr directly so the terminal user can copy-paste
          // it. Bypasses the structured logger to avoid leaking the `state`
          // nonce (and other query params) into centralized log aggregation,
          // which would enable login-CSRF via a forged localhost callback.
          process.stderr.write(
            `\n[opencode-oauth2] open this URL to authenticate (${this.server.id}):\n${authorizeUrl.toString()}\n\n`
          );
        }
      }

      const callback = await callbackServer.waitForCode();
      if (callback.state !== state) {
        throw new Error("OAuth callback state mismatch");
      }

      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.code,
        client_id: this.server.clientId,
        redirect_uri: callbackServer.redirectUri
      });

      if (pkce) {
        tokenBody.set("code_verifier", pkce.verifier);
      }

      if (this.server.clientSecret) {
        tokenBody.set("client_secret", this.server.clientSecret);
      }

      const tokenResponse = await this.postWithTimeout(endpoints.tokenEndpoint, tokenBody);

      if (!tokenResponse.ok) {
        throw new Error(`authorization code exchange failed (${tokenResponse.status})`);
      }

      const payload = (await tokenResponse.json()) as Record<string, unknown>;
      const token = toTokenSet(payload, { requireRefreshToken: true });

      this.logger.info("oauth_login_success", {
        serverId: this.server.id,
        hasRefreshToken: true
      });

      return token;
    } catch (error) {
      this.logger.error("oauth_login_failed", {
        serverId: this.server.id,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      await callbackServer.close();
    }
  }
}
