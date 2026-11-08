import { describe, expect, it } from "vitest";

import {
  applyMetadata,
  type EnrichableModel,
  isAbsent,
  isTextOnlyModality,
  mapOpenRouterEntry
} from "../src/mapping.js";
import type { OpenRouterModel } from "../src/types.js";

/** Every `Model.Info` field models-info touches, set to the provider-sync sentinels. */
function sentinel(over: Partial<EnrichableModel> = {}): EnrichableModel {
  return {
    name: "",
    limit: { context: 0, output: 0 },
    cost: [],
    capabilities: { tools: false, input: [], output: [] },
    ...over
  };
}

describe("mapOpenRouterEntry", () => {
  it("converts pricing strings to per-1M USD numbers inside a Model.Info cost tier", () => {
    const out = mapOpenRouterEntry({
      id: "x",
      pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" }
    });
    expect(out.cost).toEqual({ input: 3, output: 15, cache: { read: 0.3, write: 0 } });
  });

  it("rounds converted prices to 6 decimal places", () => {
    const out = mapOpenRouterEntry({
      id: "x",
      pricing: { prompt: "0.0000001234567", completion: "0.1", input_cache_write: "0.00000375" }
    });
    expect(out.cost).toEqual({
      input: 0.123457,
      output: 100_000,
      cache: { read: 0, write: 3.75 }
    });
  });

  it("requires both prompt and completion pricing to emit a cost tier", () => {
    expect(mapOpenRouterEntry({ id: "x", pricing: { prompt: "0.001" } }).cost).toBeUndefined();
    expect(
      mapOpenRouterEntry({ id: "x", pricing: { prompt: "nope", completion: "1" } }).cost
    ).toBeUndefined();
    expect(mapOpenRouterEntry({ id: "x" }).cost).toBeUndefined();
  });

  it("sets limit only when both context and output are known", () => {
    const both = mapOpenRouterEntry({
      id: "x",
      context_length: 128000,
      top_provider: { max_completion_tokens: 4096 }
    });
    expect(both.limit).toEqual({ context: 128000, output: 4096 });

    expect(mapOpenRouterEntry({ id: "x", context_length: 128000 }).limit).toBeUndefined();
    expect(
      mapOpenRouterEntry({ id: "x", top_provider: { max_completion_tokens: 1 } }).limit
    ).toBeUndefined();
  });

  it("prefers top_provider.context_length over the top-level one", () => {
    const out = mapOpenRouterEntry({
      id: "x",
      context_length: 1000,
      top_provider: { context_length: 2000, max_completion_tokens: 10 }
    });
    expect(out.limit).toEqual({ context: 2000, output: 10 });
  });

  it("derives tools / temperature from supported_parameters", () => {
    const out = mapOpenRouterEntry({
      id: "x",
      supported_parameters: ["tool_choice", "TEMPERATURE", "reasoning"]
    });
    expect(out.tools).toBe(true);
    expect(out.temperature).toBe(true);
    // v1's reasoning/attachment have no Model.Info field.
    expect(out).not.toHaveProperty("reasoning");
    expect(out).not.toHaveProperty("attachment");
  });

  it("splits modalities into input / output, filtered to the OpenCode enum", () => {
    const out = mapOpenRouterEntry({
      id: "x",
      architecture: {
        input_modalities: ["text", "image", "file", "image"],
        output_modalities: ["text"]
      }
    });
    expect(out.input).toEqual(["text", "image"]);
    expect(out.output).toEqual(["text"]);
    expect(out).not.toHaveProperty("modalities");
  });

  it("emits modalities only when both sides are known", () => {
    const out = mapOpenRouterEntry({
      id: "x",
      architecture: { input_modalities: ["text", "image"] }
    });
    expect(out.input).toBeUndefined();
    expect(out.output).toBeUndefined();
  });

  it("maps the display name", () => {
    expect(mapOpenRouterEntry({ id: "x", name: "Nice" }).name).toBe("Nice");
    expect(mapOpenRouterEntry({ id: "x" }).name).toBeUndefined();
  });

  it("leaves a capability undefined (true-only) when not opted into overwrite", () => {
    const out = mapOpenRouterEntry({ id: "x", supported_parameters: ["temperature"] });
    expect(out.tools).toBeUndefined();
  });

  it("emits an explicit false capability when overwritten and the source reported it", () => {
    const out = mapOpenRouterEntry(
      { id: "x", supported_parameters: ["max_tokens"] },
      new Set(["tools", "temperature"])
    );
    expect(out.tools).toBe(false);
    expect(out.temperature).toBe(false);
  });

  it("stays undefined under overwrite when the source never reported the capability", () => {
    const out = mapOpenRouterEntry({ id: "x" }, new Set(["tools", "temperature"]));
    expect(out.tools).toBeUndefined();
    expect(out.temperature).toBeUndefined();
  });
});

