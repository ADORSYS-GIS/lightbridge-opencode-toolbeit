import { Model, Provider } from "@opencode/plugin/effect";
import type { ProviderEditor } from "@opencode/plugin/effect/provider";

import type {
  Logger,
  OAuthAuthFlow,
  SubjectTokenSource,
  TokenSet
} from "@vymalo/opencode-auth-core/lib";
import type { ProviderModelSyncEngine } from "./engine.js";

/**
 * Provider-editor wiring helpers shared by any OpenCode v2 plugin composing
 * `ProviderModelSyncEngine` (`@vymalo/opencode-oauth2`, and lightbridge's
 * `register` module).
 *
 * v2 has no mutable global config object, so these helpers take the domain
 * editor a `ctx.provider.transform(...)` callback receives. An editor is only
 * valid *inside* that callback, which must be synchronous and cheap — so
 * anything effectful (the bearer lookup) is split into an async half that runs
 * beforehand and a sync half that applies the result.
 *
 * Deliberately NOT baked in here — each consumer supplies its own:
 * - the `provider.settings.<key>` opt-in key literals
 *   (oauth2's are `["oauth2", "oauth2ModelSync"]`);
 * - plugin options, which arrive as the caller's `ctx.options` object.
 *
 * The Responses-API SSE repair is gone from this layer: v1 injected it as
 * `provider.options.fetch`, and `Provider.Info` has no `fetch` field. A
 * consumer that needs it hooks `session.hook("http.response")` itself.
 */

// v2 names a provider's implementation with `Provider.Info.package`; AI-SDK
// packages carry an `aisdk:` prefix (v1 used the bare npm name in `npm`).
const AISDK_PREFIX = "aisdk:";
const OPENAI_COMPATIBLE_PACKAGE = `${AISDK_PREFIX}@ai-sdk/openai-compatible`;
// The native OpenAI provider. Since AI SDK v5 its default `languageModel()`
// targets the Responses API (`/v1/responses`), where `@ai-sdk/openai-compatible`
// only ever speaks Chat Completions (`/v1/chat/completions`). Opting a provider
// into `responseApi: true` swaps the emitted `package` to this one so OpenCode
// routes inference through the gateway's Responses endpoint instead.
const OPENAI_RESPONSES_PACKAGE = `${AISDK_PREFIX}@ai-sdk/openai`;
// Unlike `@ai-sdk/openai-compatible`, the native provider throws
// "OpenAI API key is missing" at request construction when no `apiKey` is set.
// The real bearer is injected per-request by the consumer's `model.request`
// hook (which overwrites Authorization before anything leaves the process), so
// this inert placeholder only exists to satisfy that construction-time guard —
// it is never sent.
const RESPONSES_API_PLACEHOLDER_KEY = "oauth2-managed-bearer";

export type { ProviderEditor };
/** The v2 provider shape (`Provider.Info`) the editor reads and writes. */
export type ProviderInfo = Provider.Info;
/** The v2 model shape (`Model.Info`) the editor reads and writes. */
export type ModelInfo = Model.Info;

/** Anything carrying a provider's open `settings` struct (e.g. a `Provider.Info`). */
export interface HasProviderSettings {
  readonly settings?: unknown;
}

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

/**
 * The `Provider.Info.package` value for a managed provider. v1 returned a bare
 * npm name for `provider.npm`; v2 keys the implementation off `package`, and
 * AI-SDK packages take an `aisdk:` prefix.
 */
export function resolveProviderPackage(responseApi: boolean | undefined): string {
  return responseApi ? OPENAI_RESPONSES_PACKAGE : OPENAI_COMPATIBLE_PACKAGE;
}

