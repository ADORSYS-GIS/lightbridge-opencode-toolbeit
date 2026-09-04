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
import { type ExporterLike, withFailureLogging } from "./export-logging.js";
import type { Logger } from "./logging.js";
import { createTokenSource, type TokenSource } from "./token-source.js";
import type { VcsInfo } from "./vcs.js";
import type { ResolvedOtelConfig, SignalName } from "./types.js";

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
  trace?: (config: ResolvedOtelConfig, tokenSource?: TokenSource) => SpanExporter | undefined;
  metric?: (
    config: ResolvedOtelConfig,
    tokenSource?: TokenSource
  ) => PushMetricExporter | undefined;
  log?: (config: ResolvedOtelConfig, tokenSource?: TokenSource) => LogRecordExporter | undefined;
}

/**
 * Build the exporter's `url` + `headers`. With a credential helper configured,
 * `headers` is an async factory the exporter calls before every export — which
 * is what lets a five-minute OIDC token be refreshed underneath a long-running
 * session instead of going stale at the first expiry.
 */
function otlpArgs(config: ResolvedOtelConfig, signal: SignalName, tokenSource?: TokenSource) {
  const url = signalUrl(config, signal);
  if (!url) {
    return undefined;
  }
  if (!tokenSource) {
    return { url, headers: config.headers };
  }
  return {
    url,
    // By the time this runs, `withFailureLogging`'s credential gate has already
    // resolved `tokenSource.headers()` once for this export and only proceeded
    // because it got a value back — so this call is normally an instant cache
    // hit, not a second real resolution attempt. Spreading `undefined` (the
    // rare race where the token expires in between) is a no-op, not an error.
    headers: async () => ({ ...config.headers, ...(await tokenSource.headers()) })
  };
}

