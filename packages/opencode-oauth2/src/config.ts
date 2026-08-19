import {
  DEFAULT_AUTH_FLOW,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_K8S_SA_TOKEN_PATH,
  DEFAULT_LOG_LEVEL,
  DEFAULT_TOKEN_EXPIRY_SKEW_MS,
  validateAuthConfig,
  type AuthServerConfig,
  type AuthServerConfigInput,
  type OAuthAuthFlow,
  type SubjectTokenSource
} from "@vymalo/opencode-auth-core/lib";
import type { LogLevel } from "@vymalo/opencode-auth-core/lib";

export {
  DEFAULT_AUTH_FLOW,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_K8S_SA_TOKEN_PATH,
  DEFAULT_LOG_LEVEL,
  DEFAULT_TOKEN_EXPIRY_SKEW_MS,
  type AuthServerConfig,
  type OAuthAuthFlow,
  type SubjectTokenSource,
  validateAuthConfig
};

export const DEFAULT_SYNC_INTERVAL_MINUTES = 60;

export interface OAuthServerConfigInput {
  id: string;
  name?: string;
  issuer: string;
  baseURL: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  syncIntervalMinutes?: number;
  nameOverrides?: Record<string, string>;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  jwksUri?: string;
  redirectPort?: number;
  authFlow?: OAuthAuthFlow;
  /**
   * Send PKCE (RFC 7636) on the interactive `authorization_code` and
   * `device_code` flows: `code_challenge` + `code_challenge_method=S256` on the
   * authorization/device request, and the matching `code_verifier` on the token
   * exchange. Defaults to `true` — PKCE is recommended for public clients and
   * is silently ignored by servers that don't require it, so leave it on unless
   * a non-compliant IdP rejects the extra parameters. Has no effect on the
   * machine flows (`client_credentials`, `jwt_bearer`, `token_exchange`).
   */
  pkce?: boolean;
  /**
   * Required for `jwt_bearer` and `token_exchange`. Tells the plugin where to
   * read the platform JWT it should present as the subject token.
   */
  subjectTokenSource?: SubjectTokenSource;
  /**
   * Optional `audience` parameter for the `token_exchange` grant — the
   * intended recipient of the resulting access token. Set this when the
   * OAuth server expects an explicit audience claim distinct from the
   * issuer.
   */
  tokenExchangeAudience?: string;
  /**
   * Route inference through the OpenAI **Responses API** (`/v1/responses`)
   * instead of Chat Completions (`/v1/chat/completions`). When `true` the
   * managed provider is registered with `npm: "@ai-sdk/openai"` (whose default
   * `languageModel()` targets Responses since AI SDK v5) rather than
   * `@ai-sdk/openai-compatible`. Only enable it when the gateway implements the
   * OpenAI Responses contract. Defaults to `false`. This flag affects provider
   * registration only — it never touches the token lifecycle, so it is read at
   * the config-synthesis layer and not part of the validated runtime config.
   */
  responseApi?: boolean;
}

export interface OAuth2ModelSyncConfigInput {
  servers: OAuthServerConfigInput[];
  cacheNamespace?: string;
  httpTimeoutMs?: number;
  tokenExpirySkewMs?: number;
  /**
   * Minimum log level the plugin emits. Lower-priority records are dropped.
   * One of `"trace" | "debug" | "info" | "warn" | "error"`. Defaults to
   * `"info"`. `"trace"` is the most-verbose tier (host `--log-level DEBUG`).
   */
  logLevel?: LogLevel;
}

