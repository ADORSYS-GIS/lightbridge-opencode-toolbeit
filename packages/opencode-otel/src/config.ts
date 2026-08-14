import { DEFAULT_REFRESH_MS } from "./token-source.js";
import type {
  ExporterKind,
  MetricTemporality,
  OtelPluginOptions,
  ResolvedOtelConfig,
  SignalName
} from "./types.js";

export const SIGNALS: readonly SignalName[] = ["traces", "metrics", "logs"] as const;

const DEFAULTS = {
  serviceName: "opencode",
  metricExportIntervalMs: 60_000,
  logExportIntervalMs: 5_000,
  traceExportIntervalMs: 5_000,
  metricTemporality: "delta" as MetricTemporality
} as const;

/** Env source, injectable so tests never touch `process.env`. */
export type EnvSource = Record<string, string | undefined>;

/**
 * The `OTEL_*` variable names read per signal. The first entry of each tuple is
 * the OTel-spec name; the second (where present) is the Claude-Code-compatible
 * alias, accepted so an operator can move a working env block across tools.
 */
const SIGNAL_ENV = {
  traces: {
    exporter: "OTEL_TRACES_EXPORTER",
    endpoint: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    interval: ["OTEL_BSP_SCHEDULE_DELAY", "OTEL_TRACES_EXPORT_INTERVAL"]
  },
  metrics: {
    exporter: "OTEL_METRICS_EXPORTER",
    endpoint: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    interval: ["OTEL_METRIC_EXPORT_INTERVAL"]
  },
  logs: {
    exporter: "OTEL_LOGS_EXPORTER",
    endpoint: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    interval: ["OTEL_BLRP_SCHEDULE_DELAY", "OTEL_LOGS_EXPORT_INTERVAL"]
  }
} as const satisfies Record<
  SignalName,
  { exporter: string; endpoint: string; interval: readonly string[] }
>;

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (/^(1|true|yes|on)$/i.test(value)) {
    return true;
  }
  if (/^(0|false|no|off)$/i.test(value)) {
    return false;
  }
  return undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Parse the OTel `key=value,key2=value2` list format used by both
 * `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_RESOURCE_ATTRIBUTES`. Values are
 * percent-decoded per spec; an undecodable value is kept verbatim rather than
 * dropping the whole pair.
 */
export function parseKeyValueList(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = pair.slice(0, eq).trim();
    const rawValue = pair.slice(eq + 1).trim();
    if (!key) {
      continue;
    }
    try {
      out[key] = decodeURIComponent(rawValue);
    } catch {
      out[key] = rawValue;
    }
  }
  return out;
}

function parseExporter(value: string | undefined): ExporterKind | undefined {
  if (value === undefined) {
    return undefined;
  }
  // The spec allows a comma-separated list; we honour the first recognised
  // entry rather than fanning out to multiple exporters.
  for (const candidate of value.split(",").map((v) => v.trim().toLowerCase())) {
    if (candidate === "otlp" || candidate === "console" || candidate === "none") {
      return candidate;
    }
  }
  return undefined;
}

function firstDefined(env: EnvSource, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
}

function stringRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      out[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value);
    }
  }
  return out;
}

function stringList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== "");
  }
  return [];
}

/**
 * Normalise a command to argv. An array is taken verbatim — that is the form to
 * use when a path contains spaces. A string is split on whitespace, with **no
 * shell**: no quoting, no substitution, no injection surface.
 *
 * The split is decided by the type of the value actually supplied, not by the
 * type of some other candidate. Keying it on the wrong source silently produced
 * a single argv element like `"governance-auth token"` whenever an environment
 * override sat on top of an array in config — which `execFile` then failed to
 * spawn, so every export went out unauthenticated.
 */
export function parseCommand(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((part): part is string => typeof part === "string" && part.trim() !== "");
  }
  if (typeof raw === "string") {
    return raw.split(/\s+/).filter((part) => part !== "");
  }
  return [];
}

/**
 * Resolve plugin options against the environment.
 *
 * **Precedence: environment overrides plugin options.** Options are the base
 * layer so a `.well-known/opencode` document can ship a working default for a
 * whole organization; `OTEL_*` variables override per machine so a developer
 * can point at a local collector without editing served config. See
 * `plans/otel.md`.
 */