const defaultFactories: Required<ExporterFactories> = {
  trace: (config, tokenSource) => {
    if (config.exporters.traces === "console") {
      return new ConsoleSpanExporter();
    }
    const args = otlpArgs(config, "traces", tokenSource);
    return args ? new OTLPTraceExporter(args) : undefined;
  },
  metric: (config, tokenSource) => {
    if (config.exporters.metrics === "console") {
      return new ConsoleMetricExporter();
    }
    const args = otlpArgs(config, "metrics", tokenSource);
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
  log: (config, tokenSource) => {
    if (config.exporters.logs === "console") {
      return new ConsoleLogRecordExporter();
    }
    const args = otlpArgs(config, "logs", tokenSource);
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
    /** Repository metadata read off disk — see `vcs.ts`. */
    vcs?: VcsInfo;
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
    attributes["vcs.ref.head.name"] = context.branch;
    // Deprecated in semconv 1.43 in favour of `vcs.ref.head.name`, but it is
    // what `opencode-otel-plugin` emits and what existing dashboards key on.
    // Kept as an alias so a collector receiving both plugins stays coherent;
    // due for removal once those dashboards move.
    attributes["vcs.repository.ref.name"] = context.branch;
  }
  const vcs = context.vcs;
  if (vcs) {
    if (vcs.url) {
      attributes["vcs.repository.url.full"] = vcs.url;
    }
    if (vcs.name) {
      attributes["vcs.repository.name"] = vcs.name;
    }
    if (vcs.owner) {
      attributes["vcs.owner.name"] = vcs.owner;
    }
    if (vcs.provider) {
      attributes["vcs.provider.name"] = vcs.provider;
    }
    if (vcs.revision) {
      attributes["vcs.ref.head.revision"] = vcs.revision;
    }
    if (vcs.refType) {
      attributes["vcs.ref.head.type"] = vcs.refType;
    }
  }
  // Operator-supplied attributes win — they are the escape hatch, and silently
  // ignoring them would make the escape hatch useless.
  return resourceFromAttributes({ ...attributes, ...config.resourceAttributes });
}

/**
 * Construct the enabled providers. Each signal is independent: a failure to
 * build one leaves the others running, because partial telemetry is strictly
 * better than an exception escaping into the host's plugin loader.
 *
 * **Three `tokenSource` cases, each with a different, deliberate outcome**
 * (see ADR-0015):
 *
 * 1. **No token source at all** — no `injectedTokenSource` and no
 *    `config.tokenCommand`. `tokenSource` stays `undefined`, `observe()`'s
 *    `gate` argument stays `undefined`, and exports proceed exactly as they
 *    always have. This is the standalone `@vymalo/opencode-otel` plugin
 *    pointed at an unauthenticated collector — a legitimate configuration
 *    that must not be gated.
 * 2. **Token source configured, credential obtained** — `tokenSource.headers()`
 *    resolves to a header map, `withFailureLogging`'s gate lets the export
 *    through, and it carries the resolved `Authorization` header as before.
 * 3. **Token source configured, credential unavailable** — `headers()`
 *    resolves to `undefined` (expired/failed helper, rejected exchange,
 *    logged-out user). The gate skips the export before it reaches the
 *    network, logs at `debug`, and leaves the batch processor's own interval
 *    as the only retry — no extra spinning. Because the check is lazy (run on
 *    every export attempt, not once at startup), a credential that becomes
 *    available later — e.g. the user logs in mid-session — resumes exporting
 *    on the very next flush with no restart needed.
 */
export function createProviders(
  config: ResolvedOtelConfig,
  resource: Resource,
  logger: Logger,
  factories: ExporterFactories = {},
  injectedTokenSource?: TokenSource
): TelemetryProviders {
  const make = { ...defaultFactories, ...factories };
  const flushers: Array<() => Promise<void>> = [];
  const shutdowns: Array<() => Promise<void>> = [];

  // An injected source (e.g. one backed by the shared `TokenRuntime` in the
  // `@vymalo/opencode-lightbridge` umbrella) wins over the config-driven
  // credential helper. `createTokenSource` from `config.tokenCommand` remains
  // the standalone plugin's default when nothing is injected.
  const tokenSource =
    injectedTokenSource ??
    (config.tokenCommand.length > 0
      ? createTokenSource({
          command: config.tokenCommand,
          header: config.tokenHeader,
          prefix: config.tokenPrefix,
          refreshMs: config.tokenRefreshMs,
          timeoutMs: config.tokenTimeoutMs,
          logger
        })
      : undefined);

  // A rejected export is the symptom of a dead credential, so drop the cached
  // token and let the next export re-run the helper rather than retrying with
  // something the collector has already refused.
  const onFailure = tokenSource ? () => tokenSource.invalidate() : undefined;

  // The credential gate only makes sense for a `console` exporter's sibling
  // OTLP path — a `console` exporter never leaves the process, so gating it on
  // `tokenSource` would silently blank local debug output whenever auth is
  // unusable, for no security benefit. Pass `tokenSource` through only for the
  // kinds that actually hit the network.
  const observe = <T extends ExporterLike>(
    exporter: T,
    signal: SignalName,
    gate: TokenSource | undefined
  ): T => withFailureLogging(exporter, signal, logger, { onFailure, tokenSource: gate });

  let tracer: Tracer | undefined;
  let meter: Meter | undefined;
  let otelLogger: OtelLogger | undefined;

  if (config.exporters.traces !== "none") {
    try {
      const built = make.trace(config, tokenSource);
      if (built) {
        const gate = config.exporters.traces === "console" ? undefined : tokenSource;
        const exporter = observe(built, "traces", gate);
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
      const built = make.metric(config, tokenSource);
      if (built) {
        const gate = config.exporters.metrics === "console" ? undefined : tokenSource;
        const exporter = observe(built, "metrics", gate);
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
      const built = make.log(config, tokenSource);
      if (built) {
        const gate = config.exporters.logs === "console" ? undefined : tokenSource;
        const exporter = observe(built, "logs", gate);
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
