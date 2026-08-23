import type { Logger } from "@vymalo/opencode-auth-core/lib";
import type { AuthServerConfigInput } from "@vymalo/opencode-auth-core/lib";

export function createSilentLogger(): Logger {
  return {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

export interface RecordingLogger extends Logger {
  events: Array<{ level: string; event: string; fields?: unknown }>;
}

export function createRecordingLogger(): RecordingLogger {
  const events: RecordingLogger["events"] = [];
  const log = (level: string) => (event: string, fields?: unknown) => {
    events.push({ level, event, fields });
  };
  return {
    events,
    trace: log("trace"),
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error")
  };
}

export function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export function makeAuth(overrides: Partial<AuthServerConfigInput> = {}): AuthServerConfigInput {
  return {
    id: "lightbridge",
    issuer: "https://authz.example.com/realms/lightbridge",
    clientId: "opencode-cli",
    scopes: ["openid", "offline_access"],
    authFlow: "device_code",
    tokenEndpoint: "https://authz.example.com/realms/lightbridge/protocol/openid-connect/token",
    deviceAuthorizationEndpoint:
      "https://authz.example.com/realms/lightbridge/protocol/openid-connect/auth/device",
    pkce: false,
    ...overrides
  };
}
