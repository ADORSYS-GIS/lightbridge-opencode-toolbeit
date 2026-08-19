import type { LogLevel } from "./logging.js";

export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
export const DEFAULT_TOKEN_EXPIRY_SKEW_MS = 30_000;
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

export type OAuthAuthFlow =
  | "authorization_code"
  | "device_code"
  | "client_credentials"
  | "jwt_bearer"
  | "token_exchange";

export const DEFAULT_AUTH_FLOW: OAuthAuthFlow = "authorization_code";

/**
 * Where to read the platform-supplied JWT that the runtime presents as the
 * subject token / assertion for the `jwt_bearer` and `token_exchange` flows.
 *
 * - `github_actions` — fetches the OIDC token from the GitHub Actions runtime
 *   via `ACTIONS_ID_TOKEN_REQUEST_URL` + `ACTIONS_ID_TOKEN_REQUEST_TOKEN`,
 *   with the workflow-declared `audience`. The `id-token: write` permission
 *   is required on the job.
 * - `kubernetes_sa` — reads a projected service-account token from the pod
 *   filesystem. Default path `/var/run/secrets/tokens/oauth2/token`; mount a
 *   `projected.sources.serviceAccountToken` volume with the OIDC issuer as
 *   the audience.
 * - `file` — reads any JWT from disk. Useful when an external sidecar
 *   refreshes the token to a fixed path.
 * - `env` — reads the JWT from a named environment variable.
 */
export type SubjectTokenSource =
  | { type: "github_actions"; audience: string }
  | { type: "kubernetes_sa"; tokenPath?: string }
  | { type: "file"; path: string }
  | { type: "env"; var: string };

export const DEFAULT_K8S_SA_TOKEN_PATH = "/var/run/secrets/tokens/oauth2/token";

/**
 * OAuth server configuration primitives, generic over identity. This is the
 * model-free subset an OAuth flow needs (issuer, client, scopes, endpoints,
 * flow choice) — deliberately NOT coupled to any plugin's provider/model
 * shape. A plugin (oauth2, repo-auth, …) is expected to map its richer config
 * down to this and key a `TokenRuntime` by its own identity.
 */
export interface AuthServerConfigInput {
  id: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  jwksUri?: string;
  redirectPort?: number;
  authFlow?: OAuthAuthFlow;
  /**
   * Send PKCE (RFC 7636) on the interactive `authorization_code` and
   * `device_code` flows. Defaults to `true`.
   */
  pkce?: boolean;
  /**
   * Required for `jwt_bearer` and `token_exchange`. Tells the runtime where
   * to read the platform JWT it should present as the subject token.
   */
  subjectTokenSource?: SubjectTokenSource;
  /**
   * Optional `audience` parameter for the `token_exchange` grant.
   */
  tokenExchangeAudience?: string;
}

export interface AuthServerConfig {
  id: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
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

function ensureString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function ensureStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array of strings`);
  }
  return value.map((item, index) => ensureString(item, `${path}[${index}]`));
}

function validateRedirectPort(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value >= 65536) {
    throw new Error(`${path} must be a positive integer less than 65536`);
  }
  return value;
}

function validateAuthFlow(value: unknown, path: string): OAuthAuthFlow {
  if (value === undefined || value === null) {
    return DEFAULT_AUTH_FLOW;
  }
  if (
    value === "authorization_code" ||
    value === "device_code" ||
    value === "client_credentials" ||
    value === "jwt_bearer" ||
    value === "token_exchange"
  ) {
    return value;
  }
  throw new Error(
    `${path} must be one of "authorization_code" | "device_code" | "client_credentials" | "jwt_bearer" | "token_exchange" (received ${JSON.stringify(value)})`
  );
}

function validatePkce(value: unknown, path: string): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean (received ${JSON.stringify(value)})`);
  }
  return value;
}

