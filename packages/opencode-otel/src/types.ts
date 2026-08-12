export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/**
 * Where a signal is sent. `otlp` is OTLP/HTTP-protobuf (the only wire transport
 * this plugin ships — see ADR-0009 for why gRPC is absent); `console` prints to
 * stdout for local debugging; `none` records nothing.
 */
export type ExporterKind = "otlp" | "console" | "none";

/** The three OTel signals, independently toggleable. */
export type SignalName = "traces" | "metrics" | "logs";

/**
 * Plugin options as written in `opencode.json` (or served through
 * `.well-known/opencode`). Every field is optional and every field has a
 * standard `OTEL_*` environment counterpart that **overrides** it — see
 * `resolveOtelConfig`.
 */
export interface OtelPluginOptions {
  /** Master switch. `false` returns inert hooks without initializing anything. */
  enabled?: boolean;
  /** OTLP/HTTP base URL, e.g. `http://localhost:4318`. Signal paths are appended. */
  endpoint?: string;
  /** Per-signal endpoint overrides. A full URL including the signal path. */
  endpoints?: Partial<Record<SignalName, string>>;
  /** Headers sent with every OTLP request (auth tokens live here). */
  headers?: Record<string, string>;
  /** Which signals to export. Omitted signals default to `otlp` when an endpoint is set. */
  exporters?: Partial<Record<SignalName, ExporterKind>>;
  /** `service.name` resource attribute. Defaults to `opencode`. */
  serviceName?: string;
  /** Deployment tag, mirroring Codex's `[otel] environment`. Sets `deployment.environment.name`. */
  environment?: string;
  /** Extra resource attributes merged onto the defaults. */
  resourceAttributes?: Record<string, string>;
  /** Metric export interval, ms. Default 60000. */
  metricExportIntervalMs?: number;
  /** Log record export interval, ms. Default 5000. */
  logExportIntervalMs?: number;
  /** Span export interval, ms. Default 5000. */
  traceExportIntervalMs?: number;
  /** `delta` (default) or `cumulative` metric temporality. */
  metricTemporality?: MetricTemporality;
  /**
   * Attach `gen_ai.conversation.id` to **metrics** as well as logs/spans.
   * Off by default: session id is unbounded cardinality and most metric
   * backends bill per series. Logs and spans always carry it.
   */
  includeSessionId?: boolean;
  /** Tool names excluded from span generation. They are still counted in metrics. */
  filteredTools?: string[];
  /**
   * Inject W3C `traceparent` into provider HTTP requests by wrapping
   * `provider.options.fetch`, so gateway-side spans join the session trace.
   * On by default when traces are enabled.
   */
  propagateTraceContext?: boolean;
}

export type MetricTemporality = "delta" | "cumulative";

/** Fully resolved configuration — defaults applied, env overrides folded in. */
export interface ResolvedOtelConfig {
  enabled: boolean;
  /** True when at least one signal has a live (non-`none`) exporter. */
  active: boolean;
  endpoint?: string;
  endpoints: Partial<Record<SignalName, string>>;
  headers: Record<string, string>;
  exporters: Record<SignalName, ExporterKind>;
  serviceName: string;
  environment?: string;
  resourceAttributes: Record<string, string>;
  metricExportIntervalMs: number;
  logExportIntervalMs: number;
  traceExportIntervalMs: number;
  metricTemporality: MetricTemporality;
  includeSessionId: boolean;
  filteredTools: Set<string>;
  propagateTraceContext: boolean;
}
