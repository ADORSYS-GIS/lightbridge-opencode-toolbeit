import type { MetaProviderOptions } from "./types.js";

export const DEFAULT_TTL_SECONDS = 86_400;
export const DEFAULT_TIMEOUT_MS = 5_000;

const META_KEY = "meta";

/**
 * Fields a user may opt out of upstream-wins via `meta.modelsInfoOverwrite`.
 * Mirrors the keys of `ModelMetadata` — anything outside this set is ignored
 * so a typo never silently clobbers an unrelated field.
 */
const OVERWRITABLE_FIELDS = new Set([
  "name",
  "attachment",
  "reasoning",
  "temperature",
  "tool_call",
  "cost",
  "limit",
  "modalities"
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
 * Parse a provider's `options.meta` for opt-in model-info fields. Returns
 * `null` if the provider has not opted in (no `meta.modelsInfoUrl`).
 *
 * URL resolution follows the WHATWG URL spec when `modelsInfoUrl` is not
 * absolute:
 *   - Absolute URL (`https://…`)            → used as-is.
 *   - Path starting with `/`                → resolves from the **origin**
 *                                             of `baseURL`. So with
 *                                             `baseURL: "https://x.test/v1"`
 *                                             and `modelsInfoUrl: "/models"`,
 *                                             you get `https://x.test/models`.
 *                                             Useful when your metadata
 *                                             endpoint sits at a different
 *                                             path than the inference API.
 *   - Path without leading `/`              → resolves **relative to**
 *                                             `baseURL`. So with
 *                                             `baseURL: "https://x.test/v1"`
 *                                             and `modelsInfoUrl: "models"`,
 *                                             you get `https://x.test/v1/models`.
 *                                             Useful when metadata sits under
 *                                             the same path as inference.
 */
export function parseMetaOptions(
  providerOptions: Record<string, unknown> | undefined
): MetaProviderOptions | null {
  if (!providerOptions) {
    return null;
  }

  const meta = asRecord(providerOptions[META_KEY]);
  if (!meta) {
    return null;
  }

  const rawUrl = asString(meta.modelsInfoUrl);
  if (!rawUrl) {
    return null;
  }

  const baseURL = asString(providerOptions.baseURL);
  const modelsInfoUrl = resolveUrl(rawUrl, baseURL);

  return {
    modelsInfoUrl,
    modelsInfoTtlSeconds: asPositiveInt(meta.modelsInfoTtlSeconds, DEFAULT_TTL_SECONDS),
    modelsInfoTimeoutMs: asPositiveInt(meta.modelsInfoTimeoutMs, DEFAULT_TIMEOUT_MS),
    modelsInfoHeaders: asStringMap(meta.modelsInfoHeaders),
    modelsInfoOverwrite: asOverwriteList(meta.modelsInfoOverwrite),
    modelsInfoHideTextOnly: asBoolean(meta.modelsInfoHideTextOnly),
    modelsInfoHideInternal: asBoolean(meta.modelsInfoHideInternal),
    modelsInfoHideUnmatched: asBoolean(meta.modelsInfoHideUnmatched),
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
