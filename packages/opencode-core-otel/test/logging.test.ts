import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  fromOpenCodeLogLevel,
  LOG_LEVEL_PRIORITY
} from "../src/logging.js";

describe("createJsonConsoleLogger", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("emits JSON lines at or above the min level", () => {
    const log = createJsonConsoleLogger("info");
    log.debug("skipped");
    log.info("kept", { a: 1 });
    expect(console.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((console.log as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(payload).toMatchObject({ level: "info", event: "kept", a: 1 });
    expect(payload.ts).toBeDefined();
  });

  it("routes warn/error to the right console method", () => {
    const log = createJsonConsoleLogger("trace");
    log.warn("w");
    log.error("e");
    expect(console.warn).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("redacts secret-ish fields", () => {
    const log = createJsonConsoleLogger("trace");
    log.info("e", { token: "abc", Authorization: "Bearer x", safe: "ok" });
    const payload = JSON.parse((console.log as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(payload.token).toBe("[redacted]");
    expect(payload.Authorization).toBe("[redacted]");
    expect(payload.safe).toBe("ok");
  });

  it("defaults to info and orders levels", () => {
    expect(DEFAULT_LOG_LEVEL).toBe("info");
    expect(LOG_LEVEL_PRIORITY.trace).toBeLessThan(LOG_LEVEL_PRIORITY.error);
  });
});

describe("fromOpenCodeLogLevel", () => {
  it("maps host levels (DEBUG → trace)", () => {
    expect(fromOpenCodeLogLevel("DEBUG")).toBe("trace");
    expect(fromOpenCodeLogLevel("info")).toBe("info");
    expect(fromOpenCodeLogLevel("WARN")).toBe("warn");
    expect(fromOpenCodeLogLevel("ERROR")).toBe("error");
  });

  it("returns undefined for unknown / non-string", () => {
    expect(fromOpenCodeLogLevel("VERBOSE")).toBeUndefined();
    expect(fromOpenCodeLogLevel(42)).toBeUndefined();
  });
});
