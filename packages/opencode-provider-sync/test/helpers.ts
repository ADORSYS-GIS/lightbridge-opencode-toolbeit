import type { Logger } from "@vymalo/opencode-auth-core/lib";
import type { ProviderServerConfig } from "../src/engine.js";

export function createSilentLogger(): Logger {
  return {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

export function createServerConfig(
  overrides: Partial<ProviderServerConfig> = {}
): ProviderServerConfig {
  return {
    id: "example-ai",
    name: "Example AI",
    issuer: "https://auth.example.com",
    baseURL: "https://api.example.com/v1",
    clientId: "opencode-client",
    scopes: ["openid", "profile", "offline_access"],
    syncIntervalMinutes: 60,
    nameOverrides: {},
    authorizationEndpoint: "https://auth.example.com/oauth/authorize",
    tokenEndpoint: "https://auth.example.com/oauth/token",
    jwksUri: "https://auth.example.com/.well-known/jwks.json",
    authFlow: "authorization_code",
    ...overrides
  };
}
