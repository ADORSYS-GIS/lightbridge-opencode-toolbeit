import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";

import {
  DEFAULT_LOG_LEVEL,
  type OAuth2ModelSyncConfigInput,
  type OAuthAuthFlow,
  type OAuthServerConfigInput,
  type SubjectTokenSource
} from "./config.js";
import {
  createJsonConsoleLogger,
  type LogFields,
  LOG_LEVEL_PRIORITY,
  type Logger,
  type LogLevel
} from "./logging.js";
import { OAuth2ModelSyncPlugin } from "./plugin.js";
import { createResponsesRepairFetch } from "./responses-repair.js";
import type { TokenSet } from "./types.js";

/**
 * Map OpenCode's host-level `config.logLevel` (uppercase `"DEBUG" | "INFO" |
 * "WARN" | "ERROR"`) to this plugin's internal `LogLevel`. Unknown / missing
 * values fall through to `undefined` so the caller can apply its own default —
 * we never throw on the OpenCode-supplied value because the host owns
 * validation of its own field.
 *
 * Note: host `DEBUG` unlocks this plugin's most-verbose `"trace"` tier (there
 * is no separate host `TRACE` level), so running OpenCode with
 * `--log-level DEBUG` surfaces the `oauth2_*` trace events emitted across the
 * runtime hot paths.
 */
export function fromOpenCodeLogLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  switch (value.toUpperCase()) {
    case "DEBUG":
      return "trace";
    case "INFO":
      return "info";
    case "WARN":
      return "warn";
    case "ERROR":
      return "error";
    default:
      return undefined;
  }
}

const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";
// The native OpenAI provider. Since AI SDK v5 its default `languageModel()`
// targets the Responses API (`/v1/responses`), where `@ai-sdk/openai-compatible`
// only ever speaks Chat Completions (`/v1/chat/completions`). Opting a provider
// into `responseApi: true` swaps the emitted `npm` to this package so OpenCode
// routes inference through the gateway's Responses endpoint instead.
const OPENAI_RESPONSES_NPM = "@ai-sdk/openai";
// Unlike `@ai-sdk/openai-compatible`, the native provider throws
// "OpenAI API key is missing" at request construction when no `apiKey` is set.
// We inject the real bearer per-request via `chat.headers` (which overwrites
// Authorization before anything leaves the process), so this inert placeholder
// only exists to satisfy that construction-time guard — it is never sent.
const RESPONSES_API_PLACEHOLDER_KEY = "oauth2-managed-bearer";
const OAUTH_OPTIONS_KEYS = ["oauth2", "oauth2ModelSync"] as const;
const PLUGIN_SERVICE_NAME = "opencode-oauth2-plugin";

function resolveProviderNpm(responseApi: boolean | undefined): string {
  return responseApi ? OPENAI_RESPONSES_NPM : OPENAI_COMPATIBLE_NPM;
}

/**
 * When a provider opts into the Responses API, ensure its options carry an
 * `apiKey` so the native `@ai-sdk/openai` provider can be constructed. A
 * user-supplied key is left untouched; otherwise we stamp an inert placeholder
 * (the real bearer is injected per-request by `chat.headers`). A no-op for
 * Chat-Completions providers, which need no key.
 */
function applyResponsesApiOptions(
  options: Record<string, unknown>,
  responseApi: boolean | undefined,
  providerId: string,
  logger: Logger
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

  // Repair the gateway's Responses SSE: some gateways (e.g. Envoy AI Gateway)
  // omit `output_index` / `content_index`, which AI-SDK/OpenCode need to
  // assemble message parts (absent → "text part <id> not found"). We compose
  // with any pre-existing fetch so a later fetch-wrapping plugin (e.g.
  // @vymalo/opencode-ratelimit) still wraps ours rather than clobbering it.
  const delegate = typeof next.fetch === "function" ? (next.fetch as typeof fetch) : undefined;
  next.fetch = createResponsesRepairFetch(delegate);

  return next;
}

