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
   * for the caller's **default project**.
   */
  projectId?: string;
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
   * here wins over `gateway.projectId` when both are set.
   */
  projectId?: string;
}

/** `LightbridgeOptions` after parsing: `auth` fully validated + defaulted. */
export interface ParsedLightbridgeOptions {
  auth: AuthServerConfig;
  gateway?: LightbridgeGatewayOptions;
  otel?: OtelPluginOptions;
  /** Resolved project id (`projectId` ?? `gateway.projectId`), if either was set. */
  projectId?: string;
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
  return {
    providers: asProviderList(raw.providers, `${path}.providers`),
    ...(projectId ? { projectId } : {})
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

  const explicitProjectId =
    typeof raw.projectId === "string" && raw.projectId.trim().length > 0
      ? raw.projectId.trim()
      : undefined;
  const projectId = explicitProjectId ?? gateway?.projectId;

  return { auth, gateway, otel, projectId };
}

/**
 * Whether the parsed config has a module (gateway or otel) that needs the
 * shared token — project-scoped when `projectId` is set, else a default-project
 * token. Determines whether the one shared runtime is built.
 */
export function needsProjectToken(options: ParsedLightbridgeOptions): boolean {
  return Boolean(options.gateway) || Boolean(options.otel);
}
