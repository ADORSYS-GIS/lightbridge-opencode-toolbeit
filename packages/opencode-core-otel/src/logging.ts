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

export function fromOpenCodeLogLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  switch (value.toUpperCase()) {
    case "DEBUG":
      // Host DEBUG unlocks our most-verbose internal tier (trace).
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
