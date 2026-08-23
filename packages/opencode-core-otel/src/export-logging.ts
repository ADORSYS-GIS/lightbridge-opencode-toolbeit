import { type ExportResult, ExportResultCode } from "@opentelemetry/core";

import type { Logger } from "./logging.js";
import type { SignalName } from "./types.js";

/**
 * The shape all three OTel exporters share: `export(items, resultCallback)`.
 * Typed structurally rather than against `SpanExporter | PushMetricExporter |
 * LogRecordExporter`, whose item types are unrelated.
 */
export interface ExporterLike {
  export(items: never, resultCallback: (result: ExportResult) => void): void;
  shutdown(): Promise<void>;
  forceFlush?(): Promise<void>;
}

/**
 * Wrap an exporter so a failed export reaches the host log stream.
 *
 * Without this, a rejected OTLP request — an expired credential, a wrong
 * audience, an unreachable collector — is reported only through the OTel SDK's
 * own `diag` channel, which nothing here subscribes to. The visible symptom is
 * that telemetry silently stops while the session looks entirely healthy.
 *
 * Deliberately not `diag.setLogger`: that is process-global and would hijack
 * the channel for the host and every other plugin. Decorating our own exporters
 * observes exactly the failures we caused and nothing else.
 */
export function withFailureLogging<T extends ExporterLike>(
  exporter: T,
  signal: SignalName,
  logger: Logger,
  options: { onFailure?: () => void } = {}
): T {
  let consecutiveFailures = 0;

  const wrapped: ExporterLike = {
    export(items, resultCallback) {
      exporter.export(items, (result) => {
        if (result.code === ExportResultCode.SUCCESS) {
          if (consecutiveFailures > 0) {
            logger.info("otel_export_recovered", { signal, afterFailures: consecutiveFailures });
            consecutiveFailures = 0;
          }
        } else {
          consecutiveFailures += 1;
          logger.warn("otel_export_failed", {
            signal,
            consecutiveFailures,
            // `error` may carry an HTTP status; the message is the actionable
            // part (e.g. "authentication didn't succeed" from an OIDC gate).
            error: describeExportError(result.error),
            status: readStatus(result.error)
          });
          options.onFailure?.();
        }
        resultCallback(result);
      });
    },
    shutdown: () => exporter.shutdown(),
    ...(exporter.forceFlush ? { forceFlush: () => exporter.forceFlush?.() as Promise<void> } : {})
  };

  // Preserve the prototype and any extra members the concrete exporter exposes.
  return Object.assign(Object.create(Object.getPrototypeOf(exporter)), exporter, wrapped) as T;
}

function describeExportError(error: unknown): string {
  if (!error) {
    return "unknown";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** OTLP exporter errors carry the HTTP status as `code` or `statusCode`. */
function readStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const candidate = error as { code?: unknown; statusCode?: unknown };
  for (const value of [candidate.statusCode, candidate.code]) {
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && /^\d{3}$/.test(value)) {
      return Number(value);
    }
  }
  return undefined;
}
