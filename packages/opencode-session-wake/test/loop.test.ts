import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOOP_POLICY,
  decideWake,
  initialLoopState,
  isIgnoredAuthor,
  normalizeAuthors,
  OriginatedSet
} from "../src/loop.js";
import { event } from "./helpers.js";

const policy = { maxWakes: 2, windowMs: 60_000, cooldownMs: 300_000 };

describe("decideWake", () => {
  it("delivers while under budget and records the wake", () => {
    const first = decideWake(initialLoopState(), policy, 1_000);
    expect(first.deliver).toBe(true);
    expect(first.next.wakes).toEqual([1_000]);
    expect(first.next.loopSuspected).toBe(false);

    const second = decideWake(first.next, policy, 2_000);
    expect(second.deliver).toBe(true);
    expect(second.next.wakes).toEqual([1_000, 2_000]);
  });

  it("coalesces once the budget is exhausted and starts a cooldown", () => {
    const state = { wakes: [1_000, 2_000], suppressed: 0, loopSuspected: false };
    const decision = decideWake(state, policy, 3_000);

    expect(decision.deliver).toBe(false);
    expect(decision.reason).toBe("rate");
    expect(decision.next.loopSuspected).toBe(true);
    expect(decision.next.suppressed).toBe(1);
    expect(decision.next.cooldownUntil).toBe(3_000 + policy.cooldownMs);
  });

  it("keeps coalescing inside the cooldown", () => {
    const state = {
      wakes: [1_000, 2_000],
      suppressed: 1,
      loopSuspected: true,
      cooldownUntil: 10_000
    };
    const decision = decideWake(state, policy, 5_000);

    expect(decision.deliver).toBe(false);
    expect(decision.reason).toBe("cooldown");
    expect(decision.next.suppressed).toBe(2);
  });

  it("resets after the cooldown so a short cooldown cannot immediately re-trip", () => {
    const state = {
      wakes: [1_000, 2_000],
      suppressed: 2,
      loopSuspected: true,
      cooldownUntil: 10_000
    };
    const decision = decideWake(state, policy, 10_001);

    expect(decision.deliver).toBe(true);
    expect(decision.next.loopSuspected).toBe(false);
    expect(decision.next.suppressed).toBe(0);
    expect(decision.next.wakes).toEqual([10_001]);
  });

  it("forgets wakes that fell out of the window", () => {
    const state = { wakes: [1_000], suppressed: 0, loopSuspected: false };
    const decision = decideWake(state, policy, 1_000 + policy.windowMs + 1);
    expect(decision.deliver).toBe(true);
    expect(decision.next.wakes).toEqual([1_000 + policy.windowMs + 1]);
  });

  it("ships safe defaults", () => {
    expect(DEFAULT_LOOP_POLICY.maxWakes).toBeGreaterThan(0);
    expect(DEFAULT_LOOP_POLICY.windowMs).toBeGreaterThanOrEqual(60_000);
    expect(DEFAULT_LOOP_POLICY.cooldownMs).toBeGreaterThanOrEqual(DEFAULT_LOOP_POLICY.windowMs);
  });
});

describe("author filters", () => {
  it("normalizes handles", () => {
    expect(normalizeAuthors(["@Alice", "alice", " github-actions[bot] ", ""])).toEqual([
      "alice",
      "github-actions[bot]"
    ]);
    expect(normalizeAuthors(undefined)).toEqual([]);
  });

  it("matches authors case-insensitively and ignores bots the same way", () => {
    expect(
      isIgnoredAuthor(event("1", { author: "GitHub-Actions[bot]" }), ["github-actions[bot]"])
    ).toBe(true);
    expect(isIgnoredAuthor(event("1", { author: "alice" }), ["bob"])).toBe(false);
    expect(isIgnoredAuthor(event("1", { author: "alice" }), [])).toBe(false);
  });
});

describe("OriginatedSet", () => {
  it("remembers ids until their TTL expires", () => {
    let at = 1_000;
    const set = new OriginatedSet(() => at, 5_000);
    set.mark("101");

    expect(set.has("101")).toBe(true);
    at = 6_000;
    expect(set.has("101")).toBe(false);
    expect(set.size).toBe(0);
  });

  it("prunes expired ids", () => {
    let at = 1_000;
    const set = new OriginatedSet(() => at, 5_000);
    set.mark("101");
    set.mark("102");
    at = 6_000;
    set.prune();
    expect(set.size).toBe(0);
  });
});
