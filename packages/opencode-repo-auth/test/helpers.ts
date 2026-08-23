import type { Logger } from "@vymalo/opencode-auth-core/lib";

import type { RepoAuthConfig } from "../src/config.js";

export function createSilentLogger(): Logger {
  return {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

export function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export function createRepoAuthConfig(overrides: Partial<RepoAuthConfig> = {}): RepoAuthConfig {
  return {
    projectId: "proj-123",
    auth: {
      id: "repo-auth",
      issuer: "https://idp.example.com/realms/acme",
      clientId: "opencode-cli",
      scopes: ["openid", "offline_access"],
      authFlow: "device_code",
      tokenEndpoint: "https://idp.example.com/realms/acme/protocol/openid-connect/token",
      deviceAuthorizationEndpoint:
        "https://idp.example.com/realms/acme/protocol/openid-connect/auth/device",
      pkce: false
    },
    ...overrides
  };
}
