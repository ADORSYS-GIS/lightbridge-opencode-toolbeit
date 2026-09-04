import { ExportResultCode } from "@opentelemetry/core";
import { describe, expect, it, vi } from "vitest";

import { type ExporterLike, withFailureLogging } from "../src/export-logging.js";
import type { TokenSource } from "../src/token-source.js";
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

/** A fake exporter whose `export` calls are individually observable. */
function spyExporter(): { exporter: ExporterLike; exportSpy: ReturnType<typeof vi.fn> } {
  const exportSpy = vi.fn((_items: never, resultCallback: (result: unknown) => void) => {
    resultCallback({ code: ExportResultCode.SUCCESS });
  });
  return {
    exporter: { export: exportSpy as ExporterLike["export"], shutdown: async () => {} },
    exportSpy
  };
}

/** A `TokenSource` whose `headers()` answers are scripted, one per call. */
function fakeTokenSource(answers: Array<Record<string, string> | undefined>): TokenSource {
  let i = 0;
  return {
    headers: async () => answers[Math.min(i++, answers.length - 1)],
    invalidate: () => {}
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

/**
 * The fail-closed credential gate (ADR-0015). `withFailureLogging` is the seam
 * that resolves `tokenSource.headers()` *before* delegating to the real
 * exporter, so a missing credential never reaches the network at all.
 */
describe("withFailureLogging — credential gate", () => {
  it("never calls the underlying exporter when the credential is unavailable", async () => {
    const { exporter, exportSpy } = spyExporter();
    const tokenSource = fakeTokenSource([undefined]);
    const wrapped = withFailureLogging(exporter, "traces", silentLogger(), { tokenSource });

    const result = await new Promise((resolve) => wrapped.export([] as never, resolve));

    expect(exportSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ code: ExportResultCode.FAILED });
  });

  it("logs the skip at debug, not warn, and does not invoke onFailure", async () => {
    const logger = silentLogger();
    const onFailure = vi.fn();
    const { exporter } = spyExporter();
    const tokenSource = fakeTokenSource([undefined]);
    const wrapped = withFailureLogging(exporter, "traces", logger, { tokenSource, onFailure });

    await exportOnce(wrapped);

    expect(logger.events).toEqual([
      ["debug:otel_export_skipped_no_credential", { signal: "traces" }]
    ]);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("calls the underlying exporter once the credential is available", async () => {
    const { exporter, exportSpy } = spyExporter();
    const tokenSource = fakeTokenSource([{ Authorization: "Bearer good-token" }]);
    const wrapped = withFailureLogging(exporter, "traces", silentLogger(), { tokenSource });

    const result = await new Promise((resolve) => wrapped.export([] as never, resolve));

    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ code: ExportResultCode.SUCCESS });
  });

  it("still logs and reports a real export failure normally once past the gate", async () => {
    const logger = silentLogger();
    const exporter = fakeExporter([
      { code: ExportResultCode.FAILED, error: new Error("401 rejected") }
    ]);
    const tokenSource = fakeTokenSource([{ Authorization: "Bearer stale-token" }]);
    const wrapped = withFailureLogging(exporter, "traces", logger, { tokenSource });

    await exportOnce(wrapped);

    expect(logger.events).toEqual([
      [
        "warn:otel_export_failed",
        { signal: "traces", consecutiveFailures: 1, error: "401 rejected", status: undefined }
      ]
    ]);
  });

  it("resumes exporting on the next attempt once a later credential becomes available", async () => {
    const { exporter, exportSpy } = spyExporter();
    // First attempt: logged out. Second attempt: a login happened in between —
    // no restart, no re-registration, just the next scheduled export.
    const tokenSource = fakeTokenSource([undefined, { Authorization: "Bearer fresh-token" }]);
    const wrapped = withFailureLogging(exporter, "traces", silentLogger(), { tokenSource });

    const first = await new Promise((resolve) => wrapped.export([] as never, resolve));
    expect(exportSpy).not.toHaveBeenCalled();
    expect(first).toMatchObject({ code: ExportResultCode.FAILED });

    const second = await new Promise((resolve) => wrapped.export([] as never, resolve));
    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ code: ExportResultCode.SUCCESS });
  });

  it("does not gate an exporter with no tokenSource — the standalone unauthenticated case", async () => {
    // Regression guard: `@vymalo/opencode-otel` with no `tokenCommand` must
    // keep exporting to an unauthenticated collector exactly as before.
    const { exporter, exportSpy } = spyExporter();
    const wrapped = withFailureLogging(exporter, "traces", silentLogger());

    await exportOnce(wrapped);
    await exportOnce(wrapped);

    expect(exportSpy).toHaveBeenCalledTimes(2);
  });
});
