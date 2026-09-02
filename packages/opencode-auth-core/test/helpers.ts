import type { AuthServerConfig } from "../src/config.js";
import type { Logger } from "../src/logging.js";

export function createSilentLogger(): Logger {
  return {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

export function createServerConfig(overrides: Partial<AuthServerConfig> = {}): AuthServerConfig {
  return {
    id: "example-ai",
    issuer: "https://auth.example.com",
    clientId: "opencode-client",
    scopes: ["openid", "profile", "offline_access"],
    authorizationEndpoint: "https://auth.example.com/oauth/authorize",
    tokenEndpoint: "https://auth.example.com/oauth/token",
    jwksUri: "https://auth.example.com/.well-known/jwks.json",
    authFlow: "authorization_code",
    ...overrides
  };
}

export interface RecordedLogEvent {
  level: "trace" | "debug" | "info" | "warn" | "error";
  event: string;
  fields?: Record<string, unknown>;
}

export interface RecordingLogger {
  logger: Logger;
  events: RecordedLogEvent[];
  eventNames(): string[];
}

/**
 * Logger that records every structured event instead of printing it, so tests
 * can assert on the coordination events (`token_lock_wait`, …) the runtime
 * emits.
 */
export function createRecordingLogger(): RecordingLogger {
  const events: RecordedLogEvent[] = [];
  const record =
    (level: RecordedLogEvent["level"]) =>
    (event: string, fields?: Record<string, unknown>): void => {
      events.push({ level, event, fields });
    };

  return {
    events,
    eventNames: () => events.map((entry) => entry.event),
    logger: {
      trace: record("trace"),
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error")
    }
  };
}