export function resolveOtelConfig(raw: unknown, env: EnvSource = process.env): ResolvedOtelConfig {
  const opts = (raw ?? {}) as OtelPluginOptions;

  const enabled = parseBool(env.OPENCODE_OTEL_ENABLED) ?? opts.enabled !== false;

  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT || opts.endpoint || undefined;

  const endpoints: Partial<Record<SignalName, string>> = {};
  for (const signal of SIGNALS) {
    const value = env[SIGNAL_ENV[signal].endpoint] || opts.endpoints?.[signal];
    if (value) {
      endpoints[signal] = value;
    }
  }

  // Env headers merge over option headers key-by-key rather than replacing the
  // map, so a machine can override just its auth token without restating the
  // whole set the served config provided.
  const headers = {
    ...stringRecord(opts.headers),
    ...parseKeyValueList(env.OTEL_EXPORTER_OTLP_HEADERS)
  };

  // An endpoint anywhere is what makes OTLP the implicit default; with none
  // configured the plugin stays completely inert.
  const hasEndpoint = Boolean(endpoint) || SIGNALS.some((s) => Boolean(endpoints[s]));
  const fallback: ExporterKind = hasEndpoint ? "otlp" : "none";

  const exporters = {} as Record<SignalName, ExporterKind>;
  for (const signal of SIGNALS) {
    exporters[signal] =
      parseExporter(env[SIGNAL_ENV[signal].exporter]) ?? opts.exporters?.[signal] ?? fallback;
  }

  const resourceAttributes = {
    ...stringRecord(opts.resourceAttributes),
    ...parseKeyValueList(env.OTEL_RESOURCE_ATTRIBUTES)
  };

  const temporality =
    env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE?.trim().toLowerCase() === "cumulative"
      ? "cumulative"
      : env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE?.trim().toLowerCase() === "delta"
        ? "delta"
        : (opts.metricTemporality ?? DEFAULTS.metricTemporality);

  const filteredTools = new Set(
    env.OTEL_OPENCODE_FILTERED_TOOLS !== undefined
      ? stringList(env.OTEL_OPENCODE_FILTERED_TOOLS)
      : stringList(opts.filteredTools)
  );

  // Resolve the source first, then normalise based on *its* own type — see
  // `parseCommand` for why keying the split on anything else is a trap.
  const tokenCommand = parseCommand(env.OPENCODE_OTEL_TOKEN_COMMAND ?? opts.tokenCommand);

  const enabledSignals = SIGNALS.filter((s) => exporters[s] !== "none");

  return {
    enabled,
    active: enabled && enabledSignals.length > 0,
    endpoint,
    endpoints,
    headers,
    tokenCommand,
    tokenHeader: env.OPENCODE_OTEL_TOKEN_HEADER || opts.tokenHeader || "Authorization",
    tokenPrefix: env.OPENCODE_OTEL_TOKEN_PREFIX ?? opts.tokenPrefix ?? "Bearer ",
    tokenRefreshMs:
      parsePositiveInt(env.OPENCODE_OTEL_TOKEN_REFRESH_MS) ??
      (opts.tokenRefreshMs && opts.tokenRefreshMs > 0 ? opts.tokenRefreshMs : DEFAULT_REFRESH_MS),
    tokenTimeoutMs:
      parsePositiveInt(env.OPENCODE_OTEL_TOKEN_TIMEOUT_MS) ??
      (opts.tokenTimeoutMs && opts.tokenTimeoutMs > 0 ? opts.tokenTimeoutMs : 10_000),
    exporters,
    serviceName: env.OTEL_SERVICE_NAME || opts.serviceName || DEFAULTS.serviceName,
    environment: env.OPENCODE_OTEL_ENVIRONMENT || opts.environment || undefined,
    resourceAttributes,
    metricExportIntervalMs:
      parsePositiveInt(firstDefined(env, SIGNAL_ENV.metrics.interval)) ??
      (opts.metricExportIntervalMs && opts.metricExportIntervalMs > 0
        ? opts.metricExportIntervalMs
        : DEFAULTS.metricExportIntervalMs),
    logExportIntervalMs:
      parsePositiveInt(firstDefined(env, SIGNAL_ENV.logs.interval)) ??
      (opts.logExportIntervalMs && opts.logExportIntervalMs > 0
        ? opts.logExportIntervalMs
        : DEFAULTS.logExportIntervalMs),
    traceExportIntervalMs:
      parsePositiveInt(firstDefined(env, SIGNAL_ENV.traces.interval)) ??
      (opts.traceExportIntervalMs && opts.traceExportIntervalMs > 0
        ? opts.traceExportIntervalMs
        : DEFAULTS.traceExportIntervalMs),
    metricTemporality: temporality,
    includeSessionId:
      parseBool(env.OTEL_METRICS_INCLUDE_SESSION_ID) ?? opts.includeSessionId === true,
    filteredTools,
    propagateTraceContext:
      parseBool(env.OPENCODE_OTEL_PROPAGATE_TRACE_CONTEXT) ??
      (opts.propagateTraceContext !== false && exporters.traces !== "none")
  };
}

/**
 * Resolve the OTLP URL for one signal. A per-signal endpoint is used verbatim
 * (spec: it already includes the path); the base endpoint gets the signal path
 * appended.
 */
export function signalUrl(config: ResolvedOtelConfig, signal: SignalName): string | undefined {
  const explicit = config.endpoints[signal];
  if (explicit) {
    return explicit;
  }
  if (!config.endpoint) {
    return undefined;
  }
  const base = config.endpoint.replace(/\/+$/, "");
  const path = signal === "traces" ? "v1/traces" : signal === "metrics" ? "v1/metrics" : "v1/logs";
  return `${base}/${path}`;
}
