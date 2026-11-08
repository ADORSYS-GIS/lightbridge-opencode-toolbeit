import type { OpenRouterModality, OpenRouterModel } from "./types.js";

const OPENCODE_MODALITIES = new Set(["text", "audio", "image", "video", "pdf"] as const);
type OpenCodeModality = "text" | "audio" | "image" | "video" | "pdf";

/** One pricing tier in `Model.Info.cost` (USD per 1M tokens). Untiered here. */
export interface ModelCost {
  input: number;
  output: number;
  cache: { read: number; write: number };
}

/**
 * The subset of `Model.Info` this plugin knows how to populate, keyed by the v2
 * target field it lands on:
 *
 * | key           | `Model.Info` field         | v1 field            |
 * | ------------- | -------------------------- | ------------------- |
 * | `name`        | `name`                     | `name`              |
 * | `tools`       | `capabilities.tools`       | `tool_call`         |
 * | `temperature` | `capabilities.temperature` | `temperature`       |
 * | `input`       | `capabilities.input`       | `modalities.input`  |
 * | `output`      | `capabilities.output`      | `modalities.output` |
 * | `cost`        | `cost[0]` (one tier)       | `cost`              |
 * | `limit`       | `limit`                    | `limit`             |
 *
 * v1's `reasoning` and `attachment` have no `Model.Info` field and are no
 * longer mapped (a non-text `capabilities.input` is what signals attachments).
 */
export interface ModelMetadata {
  name?: string;
  tools?: boolean;
  temperature?: boolean;
  cost?: ModelCost;
  limit?: {
    context: number;
    output: number;
  };
  input?: OpenCodeModality[];
  output?: OpenCodeModality[];
}

/** The mapped keys, in application order. */
export const METADATA_FIELDS: readonly (keyof ModelMetadata)[] = [
  "name",
  "limit",
  "cost",
  "input",
  "output",
  "tools",
  "temperature"
];

/**
 * Pure transformation from an OpenRouter model entry to the subset of
 * `Model.Info` fields we know how to populate. Returns only the fields we can
 * derive; callers do the upstream-wins merge ({@link applyMetadata}).
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
  // OpenCode requires both fields when `limit` is set. Skip rather than fake.
  if (typeof context === "number" && typeof output === "number") {
    out.limit = { context, output };
  }

  const cost = mapPricing(entry.pricing);
  if (cost) {
    out.cost = cost;
  }

  // Both sides must be known: a half-known modality pair is not emitted.
  const inputMods = filterModalities(entry.architecture?.input_modalities);
  const outputMods = filterModalities(entry.architecture?.output_modalities);
  if (inputMods.length > 0 && outputMods.length > 0) {
    out.input = inputMods;
    out.output = outputMods;
  }

  const params = entry.supported_parameters ?? [];
  const paramSet = new Set(params.map((p) => p.toLowerCase()));
  // We can only *assert a capability false* when the source actually told us
  // about it. An absent `supported_parameters` means "we don't know" — never a
  // misleading `false`.
  const knowsParams = Array.isArray(entry.supported_parameters);

  setCapability(out, "tools", paramSet.has("tools") || paramSet.has("tool_choice"), {
    known: knowsParams,
    overwrite
  });
  setCapability(out, "temperature", paramSet.has("temperature"), {
    known: knowsParams,
    overwrite
  });

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
  field: "tools" | "temperature",
  present: boolean,
  opts: { known: boolean; overwrite?: ReadonlySet<string> }
): void {
  if (present) {
    out[field] = true;
  } else if (opts.known && opts.overwrite?.has(field)) {
    out[field] = false;
  }
}

function mapPricing(pricing: OpenRouterModel["pricing"]): ModelCost | undefined {
  if (!pricing) {
    return undefined;
  }

  const input = perMillion(pricing.prompt);
  const output = perMillion(pricing.completion);
  if (input === undefined || output === undefined) {
    return undefined;
  }

  // `Model.Info.cost[].cache.{read,write}` are required numbers, so an endpoint
  // that omits cache pricing maps to 0 (v1 left the keys off entirely).
  return {
    input,
    output,
    cache: {
      read: perMillion(pricing.input_cache_read) ?? 0,
      write: perMillion(pricing.input_cache_write) ?? 0
    }
  };
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
 * side. Undefined modalities means the source never told us, so we can't
 * claim text-only (consistent with the true-only / "known" pattern above).
 */