type OpenCodeConfig = Parameters<NonNullable<Hooks["config"]>>[0];
type OpenCodeProviderMap = NonNullable<OpenCodeConfig["provider"]>;
type OpenCodeProviderConfig = OpenCodeProviderMap[string];
type OpenCodeModelConfig = NonNullable<OpenCodeProviderConfig["models"]>[string];

interface OAuthProviderExtension {
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

interface ManagedProviders {
  servers: OAuthServerConfigInput[];
}

interface RuntimeState {
  runtime?: OAuth2ModelSyncPlugin;
  signature?: string;
  managedProviderIds: Set<string>;
}

export interface OpenCodePluginFactoryOptions {
  logger?: Logger;
  fetchImpl?: typeof fetch;
  onAuthorizationUrl?: (url: string) => Promise<void> | void;
  cacheDir?: string;
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

function parseOAuthExtension(provider: OpenCodeProviderConfig): OAuthProviderExtension | undefined {
  const options = asRecord(provider.options);
  if (!options) {
    return undefined;
  }

  let raw: Record<string, unknown> | undefined;
  for (const key of OAUTH_OPTIONS_KEYS) {
    raw = asRecord(options[key]);
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
    // Deep validation of subjectTokenSource happens in validateConfig — this
    // layer just passes the raw value through so error messages reference
    // the canonical config path.
    subjectTokenSource: raw.subjectTokenSource as SubjectTokenSource | undefined,
    tokenExchangeAudience: asString(raw.tokenExchangeAudience),
    responseApi: asBoolean(raw.responseApi, "provider.options.oauth2.responseApi")
  };
}

function parsePluginConfigServers(
  config: OpenCodeConfig,
  logger: Logger
): OAuthServerConfigInput[] {
  const root = asRecord(config);
  const pluginConfig = asRecord(root?.pluginConfig);
  const oauth2ModelSync = asRecord(pluginConfig?.oauth2ModelSync);
  const servers = oauth2ModelSync?.servers;

  if (!Array.isArray(servers)) {
    return [];
  }

  const parsed: OAuthServerConfigInput[] = [];
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

    const sourceLabel = `pluginConfig.oauth2ModelSync.servers[${index}] (id=${id})`;

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

function collectManagedProviders(config: OpenCodeConfig, logger: Logger): ManagedProviders {
  const providers = (config.provider ??= {});
  const byId = new Map<string, OAuthServerConfigInput>();

  for (const server of parsePluginConfigServers(config, logger)) {
    const providerConfig = (providers[server.id] ??= {});
    const providerOptions = asRecord(providerConfig.options) ?? {};

    providerConfig.npm = resolveProviderNpm(server.responseApi);
    providerConfig.name = asString(providerConfig.name) ?? server.name ?? server.id;
    providerConfig.options = applyResponsesApiOptions(
      { ...providerOptions, baseURL: server.baseURL },
      server.responseApi,
      server.id,
      logger
    );

    byId.set(server.id, {
      ...server,
      name: providerConfig.name ?? server.name ?? server.id
    });
  }

  for (const [providerId, providerConfig] of Object.entries(providers)) {
    const extension = parseOAuthExtension(providerConfig);
    if (!extension) {
      continue;
    }

    const options = asRecord(providerConfig.options) ?? {};
    const baseURL = asString(options.baseURL);
    if (!baseURL) {
      logger.warn("provider_skipped_missing_baseurl", { providerId });
      continue;
    }

    const providerName = asString(providerConfig.name) ?? providerId;
    providerConfig.npm = resolveProviderNpm(extension.responseApi);
    providerConfig.name = providerName;
    providerConfig.options = applyResponsesApiOptions(
      { ...options, baseURL },
      extension.responseApi,
      providerId,
      logger
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

function runtimeSignature(config: OAuth2ModelSyncConfigInput): string {
  const sorted = [...config.servers].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(sorted);
}

function mergeDiscoveredModels(
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

async function propagateCachedBearer(
  providerConfig: OpenCodeProviderConfig,
  providerId: string,
  runtime: OAuth2ModelSyncPlugin,
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

function createOpenCodeLogger(client: PluginInput["client"], getMinLevel: () => LogLevel): Logger {
  // Bypass createJsonConsoleLogger's own filter so the gate stays driven by
  // the current value of getMinLevel() — the level can change once the plugin
  // sees `pluginConfig.oauth2ModelSync.logLevel` during the `config` hook.
  const fallback = createJsonConsoleLogger("debug");
  // OpenCode already captures plugin logs via client.app.log (and filters them
  // by its own log level). Mirroring every event to stdout on top of that just
  // floods the terminal, so only mirror warn/error to the JSON console by
  // default; set VYMALO_PLUGIN_CONSOLE_LOG=1 to restore full console output.
  const consoleAll = /^(1|true|yes|on)$/i.test(process.env.VYMALO_PLUGIN_CONSOLE_LOG ?? "");

  const write = (
    level: "trace" | "debug" | "info" | "warn" | "error",
    event: string,
    fields?: LogFields
  ) => {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[getMinLevel()]) {
      return;
    }

    if (consoleAll || level === "warn" || level === "error") {
      fallback[level](event, fields);
    }

    // OpenCode's host log API has no dedicated `trace` level, so forward our
    // most-verbose tier as host `debug` (the trace gate above already ran, so
    // host-side filtering only sees records we intended to surface). The
    // original event name still carries the `oauth2_*` prefix, so the record
    // remains identifiable in the host log stream.
    const hostLevel = level === "trace" ? "debug" : level;

    void client.app
      .log({
        body: {
          service: PLUGIN_SERVICE_NAME,
          level: hostLevel,
          message: event,
          extra: fields
        }
      })
      .catch(() => {
        // Best-effort forwarding; console logger is the reliable fallback.
      });
  };

  return {
    trace(event, fields) {
      write("trace", event, fields);
    },
    debug(event, fields) {
      write("debug", event, fields);
    },
    info(event, fields) {
      write("info", event, fields);
    },
    warn(event, fields) {
      write("warn", event, fields);
    },
    error(event, fields) {
      write("error", event, fields);
    }
  };
}

export function createOpencodeOauth2Plugin(
  factoryOptions: OpenCodePluginFactoryOptions = {}
): Plugin {
  return async ({ client }) => {
    // The plugin defers to OpenCode's own `config.logLevel` for filter
    // decisions. Until the first `config` hook fires we don't know what the
    // host picked, so we start at the package default (`"info"`) and update
    // the holder once we see the real value.
    let currentLogLevel: LogLevel = DEFAULT_LOG_LEVEL;
    const logger = factoryOptions.logger ?? createOpenCodeLogger(client, () => currentLogLevel);

    const state: RuntimeState = {
      runtime: undefined,
      signature: undefined,
      managedProviderIds: new Set<string>()
    };

    return {
      config: async (config) => {
        // Apply the host's logLevel BEFORE walking the config: parsing emits
        // `plugin_config_server_invalid` / `plugin_config_server_missing_fields`
        // warnings via `logger`, and those need to be filtered against the
        // user's chosen threshold — not the bootstrap default.
        currentLogLevel = fromOpenCodeLogLevel(config.logLevel) ?? DEFAULT_LOG_LEVEL;
        logger.trace("oauth2_config_hook_start", {
          logLevel: currentLogLevel,
          hostLogLevel: typeof config.logLevel === "string" ? config.logLevel : undefined
        });
        const managed = collectManagedProviders(config, logger);
        logger.trace("oauth2_config_hook_collected_providers", {
          managedCount: managed.servers.length,
          providerIds: managed.servers.map((server) => server.id)
        });

        if (managed.servers.length === 0) {
          logger.trace("oauth2_config_hook_no_managed_providers", {});
          state.runtime?.stop();
          state.runtime = undefined;
          state.signature = undefined;
          state.managedProviderIds = new Set<string>();
          return;
        }

        const pluginConfig: OAuth2ModelSyncConfigInput = {
          servers: managed.servers,
          cacheNamespace: "opencode-oauth2-model-sync",
          logLevel: currentLogLevel
        };

        const signature = runtimeSignature(pluginConfig);
        if (!state.runtime || state.signature !== signature) {
          logger.trace("oauth2_runtime_rebuild", {
            reason: state.runtime ? "signature_changed" : "first_build",
            serverCount: pluginConfig.servers.length
          });
          state.runtime?.stop();

          state.runtime = new OAuth2ModelSyncPlugin(pluginConfig, {
            logger,
            fetchImpl: factoryOptions.fetchImpl,
            onAuthorizationUrl: factoryOptions.onAuthorizationUrl,
            cacheDir: factoryOptions.cacheDir
          });

          await state.runtime.initialize();
          await state.runtime.start({ warmup: true });
          state.signature = signature;
        } else {
          logger.trace("oauth2_runtime_reused", { serverCount: pluginConfig.servers.length });
        }

        state.managedProviderIds = new Set<string>(managed.servers.map((server) => server.id));

        const providers = (config.provider ??= {});
        const runtime = state.runtime;
        // Each provider is independent (distinct config object, distinct
        // runtime state), and propagation can do a token-refresh round trip
        // (up to httpTimeoutMs). Fan out so one slow IdP doesn't serialize
        // startup behind the others. propagateCachedBearer swallows its own
        // errors, so this never rejects.
        await Promise.all(
          [...state.managedProviderIds].map((providerId) => {
            const providerConfig = providers[providerId];
            if (!providerConfig) {
              return undefined;
            }

            const models = runtime.getServerModels(providerId);
            logger.trace("oauth2_config_hook_provider_models", {
              providerId,
              modelCount: models.length
            });
            if (models.length > 0) {
              mergeDiscoveredModels(providerConfig, models);
            }

            // Stamp the cached bearer onto `options.headers.Authorization` so
            // subsequent `config` hooks (e.g. @vymalo/opencode-models-info
            // fetching a metadata endpoint) can inherit it without depending
            // on this plugin. `chat.headers` still overwrites per-request with
            // a freshly-ensured token, so a stale value here can only ever
            // affect other config-time consumers — never the actual inference
            // call. We never clobber a user-set Authorization header.
            return propagateCachedBearer(providerConfig, providerId, runtime, logger);
          })
        );
        logger.trace("oauth2_config_hook_finished", {
          managedCount: state.managedProviderIds.size
        });
      },
      "chat.headers": async (input, output) => {
        const providerId = input.model?.providerID ?? input.provider?.info?.id;
        if (!providerId || !state.runtime || !state.managedProviderIds.has(providerId)) {
          logger.trace("oauth2_chat_headers_skipped", {
            providerId,
            managed: providerId ? state.managedProviderIds.has(providerId) : false
          });
          return;
        }

        logger.trace("oauth2_chat_headers_ensure_token", { providerId });
        const token = await state.runtime.ensureAccessToken(providerId);
        output.headers.Authorization = `${token.tokenType || "Bearer"} ${token.accessToken}`;
        logger.trace("oauth2_chat_headers_bearer_injected", {
          providerId,
          present: Boolean(token.accessToken),
          tokenType: token.tokenType || "Bearer"
        });

        if (state.runtime.getServerModels(providerId).length === 0) {
          logger.trace("oauth2_chat_headers_lazy_sync", { providerId });
          void state.runtime.syncServer(providerId);
        }
      }
    };
  };
}

export const OpencodeOauth2Plugin: Plugin = createOpencodeOauth2Plugin();

export default OpencodeOauth2Plugin;
