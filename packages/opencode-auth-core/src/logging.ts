export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 5,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

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
    if (/token|secret|password/i.test(key)) {
      redacted[key] = "[redacted]";
      continue;
    }
    redacted[key] = value;
  }

  return redacted;
}

export function createJsonConsoleLogger(minLevel: LogLevel = "info"): Logger {
  const minPriority = LOG_LEVEL_PRIORITY[minLevel];

  const log = (level: LogLevel, event: string, fields?: LogFields): void => {
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
    trace(event, fields) {
      log("trace", event, fields);
    },
    debug(event, fields) {
      log("debug", event, fields);
    },
    info(event, fields) {
      log("info", event, fields);
    },
    warn(event, fields) {
      log("warn", event, fields);
    },
    error(event, fields) {
      log("error", event, fields);
    }
  };
}
