import { describe, expect, it } from "vitest";

import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TTL_SECONDS,
  OVERWRITABLE_FIELDS,
  parseModelsInfoSettings
} from "../src/config.js";

const URL_ = "https://x.test/m";
const parse = (extra: Record<string, unknown> = {}) =>
  parseModelsInfoSettings({ modelsInfoUrl: URL_, ...extra });

describe("parseModelsInfoSettings", () => {
  it("returns null when the provider has no settings", () => {
    expect(parseModelsInfoSettings(undefined)).toBeNull();
    expect(parseModelsInfoSettings({})).toBeNull();
  });

  it("does not read the v1 options.meta shape", () => {
    expect(parseModelsInfoSettings({ meta: { modelsInfoUrl: URL_ } })).toBeNull();
  });

  it("returns null when modelsInfoUrl is missing, blank or not a string", () => {
    expect(parseModelsInfoSettings({ baseURL: "https://x.test" })).toBeNull();
    expect(parseModelsInfoSettings({ modelsInfoUrl: "" })).toBeNull();
    expect(parseModelsInfoSettings({ modelsInfoUrl: "   " })).toBeNull();
    expect(parseModelsInfoSettings({ modelsInfoUrl: 42 })).toBeNull();
  });

  it("applies defaults for optional fields", () => {
    expect(parse()).toEqual({
      modelsInfoUrl: URL_,
      modelsInfoTtlSeconds: DEFAULT_TTL_SECONDS,
      modelsInfoTimeoutMs: DEFAULT_TIMEOUT_MS,
      modelsInfoHeaders: undefined,
      modelsInfoOverwrite: undefined,
      modelsInfoHideTextOnly: false,
      modelsInfoHideInternal: false,
      modelsInfoHideUnmatched: false,
      modelsInfoFormat: "openrouter"
    });
  });

  it.each([
    ["modelsInfoHideTextOnly"],
    ["modelsInfoHideInternal"],
    ["modelsInfoHideUnmatched"]
  ] as const)("%s is true only for a literal true, and independent of the others", (flag) => {
    const out = parse({ [flag]: true });
    expect(out?.[flag]).toBe(true);
    const others = (
      ["modelsInfoHideTextOnly", "modelsInfoHideInternal", "modelsInfoHideUnmatched"] as const
    ).filter((f) => f !== flag);
    for (const other of others) {
      expect(out?.[other]).toBe(false);
    }
    expect(parse({ [flag]: "true" })?.[flag]).toBe(false);
    expect(parse()?.[flag]).toBe(false);
  });

  it("coerces positive integers and ignores invalid numeric inputs", () => {
    const out = parse({ modelsInfoTtlSeconds: 60.7, modelsInfoTimeoutMs: -1 });
    expect(out?.modelsInfoTtlSeconds).toBe(60);
    expect(out?.modelsInfoTimeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("filters non-string header values out of modelsInfoHeaders", () => {
    const out = parse({ modelsInfoHeaders: { "x-tenant": "t1", bogus: 123, empty: "" } });
    expect(out?.modelsInfoHeaders).toEqual({ "x-tenant": "t1" });
  });

  it("returns undefined headers when the map is empty after filtering, or is an array", () => {
    expect(parse({ modelsInfoHeaders: { bogus: 123 } })?.modelsInfoHeaders).toBeUndefined();
    expect(parse({ modelsInfoHeaders: ["a"] })?.modelsInfoHeaders).toBeUndefined();
  });

  it("parses modelsInfoOverwrite, keeping only known v2 field names and dropping dupes", () => {
    const out = parse({ modelsInfoOverwrite: ["name", "input", "name", "bogus", 7] });
    expect(out?.modelsInfoOverwrite).toEqual(["name", "input"]);
  });

  it("drops the v1-only overwrite names that have no Model.Info field", () => {
    const out = parse({
      modelsInfoOverwrite: ["reasoning", "attachment", "tool_call", "modalities"]
    });
    expect(out?.modelsInfoOverwrite).toBeUndefined();
    expect([...OVERWRITABLE_FIELDS].sort()).toEqual(
      ["cost", "input", "limit", "name", "output", "temperature", "tools"].sort()
    );
  });

  it("leaves modelsInfoOverwrite undefined when absent, non-array, or empty after filtering", () => {
    expect(parse()?.modelsInfoOverwrite).toBeUndefined();
    expect(parse({ modelsInfoOverwrite: "name" })?.modelsInfoOverwrite).toBeUndefined();
    expect(parse({ modelsInfoOverwrite: ["bogus"] })?.modelsInfoOverwrite).toBeUndefined();
  });
});

describe("modelsInfoUrl resolution against settings.baseURL", () => {
  const resolve = (baseURL: string | undefined, modelsInfoUrl: string) =>
    parseModelsInfoSettings({ baseURL, modelsInfoUrl })?.modelsInfoUrl;

  it("resolves a path-relative url under the baseURL's path, with or without a trailing slash", () => {
    expect(resolve("https://x.test/v1", "models/info")).toBe("https://x.test/v1/models/info");
    expect(resolve("https://x.test/v1/", "models/info")).toBe("https://x.test/v1/models/info");
  });

  it("resolves a leading-slash url from the origin of baseURL", () => {
    expect(resolve("https://x.test/v1", "/models")).toBe("https://x.test/models");
  });

  it("avoids path duplication when the url repeats the baseURL prefix", () => {
    expect(resolve("https://x.test/v1", "/v1/models/info")).toBe("https://x.test/v1/models/info");
  });

  it("leaves absolute URLs untouched even when baseURL is present", () => {
    expect(resolve("https://x.test/v1", "https://other.test/models")).toBe(
      "https://other.test/models"
    );
  });

  it("keeps the relative path verbatim when baseURL is absent or unparsable", () => {
    expect(resolve(undefined, "/models")).toBe("/models");
    expect(resolve("not a url", "models")).toBe("models");
  });
});
