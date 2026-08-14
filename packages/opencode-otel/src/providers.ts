import type { Logger as OtelLogger } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  type DetectedResourceAttributes,
  type MaybePromise,
  type Resource,
  resourceFromAttributes
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  ConsoleLogRecordExporter,
  type LogRecordExporter,
  LoggerProvider
} from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type SpanExporter,
  TracerProvider
} from "@opentelemetry/sdk-trace";
import type { Tracer } from "@opentelemetry/api";
import type { Meter } from "@opentelemetry/api";

import { signalUrl } from "./config.js";
import type { Logger } from "./logging.js";
import type { ResolvedOtelConfig } from "./types.js";

const INSTRUMENTATION_SCOPE = "@vymalo/opencode-otel";

/**
 * The three provider handles the recorder needs, plus lifecycle. `undefined`
 * for a signal whose exporter is `none` — the recorder no-ops on it rather
 * than branching on config everywhere.
 */
export interface TelemetryProviders {
  tracer?: Tracer;
  meter?: Meter;
  otelLogger?: OtelLogger;
  /** Push everything buffered. Called on `session.idle` and on process exit. */
  forceFlush(): Promise<void>;
  /** Flush and tear down. */
  shutdown(): Promise<void>;
}

/**
 * Exporter factories, injectable so tests can substitute in-memory exporters
 * without reaching the network or constructing real OTLP clients.
 */
export interface ExporterFactories {
  trace?: (config: ResolvedOtelConfig) => SpanExporter | undefined;
  metric?: (config: ResolvedOtelConfig) => PushMetricExporter | undefined;
  log?: (config: ResolvedOtelConfig) => LogRecordExporter | undefined;
}

function otlpArgs(config: ResolvedOtelConfig, signal: "traces" | "metrics" | "logs") {
  const url = signalUrl(config, signal);
  return url ? { url, headers: config.headers } : undefined;
}

const defaultFactories: Required<ExporterFactories> = {
  trace: (config) => {
    if (config.exporters.traces === "console") {
      return new ConsoleSpanExporter();
    }
    const args = otlpArgs(config, "traces");
    return args ? new OTLPTraceExporter(args) : undefined;
  },
  metric: (config) => {
    if (config.exporters.metrics === "console") {
      return new ConsoleMetricExporter();
    }
    const args = otlpArgs(config, "metrics");
    return args
      ? new OTLPMetricExporter({
          ...args,
          temporalityPreference:
            config.metricTemporality === "cumulative"
              ? AggregationTemporality.CUMULATIVE
              : AggregationTemporality.DELTA
        })
      : undefined;
  },
  log: (config) => {
    if (config.exporters.logs === "console") {
      return new ConsoleLogRecordExporter();
    }
    const args = otlpArgs(config, "logs");
    return args ? new OTLPLogExporter(args) : undefined;
  }
};

/**
 * Build the resource every signal is stamped with.
 *
 * Deliberately identifies the **machine and the project**, never the developer:
 * no git author email, no account id. An operator who wants per-person
 * attribution adds it explicitly via `resourceAttributes` /
 * `OTEL_RESOURCE_ATTRIBUTES`, which keeps that choice visible in config.
 */
export function buildResource(
  config: ResolvedOtelConfig,
  context: {
    /**
     * May be a promise: OpenCode reports the host version as an
     * `installation.updated` *event*, after the resource is already built. The
     * OTel resource API awaits promise-valued attributes before the first
     * export — see `deferred.ts` for why the deferral is always bounded.
     */
    version?: MaybePromise<string | undefined>;
    hostname?: string;
    projectName?: string;
    directory?: string;
    worktree?: string;
    /** May be a promise, for the same reason as `version` (`vcs.branch.updated`). */
    branch?: MaybePromise<string | undefined>;
  }
): Resource {
  const attributes: DetectedResourceAttributes = {
    "service.name": config.serviceName,
    "telemetry.sdk.language": "nodejs"
  };
  if (context.version) {
    attributes["service.version"] = context.version;
  }
  if (config.environment) {
    attributes["deployment.environment.name"] = config.environment;
  }
  if (context.hostname) {
    attributes["host.name"] = context.hostname;
  }
  if (context.projectName) {
    attributes["opencode.project.name"] = context.projectName;
  }
  if (context.directory) {
    attributes["opencode.directory"] = context.directory;
  }
  if (context.worktree) {
    attributes["opencode.worktree"] = context.worktree;
  }
  if (context.branch) {
    attributes["vcs.repository.ref.name"] = context.branch;
  }
  // Operator-supplied attributes win — they are the escape hatch, and silently
  // ignoring them would make the escape hatch useless.
  return resourceFromAttributes({ ...attributes, ...config.resourceAttributes });
}

/**
 * Construct the enabled providers. Each signal is independent: a failure to
 * build one leaves the others running, because partial telemetry is strictly
 * better than an exception escaping into the host's plugin loader.
 */
export function createProviders(
  config: ResolvedOtelConfig,
  resource: Resource,
  logger: Logger,
  factories: ExporterFactories = {}
): TelemetryProviders {
  const make = { ...defaultFactories, ...factories };
  const flushers: Array<() => Promise<void>> = [];
  const shutdowns: Array<() => Promise<void>> = [];

  let tracer: Tracer | undefined;
  let meter: Meter | undefined;
  let otelLogger: OtelLogger | undefined;

  if (config.exporters.traces !== "none") {
    try {
      const exporter = make.trace(config);
      if (exporter) {
        const provider = new TracerProvider({
          resource,
          spanProcessors: [
            new BatchSpanProcessor({
              exporter,
              scheduledDelayMillis: config.traceExportIntervalMs
            })
          ]
        });
        tracer = provider.getTracer(INSTRUMENTATION_SCOPE);
        flushers.push(() => provider.forceFlush());
        shutdowns.push(() => provider.shutdown());
      }
    } catch (error) {
      logger.warn("otel_traces_init_failed", { error: describeError(error) });
    }
  }

  if (config.exporters.metrics !== "none") {
    try {
      const exporter = make.metric(config);
      if (exporter) {
        const provider = new MeterProvider({
          resource,
          readers: [
            new PeriodicExportingMetricReader({
              exporter,
              exportIntervalMillis: config.metricExportIntervalMs
            })
          ]
        });
        meter = provider.getMeter(INSTRUMENTATION_SCOPE);
        flushers.push(() => provider.forceFlush());
        shutdowns.push(() => provider.shutdown());
      }
    } catch (error) {
      logger.warn("otel_metrics_init_failed", { error: describeError(error) });
    }
  }

  if (config.exporters.logs !== "none") {
    try {
      const exporter = make.log(config);
      if (exporter) {
        const provider = new LoggerProvider({
          resource,
          processors: [
            new BatchLogRecordProcessor({
              exporter,
              scheduledDelayMillis: config.logExportIntervalMs
            })
          ]
        });
        otelLogger = provider.getLogger(INSTRUMENTATION_SCOPE);
        flushers.push(() => provider.forceFlush());
        shutdowns.push(() => provider.shutdown());
      }
    } catch (error) {
      logger.warn("otel_logs_init_failed", { error: describeError(error) });
    }
  }

  const runAll = async (tasks: Array<() => Promise<void>>): Promise<void> => {
    // `allSettled`, not `all`: one unreachable collector must not stop the
    // other signals from draining.
    await Promise.allSettled(tasks.map((task) => task()));
  };

  return {
    tracer,
    meter,
    otelLogger,
    forceFlush: () => runAll(flushers),
    shutdown: () => runAll(shutdowns)
  };
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