/**
 * When a provider opts into the Responses API, ensure its `settings` carry an
 * `apiKey` so the native `@ai-sdk/openai` provider can be constructed. A
 * user-supplied key is left untouched; otherwise we stamp an inert placeholder
 * (the real bearer is injected per-request by the consumer's `model.request`
 * hook). A no-op for Chat-Completions providers, which need no key.
 *
 * Field mapping from v1 `provider.options`: `apiKey` and `baseURL` live on
 * `Provider.Info.settings` (an open struct handed to the provider package);
 * `headers` moved to `Provider.Info.headers`; `fetch` has no v2 home at all.
 */
export function applyResponsesApiSettings(
  settings: Record<string, unknown>,
  responseApi: boolean | undefined,
  providerId: string,
  logger: Logger
): Record<string, unknown> {
  if (!responseApi) {
    // If the same provider id appears in both config shapes and an earlier pass
    // stamped our placeholder for Responses mode, but Responses ultimately loses
    // (this shape omits the flag), don't leave the fake key on the resulting
    // Chat-Completions provider. Only ever scrub our own placeholder.
    if (asString(settings.apiKey) === RESPONSES_API_PLACEHOLDER_KEY) {
      const cleaned = { ...settings };
      delete cleaned.apiKey;
      return cleaned;
    }
    return settings;
  }

  logger.debug("oauth2_provider_response_api_enabled", { providerId });

  const next: Record<string, unknown> = { ...settings };

  // The native @ai-sdk/openai provider throws at construction without an
  // apiKey; stamp an inert placeholder only when the user hasn't set one.
  if (!asString(next.apiKey)) {
    next.apiKey = RESPONSES_API_PLACEHOLDER_KEY;
  }

  return next;
}

/**
 * Read the `servers` array out of a plugin's own options object (`ctx.options`).
 * v1 read `config.pluginConfig.<key>.servers`; v2 has no `pluginConfig`, and a
 * plugin's options already are its own scope, so no key is needed.
 */
export function parsePluginOptionsServers(
  pluginOptions: Record<string, unknown> | undefined,
  logger: Logger
): ProviderServerConfigInput[] {
  const servers = asRecord(pluginOptions)?.servers;

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

    const sourceLabel = `options.servers[${index}] (id=${id})`;

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

/**
 * Parse a provider's per-provider OAuth opt-in out of `provider.settings`
 * (v1: `provider.options`). The first key in `settingsKeys` that holds an
 * object wins.
 */
export function parseOAuthExtension(
  provider: HasProviderSettings,
  options: { settingsKeys: readonly string[] }
): ProviderExtension | undefined {
  const providerSettings = asRecord(provider.settings);
  if (!providerSettings) {
    return undefined;
  }

  let raw: Record<string, unknown> | undefined;
  let matchedKey = "oauth2";
  for (const key of options.settingsKeys) {
    raw = asRecord(providerSettings[key]);
    if (raw) {
      matchedKey = key;
      break;
    }
  }

  if (!raw) {
    return undefined;
  }

  const source = `provider.settings.${matchedKey}`;
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
    clientSecret: asClientSecret(raw.clientSecret, source),
    scopes,
    syncIntervalMinutes,
    nameOverrides: asStringMap(raw.nameOverrides),
    authorizationEndpoint: asString(raw.authorizationEndpoint),
    tokenEndpoint: asString(raw.tokenEndpoint),
    deviceAuthorizationEndpoint: asString(raw.deviceAuthorizationEndpoint),
    jwksUri: asString(raw.jwksUri),
    redirectPort: asRedirectPort(raw.redirectPort, source),
    authFlow: asAuthFlow(raw.authFlow, source),
    pkce: asBoolean(raw.pkce, `${source}.pkce`),
    // Deep validation of subjectTokenSource happens in each consumer's own
    // config module — this layer just passes the raw value through so error
    // messages reference the canonical config path.
    subjectTokenSource: raw.subjectTokenSource as SubjectTokenSource | undefined,
    tokenExchangeAudience: asString(raw.tokenExchangeAudience),
    responseApi: asBoolean(raw.responseApi, `${source}.responseApi`)
  };
}

