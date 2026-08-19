import type {
  AuthServerConfigInput,
  OAuthAuthFlow,
  SubjectTokenSource
} from "@vymalo/opencode-auth-core/lib";

export const REPO_AUTH_META_KEY = "repoAuth";

/**
 * Parsed outcome of inspecting one provider's `options.meta.repoAuth`:
 *   - `not_opted_in`        — no `meta.repoAuth` block at all (skip silently).
 *   - `missing_project_id`  — block present but no `projectId` (warn; never
 *                             crash — the no-op matrix in docs/repo-auth.md).
 *   - `opted_in`            — a valid, self-contained config to manage.
 */
export type RepoAuthParseResult =
  | { kind: "not_opted_in" }
  | { kind: "missing_project_id" }
  | { kind: "opted_in"; config: RepoAuthConfig };

/** The per-provider opt-in: a `projectId` plus the IdP auth server config. */
export interface RepoAuthConfig {
  projectId: string;
  auth: AuthServerConfigInput;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => asString(entry))
      .filter((entry): entry is string => Boolean(entry));

    return normalized.length > 0 ? normalized : undefined;
  }

  if (typeof value === "string") {
    const normalized = value
      .split(/[\s,]+/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    return normalized.length > 0 ? normalized : undefined;
  }

  return undefined;
}

function asAuthFlow(value: unknown, source: string): OAuthAuthFlow | undefined {
  if (value === undefined || value === null) {
    return undefined;
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
    `${source}.authFlow must be one of "authorization_code" | "device_code" | "client_credentials" | "jwt_bearer" | "token_exchange" (received ${JSON.stringify(value)})`
  );
}

function asClientSecret(value: unknown, source: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${source}.clientSecret must be a non-empty string when provided`);
  }
  return value;
}

function asRedirectPort(value: unknown, source: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536) {
    return value;
  }
  throw new Error(
    `${source}.redirectPort must be an integer in [1, 65535] (received ${JSON.stringify(value)})`
  );
}

function asBoolean(value: unknown, source: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${source} must be a boolean (received ${JSON.stringify(value)})`);
  }
  return value;
}

function asSubjectTokenSource(value: unknown): SubjectTokenSource | undefined {
  // Shallow pass-through; deep validation happens in auth-core's
  // `validateAuthConfig` and its error messages reference the canonical path.
  return value as SubjectTokenSource | undefined;
}

/**
 * Parse a provider's `options.meta.repoAuth` opt-in block (mirrors models-info's
 * `options.meta.modelsInfoUrl` pattern). Throws malformed-field errors with the
 * canonical config path (`provider.options.meta.repoAuth`) so a typo is
 * debuggable; the missing-`projectId` case is a distinct sentinel, not an
 * error, because the no-op matrix requires it to warn-and-skip rather than
 * crash.
 */
export function parseRepoAuthOptions(
  providerOptions: Record<string, unknown> | undefined
): RepoAuthParseResult {
  if (!providerOptions) {
    return { kind: "not_opted_in" };
  }

  const meta = asRecord(providerOptions.meta);
  if (!meta) {
    return { kind: "not_opted_in" };
  }

  const raw = asRecord(meta[REPO_AUTH_META_KEY]);
  if (!raw) {
    return { kind: "not_opted_in" };
  }

  const projectId = asString(raw.projectId);
  if (!projectId) {
    return { kind: "missing_project_id" };
  }

  const source = "provider.options.meta.repoAuth";
  const issuer = asString(raw.issuer);
  const clientId = asString(raw.clientId);
  const scopes = asStringArray(raw.scopes);

  if (!issuer || !clientId || !scopes) {
    throw new Error(
      `${source} requires non-empty issuer, clientId and scopes (projectId=${projectId})`
    );
  }

  return {
    kind: "opted_in",
    config: {
      projectId,
      auth: {
        id: REPO_AUTH_META_KEY,
        issuer,
        clientId,
        clientSecret: asClientSecret(raw.clientSecret, source),
        scopes,
        authorizationEndpoint: asString(raw.authorizationEndpoint),
        tokenEndpoint: asString(raw.tokenEndpoint),
        deviceAuthorizationEndpoint: asString(raw.deviceAuthorizationEndpoint),
        jwksUri: asString(raw.jwksUri),
        redirectPort: asRedirectPort(raw.redirectPort, source),
        authFlow: asAuthFlow(raw.authFlow, source),
        pkce: asBoolean(raw.pkce, `${source}.pkce`),
        subjectTokenSource: asSubjectTokenSource(raw.subjectTokenSource)
      }
    }
  };
}

const OAUTH2_CONFLICT_KEYS = ["oauth2", "oauth2ModelSync"] as const;

type OpenCodeConfigLike = {
  provider?: unknown;
  pluginConfig?: unknown;
};

/**
 * Provider ids managed by `@vymalo/opencode-oauth2` via the
 * `pluginConfig.oauth2ModelSync.servers` channel. oauth2 registers those
 * providers under their server `id` without touching `options` at all, so a
 * per-`options` scan alone would miss them.
 */
export function oauth2ManagedProviderIds(config: OpenCodeConfigLike): Set<string> {
  const ids = new Set<string>();
  const pluginConfig = asRecord(config.pluginConfig);
  const oauth2ModelSync = asRecord(pluginConfig?.oauth2ModelSync);
  const servers = asRecord(oauth2ModelSync)?.servers;
  if (Array.isArray(servers)) {
    for (const rawServer of servers) {
      const entry = asRecord(rawServer);
      const id = asString(entry?.id);
      if (id) {
        ids.add(id);
      }
    }
  }
  return ids;
}

/**
 * Detect whether a provider is (also) managed by `@vymalo/opencode-oauth2` —
 * either via the provider's own `options.oauth2` / `options.oauth2ModelSync`
 * blocks, or via the `pluginConfig.oauth2ModelSync.servers` channel (whose
 * provider ids are the server ids). The two plugins must never manage the same
 * provider — repo-auth skips (warn) rather than fight over headers.
 */
export function hasOAuth2Conflict(
  config: OpenCodeConfigLike,
  providerOptions: Record<string, unknown> | undefined,
  providerId?: string
): boolean {
  if (
    providerOptions &&
    OAUTH2_CONFLICT_KEYS.some((key) => asRecord(providerOptions[key]) !== undefined)
  ) {
    return true;
  }
  if (providerId && oauth2ManagedProviderIds(config).has(providerId)) {
    return true;
  }
  return false;
}
