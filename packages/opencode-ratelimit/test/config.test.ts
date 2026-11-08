import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEADER_PREFIX,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_SCOPE,
  parseRateLimitOptions,
  selectTier
} from "../src/config.js";

function rl(rateLimit: Record<string, unknown>) {
  return parseRateLimitOptions({ rateLimit });
}

describe("parseRateLimitOptions", () => {
  it("returns null when options are absent", () => {
    expect(parseRateLimitOptions(undefined)).toBeNull();
  });

  it("returns null when the settings have no rateLimit block", () => {
    expect(parseRateLimitOptions({ baseURL: "https://x.test" })).toBeNull();
  });

  it("does not read the v1 options.meta.rateLimit location", () => {
    expect(parseRateLimitOptions({ meta: { rateLimit: {} } })).toBeNull();
  });

  it("returns null when rateLimit is explicitly disabled", () => {
    expect(rl({ enabled: false })).toBeNull();
  });

  it("applies defaults for an empty rateLimit block (flat → one catch-all wait tier)", () => {
    const opts = rl({});
    expect(opts).toEqual({
      enabled: true,
      scope: DEFAULT_SCOPE,
      headerPrefix: DEFAULT_HEADER_PREFIX,
      tiers: [
        {
          maxResetSeconds: null,
          action: "wait",
          maxWaitMs: DEFAULT_MAX_WAIT_MS,
          maxRetries: DEFAULT_MAX_RETRIES
        }
      ]
    });
  });

  it("defaults scope to model", () => {
    expect(rl({})?.scope).toBe("model");
    expect(DEFAULT_SCOPE).toBe("model");
  });

  it("honors an explicit provider scope", () => {
    expect(rl({ scope: "provider" })?.scope).toBe("provider");
  });

  it("ignores a bogus scope and uses the default", () => {
    expect(rl({ scope: "galaxy" })?.scope).toBe("model");
  });

  it("maps flat maxWaitMs/maxRetries into the single catch-all tier", () => {
    const opts = rl({ maxWaitMs: 5000, maxRetries: 2 });
    expect(opts?.tiers).toEqual([
      { maxResetSeconds: null, action: "wait", maxWaitMs: 5000, maxRetries: 2 }
    ]);
  });

  it("accepts maxWaitMs of 0 as unlimited", () => {
    expect(rl({ maxWaitMs: 0 })?.tiers[0].maxWaitMs).toBe(0);
  });

  it("lowercases the header prefix", () => {
    expect(rl({ headerPrefix: "X-RateLimit" })?.headerPrefix).toBe("x-ratelimit");
  });

  describe("tiers", () => {
    it("parses an explicit tiers array and sorts ascending with catch-all last", () => {
      const opts = rl({
        tiers: [
          { action: "error" }, // no maxResetSeconds → catch-all
          { maxResetSeconds: 120, maxWaitMs: 0, maxRetries: 3 }
        ]
      });
      expect(opts?.tiers).toEqual([
        { maxResetSeconds: 120, action: "wait", maxWaitMs: 0, maxRetries: 3 },
        { maxResetSeconds: null, action: "error", maxWaitMs: 0, maxRetries: DEFAULT_MAX_RETRIES }
      ]);
    });

    it("appends a catch-all wait tier when none is provided", () => {
      const opts = rl({ tiers: [{ maxResetSeconds: 60, action: "wait", maxWaitMs: 1000 }] });
      expect(opts?.tiers).toHaveLength(2);
      const last = opts?.tiers.at(-1);
      expect(last?.maxResetSeconds).toBeNull();
      expect(last?.action).toBe("wait");
    });

    it("treats a non-positive maxResetSeconds as the catch-all", () => {
      const opts = rl({ tiers: [{ maxResetSeconds: 0, action: "error" }] });
      expect(opts?.tiers).toEqual([
        { maxResetSeconds: null, action: "error", maxWaitMs: 0, maxRetries: DEFAULT_MAX_RETRIES }
      ]);
    });

    it("falls back to the flat form when tiers is an empty array", () => {
      const opts = rl({ tiers: [], maxWaitMs: 7000 });
      expect(opts?.tiers).toEqual([
        { maxResetSeconds: null, action: "wait", maxWaitMs: 7000, maxRetries: DEFAULT_MAX_RETRIES }
      ]);
    });

    it("sorts a mixed set deterministically (comparator returns 0 on ties)", () => {
      // Includes two catch-alls and out-of-order finite bounds; a non-reflexive
      // comparator would risk engine-dependent ordering here.
      const opts = rl({
        tiers: [
          { action: "error" },
          { maxResetSeconds: 300, action: "wait" },
          { action: "wait", maxWaitMs: 5 },
          { maxResetSeconds: 60, action: "wait" }
        ]
      });
      const bounds = opts?.tiers.map((t) => t.maxResetSeconds);
      expect(bounds).toEqual([60, 300, null, null]); // finite ascending, catch-alls last
    });
  });
});

describe("selectTier", () => {
  const tiers = parseRateLimitOptions({
    rateLimit: {
      tiers: [
        { maxResetSeconds: 120, action: "wait", maxWaitMs: 0, maxRetries: 3 },
        { maxResetSeconds: null, action: "error" }
      ]
    }
  })?.tiers;

  it("picks the wait tier for a short reset", () => {
    expect(selectTier(tiers ?? [], 60).action).toBe("wait");
    expect(selectTier(tiers ?? [], 120).action).toBe("wait"); // inclusive bound
  });

  it("picks the error tier for a long reset", () => {
    expect(selectTier(tiers ?? [], 121).action).toBe("error");
    expect(selectTier(tiers ?? [], 2_592_000).action).toBe("error");
  });

  it("treats an unknown reset as the smallest band", () => {
    expect(selectTier(tiers ?? [], undefined).action).toBe("wait");
  });
});
