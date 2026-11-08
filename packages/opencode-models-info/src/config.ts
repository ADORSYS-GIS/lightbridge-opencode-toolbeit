import type { ModelsInfoSettings } from "./types.js";

export const DEFAULT_TTL_SECONDS = 86_400;
export const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Fields a user may opt out of upstream-wins via `settings.modelsInfoOverwrite`.
 * Mirrors the keys of `ModelMetadata` (the v2 `Model.Info` target fields) —
 * anything outside this set is ignored so a typo never silently clobbers an
 * unrelated field.
 *
 * v1's `reasoning` and `attachment` are gone: `Model.Info` has no field for
 * either (attachment support is now implied by a non-text `capabilities.input`).
 * `tool_call` became `tools`; `modalities` split into `input` / `output`.
 */
export const OVERWRITABLE_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "tools",
  "temperature",
  "cost",
  "limit",
  "input",
  "output"
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "string" && raw.length > 0) {
      out[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asOverwriteList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw === "string" && OVERWRITABLE_FIELDS.has(raw) && !out.includes(raw)) {
      out.push(raw);
    }
  }
  return out.length > 0 ? out : undefined;
}

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

/**
 * Parse a provider's `settings` for the `modelsInfo*` opt-in keys. Returns
 * `null` if the provider has not opted in (no `settings.modelsInfoUrl`).
 *
 * v1 read these from `options.meta`; v2's `Provider.Info` has no `options`, so
 * they sit flat on the open `settings` struct beside `baseURL`.
 *
 * URL resolution follows the WHATWG URL spec when `modelsInfoUrl` is not
 * absolute, against `settings.baseURL`:
 *   - Absolute URL (`https://…`)            → used as-is.
 *   - Path starting with `/`                → resolves from the **origin**
 *                                             of `baseURL`. So with
 *                                             `baseURL: "https://x.test/v1"`
 *                                             and `modelsInfoUrl: "/models"`,
 *                                             you get `https://x.test/models`.
 *   - Path without leading `/`              → resolves **relative to**
 *                                             `baseURL`. So with
 *                                             `baseURL: "https://x.test/v1"`
 *                                             and `modelsInfoUrl: "models"`,
 *                                             you get `https://x.test/v1/models`.
 */
export function parseModelsInfoSettings(
  settings: Record<string, unknown> | undefined
): ModelsInfoSettings | null {
  if (!settings) {
    return null;
  }

  const rawUrl = asString(settings.modelsInfoUrl);
  if (!rawUrl) {
    return null;
  }

  const baseURL = asString(settings.baseURL);
  const modelsInfoUrl = resolveUrl(rawUrl, baseURL);

  return {
    modelsInfoUrl,
    modelsInfoTtlSeconds: asPositiveInt(settings.modelsInfoTtlSeconds, DEFAULT_TTL_SECONDS),
    modelsInfoTimeoutMs: asPositiveInt(settings.modelsInfoTimeoutMs, DEFAULT_TIMEOUT_MS),
    modelsInfoHeaders: asStringMap(settings.modelsInfoHeaders),
    modelsInfoOverwrite: asOverwriteList(settings.modelsInfoOverwrite),
    modelsInfoHideTextOnly: asBoolean(settings.modelsInfoHideTextOnly),
    modelsInfoHideInternal: asBoolean(settings.modelsInfoHideInternal),
    modelsInfoHideUnmatched: asBoolean(settings.modelsInfoHideUnmatched),
    modelsInfoFormat: "openrouter"
  };
}

function resolveUrl(candidate: string, baseURL: string | undefined): string {
  if (/^https?:\/\//i.test(candidate)) {
    return candidate;
  }
  if (!baseURL) {
    return candidate;
  }
  // Always treat the baseURL as a directory by appending a trailing slash if
  // it's missing. This way a path-relative `modelsInfoUrl` ("models/info")
  // resolves under the baseURL's path instead of replacing its last segment
  // (the WHATWG default). A leading-slash candidate ("/models/info") still
  // resolves from the origin per spec.
  const base = baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
  try {
    return new URL(candidate, base).toString();
  } catch {
    return candidate;
  }
}
