import { ExportResultCode } from "@opentelemetry/core";
import { describe, expect, it, vi } from "vitest";

import { type ExporterLike, withFailureLogging } from "../src/export-logging.js";
import { silentLogger } from "./helpers.js";

function fakeExporter(results: Array<{ code: ExportResultCode; error?: unknown }>): ExporterLike {
  let i = 0;
  return {
    export(_items, resultCallback) {
      const result = results[Math.min(i, results.length - 1)];
      i += 1;
      resultCallback(result as never);
    },
    shutdown: async () => {},
    forceFlush: async () => {}
  };
}

const exportOnce = (exporter: ExporterLike) =>
  new Promise<void>((resolve) => exporter.export([] as never, () => resolve()));

describe("withFailureLogging", () => {
  it("says nothing on a successful export", async () => {
    const logger = silentLogger();
    const wrapped = withFailureLogging(
      fakeExporter([{ code: ExportResultCode.SUCCESS }]),
      "traces",
      logger
    );
    await exportOnce(wrapped);
    expect(logger.events).toHaveLength(0);
  });

  it("surfaces a failed export with the signal and the error message", async () => {
    const logger = silentLogger();
    const wrapped = withFailureLogging(
      fakeExporter([
        { code: ExportResultCode.FAILED, error: new Error("authentication didn't succeed") }
      ]),
      "logs",
      logger
    );
    await exportOnce(wrapped);

    const [name, fields] = logger.events[0];
    expect(name).toBe("warn:otel_export_failed");
    expect(fields).toMatchObject({
      signal: "logs",
      consecutiveFailures: 1,
      error: "authentication didn't succeed"
    });
  });

  it("extracts the HTTP status an OTLP error carries", async () => {
    const logger = silentLogger();
    const error = Object.assign(new Error("Unauthorized"), { code: 401 });
    const wrapped = withFailureLogging(
      fakeExporter([{ code: ExportResultCode.FAILED, error }]),
      "metrics",
      logger
    );
    await exportOnce(wrapped);
    expect(logger.events[0][1]).toMatchObject({ status: 401 });
  });

  it("counts consecutive failures and reports recovery once", async () => {
    const logger = silentLogger();
    const wrapped = withFailureLogging(
      fakeExporter([
        { code: ExportResultCode.FAILED, error: new Error("boom") },
        { code: ExportResultCode.FAILED, error: new Error("boom") },
        { code: ExportResultCode.SUCCESS },
        { code: ExportResultCode.SUCCESS }
      ]),
      "traces",
      logger
    );

    await exportOnce(wrapped);
    await exportOnce(wrapped);
    await exportOnce(wrapped);
    await exportOnce(wrapped);

    const names = logger.events.map(([name]) => name);
    expect(names).toEqual([
      "warn:otel_export_failed",
      "warn:otel_export_failed",
      "info:otel_export_recovered"
    ]);
    expect(logger.events[1][1]).toMatchObject({ consecutiveFailures: 2 });
    expect(logger.events[2][1]).toMatchObject({ afterFailures: 2 });
  });

  it("invokes the failure hook so a dead credential can be dropped", async () => {
    const onFailure = vi.fn();
    const wrapped = withFailureLogging(
      fakeExporter([{ code: ExportResultCode.FAILED, error: new Error("401") }]),
      "traces",
      silentLogger(),
      { onFailure }
    );
    await exportOnce(wrapped);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("passes the result through untouched and keeps lifecycle methods working", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const forceFlush = vi.fn().mockResolvedValue(undefined);
    const base: ExporterLike = {
      export(_items, cb) {
        cb({ code: ExportResultCode.SUCCESS } as never);
      },
      shutdown,
      forceFlush
    };
    const wrapped = withFailureLogging(base, "traces", silentLogger());

    const seen = await new Promise((resolve) => wrapped.export([] as never, resolve));
    expect(seen).toEqual({ code: ExportResultCode.SUCCESS });
    await wrapped.shutdown();
    await wrapped.forceFlush?.();
    expect(shutdown).toHaveBeenCalled();
    expect(forceFlush).toHaveBeenCalled();
  });

  it("reads a status carried as a numeric string", async () => {
    const logger = silentLogger();
    const error = Object.assign(new Error("failed"), { statusCode: "503" });
    const wrapped = withFailureLogging(
      fakeExporter([{ code: ExportResultCode.FAILED, error }]),
      "traces",
      logger
    );
    await exportOnce(wrapped);
    expect(logger.events[0][1]).toMatchObject({ status: 503 });
  });

  it("ignores a non-numeric error code and a non-object error", async () => {
    const logger = silentLogger();
    const wrapped = withFailureLogging(
      fakeExporter([{ code: ExportResultCode.FAILED, error: "plain string failure" }]),
      "traces",
      logger
    );
    await exportOnce(wrapped);
    expect(logger.events[0][1]).toMatchObject({
      error: "plain string failure",
      status: undefined
    });
  });

  it("handles a failure with no error attached", async () => {
    const logger = silentLogger();
    const wrapped = withFailureLogging(
      fakeExporter([{ code: ExportResultCode.FAILED }]),
      "traces",
      logger
    );
    await exportOnce(wrapped);
    expect(logger.events[0][1]).toMatchObject({ error: "unknown", status: undefined });
  });
});
