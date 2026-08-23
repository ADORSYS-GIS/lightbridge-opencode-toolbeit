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
  /**
   * A credential helper that prints a fresh access token on stdout, re-run
   * before the cached one expires. Use instead of a static `Authorization`
   * header when the collector is behind a short-lived OIDC token.
   * String or argv array, e.g. `"governance-auth token"`.
   */
  tokenCommand?: string | string[];
  /** Header the token goes in. Default `Authorization`. */
  tokenHeader?: string;
  /** Token value prefix. Default `Bearer `. */
  tokenPrefix?: string;
  /** Fallback refresh cadence when the token carries no readable `exp`, ms. */
  tokenRefreshMs?: number;
  /** How long the helper may run before being killed, ms. Default 10000. */
  tokenTimeoutMs?: number;
  /** Which signals to export. Omitted signals default to `otlp` when an endpoint is set. */
  exporters?: Partial<Record<SignalName, ExporterKind>>;
  /** `service.name` resource attribute. Defaults to `opencode`. */
  serviceName?: string;
  /** Deployment tag, mirroring Codex's `[otel] environment`. Sets `deployment.environment.name`. */
  environment?: string;
  /** Extra resource attributes merged onto the defaults. */
  resourceAttributes?: Record<string, string>;
  /**
   * Read repository metadata (remote URL, owner, branch, revision) off disk and
   * attach it to the resource. On by default. Credentials in the remote URL are
   * always stripped; set `false` to publish no repository identity at all.
   */
  collectVcs?: boolean;
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
  /** Argv of the credential helper; empty when none is configured. */
  tokenCommand: string[];
  tokenHeader: string;
  tokenPrefix: string;
  tokenRefreshMs: number;
  tokenTimeoutMs: number;
  exporters: Record<SignalName, ExporterKind>;
  serviceName: string;
  environment?: string;
  resourceAttributes: Record<string, string>;
  collectVcs: boolean;
  metricExportIntervalMs: number;
  logExportIntervalMs: number;
  traceExportIntervalMs: number;
  metricTemporality: MetricTemporality;
  includeSessionId: boolean;
  filteredTools: Set<string>;
  propagateTraceContext: boolean;
}