export interface CollectManagedProvidersOptions {
  /** `provider.settings.<key>` opt-in keys, first match wins (oauth2: `["oauth2", "oauth2ModelSync"]`). */
  settingsKeys: readonly string[];
}

/**
 * Create or update one managed provider on the editor. A provider that does
 * not exist yet is added with `activation: "enabled"` (the gateway's bearer
 * is not a connection the host knows about, so `"auto"` could leave it
 * inactive); an existing one keeps its activation, id and other fields.
 */
function upsertManagedProvider(
  editor: ProviderEditor,
  providerId: string,
  next: { name: string; package: string; settings: Record<string, unknown> }
): void {
  if (!editor.get(providerId)) {
    editor.add({
      info: {
        id: Provider.ID.make(providerId),
        name: next.name,
        activation: "enabled",
        package: next.package,
        settings: next.settings
      },
      models: []
    });
    return;
  }

  editor.update(providerId, (provider) => {
    provider.package = next.package;
    provider.name = next.name;
    provider.settings = next.settings as typeof provider.settings;
  });
}

/**
 * Materialize every managed provider on the editor and return the validated
 * server list for `ProviderModelSyncEngine`. Two sources, as in v1:
 *
 * 1. `pluginOptions.servers` (the plugin's own `ctx.options`) — each entry is
 *    added to, or merged onto, the editor;
 * 2. any provider already on the editor carrying a `settings.<key>` OAuth
 *    opt-in — which wins on a duplicate id (it runs second).
 *
 * Must be called inside a `ctx.provider.transform` callback. Idempotent, so
 * it is safe across `provider.reload()`.
 */