function validateSubjectTokenSource(value: unknown, path: string): SubjectTokenSource | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  switch (type) {
    case "github_actions": {
      const audience = record.audience;
      if (typeof audience !== "string" || audience.trim().length === 0) {
        throw new Error(
          `${path}.audience must be a non-empty string when type is "github_actions"`
        );
      }
      return { type: "github_actions", audience: audience.trim() };
    }
    case "kubernetes_sa": {
      const tokenPath = record.tokenPath;
      if (tokenPath !== undefined && tokenPath !== null) {
        if (typeof tokenPath !== "string" || tokenPath.trim().length === 0) {
          throw new Error(`${path}.tokenPath must be a non-empty string when provided`);
        }
        return { type: "kubernetes_sa", tokenPath: tokenPath.trim() };
      }
      return { type: "kubernetes_sa" };
    }
    case "file": {
      const filePath = record.path;
      if (typeof filePath !== "string" || filePath.trim().length === 0) {
        throw new Error(`${path}.path must be a non-empty string when type is "file"`);
      }
      return { type: "file", path: filePath.trim() };
    }
    case "env": {
      const varName = record.var;
      if (typeof varName !== "string" || varName.trim().length === 0) {
        throw new Error(`${path}.var must be a non-empty string when type is "env"`);
      }
      return { type: "env", var: varName.trim() };
    }
    default:
      throw new Error(
        `${path}.type must be one of "github_actions" | "kubernetes_sa" | "file" | "env" (received ${JSON.stringify(type)})`
      );
  }
}

export function validateAuthConfig(input: AuthServerConfigInput): AuthServerConfig {
  if (!input || typeof input !== "object") {
    throw new Error("auth config must be an object");
  }

  const path = "";
  const id = ensureString(input.id, `${path}.id`);
  const issuer = ensureString(input.issuer, `${path}.issuer`);
  const clientId = ensureString(input.clientId, `${path}.clientId`);
  const scopes = ensureStringArray(input.scopes, `${path}.scopes`);
  const authFlow = validateAuthFlow(input.authFlow, `${path}.authFlow`);
  const pkce = validatePkce(input.pkce, `${path}.pkce`);
  const redirectPort = validateRedirectPort(input.redirectPort, `${path}.redirectPort`);
  const subjectTokenSource = validateSubjectTokenSource(
    input.subjectTokenSource,
    `${path}.subjectTokenSource`
  );

  let clientSecret: string | undefined;
  if (input.clientSecret !== undefined && input.clientSecret !== null) {
    if (typeof input.clientSecret !== "string" || input.clientSecret.length === 0) {
      throw new Error(`${path}.clientSecret must be a non-empty string when provided`);
    }
    clientSecret = input.clientSecret;
  }

  if (authFlow === "client_credentials" && !clientSecret) {
    throw new Error(`${path}.clientSecret is required when authFlow is "client_credentials"`);
  }

  if ((authFlow === "jwt_bearer" || authFlow === "token_exchange") && !subjectTokenSource) {
    throw new Error(
      `${path}.subjectTokenSource is required when authFlow is "${authFlow}" — set it to {type: "github_actions" | "kubernetes_sa" | "file" | "env", ...}`
    );
  }

  let tokenExchangeAudience: string | undefined;
  if (input.tokenExchangeAudience !== undefined && input.tokenExchangeAudience !== null) {
    if (
      typeof input.tokenExchangeAudience !== "string" ||
      input.tokenExchangeAudience.trim().length === 0
    ) {
      throw new Error(`${path}.tokenExchangeAudience must be a non-empty string when provided`);
    }
    tokenExchangeAudience = input.tokenExchangeAudience.trim();
  }

  return {
    id,
    issuer,
    clientId,
    clientSecret,
    scopes,
    authorizationEndpoint: input.authorizationEndpoint,
    tokenEndpoint: input.tokenEndpoint,
    deviceAuthorizationEndpoint: input.deviceAuthorizationEndpoint,
    jwksUri: input.jwksUri,
    redirectPort,
    authFlow,
    pkce,
    subjectTokenSource,
    tokenExchangeAudience
  };
}
