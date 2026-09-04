import type { Hooks } from "@opencode-ai/plugin";

import type {
  Logger,
  OAuthAuthFlow,
  SubjectTokenSource,
  TokenSet
} from "@vymalo/opencode-auth-core/lib";
import type { ProviderModelSyncEngine } from "./engine.js";

/**
 * Host-config wiring helpers shared by any OpenCode plugin composing
 * `ProviderModelSyncEngine` (currently `@vymalo/opencode-oauth2`; a future
 * `@vymalo/opencode-lightbridge` gateway module is the second consumer).
 *
 * Deliberately NOT baked in here — each consumer supplies its own:
 * - the `pluginConfig.<key>` / `provider.options.<key>` config-key literals
 *   (oauth2's are `"oauth2ModelSync"` / `["oauth2", "oauth2ModelSync"]`);
 * - the Responses-API SSE repair hook (gateway-specific, injected via
 *   `createResponsesRepairFetch` — never imported here).
 */

const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";
// The native OpenAI provider. Since AI SDK v5 its default `languageModel()`
// targets the Responses API (`/v1/responses`), where `@ai-sdk/openai-compatible`
// only ever speaks Chat Completions (`/v1/chat/completions`). Opting a provider
// into `responseApi: true` swaps the emitted `npm` to this package so OpenCode
// routes inference through the gateway's Responses endpoint instead.
const OPENAI_RESPONSES_NPM = "@ai-sdk/openai";
// Unlike `@ai-sdk/openai-compatible`, the native provider throws
// "OpenAI API key is missing" at request construction when no `apiKey` is set.
// The real bearer is injected per-request via `chat.headers` (which overwrites
// Authorization before anything leaves the process), so this inert placeholder
// only exists to satisfy that construction-time guard — it is never sent.
const RESPONSES_API_PLACEHOLDER_KEY = "oauth2-managed-bearer";

export type OpenCodeConfig = Parameters<NonNullable<Hooks["config"]>>[0];
export type OpenCodeProviderMap = NonNullable<OpenCodeConfig["provider"]>;
export type OpenCodeProviderConfig = OpenCodeProviderMap[string];
export type OpenCodeModelConfig = NonNullable<OpenCodeProviderConfig["models"]>[string];

export interface ProviderExtension {
  issuer: string;
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
  pkce?: boolean;
  subjectTokenSource?: SubjectTokenSource;
  tokenExchangeAudience?: string;
  responseApi?: boolean;
}

/**
 * The raw, not-yet-validated per-server shape a consumer's own config module
 * normalizes/validates before handing servers to `ProviderModelSyncEngine`
 * (see `ProviderServerConfig` in `engine.ts` for the validated counterpart).
 */
export interface ProviderServerConfigInput {
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
  pkce?: boolean;
  subjectTokenSource?: SubjectTokenSource;
  tokenExchangeAudience?: string;
  responseApi?: boolean;
}

export interface ManagedProviders {
  servers: ProviderServerConfigInput[];
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

function asStringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    const text = asString(raw);
    if (!text) {
      continue;
    }

