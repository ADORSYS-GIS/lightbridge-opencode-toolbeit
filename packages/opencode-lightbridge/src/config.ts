import {
  validateAuthConfig,
  type AuthServerConfig,
  type AuthServerConfigInput
} from "@vymalo/opencode-auth-core/lib";
import type { OtelPluginOptions } from "@vymalo/opencode-core-otel";

/** The `gateway` opt-in: which providers get the shared project bearer. */
export interface LightbridgeGatewayOptions {
  /** OpenCode provider ids to inject `Authorization: Bearer <project-token>` on. */
  providers: string[];
  /**
   * Optional project id for the shared RFC 8693 exchange (ADR-0012). When
   * omitted, the exchange sends no `project_id` and the backend mints a token
   * for the caller's **default project**. Only meaningful when `exchange` is
   * `true` — ignored otherwise (there is no exchange call to attach it to).
   */
  projectId?: string;
  /**
   * Whether to perform the RFC 8693 token exchange (ADR-0012) before using
   * the result as the gateway bearer. Defaults to `false` (ADR-0017 amends
   * ADR-0012): most IdP setups hand out an access token that is already
   * scoped for the gateway, and an unconditional exchange fails outright for
   * a client that has no `token-exchange` grant registered (`unauthorized_client`).
   *
   * - `false` (default): the IdP access token from `auth` is used directly
   *   as `Authorization: Bearer <token>` — no second network call, no extra
   *   grant required.
   * - `true`: today's ADR-0012 behaviour, unchanged — the human token is
   *   exchanged for a project-scoped token (optionally carrying `project_id`)
   *   and THAT is used as the bearer.
   */
  exchange?: boolean;
}

/**
 * The `register` opt-in (ADR-0017): register `auth`'s IdP as an OpenCode
 * provider and keep its model list in sync via the SAME
 * `@vymalo/opencode-provider-sync` engine `@vymalo/opencode-oauth2` uses —
 * "everything oauth2 does", now available from lightbridge too. Independent
 * of `gateway` (header injection) and `otel`: a config can register a
 * provider without ever using it as the gateway bearer target, though the
 * common case sets `gateway.providers` to the same id.
 */
export interface LightbridgeRegisterOptions {
  /** Base URL of the OpenAI-compatible (or Responses) inference endpoint. */
  baseURL: string;
  /** Display name for the registered OpenCode provider. Defaults to `auth.id`. */
  name?: string;
  /** Raw model id -> display name overrides, applied at discovery time. */
  nameOverrides?: Record<string, string>;
  /** Minutes between model-discovery syncs. Defaults to 60 (matches oauth2). */
  syncIntervalMinutes?: number;
  /**
   * Route inference through the OpenAI Responses API instead of Chat
   * Completions — see `@vymalo/opencode-provider-sync`'s `resolveProviderNpm`.
   */
  responseApi?: boolean;
}

/**
 * Plugin options as written under the `opencode-lightbridge` entry of
 * `plugin` in `opencode.json` (or served through `.well-known/opencode`).
 * `auth` is the one IdP login every egress rides on; `gateway` and `otel` are
 * each independently optional — omitting both is a valid, inert config (the
 * plugin logs and no-ops). See ADR-0012.
 */
export interface LightbridgeOptions {
  auth: AuthServerConfigInput;
  gateway?: LightbridgeGatewayOptions;
  otel?: OtelPluginOptions;
  /**
   * Optional project id for the shared project-scoped token exchange. Fully
   * optional: when omitted, the exchange sends no `project_id` and the backend
   * mints a token for the caller's **default project**. An explicit `projectId`
   * here wins over `gateway.projectId` when both are set. Only meaningful
   * when `gateway.exchange` is `true`.
   */
  projectId?: string;
  /** NEW (ADR-0017): register `auth`'s IdP as an OpenCode provider + sync its models. */
  register?: LightbridgeRegisterOptions;
}

/** `LightbridgeOptions` after parsing: `auth` fully validated + defaulted. */
export interface ParsedLightbridgeOptions {
  auth: AuthServerConfig;
  gateway?: LightbridgeGatewayOptions;
  otel?: OtelPluginOptions;
  /** Resolved project id (`projectId` ?? `gateway.projectId`), if either was set. */
  projectId?: string;
  register?: LightbridgeRegisterOptions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function asProviderList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array of provider ids`);
  }
  return value.map((entry, index) => asNonEmptyString(entry, `${path}[${index}]`));
}

function asBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean (received ${JSON.stringify(value)})`);
  }
  return value;
}

function parseGateway(raw: unknown, path: string): LightbridgeGatewayOptions | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new Error(`${path} must be an object with \`providers\` (and an optional \`projectId\`)`);
  }
  const projectId =
    raw.projectId === undefined || raw.projectId === null
      ? undefined
      : asNonEmptyString(raw.projectId, `${path}.projectId`);
  // Opt-in (ADR-0017, amends ADR-0012): defaults to `false` — see
  // `LightbridgeGatewayOptions.exchange`'s doc comment for the rationale.
  const exchange = asBoolean(raw.exchange, `${path}.exchange`) ?? false;
  return {
    providers: asProviderList(raw.providers, `${path}.providers`),
    exchange,
    ...(projectId ? { projectId } : {})
  };
}

