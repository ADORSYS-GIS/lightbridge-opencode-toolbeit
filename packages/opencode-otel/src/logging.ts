import { type Context as EffectContext, Effect } from "effect";

import {
  createJsonConsoleLogger,
  fromOpenCodeLogLevel,
  type LogFields,
  LOG_LEVEL_PRIORITY,
  type Logger,
  type LogLevel
} from "@vymalo/opencode-core-otel";

/**
 * Resolve a log level from a `logLevel` option / `OPENCODE_LOG_LEVEL` value.
 * v2 gives plugins no `config` object, so the v1 `config.logLevel` channel is
 * gone: callers read this plugin's own option first, then the host env var.
 */
export const resolveLogLevel: (value: unknown) => LogLevel | undefined = fromOpenCodeLogLevel;

function redactFields(fields?: LogFields): LogFields | undefined {
  if (!fields) {
    return undefined;
  }
  const redacted: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    redacted[key] = /token|secret|password|authorization/i.test(key) ? "[redacted]" : value;
  }
  return redacted;
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
 * This is the plugin's *own* diagnostic logging, entirely separate from the
 * OTLP logs signal it exports. ADR-0014 (no plugin writes to the user's TUI) is
 * preserved: OpenCode's own logger is a `Logger.toFile` sink, so records land in
 * the host log stream and never on the terminal — which also keeps ADR-0013's
 * guarantee that a telemetry exporter never interrupts the work it observes
 * with terminal output (ADR-0013 itself is superseded by ADR-0014). The event
 * name becomes the log message and `fields` become log annotations.
 * `VYMALO_PLUGIN_CONSOLE_LOG=1` opts back into a console mirror for local debugging.
 */
export function createEffectLogger(
  context: EffectContext.Context<never>,
  getMinLevel: () => LogLevel
): Logger {
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
    // Effect has no `trace` severity below `debug`; fold the most-verbose tier onto debug.
    const record =
      level === "trace" || level === "debug"
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

export { DEFAULT_LOG_LEVEL } from "@vymalo/opencode-core-otel";
