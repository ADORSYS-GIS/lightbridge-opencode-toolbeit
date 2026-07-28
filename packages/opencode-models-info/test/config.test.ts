import { describe, expect, it } from "vitest";

import { DEFAULT_TIMEOUT_MS, DEFAULT_TTL_SECONDS, parseMetaOptions } from "../src/config.js";

describe("parseMetaOptions", () => {
  it("returns null when no provider options exist", () => {
    expect(parseMetaOptions(undefined)).toBeNull();
  });

  it("returns null when meta is absent or not an object", () => {
    expect(parseMetaOptions({})).toBeNull();
    expect(parseMetaOptions({ meta: "no" })).toBeNull();
    expect(parseMetaOptions({ meta: [] })).toBeNull();
  });

  it("returns null when modelsInfoUrl is missing or empty", () => {
    expect(parseMetaOptions({ meta: {} })).toBeNull();
    expect(parseMetaOptions({ meta: { modelsInfoUrl: "" } })).toBeNull();
    expect(parseMetaOptions({ meta: { modelsInfoUrl: "   " } })).toBeNull();
    expect(parseMetaOptions({ meta: { modelsInfoUrl: 42 } })).toBeNull();
  });

  it("applies defaults for optional fields", () => {
    const out = parseMetaOptions({ meta: { modelsInfoUrl: "https://x.test/m" } });
    expect(out).toEqual({
      modelsInfoUrl: "https://x.test/m",
      modelsInfoTtlSeconds: DEFAULT_TTL_SECONDS,
      modelsInfoTimeoutMs: DEFAULT_TIMEOUT_MS,
      modelsInfoHeaders: undefined,
      modelsInfoHideTextOnly: false,
      modelsInfoFormat: "openrouter"
    });
  });

  it("parses modelsInfoHideTextOnly, defaulting to false for anything but a literal true", () => {
    expect(
      parseMetaOptions({
        meta: { modelsInfoUrl: "https://x.test/m", modelsInfoHideTextOnly: true }
      })?.modelsInfoHideTextOnly
    ).toBe(true);
    expect(
      parseMetaOptions({
        meta: { modelsInfoUrl: "https://x.test/m", modelsInfoHideTextOnly: "true" }
      })?.modelsInfoHideTextOnly
    ).toBe(false);
    expect(
      parseMetaOptions({ meta: { modelsInfoUrl: "https://x.test/m" } })?.modelsInfoHideTextOnly
    ).toBe(false);
  });

  it("coerces positive integers and ignores invalid numeric inputs", () => {
    const out = parseMetaOptions({
      meta: {
        modelsInfoUrl: "https://x.test/m",
        modelsInfoTtlSeconds: 60.7,
        modelsInfoTimeoutMs: -1
      }
    });
    expect(out?.modelsInfoTtlSeconds).toBe(60);
    expect(out?.modelsInfoTimeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("filters non-string header values out of modelsInfoHeaders", () => {
    const out = parseMetaOptions({
      meta: {
        modelsInfoUrl: "https://x.test/m",
        modelsInfoHeaders: { "x-tenant": "t1", bogus: 123, empty: "" }
      }
    });
    expect(out?.modelsInfoHeaders).toEqual({ "x-tenant": "t1" });
  });

  it("returns undefined headers when the map is empty after filtering", () => {
    const out = parseMetaOptions({
      meta: {
        modelsInfoUrl: "https://x.test/m",
        modelsInfoHeaders: { bogus: 123 }
      }
    });
    expect(out?.modelsInfoHeaders).toBeUndefined();
  });

  it("parses modelsInfoOverwrite, keeping only known fields and dropping dupes", () => {
    const out = parseMetaOptions({
      meta: {
        modelsInfoUrl: "https://x.test/m",
        modelsInfoOverwrite: ["name", "modalities", "name", "bogus", 7]
      }
    });
    expect(out?.modelsInfoOverwrite).toEqual(["name", "modalities"]);
  });

  it("leaves modelsInfoOverwrite undefined when absent, non-array, or empty after filtering", () => {
    expect(
      parseMetaOptions({ meta: { modelsInfoUrl: "https://x.test/m" } })?.modelsInfoOverwrite
    ).toBeUndefined();
    expect(
      parseMetaOptions({
        meta: { modelsInfoUrl: "https://x.test/m", modelsInfoOverwrite: "name" }
      })?.modelsInfoOverwrite
    ).toBeUndefined();
    expect(
      parseMetaOptions({
        meta: { modelsInfoUrl: "https://x.test/m", modelsInfoOverwrite: ["bogus"] }
      })?.modelsInfoOverwrite
    ).toBeUndefined();
  });

  it("resolves a path-relative modelsInfoUrl under the baseURL's path", () => {
    // No leading slash + baseURL with or without trailing slash → joins under
    // baseURL's path. baseURL is always treated as a directory.
    expect(
      parseMetaOptions({
        baseURL: "https://x.test/v1",
        meta: { modelsInfoUrl: "models/info" }
      })?.modelsInfoUrl
    ).toBe("https://x.test/v1/models/info");

    expect(
      parseMetaOptions({
        baseURL: "https://x.test/v1/",
        meta: { modelsInfoUrl: "models/info" }
      })?.modelsInfoUrl
    ).toBe("https://x.test/v1/models/info");
  });

  it("resolves a leading-slash modelsInfoUrl from the origin of baseURL", () => {
    // Standard WHATWG semantics: `/path` is origin-rooted. This is the
    // escape hatch for users whose metadata endpoint sits at a different
    // path than the inference API.
    expect(
      parseMetaOptions({
        baseURL: "https://x.test/v1",
        meta: { modelsInfoUrl: "/models" }
      })?.modelsInfoUrl
    ).toBe("https://x.test/models");
  });

  it("avoids path duplication when the modelsInfoUrl includes the same prefix as baseURL", () => {
    // Regression: previously stripping the leading slash before resolving
    // produced `https://x.test/v1/v1/models`. Standard semantics give the
    // intuitive result.
    expect(
      parseMetaOptions({
        baseURL: "https://x.test/v1",
        meta: { modelsInfoUrl: "/v1/models/info" }
      })?.modelsInfoUrl
    ).toBe("https://x.test/v1/models/info");
  });

  it("leaves absolute URLs untouched even when baseURL is present", () => {
    expect(
      parseMetaOptions({
        baseURL: "https://x.test/v1",
        meta: { modelsInfoUrl: "https://other.test/models" }
      })?.modelsInfoUrl
    ).toBe("https://other.test/models");
  });

  it("keeps the relative path verbatim when baseURL is absent", () => {
    expect(
      parseMetaOptions({
        meta: { modelsInfoUrl: "/models" }
      })?.modelsInfoUrl
    ).toBe("/models");
  });
});