export interface OAuthServerConfig {
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

export interface OAuth2ModelSyncConfig {
  servers: OAuthServerConfig[];
  cacheNamespace: string;
  httpTimeoutMs: number;
  tokenExpirySkewMs: number;
  logLevel: LogLevel;
}

function ensureString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function validateLogLevel(value: unknown, path: string): LogLevel {
  if (value === undefined || value === null) {
    return DEFAULT_LOG_LEVEL;
  }

  if (
    value === "trace" ||
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error"
  ) {
    return value;
  }

  throw new Error(
    `${path} must be one of "trace" | "debug" | "info" | "warn" | "error" (received ${JSON.stringify(value)})`
  );
}

function toAuthInput(input: OAuthServerConfigInput): AuthServerConfigInput {
  return {
    id: input.id,
    issuer: input.issuer,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    scopes: input.scopes,
    authorizationEndpoint: input.authorizationEndpoint,
    tokenEndpoint: input.tokenEndpoint,
    deviceAuthorizationEndpoint: input.deviceAuthorizationEndpoint,
    jwksUri: input.jwksUri,
    redirectPort: input.redirectPort,
    authFlow: input.authFlow,
    pkce: input.pkce,
    subjectTokenSource: input.subjectTokenSource,
    tokenExchangeAudience: input.tokenExchangeAudience
  };
}

function normalizeServerConfig(input: OAuthServerConfigInput, index: number): OAuthServerConfig {
  const path = `servers[${index}]`;

  // The auth subset (issuer/client/scopes/endpoints/flows/subject-token-source,
  // PKCE, redirect-port bounds, and the flow-required clientSecret /
  // subjectTokenSource checks) is owned by auth-core's validateAuthConfig so
  // it lives in exactly one place. oauth2 layers its model-sync fields on top.
  const auth: AuthServerConfig = validateAuthConfig(toAuthInput(input));

  const name = input.name && input.name.trim().length > 0 ? input.name.trim() : auth.id;
  const baseURL = ensureString(input.baseURL, `${path}.baseURL`);

  const syncIntervalMinutes =
    typeof input.syncIntervalMinutes === "number" &&
    Number.isFinite(input.syncIntervalMinutes) &&
    input.syncIntervalMinutes > 0
      ? input.syncIntervalMinutes
      : DEFAULT_SYNC_INTERVAL_MINUTES;

  return {
    id: auth.id,
    name,
    issuer: auth.issuer,
    baseURL,
    clientId: auth.clientId,
    clientSecret: auth.clientSecret,
    scopes: auth.scopes,
    syncIntervalMinutes,
    nameOverrides: input.nameOverrides ?? {},
    authorizationEndpoint: auth.authorizationEndpoint,
    tokenEndpoint: auth.tokenEndpoint,
    deviceAuthorizationEndpoint: auth.deviceAuthorizationEndpoint,
    jwksUri: auth.jwksUri,
    redirectPort: auth.redirectPort,
    authFlow: auth.authFlow,
    pkce: auth.pkce,
    subjectTokenSource: auth.subjectTokenSource,
    tokenExchangeAudience: auth.tokenExchangeAudience
  };
}

export function validateConfig(input: OAuth2ModelSyncConfigInput): OAuth2ModelSyncConfig {
  if (!input || typeof input !== "object") {
    throw new Error("plugin config must be an object");
  }

  if (!Array.isArray(input.servers) || input.servers.length === 0) {
    throw new Error("servers must be a non-empty array");
  }

  const normalizedServers = input.servers.map(normalizeServerConfig);
  const ids = new Set<string>();

  for (const server of normalizedServers) {
    if (ids.has(server.id)) {
      throw new Error(`duplicate server id detected: ${server.id}`);
    }
    ids.add(server.id);
  }

  let tokenExpirySkewMs = DEFAULT_TOKEN_EXPIRY_SKEW_MS;
  if (input.tokenExpirySkewMs !== undefined && input.tokenExpirySkewMs !== null) {
    if (
      typeof input.tokenExpirySkewMs !== "number" ||
      !Number.isFinite(input.tokenExpirySkewMs) ||
      input.tokenExpirySkewMs <= 0
    ) {
      throw new Error("tokenExpirySkewMs must be a positive number");
    }
    tokenExpirySkewMs = input.tokenExpirySkewMs;
  }

  return {
    servers: normalizedServers,
    cacheNamespace:
      typeof input.cacheNamespace === "string" && input.cacheNamespace.trim().length > 0
        ? input.cacheNamespace.trim()
        : "oauth2-model-sync",
    httpTimeoutMs:
      typeof input.httpTimeoutMs === "number" &&
      Number.isFinite(input.httpTimeoutMs) &&
      input.httpTimeoutMs > 0
        ? input.httpTimeoutMs
        : DEFAULT_HTTP_TIMEOUT_MS,
    tokenExpirySkewMs,
    logLevel: validateLogLevel(input.logLevel, "logLevel")
  };
}
