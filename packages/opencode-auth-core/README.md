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
- `lock.ts` — `acquireFileLock`, the `O_EXCL` advisory lock the refresh path
  serializes on across processes.
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

## Refresh coordination

An IdP with single-use rotating refresh tokens and reuse detection (RFC 6819
§5.2.2.3) revokes the **whole chain** when an already-rotated refresh token is
replayed, so two OpenCode processes each refreshing from their own copy log
both of them out. `TokenRuntime.ensure` therefore coordinates the refresh:

- **Single-flight** — concurrent `ensure()` calls on one runtime share one
  in-flight refresh, so ten callers present the refresh token once.
- **Cross-process lock** — the refresh runs under an advisory lock file
  (`<cacheDir>/locks/<identity>.lock`, `open(path, "wx")`) so processes sharing
  a cache directory take turns. The valid-cached-token fast path never touches
  it. A lock older than `lockStaleMs` is treated as abandoned and broken; if
  the lock directory cannot be created or written the runtime logs
  `token_lock_unavailable` once and proceeds **without** the lock — an
  unwritable filesystem must never become a permanent auth outage.
- **Re-read** — inside the lock the cache is read again (`getCached`, which for
  the default file store is a real disk read, and for an override is whatever
  that override re-reads). A token another process persisted meanwhile is
  adopted as-is, with no call to the IdP.
- **Retry on refusal** — a 4xx from the token endpoint (`RefreshTokenError`,
  which carries the HTTP `status`) triggers one more re-read: a newer valid
  access token is adopted, a newer refresh token is retried exactly once, and
  only if neither exists does the runtime fall through to interactive login.
  A refresh token that was already presented is never presented twice.

Options: `lockStaleMs` (default `30_000`; must exceed `timeoutMs`, the refresh's
own HTTP timeout, default `15_000`). The total lock wait is bounded at
`lockStaleMs + 5s`, after which the runtime proceeds unlocked rather than
hanging the request.

Events (structured, snake_case, never carrying token material):
`token_refresh_joined_in_flight`, `token_refresh_adopted_persisted`,
`token_refresh_retry_with_newer`, `token_refresh_retry_failed`,
`token_lock_wait`, `token_lock_stale_broken`, `token_lock_unavailable`.

`refresh()` and the `exchange*` / `getExchanged*` methods are unchanged: they
address a different key space and deliberately do not share the `ensure`
single-flight slot.

## Development

```bash
pnpm --filter @vymalo/opencode-auth-core build
pnpm --filter @vymalo/opencode-auth-core typecheck
pnpm --filter @vymalo/opencode-auth-core test
pnpm --filter @vymalo/opencode-auth-core coverage
```
