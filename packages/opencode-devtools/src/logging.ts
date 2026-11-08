import { type Context as EffectContext, Effect } from "effect";

import type { LogLevel } from "./types.js";

export type { LogLevel } from "./types.js";

export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 5,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  trace(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

function redactFields(fields?: LogFields): LogFields | undefined {
  if (!fields) {
    return undefined;
  }
  const redacted: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/token|secret|password|authorization/i.test(key)) {
      redacted[key] = "[redacted]";
      continue;
    }
    redacted[key] = value;
  }
  return redacted;
}

export function createJsonConsoleLogger(minLevel: LogLevel = DEFAULT_LOG_LEVEL): Logger {
  const minPriority = LOG_LEVEL_PRIORITY[minLevel];

  const write = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (LOG_LEVEL_PRIORITY[level] < minPriority) {
      return;
    }
    const payload = {
      ts: new Date().toISOString(),
      level,
      event,
      ...(redactFields(fields) ?? {})
    };
    const line = JSON.stringify(payload);
    if (level === "error") {
      console.error(line);
      return;
    }
    if (level === "warn") {
      console.warn(line);
      return;
    }
    console.log(line);
  };

  return {
    trace: (event, fields) => write("trace", event, fields),
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields)
  };
}

/**
 * Capture the host's Effect context from inside the plugin's own fiber. The
 * returned value is what {@link createEffectLogger} needs to put a log record
 * on the host's logger rather than on a default one.
 *
 * OpenCode installs its file logger as a `Logger.layer(...)` on the runtime
 * that runs plugin setup, and Effect carries loggers as fiber-level references
 * — so the context captured here is the only route to that sink. A bare
 * `Effect.runFork` would log to Effect's default logger (the terminal) instead,
 * which is exactly what ADR-0014 forbids.
 */
export const captureHostContext: Effect.Effect<EffectContext.Context<never>> = Effect.withFiber(
  (fiber) => Effect.succeed(fiber.context)
);

/**
 * Structured logger that writes through the host's Effect logger — the v2
 * replacement for v1's `client.app.log`.
 *
 * ADR-0014 (no plugin writes to the user's TUI) is preserved: OpenCode's own
 * logger is a `Logger.toFile` sink over the shared `opencode-<channel>.log`,
 * so records land in the host log stream and never on the terminal. The event
 * name becomes the log message and `fields` become log annotations, which
 * OpenCode's logfmt formatter flattens to `key=value` — the same shape the v1
 * `extra` payload produced.
 *
 * Host-side severity filtering is Effect's job (`OPENCODE_LOG_LEVEL`); the
 * `getMinLevel` gate here is only this plugin's own `logLevel` option, applied
 * before the record is built so a filtered-out call costs nothing.
 */
export function createEffectLogger(
  context: EffectContext.Context<never>,
  getMinLevel: () => LogLevel
): Logger {
  // `VYMALO_PLUGIN_CONSOLE_LOG=1` mirrors to stdout for local debugging. Off by
  // default precisely because stdout is the user's terminal (ADR-0014).
  const consoleAll = /^(1|true|yes|on)$/i.test(process.env.VYMALO_PLUGIN_CONSOLE_LOG ?? "");
  const fallback = createJsonConsoleLogger("trace");

  const write = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[getMinLevel()]) {
      return;
    }
    if (consoleAll) {
      fallback[level](event, fields);
    }

    const redacted = redactFields(fields);
    // Effect has no `trace` severity below `debug`; fold the most-verbose tier
    // onto debug, as the v1 adapter did for the host log API.
    const record =
      level === "trace"
        ? Effect.logDebug(event)
        : level === "debug"
          ? Effect.logDebug(event)
          : level === "info"
            ? Effect.logInfo(event)
            : level === "warn"
              ? Effect.logWarning(event)
              : Effect.logError(event);

    const annotated = redacted ? Effect.annotateLogs(record, redacted) : record;
    Effect.runFork(Effect.provideContext(annotated, context));
  };

  return {
    trace: (event, fields) => write("trace", event, fields),
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields)
  };
}

/**
 * Resolve this plugin's log level from its own `logLevel` option, falling back
 * to the host's `OPENCODE_LOG_LEVEL` env var. v2 gives plugins no `config`
 * object, so the v1 `config.logLevel` channel is gone.
 */
export function resolveLogLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  switch (value.toUpperCase()) {
    // DEBUG unlocks the most-verbose `trace` tier (host has no finer level).
    case "DEBUG":
      return "trace";
    case "TRACE":
      return "trace";
    case "INFO":
      return "info";
    case "WARN":
      return "warn";
    case "ERROR":
      return "error";
    default:
      return undefined;
  }
}
