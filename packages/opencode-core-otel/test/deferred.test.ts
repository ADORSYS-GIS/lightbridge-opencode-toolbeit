import { describe, expect, it, vi } from "vitest";

import { deferredAttribute } from "../src/deferred.js";

describe("deferredAttribute", () => {
  it("resolves with the settled value", async () => {
    const attribute = deferredAttribute(50);
    attribute.settle("1.15.10");
    await expect(attribute.value).resolves.toBe("1.15.10");
  });

  it("keeps the first value when settled twice", async () => {
    const attribute = deferredAttribute(50);
    attribute.settle("first");
    attribute.settle("second");
    await expect(attribute.value).resolves.toBe("first");
  });

  it("ignores an empty or missing value so the attribute is simply absent", async () => {
    const attribute = deferredAttribute(50);
    attribute.settle("");
    attribute.settle(undefined);
    attribute.abandon();
    await expect(attribute.value).resolves.toBeUndefined();
  });

  it("gives up on its own, so a never-arriving event cannot stall an export", async () => {
    vi.useFakeTimers();
    try {
      const attribute = deferredAttribute(1_000);
      vi.advanceTimersByTime(1_000);
      await expect(attribute.value).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandoning after the timeout is a no-op", async () => {
    const attribute = deferredAttribute(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    attribute.abandon();
    attribute.settle("too late");
    await expect(attribute.value).resolves.toBeUndefined();
  });

  it("survives a scheduler with no unref, as in a browser-like runtime", async () => {
    const schedule = ((fn: () => void, ms: number) =>
      setTimeout(fn, ms) as unknown as number) as unknown as typeof setTimeout;
    const attribute = deferredAttribute(50, schedule);
    attribute.settle("ok");
    await expect(attribute.value).resolves.toBe("ok");
  });
});
