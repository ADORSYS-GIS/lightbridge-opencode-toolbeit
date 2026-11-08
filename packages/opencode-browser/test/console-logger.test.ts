import { afterEach, describe, expect, it, vi } from "vitest";

import { createJsonConsoleLogger } from "../src/logging.js";

function lastJson(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const call = spy.mock.calls.at(-1);
  return JSON.parse(String(call?.[0]));
}

describe("createJsonConsoleLogger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("suppresses messages below the minimum level", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createJsonConsoleLogger("warn");
    logger.trace("t");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("emits trace at the trace level but suppresses it at debug", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    createJsonConsoleLogger("trace").trace("seen", { n: 1 });
    expect(log).toHaveBeenCalledTimes(1);
    expect(lastJson(log as never)).toMatchObject({ level: "trace", event: "seen", n: 1 });

    log.mockClear();
    createJsonConsoleLogger("debug").trace("hidden");
    expect(log).not.toHaveBeenCalled();
  });

  it("routes error and warn to their console channels", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createJsonConsoleLogger("debug");
    logger.error("boom");
    logger.warn("careful");
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(lastJson(error as never)).toMatchObject({ level: "error", event: "boom" });
  });

  it("redacts secret-bearing field keys", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createJsonConsoleLogger("debug");
    logger.info("auth", {
      token: "abc",
      Authorization: "Bearer x",
      password: "p",
      apiSecret: "s",
      url: "https://ok"
    });
    const payload = lastJson(log as never);
    expect(payload.token).toBe("[redacted]");
    expect(payload.Authorization).toBe("[redacted]");
    expect(payload.password).toBe("[redacted]");
    expect(payload.apiSecret).toBe("[redacted]");
    expect(payload.url).toBe("https://ok");
  });

  it("emits a structured payload with ts/level/event", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    createJsonConsoleLogger("debug").info("ev", { n: 1 });
    const payload = lastJson(log as never);
    expect(payload).toMatchObject({ level: "info", event: "ev", n: 1 });
    expect(typeof payload.ts).toBe("string");
  });
});