function asStringMap(value: unknown, path: string): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object mapping model id -> display name`);
  }
  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    normalized[key] = asNonEmptyString(entry, `${path}.${key}`);
  }
  return normalized;
}

function parseRegister(raw: unknown, path: string): LightbridgeRegisterOptions | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new Error(`${path} must be an object with at least \`baseURL\``);
  }

  const syncIntervalMinutes =
    typeof raw.syncIntervalMinutes === "number" &&
    Number.isFinite(raw.syncIntervalMinutes) &&
    raw.syncIntervalMinutes > 0
      ? raw.syncIntervalMinutes
      : undefined;

  return {
    baseURL: asNonEmptyString(raw.baseURL, `${path}.baseURL`),
    name:
      raw.name === undefined || raw.name === null
        ? undefined
        : asNonEmptyString(raw.name, `${path}.name`),
    nameOverrides: asStringMap(raw.nameOverrides, `${path}.nameOverrides`),
    syncIntervalMinutes,
    responseApi: asBoolean(raw.responseApi, `${path}.responseApi`)
  };
}

function parseOtel(raw: unknown, path: string): OtelPluginOptions | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new Error(`${path} must be an object (OtelPluginOptions)`);
  }
  // Deep validation of the otel block itself is `resolveOtelConfig`'s job
  // (it never throws — malformed/missing fields fall back to defaults); this
  // parser only guards the block's own shape.
  return raw as OtelPluginOptions;
}

/**
 * Parse + validate the plugin's `pluginOptions` (2nd factory arg). `auth` is
 * required and validated eagerly via auth-core's `validateAuthConfig` so a
 * malformed IdP block fails fast with a field-level error — mirroring
 * repo-auth/oauth2. `gateway` and `otel` are each optional and independently
 * activate their module (see `opencode.ts`); an only-`auth` config is valid
 * and inert.
 */
export function parseLightbridgeOptions(raw: unknown): ParsedLightbridgeOptions {
  if (!isRecord(raw)) {
    throw new Error(
      "@vymalo/opencode-lightbridge options must be an object with at least an `auth` block"
    );
  }
  if (!isRecord(raw.auth)) {
    throw new Error("lightbridge.auth is required and must be an object (AuthServerConfigInput)");
  }

  const auth = validateAuthConfig(raw.auth as unknown as AuthServerConfigInput);
  const gateway = parseGateway(raw.gateway, "lightbridge.gateway");
  const otel = parseOtel(raw.otel, "lightbridge.otel");
  const register = parseRegister(raw.register, "lightbridge.register");

  const explicitProjectId =
    typeof raw.projectId === "string" && raw.projectId.trim().length > 0
      ? raw.projectId.trim()
      : undefined;
  const projectId = explicitProjectId ?? gateway?.projectId;

  return { auth, gateway, otel, projectId, register };
}

/**
 * Whether the parsed config has a module (gateway or otel) that needs the
 * shared token — project-scoped when `projectId` is set (and `gateway.exchange`
 * is `true`), else the raw IdP token. Determines whether the one shared
 * runtime is built. `register` doesn't gate this: it drives a separate
 * `ProviderModelSyncEngine`, not `LightbridgeRuntime`.
 */
export function needsProjectToken(options: ParsedLightbridgeOptions): boolean {
  return Boolean(options.gateway) || Boolean(options.otel);
}

// ---- oauth2 provider-id collision guard (ADR-0017 requirement 4) ----------
//
// If a developer configures BOTH `@vymalo/opencode-oauth2` and lightbridge's
// `register` block against the SAME OpenCode provider id, they must not both
// register/own it — mirrors `@vymalo/opencode-repo-auth`'s
// `hasOAuth2Conflict`/`oauth2ManagedProviderIds` (which defers to oauth2 the
// same way). Kept as a lightbridge-local copy rather than a shared import:
// each consumer's own config-key literals are intentionally NOT centralized
// (see `@vymalo/opencode-provider-sync`'s `opencode-helpers.ts` module doc).

const OAUTH2_OPTION_KEYS = ["oauth2", "oauth2ModelSync"] as const;

export interface OpenCodeConfigLike {
  provider?: unknown;
  pluginConfig?: unknown;
}

/**
 * Provider ids managed by `@vymalo/opencode-oauth2` via its
 * `pluginConfig.oauth2ModelSync.servers` channel.
 */
export function oauth2ManagedProviderIds(config: OpenCodeConfigLike): Set<string> {
  const ids = new Set<string>();
  const pluginConfig = isRecord(config.pluginConfig) ? config.pluginConfig : undefined;
  const oauth2ModelSync = isRecord(pluginConfig?.oauth2ModelSync)
    ? pluginConfig?.oauth2ModelSync
    : undefined;
  const servers = oauth2ModelSync?.servers;
  if (Array.isArray(servers)) {
    for (const raw of servers) {
      const entry = isRecord(raw) ? raw : undefined;
      const id = typeof entry?.id === "string" ? entry.id : undefined;
      if (id) {
        ids.add(id);
      }
    }
  }
  return ids;
}

/**
 * Whether `providerId` is (also) managed by `@vymalo/opencode-oauth2` —
 * either via that provider's own `options.oauth2` / `options.oauth2ModelSync`
 * block, or via the `pluginConfig.oauth2ModelSync.servers` channel. Used by
 * lightbridge's `register` module to skip registering/owning a provider
 * oauth2 already claims (logged at `debug` — see `opencode.ts`).
 */
export function hasOAuth2Conflict(config: OpenCodeConfigLike, providerId: string): boolean {
  const providers = isRecord(config.provider) ? config.provider : undefined;
  const providerEntry = providers ? (providers as Record<string, unknown>)[providerId] : undefined;
  const providerOptions =
    isRecord(providerEntry) && isRecord(providerEntry.options) ? providerEntry.options : undefined;

  if (providerOptions && OAUTH2_OPTION_KEYS.some((key) => isRecord(providerOptions[key]))) {
    return true;
  }
  return oauth2ManagedProviderIds(config).has(providerId);
}
