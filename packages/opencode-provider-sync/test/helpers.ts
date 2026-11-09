import type { Logger } from "@vymalo/opencode-auth-core/lib";
import type { ServerStateStore } from "../src/cache.js";
import type { ProviderServerConfig } from "../src/engine.js";
import type { CachedServerState } from "../src/types.js";

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

/**
 * Test seeding only: writes both records the way a finished login + sync would.
 * Production code never writes the credential from the model path.
 */
export async function seedServerState(
  store: ServerStateStore,
  state: CachedServerState
): Promise<void> {
  if (state.token) {
    await store.credentials.save(state.serverId, state.token, state.updatedAt);
  }
  await store.models.save(state);
}
