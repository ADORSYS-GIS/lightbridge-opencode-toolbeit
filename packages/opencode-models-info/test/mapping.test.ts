import { describe, expect, it } from "vitest";

import { isTextOnlyModality, mapOpenRouterEntry, mergeIntoModel } from "../src/mapping.js";
import type { OpenRouterModel } from "../src/types.js";

describe("mapOpenRouterEntry", () => {
  it("converts pricing strings to per-1M USD numbers", () => {
    const entry: OpenRouterModel = {
      id: "x",
      pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" }
    };
    const out = mapOpenRouterEntry(entry);
    expect(out.cost).toEqual({ input: 3, output: 15, cache_read: 0.3 });
  });

  it("requires both prompt and completion pricing to emit a cost block", () => {
    const out = mapOpenRouterEntry({ id: "x", pricing: { prompt: "0.001" } });
    expect(out.cost).toBeUndefined();
  });

  it("sets limit only when both context and output are known", () => {
    const both = mapOpenRouterEntry({
      id: "x",
      context_length: 128000,
      top_provider: { max_completion_tokens: 4096 }
    });
    expect(both.limit).toEqual({ context: 128000, output: 4096 });

    const contextOnly = mapOpenRouterEntry({ id: "x", context_length: 128000 });
    expect(contextOnly.limit).toBeUndefined();
  });

  it("derives capability flags from supported_parameters", () => {
    const out = mapOpenRouterEntry({
      id: "x",
      supported_parameters: ["tools", "temperature", "reasoning"]
    });
    expect(out.tool_call).toBe(true);
    expect(out.temperature).toBe(true);
    expect(out.reasoning).toBe(true);
  });

  it("filters modalities to OpenCode's enum and marks attachment when non-text", () => {
    const out = mapOpenRouterEntry({
      id: "x",
      architecture: {
        input_modalities: ["text", "image", "file"],
        output_modalities: ["text"]
      }
    });
    expect(out.modalities).toEqual({ input: ["text", "image"], output: ["text"] });
    expect(out.attachment).toBe(true);
  });

  it("does not set attachment for text-only models", () => {
    const out = mapOpenRouterEntry({
      id: "x",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] }
    });
    expect(out.attachment).toBeUndefined();
  });

  it("leaves a capability undefined (true-only) when not opted into overwrite", () => {
    // supported_parameters present but lacks tools → we know it's false, but
    // without overwrite we stay true-only so upstream-wins leaves it alone.
    const out = mapOpenRouterEntry({ id: "x", supported_parameters: ["temperature"] });
    expect(out.tool_call).toBeUndefined();
  });

  it("emits an explicit false capability when overwritten and the source reported it", () => {
    const out = mapOpenRouterEntry(
      {
        id: "x",
        supported_parameters: ["temperature"],
        architecture: { input_modalities: ["text"], output_modalities: ["text"] }
      },
      new Set(["tool_call", "attachment"])
    );
    expect(out.tool_call).toBe(false);
    expect(out.attachment).toBe(false);
  });

  it("stays undefined under overwrite when the source never reported the capability", () => {
    // No supported_parameters / input_modalities at all → we genuinely don't
    // know, so overwrite must not fabricate a false.
    const out = mapOpenRouterEntry({ id: "x" }, new Set(["tool_call", "attachment"]));
    expect(out.tool_call).toBeUndefined();
    expect(out.attachment).toBeUndefined();
  });
});

describe("isTextOnlyModality", () => {
  it("is false when modalities is undefined (source never reported it)", () => {
    expect(isTextOnlyModality(undefined)).toBe(false);
  });

  it("is true when input and output are both exactly text", () => {
    expect(isTextOnlyModality({ input: ["text"], output: ["text"] })).toBe(true);
  });

  it("is false when either side carries a non-text modality", () => {
    expect(isTextOnlyModality({ input: ["text", "image"], output: ["text"] })).toBe(false);
    expect(isTextOnlyModality({ input: ["text"], output: ["audio"] })).toBe(false);
  });
});

describe("mergeIntoModel", () => {
  it("only writes fields that are undefined upstream", () => {
    const existing: Record<string, unknown> = { name: "Pre-named", tool_call: true };
    mergeIntoModel(existing, {
      name: "From OpenRouter",
      tool_call: false,
      reasoning: true,
      cost: { input: 1, output: 2 }
    });
    expect(existing.name).toBe("Pre-named");
    expect(existing.tool_call).toBe(true);
    expect(existing.reasoning).toBe(true);
    expect(existing.cost).toEqual({ input: 1, output: 2 });
  });

  it("is idempotent", () => {
    const existing: Record<string, unknown> = {};
    mergeIntoModel(existing, { reasoning: true });
    mergeIntoModel(existing, { reasoning: false });
    expect(existing.reasoning).toBe(true);
  });

  it("overwrites only the fields named in the overwrite set", () => {
    const existing: Record<string, unknown> = { name: "Kimi K2.6", tool_call: true };
    mergeIntoModel(existing, { name: "kimi-k2.6", tool_call: false }, new Set(["name"]));
    expect(existing.name).toBe("kimi-k2.6");
    expect(existing.tool_call).toBe(true);
  });

  it("does not write an overwrite field when the derived value is absent", () => {
    const existing: Record<string, unknown> = { name: "Kimi K2.6" };
    mergeIntoModel(existing, { tool_call: true }, new Set(["name"]));
    expect(existing.name).toBe("Kimi K2.6");
  });
});