    normalized[key] = text;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function resolveProviderNpm(responseApi: boolean | undefined): string {
  return responseApi ? OPENAI_RESPONSES_NPM : OPENAI_COMPATIBLE_NPM;
}

export interface ApplyResponsesApiOptionsHooks {
  /**
   * Injected Responses-API SSE repair fetch factory (gateway-specific — e.g.
   * oauth2's `createResponsesRepairFetch`). Omit it for a consumer that has no
   * such repair need; `responseApi: true` still swaps the provider npm and
   * stamps the placeholder key, it just leaves `options.fetch` untouched.
   */
  createResponsesRepairFetch?: (delegate?: typeof fetch) => typeof fetch;
}

/**
 * When a provider opts into the Responses API, ensure its options carry an
 * `apiKey` so the native `@ai-sdk/openai` provider can be constructed. A
 * user-supplied key is left untouched; otherwise we stamp an inert placeholder
 * (the real bearer is injected per-request by `chat.headers`). A no-op for
 * Chat-Completions providers, which need no key.
 */
export function applyResponsesApiOptions(
  options: Record<string, unknown>,
  responseApi: boolean | undefined,
  providerId: string,
  logger: Logger,
  hooks: ApplyResponsesApiOptionsHooks = {}
): Record<string, unknown> {
  if (!responseApi) {
    // If the same provider id appears in both config shapes and an earlier pass
    // stamped our placeholder for Responses mode, but Responses ultimately loses
    // (this shape omits the flag), don't leave the fake key on the resulting
    // Chat-Completions provider. Only ever scrub our own placeholder.
    if (asString(options.apiKey) === RESPONSES_API_PLACEHOLDER_KEY) {
      const cleaned = { ...options };
      delete cleaned.apiKey;
      return cleaned;
    }
    return options;
  }

  logger.debug("oauth2_provider_response_api_enabled", { providerId });

  const next: Record<string, unknown> = { ...options };

  // The native @ai-sdk/openai provider throws at construction without an
  // apiKey; stamp an inert placeholder only when the user hasn't set one. The
  // real bearer is injected per-request by chat.headers, so it is never sent.
  if (!asString(next.apiKey)) {
    next.apiKey = RESPONSES_API_PLACEHOLDER_KEY;
  }

  if (hooks.createResponsesRepairFetch) {
    // Repair the gateway's Responses SSE: some gateways (e.g. Envoy AI Gateway)
    // omit `output_index` / `content_index`, which AI-SDK/OpenCode need to
    // assemble message parts (absent → "text part <id> not found"). We compose
    // with any pre-existing fetch so a later fetch-wrapping plugin (e.g.
    // @vymalo/opencode-ratelimit) still wraps ours rather than clobbering it.
    const delegate = typeof next.fetch === "function" ? (next.fetch as typeof fetch) : undefined;
    next.fetch = hooks.createResponsesRepairFetch(delegate);
  }

  return next;
}

export function parsePluginConfigServers(
  config: OpenCodeConfig,
  logger: Logger,
  options: { pluginConfigKey: string }
): ProviderServerConfigInput[] {
  const root = asRecord(config);
  const pluginConfig = asRecord(root?.pluginConfig);
  const scoped = asRecord(pluginConfig?.[options.pluginConfigKey]);
  const servers = scoped?.servers;

  if (!Array.isArray(servers)) {
    return [];
  }

  const parsed: ProviderServerConfigInput[] = [];
  for (const [index, rawServer] of servers.entries()) {
    const entry = asRecord(rawServer);
    if (!entry) {
      logger.warn("plugin_config_server_invalid", { index });
      continue;
    }

    const id = asString(entry.id);
    const name = asString(entry.name) ?? id;
    const issuer = asString(entry.issuer);
    const baseURL = asString(entry.baseURL);
    const clientId = asString(entry.clientId);
    const scopes = asStringArray(entry.scopes);

    if (!id || !issuer || !baseURL || !clientId || !scopes) {
      logger.warn("plugin_config_server_missing_fields", { index, id: id ?? "unknown" });
      continue;
    }

    const syncIntervalMinutes =
      typeof entry.syncIntervalMinutes === "number" &&
      Number.isFinite(entry.syncIntervalMinutes) &&
      entry.syncIntervalMinutes > 0
        ? entry.syncIntervalMinutes
        : undefined;

    const sourceLabel = `pluginConfig.${options.pluginConfigKey}.servers[${index}] (id=${id})`;

    parsed.push({
      id,
      name: name ?? id,
      issuer,
      baseURL,
      clientId,
      clientSecret: asClientSecret(entry.clientSecret, sourceLabel),
      scopes,
      syncIntervalMinutes,
      nameOverrides: asStringMap(entry.nameOverrides),
      authorizationEndpoint: asString(entry.authorizationEndpoint),
      tokenEndpoint: asString(entry.tokenEndpoint),
      deviceAuthorizationEndpoint: asString(entry.deviceAuthorizationEndpoint),
      jwksUri: asString(entry.jwksUri),
      redirectPort: asRedirectPort(entry.redirectPort, sourceLabel),
      authFlow: asAuthFlow(entry.authFlow, sourceLabel),
      pkce: asBoolean(entry.pkce, `${sourceLabel}.pkce`),
      subjectTokenSource: entry.subjectTokenSource as SubjectTokenSource | undefined,
      tokenExchangeAudience: asString(entry.tokenExchangeAudience),
      responseApi: asBoolean(entry.responseApi, `${sourceLabel}.responseApi`)
    });
  }

  return parsed;
}

export function parseOAuthExtension(
  provider: OpenCodeProviderConfig,
  options: { optionKeys: readonly string[] }
): ProviderExtension | undefined {
  const providerOptions = asRecord(provider.options);
  if (!providerOptions) {
    return undefined;
  }

  let raw: Record<string, unknown> | undefined;
  for (const key of options.optionKeys) {
    raw = asRecord(providerOptions[key]);
    if (raw) {
      break;
    }
  }

  if (!raw) {
    return undefined;
  }

  const issuer = asString(raw.issuer);
  const clientId = asString(raw.clientId);
  const scopes = asStringArray(raw.scopes);

  if (!issuer || !clientId || !scopes) {
    return undefined;
  }

  const syncIntervalMinutes =
    typeof raw.syncIntervalMinutes === "number" &&
    Number.isFinite(raw.syncIntervalMinutes) &&
    raw.syncIntervalMinutes > 0
      ? raw.syncIntervalMinutes
      : undefined;

  return {
    issuer,
    clientId,
    clientSecret: asClientSecret(raw.clientSecret, "provider.options.oauth2"),
    scopes,
    syncIntervalMinutes,
    nameOverrides: asStringMap(raw.nameOverrides),
    authorizationEndpoint: asString(raw.authorizationEndpoint),
    tokenEndpoint: asString(raw.tokenEndpoint),
    deviceAuthorizationEndpoint: asString(raw.deviceAuthorizationEndpoint),
    jwksUri: asString(raw.jwksUri),
    redirectPort: asRedirectPort(raw.redirectPort, "provider.options.oauth2"),
    authFlow: asAuthFlow(raw.authFlow, "provider.options.oauth2"),
    pkce: asBoolean(raw.pkce, "provider.options.oauth2.pkce"),
    // Deep validation of subjectTokenSource happens in each consumer's own
    // config module — this layer just passes the raw value through so error
    // messages reference the canonical config path.
    subjectTokenSource: raw.subjectTokenSource as SubjectTokenSource | undefined,
    tokenExchangeAudience: asString(raw.tokenExchangeAudience),
    responseApi: asBoolean(raw.responseApi, "provider.options.oauth2.responseApi")
  };
}

export interface CollectManagedProvidersOptions extends ApplyResponsesApiOptionsHooks {
  pluginConfigKey: string;
  optionKeys: readonly string[];
}

export function collectManagedProviders(
  config: OpenCodeConfig,
  logger: Logger,
  options: CollectManagedProvidersOptions
): ManagedProviders {
  const providers = (config.provider ??= {});
  const byId = new Map<string, ProviderServerConfigInput>();

  for (const server of parsePluginConfigServers(config, logger, options)) {
    const providerConfig = (providers[server.id] ??= {});
    const providerOptions = asRecord(providerConfig.options) ?? {};

    providerConfig.npm = resolveProviderNpm(server.responseApi);
    providerConfig.name = asString(providerConfig.name) ?? server.name ?? server.id;
    providerConfig.options = applyResponsesApiOptions(
      { ...providerOptions, baseURL: server.baseURL },
      server.responseApi,
      server.id,
      logger,
      options
    );

    byId.set(server.id, {
      ...server,
      name: providerConfig.name ?? server.name ?? server.id
    });
  }

  for (const [providerId, providerConfig] of Object.entries(providers)) {
    const extension = parseOAuthExtension(providerConfig, options);
    if (!extension) {
      continue;
    }

    const providerOptions = asRecord(providerConfig.options) ?? {};
    const baseURL = asString(providerOptions.baseURL);
    if (!baseURL) {
      logger.warn("provider_skipped_missing_baseurl", { providerId });
      continue;
    }

    const providerName = asString(providerConfig.name) ?? providerId;
    providerConfig.npm = resolveProviderNpm(extension.responseApi);
    providerConfig.name = providerName;
    providerConfig.options = applyResponsesApiOptions(
      { ...providerOptions, baseURL },
      extension.responseApi,
      providerId,
      logger,
      options
    );

    byId.set(providerId, {
      id: providerId,
      name: providerName,
      issuer: extension.issuer,
      baseURL,
      clientId: extension.clientId,
      clientSecret: extension.clientSecret,
      scopes: extension.scopes,
      syncIntervalMinutes: extension.syncIntervalMinutes,
      nameOverrides: extension.nameOverrides,
      authorizationEndpoint: extension.authorizationEndpoint,
      tokenEndpoint: extension.tokenEndpoint,
      deviceAuthorizationEndpoint: extension.deviceAuthorizationEndpoint,
      jwksUri: extension.jwksUri,
      redirectPort: extension.redirectPort,
      authFlow: extension.authFlow,
      pkce: extension.pkce,
      subjectTokenSource: extension.subjectTokenSource,
      tokenExchangeAudience: extension.tokenExchangeAudience,
      responseApi: extension.responseApi
    });
  }

  return { servers: [...byId.values()] };
}

export function runtimeSignature(config: { servers: Array<{ id: string }> }): string {
  const sorted = [...config.servers].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(sorted);
}

export function mergeDiscoveredModels(
  providerConfig: OpenCodeProviderConfig,
  models: Array<{ id: string; displayName: string }>
): void {
  const existingModels = (providerConfig.models ?? {}) as Record<string, OpenCodeModelConfig>;
  const merged: Record<string, OpenCodeModelConfig> = { ...existingModels };

  for (const model of models) {
    const existingModel = existingModels[model.id] ?? {};
    merged[model.id] = {
      ...existingModel,
      id: model.id,
      name: model.displayName
    };
  }

  providerConfig.models = merged;
}

export async function propagateCachedBearer(
  providerConfig: OpenCodeProviderConfig,
  providerId: string,
  runtime: ProviderModelSyncEngine,
  logger: Logger
): Promise<void> {
  const options = (providerConfig.options ??= {} as NonNullable<OpenCodeProviderConfig["options"]>);
  const headers = ((options as { headers?: Record<string, string> }).headers ??= {});
  // Case-insensitive scan so a user-set `authorization:` lowercase entry
  // also wins — HTTP header names are case-insensitive but most plugins use
  // PascalCase.
  const hasUserAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
  if (hasUserAuth) {
    logger.debug("oauth2_bearer_propagation_skipped_user_set", { providerId });
    return;
  }

  // Refresh-only ensure: returns the warmed-up token, transparently refreshing
  // one that's near expiry, and throws rather than opening a second browser /
  // device-code prompt if a fresh login would be required. This is stricter
  // than reading the raw cache (the previous behavior) — a token minted moments
  // ago for a short-lived realm no longer fails a fixed expiry-skew gate, which
  // is exactly the case that left `@vymalo/opencode-models-info` fetching an
  // OAuth2-protected `meta.modelsInfoUrl` without a bearer (HTTP 401). A stale
  // value here is still harmless: `chat.headers` overwrites per request.
  logger.trace("oauth2_bearer_propagation_start", { providerId });
  let token: TokenSet;
  try {
    token = await runtime.ensureAccessToken(providerId, { interactive: false });
  } catch (error) {
    logger.debug("oauth2_bearer_propagation_skipped_no_token", {
      providerId,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  if (!token.accessToken) {
    // ensureAccessToken resolved but with no usable token — surface it so a
    // downstream 401 (e.g. models-info) isn't a silent mystery.
    logger.debug("oauth2_bearer_propagation_skipped_empty_token", { providerId });
    return;
  }

  headers.Authorization = `${token.tokenType || "Bearer"} ${token.accessToken}`;
  logger.debug("oauth2_bearer_propagated_to_provider_headers", { providerId });
}
