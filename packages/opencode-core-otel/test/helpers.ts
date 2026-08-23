import { InMemoryLogRecordExporter, type ReadableLogRecord } from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  type MetricData
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace";

import { resolveOtelConfig } from "../src/config.js";
import type { Logger } from "../src/logging.js";
import { buildResource, createProviders, type TelemetryProviders } from "../src/providers.js";
import type { OtelPluginOptions, ResolvedOtelConfig } from "../src/types.js";

export function silentLogger(): Logger & { events: Array<[string, unknown]> } {
  const events: Array<[string, unknown]> = [];
  const push =
    (level: string) =>
    (event: string, fields?: unknown): void => {
      events.push([`${level}:${event}`, fields]);
    };
  return {
    events,
    trace: push("trace"),
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error")
  };
}

export interface Harness {
  config: ResolvedOtelConfig;
  providers: TelemetryProviders;
  logger: ReturnType<typeof silentLogger>;
  /** Flushes first — the real batch processors buffer, so a bare read races. */
  spans(): Promise<ReadableSpan[]>;
  logs(): Promise<ReadableLogRecord[]>;
  metrics(): Promise<MetricData[]>;
}

/**
 * Build the real provider stack against in-memory exporters, so tests assert on
 * exported telemetry rather than on mock call shapes.
 */
export function harness(options: OtelPluginOptions = {}): Harness {
  const config = resolveOtelConfig({ endpoint: "http://localhost:4318", ...options }, {});
  const logger = silentLogger();
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const logExporter = new InMemoryLogRecordExporter();

  const providers = createProviders(config, buildResource(config, {}), logger, {
    trace: () => spanExporter,
    metric: () => metricExporter,
    log: () => logExporter
  });

  return {
    config,
    providers,
    logger,
    spans: async () => {
      await providers.forceFlush();
      return spanExporter.getFinishedSpans();
    },
    logs: async () => {
      await providers.forceFlush();
      return logExporter.getFinishedLogRecords();
    },
    metrics: async () => {
      await providers.forceFlush();
      return metricExporter
        .getMetrics()
        .flatMap((resourceMetrics) => resourceMetrics.scopeMetrics)
        .flatMap((scope) => scope.metrics);
    }
  };
}

/** Find one exported metric by name, or `undefined`. */
export function metricNamed(metrics: MetricData[], name: string): MetricData | undefined {
  return metrics.find((metric) => metric.descriptor.name === name);
}

/** Every data point of a metric, as `[value, attributes]` pairs. */
export function points(metric: MetricData | undefined): Array<[number, Record<string, unknown>]> {
  if (!metric) {
    return [];
  }
  return metric.dataPoints.map((point) => {
    const value = point.value as number | { sum?: number; count?: number };
    return [
      typeof value === "number" ? value : (value.sum ?? 0),
      point.attributes as Record<string, unknown>
    ];
  });
}

/** Log records matching an `event.name`. */
export function logsNamed(records: ReadableLogRecord[], name: string): ReadableLogRecord[] {
  return records.filter((record) => record.attributes["event.name"] === name);
}

export function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    sessionID: "ses_1",
    role: "assistant",
    modelID: "kimi-k2.6",
    providerID: "camer-digital",
    mode: "build",
    parentID: "msg_0",
    path: { cwd: "/repo", root: "/repo" },
    cost: 0.0125,
    tokens: { input: 1200, output: 340, reasoning: 88, cache: { read: 9600, write: 400 } },
    time: { created: 1_000, completed: 3_500 },
    finish: "stop",
    ...overrides
  };
}