export function isTextOnlyModality(derived: Pick<ModelMetadata, "input" | "output">): boolean {
  if (!derived.input || !derived.output) {
    return false;
  }
  const isTextOnlyList = (mods: OpenCodeModality[]): boolean =>
    mods.length === 1 && mods[0] === "text";
  return isTextOnlyList(derived.input) && isTextOnlyList(derived.output);
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
 * The structural slice of `Model.Info` that {@link applyMetadata} reads and
 * writes. Declared here (rather than importing `Model.Info`) so the pure
 * mapping/merge layer stays free of the plugin API and trivially testable; a
 * real `DeepMutable<Model.Info>` is assignable to it.
 */
export interface EnrichableModel {
  name: string;
  limit: { context: number; output: number; input?: number };
  cost: Array<{ input: number; output: number; cache: { read: number; write: number } }>;
  capabilities: { tools: boolean; input: string[]; output: string[]; temperature?: boolean };
}

/**
 * Is `field` on `model` still the "unknown" placeholder (or genuinely unset)?
 *
 * v2's `Model.Info` requires every field, so a plugin that only knows a model's
 * id and name (`@vymalo/opencode-provider-sync`'s discovery) has to fill the
 * rest with sentinels meaning *unknown*. Upstream-wins must treat those as
 * ABSENT, or models-info silently stops enriching exactly the models oauth2
 * discovered. The sentinels, and what a non-sentinel value means:
 *
 * | field            | absent (unknown)            | present                |
 * | ---------------- | --------------------------- | ---------------------- |
 * | `name`           | `""`                        | any non-empty string   |
 * | `limit`          | `{ context: 0, output: 0 }` | anything else          |
 * | `cost`           | `[]`                        | at least one tier      |
 * | `tools`          | `false`                     | `true`                 |
 * | `input`/`output` | `[]`                        | at least one modality  |
 * | `temperature`    | `undefined`                 | `true` or `false`      |
 *
 * `tools: false` is read as unknown because the mapper only ever emits `true`
 * (a `false` appears only under an explicit `modelsInfoOverwrite`). The cost of
 * that choice: a hand-set `tools: false` is not protected by upstream-wins, and
 * is flipped to `true` if the endpoint advertises tool support.
 */
export function isAbsent(model: EnrichableModel, field: keyof ModelMetadata): boolean {
  switch (field) {
    case "name":
      return typeof model.name !== "string" || model.name === "";
    case "limit":
      return !model.limit || (model.limit.context === 0 && model.limit.output === 0);
    case "cost":
      return !Array.isArray(model.cost) || model.cost.length === 0;
    case "tools":
      return model.capabilities?.tools !== true;
    case "input":
      return !model.capabilities?.input || model.capabilities.input.length === 0;
    case "output":
      return !model.capabilities?.output || model.capabilities.output.length === 0;
    case "temperature":
      return model.capabilities?.temperature === undefined;
  }
}

function write(model: EnrichableModel, field: keyof ModelMetadata, derived: ModelMetadata): void {
  switch (field) {
    case "name":
      model.name = derived.name as string;
      return;
    case "limit": {
      // Preserve an optional `limit.input` another plugin may have set.
      const limit = derived.limit as { context: number; output: number };
      model.limit = { ...model.limit, context: limit.context, output: limit.output };
      return;
    }
    case "cost":
      model.cost = [derived.cost as ModelCost];
      return;
    case "tools":
      model.capabilities.tools = derived.tools as boolean;
      return;
    case "temperature":
      model.capabilities.temperature = derived.temperature as boolean;
      return;
    case "input":
      model.capabilities.input = [...(derived.input as string[])];
      return;
    case "output":
      model.capabilities.output = [...(derived.output as string[])];
      return;
  }
}

export interface ApplyResult {
  applied: (keyof ModelMetadata)[];
  skipped: (keyof ModelMetadata)[];
}

/**
 * Merge a derived metadata snapshot onto a `Model.Info`-shaped object, in
 * place. Upstream wins by default: a field already holding a real value is left
 * untouched — where "real" excludes the {@link isAbsent} placeholders.
 *
 * `overwrite` opts specific fields *out* of upstream-wins, letting the derived
 * (endpoint) value replace one that's already set. It exists because another
 * plugin (e.g. `@vymalo/opencode-oauth2`) may auto-stamp a field such as `name`
 * — to upstream-wins that looks like deliberate user config. A field named in
 * `overwrite` only wins when the derived value is actually present.
 */
export function applyMetadata(
  model: EnrichableModel,
  derived: ModelMetadata,
  overwrite?: ReadonlySet<string>
): ApplyResult {
  const result: ApplyResult = { applied: [], skipped: [] };
  for (const field of METADATA_FIELDS) {
    if (derived[field] === undefined) {
      continue;
    }
    if (isAbsent(model, field) || overwrite?.has(field)) {
      write(model, field, derived);
      result.applied.push(field);
    } else {
      result.skipped.push(field);
    }
  }
  return result;
}
