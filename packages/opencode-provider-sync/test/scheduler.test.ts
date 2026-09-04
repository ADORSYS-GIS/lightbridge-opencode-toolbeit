import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "@vymalo/opencode-auth-core/lib";
import { startScheduler } from "../src/scheduler.js";

function silentLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startScheduler", () => {
  it("does not run immediately — the first tick fires after one interval", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    startScheduler({ intervalMs: 1000, logger: silentLogger(), taskName: "t", run });

    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps running on the same cadence after a successful tick", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    startScheduler({ intervalMs: 1000, logger: silentLogger(), taskName: "t", run });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("stop() prevents any further ticks", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const handle = startScheduler({ intervalMs: 1000, logger: silentLogger(), taskName: "t", run });

    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);

    handle.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("backs off after a failure instead of retrying at the full interval", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const logger = silentLogger();
    startScheduler({ intervalMs: 60_000, logger, taskName: "t", run });

    // First tick fails; retry should come back well before the full 60s interval.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "sync_schedule_retry",
      expect.objectContaining({ taskName: "t", failures: 1 })
    );

    await vi.advanceTimersByTimeAsync(15_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("resumes the normal cadence once a retry succeeds", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    startScheduler({ intervalMs: 60_000, logger: silentLogger(), taskName: "t", run });

    await vi.advanceTimersByTimeAsync(60_000); // fails
    await vi.advanceTimersByTimeAsync(15_000); // retry succeeds
    expect(run).toHaveBeenCalledTimes(2);

    // Back to the full interval, not another short backoff.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(run).toHaveBeenCalledTimes(3);
  });
});
