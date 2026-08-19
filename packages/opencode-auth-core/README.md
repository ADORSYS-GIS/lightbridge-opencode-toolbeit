# @vymalo/opencode-auth-core

Shared OAuth2/OIDC auth core for the @vymalo OpenCode plugin suite. Holds the
security-critical token machinery in **one place** so plugins like
[`@vymalo/opencode-oauth2`](../opencode-oauth2) and the upcoming
`@vymalo/opencode-repo-auth` can share it instead of forking it.

> Extracted from `@vymalo/opencode-oauth2` (see Epic #64 / ticket #66).

## What it provides

- `oauth/*` — the five OAuth flows: authorization_code (PKCE), device_code,
  client_credentials, jwt_bearer, and **token exchange** (RFC 8693).
- `TokenRuntime` — identity-keyed `ensure` / `refresh` / `exchangeToAudience` /
  `getCached` / `reset`, backed by a persistent file cache.
- `cache.ts` — identity-keyed, atomic-write `FileCacheStore` + `resolveCacheDir`.
- `logging.ts` — structured logger with secret redaction.
- `config.ts` — auth-server config primitives (`AuthServerConfig`,
  `SubjectTokenSource`, flow types, validator) — deliberately model-free.
- token types (`TokenSet`).

## Usage

```ts
import { TokenRuntime } from "@vymalo/opencode-auth-core";

const runtime = new TokenRuntime("my-identity", {
  id: "my-identity",
  issuer: "https://idp.example",
  clientId: "opencode-cli",
  scopes: ["openid"],
  authFlow: "device_code"
});

const token = await runtime.ensure(); // refresh / login as needed
```

For the full surface (flows, validators, cache) import from
`@vymalo/opencode-auth-core/lib`.

## Development

```bash
pnpm --filter @vymalo/opencode-auth-core build
pnpm --filter @vymalo/opencode-auth-core typecheck
pnpm --filter @vymalo/opencode-auth-core test
pnpm --filter @vymalo/opencode-auth-core coverage
```
