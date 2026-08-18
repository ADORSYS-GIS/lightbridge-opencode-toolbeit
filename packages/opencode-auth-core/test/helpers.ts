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