describe("isTextOnlyModality", () => {
  it("is false when either side is unknown", () => {
    expect(isTextOnlyModality({})).toBe(false);
    expect(isTextOnlyModality({ input: ["text"] })).toBe(false);
    expect(isTextOnlyModality({ output: ["text"] })).toBe(false);
  });

  it("is true when input and output are both exactly text", () => {
    expect(isTextOnlyModality({ input: ["text"], output: ["text"] })).toBe(true);
  });

  it("is false when either side carries a non-text modality", () => {
    expect(isTextOnlyModality({ input: ["text", "image"], output: ["text"] })).toBe(false);
    expect(isTextOnlyModality({ input: ["text"], output: ["audio"] })).toBe(false);
  });
});

describe("isAbsent — the provider-sync placeholder contract", () => {
  it("reads every sentinel as absent", () => {
    const m = sentinel();
    for (const field of [
      "name",
      "limit",
      "cost",
      "tools",
      "input",
      "output",
      "temperature"
    ] as const) {
      expect(isAbsent(m, field), field).toBe(true);
    }
  });

  it("reads real values as present", () => {
    const m = sentinel({
      name: "N",
      limit: { context: 1, output: 0 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      capabilities: { tools: true, input: ["text"], output: ["text"], temperature: false }
    });
    for (const field of [
      "name",
      "limit",
      "cost",
      "tools",
      "input",
      "output",
      "temperature"
    ] as const) {
      expect(isAbsent(m, field), field).toBe(false);
    }
  });

  it("treats a free (all-zero) cost tier as present — it is a real answer, not a sentinel", () => {
    const m = sentinel({ cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] });
    expect(isAbsent(m, "cost")).toBe(false);
  });

  it("treats malformed host data defensively as absent", () => {
    const broken = {} as unknown as EnrichableModel;
    for (const field of ["limit", "cost", "tools", "input", "output", "temperature"] as const) {
      expect(isAbsent(broken, field), field).toBe(true);
    }
    expect(isAbsent({ name: undefined } as unknown as EnrichableModel, "name")).toBe(true);
  });
});

describe("applyMetadata", () => {
  const full: OpenRouterModel = {
    id: "x",
    name: "From catalog",
    context_length: 100,
    top_provider: { max_completion_tokens: 10 },
    pricing: { prompt: "0.000001", completion: "0.000002" },
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    supported_parameters: ["tools", "temperature"]
  };

  it("fills every sentinel field", () => {
    const m = sentinel();
    const result = applyMetadata(m, mapOpenRouterEntry(full));
    expect(m).toEqual({
      name: "From catalog",
      limit: { context: 100, output: 10 },
      cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }],
      capabilities: { tools: true, temperature: true, input: ["text", "image"], output: ["text"] }
    });
    expect(result.skipped).toEqual([]);
    expect([...result.applied].sort()).toEqual(
      ["cost", "input", "limit", "name", "output", "temperature", "tools"].sort()
    );
  });

  it("leaves real values alone and reports them as skipped", () => {
    const m = sentinel({
      name: "Mine",
      limit: { context: 5, output: 5 },
      capabilities: { tools: true, input: ["text"], output: ["text"], temperature: false }
    });
    const result = applyMetadata(m, mapOpenRouterEntry(full));
    expect(m.name).toBe("Mine");
    expect(m.limit).toEqual({ context: 5, output: 5 });
    expect(m.capabilities).toEqual({
      tools: true,
      input: ["text"],
      output: ["text"],
      temperature: false
    });
    expect(m.cost).toHaveLength(1); // the one sentinel field that was still empty
    expect(result.applied).toEqual(["cost"]);
    expect(result.skipped).toContain("name");
  });

  it("overwrites only the fields named in the overwrite set", () => {
    const m = sentinel({
      name: "Kimi K2.6",
      capabilities: { tools: true, input: ["text"], output: ["text"] }
    });
    applyMetadata(
      m,
      { name: "kimi-k2.6", tools: false, input: ["text", "image"] },
      new Set(["name"])
    );
    expect(m.name).toBe("kimi-k2.6");
    expect(m.capabilities.tools).toBe(true);
    expect(m.capabilities.input).toEqual(["text"]);
  });

  it("does not write an overwrite field when the derived value is absent", () => {
    const m = sentinel({ name: "Kimi K2.6" });
    applyMetadata(m, { tools: true }, new Set(["name"]));
    expect(m.name).toBe("Kimi K2.6");
  });

  it("does not alias the derived modality arrays into the model", () => {
    const m = sentinel();
    const derived = mapOpenRouterEntry(full);
    applyMetadata(m, derived);
    m.capabilities.input.push("pdf");
    expect(derived.input).toEqual(["text", "image"]);
  });
});