export function collectManagedProviders(
  editor: ProviderEditor,
  pluginOptions: Record<string, unknown> | undefined,
  logger: Logger,
  options: CollectManagedProvidersOptions
): ManagedProviders {
  const byId = new Map<string, ProviderServerConfigInput>();

  for (const server of parsePluginOptionsServers(pluginOptions, logger)) {
    const existing = editor.get(server.id)?.provider;
    // `Provider.Info.name` is required, so a provider declared without a name
    // reads back as its own id — treat that as "unset" and let the server's win.
    const existingName = existing && existing.name !== server.id ? existing.name : undefined;
    const name = existingName ?? server.name ?? server.id;

    upsertManagedProvider(editor, server.id, {
      name,
      package: resolveProviderPackage(server.responseApi),
      settings: applyResponsesApiSettings(
        { ...(asRecord(existing?.settings) ?? {}), baseURL: server.baseURL },
        server.responseApi,
        server.id,
        logger
      )
    });

    byId.set(server.id, { ...server, name });
  }

  for (const { provider } of editor.list()) {
    const extension = parseOAuthExtension(provider, options);
    if (!extension) {
      continue;
    }

    const providerId: string = provider.id;
    const providerSettings = asRecord(provider.settings) ?? {};
    const baseURL = asString(providerSettings.baseURL);
    if (!baseURL) {
      logger.warn("provider_skipped_missing_baseurl", { providerId });
      continue;
    }

    const providerName = asString(provider.name) ?? providerId;
    upsertManagedProvider(editor, providerId, {
      name: providerName,
      package: resolveProviderPackage(extension.responseApi),
      settings: applyResponsesApiSettings(
        { ...providerSettings, baseURL },
        extension.responseApi,
        providerId,
        logger
      )
    });

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

/**
 * Merge discovered models into a provider on the editor. Existing models are
 * kept as-is (a user's overrides survive) except that a model whose id was
 * discovered takes the discovered display `name`; ids not yet on the provider
 * are added as `Model.Info.default(...)` placeholders carrying that name.
 *
 * `ProviderEditor.models.update` can only edit an existing model, and `set`
 * replaces the provider's whole model list, so the union is built here and
 * written with one `set`. A provider the editor does not know is a no-op.
 *
 * Must be called inside a `ctx.provider.transform` callback.
 */
export function mergeDiscoveredModels(
  editor: ProviderEditor,
  providerId: string,
  models: Array<{ id: string; displayName: string }>
): void {
  const record = editor.get(providerId);
  if (!record) {
    return;
  }

  const names = new Map(models.map((model) => [model.id, model.displayName]));
  const merged: ModelInfo[] = [];

  for (const [key, existing] of record.models) {
    const name = names.get(key);
    merged.push(name === undefined ? existing : { ...existing, name });
    names.delete(key);
  }

  for (const [id, name] of names) {
    merged.push({
      ...Model.Info.default(Provider.ID.make(providerId), Model.ID.make(id)),
      name
    });
  }

  editor.models.set(providerId, merged);
}

/**
 * ASYNC half of the bearer handoff to `@vymalo/opencode-models-info`: resolve
 * the `Authorization` header value for a managed provider, or `undefined`.
 * Run it BEFORE registering/reloading the transform — transform callbacks must
 * stay synchronous, so the result is cached by the caller and applied with
 * {@link propagateCachedBearer}.
 *
 * Uses a refresh-only ensure: returns the warmed-up token, transparently
 * refreshing one that's near expiry, and throws rather than opening a second
 * browser / device-code prompt if a fresh login would be required. A token
 * minted moments ago for a short-lived realm therefore doesn't fail a fixed
 * expiry-skew gate. A stale value is harmless for inference: the consumer's
 * `model.request` hook overwrites Authorization per request.
 */
export async function resolveCachedBearer(
  providerId: string,
  runtime: ProviderModelSyncEngine,
  logger: Logger
): Promise<string | undefined> {
  logger.trace("oauth2_bearer_propagation_start", { providerId });
  let token: TokenSet;
  try {
    token = await runtime.ensureAccessToken(providerId, { interactive: false });
  } catch (error) {
    logger.debug("oauth2_bearer_propagation_skipped_no_token", {
      providerId,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }

  if (!token.accessToken) {
    // ensureAccessToken resolved but with no usable token — surface it so a
    // downstream 401 (e.g. models-info) isn't a silent mystery.
    logger.debug("oauth2_bearer_propagation_skipped_empty_token", { providerId });
    return undefined;
  }

  return `${token.tokenType || "Bearer"} ${token.accessToken}`;
}

/**
 * SYNC half of the bearer handoff: stamp `authorization` onto
 * `Provider.Info.headers.Authorization` so a later transform/consumer
 * (models-info fetching an OAuth-protected `modelsInfoUrl`) can reuse it.
 * Must be called inside a `ctx.provider.transform` callback.
 *
 * A user-set `Authorization` header (matched case-insensitively — header names
 * are case-insensitive but most config uses PascalCase) always wins and is
 * never overwritten. To tell the user's header from one this plugin stamped on
 * an earlier pass, pass the same `stamped` map every call: it records the last
 * value written per provider, and a header equal to it is ours to refresh.
 * This keeps the refresh working whether or not the host hands each transform
 * pass a fresh editor.
 */
export function propagateCachedBearer(
  editor: ProviderEditor,
  providerId: string,
  authorization: string | undefined,
  logger: Logger,
  stamped?: Map<string, string>
): void {
  if (!authorization) {
    return;
  }

  const record = editor.get(providerId);
  if (!record) {
    return;
  }

  const headers = record.provider.headers ?? {};
  const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === "authorization");
  if (existingKey !== undefined && headers[existingKey] !== stamped?.get(providerId)) {
    logger.debug("oauth2_bearer_propagation_skipped_user_set", { providerId });
    return;
  }

  editor.update(providerId, (provider) => {
    provider.headers = {
      ...(provider.headers ?? {}),
      [existingKey ?? "Authorization"]: authorization
    };
  });
  stamped?.set(providerId, authorization);
  logger.debug("oauth2_bearer_propagated_to_provider_headers", { providerId });
}
