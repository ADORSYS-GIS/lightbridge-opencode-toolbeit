import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createJsonConsoleLogger, LOG_LEVEL_PRIORITY, type Logger } from "../src/logging.js";

describe("createJsonConsoleLogger trace tier", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("exposes a working trace method that emits a JSON line", () => {
    const logger: Logger = createJsonConsoleLogger("trace");
    logger.trace("oauth2_trace_event", { providerId: "example" });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(payload).toMatchObject({
      level: "trace",
      event: "oauth2_trace_event",
      providerId: "example"
    });
  });

  it("emits trace records when minLevel is 'trace'", () => {
    const logger = createJsonConsoleLogger("trace");
    logger.trace("oauth2_trace_visible", {});
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("suppresses trace records when minLevel is 'debug' but still emits debug", () => {
    const logger = createJsonConsoleLogger("debug");
    logger.trace("oauth2_trace_hidden", {});
    expect(logSpy).not.toHaveBeenCalled();

    logger.debug("oauth2_debug_visible", {});
    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(payload.level).toBe("debug");
  });

  it("orders trace as the most-verbose (lowest-priority) level", () => {
    expect(LOG_LEVEL_PRIORITY.trace).toBeLessThan(LOG_LEVEL_PRIORITY.debug);
    expect(LOG_LEVEL_PRIORITY.trace).toBeLessThan(LOG_LEVEL_PRIORITY.error);
  });

  it("redacts secret-like fields on trace records", () => {
    const logger = createJsonConsoleLogger("trace");
    logger.trace("oauth2_trace_secret", { accessToken: "super-secret", providerId: "example" });

    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(payload.accessToken).toBe("[redacted]");
    expect(payload.providerId).toBe("example");
  });
});
