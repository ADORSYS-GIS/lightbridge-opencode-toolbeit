import {
  validateAuthConfig,
  type AuthServerConfig,
  type AuthServerConfigInput
} from "@vymalo/opencode-auth-core/lib";
import type { OtelPluginOptions } from "@vymalo/opencode-core-otel";

/** The `gateway` opt-in: which providers get the shared project bearer. */
export interface LightbridgeGatewayOptions {
  /** Project id for the shared RFC 8693 project-token exchange (ADR-0012). */
  projectId: string;
  /** OpenCode provider ids to inject `Authorization: Bearer <project-token>` on. */
  providers: string[];
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
   * Project id for the shared project-scoped token exchange. Only needed when
   * `otel` is configured without `gateway` (OTEL consumes the same
   * project-scoped token as the gateway, so it needs a project id too). When
   * `gateway` is also set, `gateway.projectId` is used automatically; an
   * explicit `projectId` here always wins over `gateway.projectId` if both
   * are present.
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
    throw new Error(`${path} must be an object with \`projectId\` and \`providers\``);
  }
  return {
    projectId: asNonEmptyString(raw.projectId, `${path}.projectId`),
    providers: asProviderList(raw.providers, `${path}.providers`)
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

/** Whether the parsed config has a module that needs the shared project token. */
export function needsProjectToken(options: ParsedLightbridgeOptions): boolean {
  return Boolean(options.gateway) || Boolean(options.otel);
}
