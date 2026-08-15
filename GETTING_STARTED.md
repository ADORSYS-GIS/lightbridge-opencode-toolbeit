# Getting Started

This guide shows how to run the plugin locally with OpenCode.

## Prerequisites

- Node.js `22+`
- `pnpm`
- OpenCode CLI installed
- An OAuth2/OIDC provider that:
- supports Authorization Code + PKCE (or the RFC 8628 device authorization grant for headless setups)
- returns a `refresh_token`
- exposes an OpenAI-compatible models endpoint at `{baseURL}/v1/models`

## 1. Build The Plugin

From repo root:

```bash
pnpm install
pnpm --filter @vymalo/opencode-oauth2 build
```

## 2. Register It In OpenCode (Local Plugin Mode)

Create a local OpenCode plugin file in your target project:

`<your-project>/.opencode/plugins/opencode-oauth2.ts`

```ts
import LightbridgeOAuth2ModelSyncPlugin from "/absolute/path/to/opencode-oauth2/packages/opencode-oauth2/dist/index.js";

export default LightbridgeOAuth2ModelSyncPlugin;
```

Use an absolute path to this repository on your machine.

## 3. Configure OpenCode Provider

In your project `opencode.json`, add provider configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "example-ai": {
      "name": "Example AI",
      "options": {
        "baseURL": "https://api.example.com/v1",
        "oauth2": {
          "issuer": "https://auth.example.com",
          "clientId": "opencode-client",
          "scopes": ["openid", "profile", "offline_access"],
          "syncIntervalMinutes": 60,
          "nameOverrides": {
            "glm-5": "GLM 5"
          }
        }
      }
    }
  }
}
```

### Optional fields

- `clientSecret` — for confidential clients; sent with every token POST. Never logged. PKCE still applies.
- `authFlow` — `"authorization_code"` (default) or `"device_code"` for browserless setups (e.g., SSH/CI).
- `deviceAuthorizationEndpoint` — override; otherwise discovered from the OIDC metadata.

## 4. Start OpenCode

Run OpenCode in the project:

```bash
opencode
```

On first use of the configured provider:

- browser opens for OAuth login
- callback is handled locally by the plugin
- model list is fetched and normalized
- bearer token is injected on model requests

## 5. Verify It Works

- Run `/models` and confirm your provider appears.
- Select a discovered model and send a prompt.
- Confirm model names are normalized (`glm-5` -> `GLM 5`).

## Token Requirement

Refresh token support is mandatory:

- access-only OAuth tokens are rejected
- cached tokens without `refreshToken` are ignored
- refresh flow preserves old refresh token if the refresh response omits it

## Useful Commands

```bash
pnpm --filter @vymalo/opencode-oauth2 typecheck
pnpm --filter @vymalo/opencode-oauth2 test
pnpm --filter @vymalo/opencode-oauth2 build
```

## Companion plugins

This workspace ships more **auth-agnostic** plugins you can stack on the same provider (they compose with oauth2, static API keys, or no auth):

- [`@vymalo/opencode-models-info`](packages/opencode-models-info/README.md) — enrich models with context length, pricing, modalities, and capability flags from a metadata endpoint.
- [`@vymalo/opencode-ratelimit`](packages/opencode-ratelimit/README.md) — read the gateway's `x-ratelimit-*` headers and proactively throttle / back off on 429 (with reset-magnitude `tiers` and per-model `scope`).
- [`@vymalo/opencode-otel`](packages/opencode-otel/README.md) — export what the session is doing and costing as OTLP traces, metrics and logs (real USD cost, all five token types, tool results, errors). Inert until an endpoint is configured. See [`docs/otel.md`](docs/otel.md).

Recommended `plugin` order: `@vymalo/opencode-oauth2` → `@vymalo/opencode-models-info` → `@vymalo/opencode-ratelimit`. See the [root README](README.md#-stacking-the-belt) for a combined config example.

