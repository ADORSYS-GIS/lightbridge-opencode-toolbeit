import type { OpenRouterModality, OpenRouterModel } from "./types.js";

const OPENCODE_MODALITIES = new Set(["text", "audio", "image", "video", "pdf"] as const);
type OpenCodeModality = "text" | "audio" | "image" | "video" | "pdf";

export interface ModelMetadata {
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: {
    context: number;
    output: number;
  };
  modalities?: {
    input: OpenCodeModality[];
    output: OpenCodeModality[];
  };
}

/**
 * Pure transformation from an OpenRouter model entry to the subset of
 * OpenCode `ModelConfig` fields we know how to populate. Returns only the
 * fields we can derive; callers do the upstream-wins merge.
 */
export function mapOpenRouterEntry(
  entry: OpenRouterModel,
  overwrite?: ReadonlySet<string>
): ModelMetadata {
  const out: ModelMetadata = {};

  if (entry.name) {
    out.name = entry.name;
  }

  const context = entry.top_provider?.context_length ?? entry.context_length;
  const output = entry.top_provider?.max_completion_tokens;
  if (typeof context === "number" && typeof output === "number") {
    out.limit = { context, output };
  } else if (typeof context === "number") {
    // OpenCode requires both fields when `limit` is set. Skip rather than fake.
  }

  const cost = mapPricing(entry.pricing);
  if (cost) {
    out.cost = cost;
  }

  const inputMods = filterModalities(entry.architecture?.input_modalities);
  const outputMods = filterModalities(entry.architecture?.output_modalities);
  if (inputMods.length > 0 && outputMods.length > 0) {
    out.modalities = { input: inputMods, output: outputMods };
  }

  const params = entry.supported_parameters ?? [];
  const paramSet = new Set(params.map((p) => p.toLowerCase()));
  // We can only *assert a capability false* when the source actually told us
  // about it. An absent `supported_parameters` / `input_modalities` means "we
  // don't know" — never a misleading `false`.
  const knowsParams = Array.isArray(entry.supported_parameters);
  const knowsInputMods = Array.isArray(entry.architecture?.input_modalities);

  setCapability(out, "tool_call", paramSet.has("tools") || paramSet.has("tool_choice"), {
    known: knowsParams,
    overwrite
  });
  setCapability(
    out,
    "reasoning",
    paramSet.has("reasoning") || paramSet.has("reasoning_effort") || paramSet.has("thinking"),
    { known: knowsParams, overwrite }
  );
  setCapability(out, "temperature", paramSet.has("temperature"), {
    known: knowsParams,
    overwrite
  });
  setCapability(
    out,
    "attachment",
    inputMods.some((m) => m !== "text"),
    {
      known: knowsInputMods,
      overwrite
    }
  );

  return out;
}

/**
 * Emit a capability flag. By default these are *true-only*: an absent
 * capability stays `undefined`, which under upstream-wins correctly means
 * "leave whatever is there". But a field opted into `overwrite` wants the
 * endpoint's answer to win outright — so we must also emit an explicit `false`
 * to clear a stale `true` another plugin stamped. We only do that when the
 * source actually carried the relevant data (`known`); otherwise there is
 * nothing to assert and the field stays `undefined`.
 */
function setCapability(
  out: ModelMetadata,
  field: "tool_call" | "reasoning" | "temperature" | "attachment",
  present: boolean,
  opts: { known: boolean; overwrite?: ReadonlySet<string> }
): void {
  if (present) {
    out[field] = true;
  } else if (opts.known && opts.overwrite?.has(field)) {
    out[field] = false;
  }
}

function mapPricing(pricing: OpenRouterModel["pricing"]): ModelMetadata["cost"] | undefined {
  if (!pricing) {
    return undefined;
  }

  const input = perMillion(pricing.prompt);
  const output = perMillion(pricing.completion);
  if (input === undefined || output === undefined) {
    return undefined;
  }

  const cost: NonNullable<ModelMetadata["cost"]> = { input, output };
  const cacheRead = perMillion(pricing.input_cache_read);
  if (cacheRead !== undefined) {
    cost.cache_read = cacheRead;
  }
  const cacheWrite = perMillion(pricing.input_cache_write);
  if (cacheWrite !== undefined) {
    cost.cache_write = cacheWrite;
  }
  return cost;
}

/** OpenRouter pricing is a string per-token in USD; OpenCode stores per-1M-token. */
function perMillion(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return roundTo(parsed * 1_000_000, 6);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * A model is "text-only" when the source reported modalities and both input
 * and output are exactly `["text"]` — no vision/audio/video/pdf on either
 * side. Undefined `modalities` means the source never told us, so we can't
 * claim text-only (consistent with the true-only / "known" pattern above).
 */
export function isTextOnlyModality(modalities: ModelMetadata["modalities"]): boolean {
  if (!modalities) {
    return false;
  }
  const isTextOnlyList = (mods: OpenCodeModality[]): boolean =>
    mods.length === 1 && mods[0] === "text";
  return isTextOnlyList(modalities.input) && isTextOnlyList(modalities.output);
}

function filterModalities(values: OpenRouterModality[] | undefined): OpenCodeModality[] {
  if (!values) {
    return [];
  }
  const out: OpenCodeModality[] = [];
  for (const value of values) {
    if (
      OPENCODE_MODALITIES.has(value as OpenCodeModality) &&
      !out.includes(value as OpenCodeModality)
    ) {
      out.push(value as OpenCodeModality);
    }
  }
  return out;
}

/**
 * Merge a derived metadata snapshot onto an existing OpenCode model entry.
 * Upstream wins by default: any field already present is left untouched.
 * Returns the same object reference (mutated) for ergonomic chaining.
 *
 * `overwrite` opts specific fields *out* of upstream-wins, letting the derived
 * (endpoint) value replace one that's already set. This exists because another
 * plugin (e.g. `@vymalo/opencode-oauth2`) may auto-stamp a field such as `name`
 * before this hook runs — to upstream-wins that looks like deliberate user
 * config, so without an opt-out the endpoint's value can never land. A field
 * named in `overwrite` only wins when the derived value is actually present.
 */
export function mergeIntoModel<T extends Record<string, unknown>>(
  existing: T,
  derived: ModelMetadata,
  overwrite?: ReadonlySet<string>
): T {
  for (const [key, value] of Object.entries(derived)) {
    if (value === undefined) {
      continue;
    }
    if (existing[key] === undefined || overwrite?.has(key)) {
      (existing as Record<string, unknown>)[key] = value;
    }
  }
  return existing;
}
