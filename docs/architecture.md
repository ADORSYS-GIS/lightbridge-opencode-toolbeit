# Architecture

How `@vymalo/opencode-oauth2` actually runs inside OpenCode: what each hook does, how tokens move through the system, where they live on disk, and what to expect when something fails.

If you just want to copy YAML, jump to the [GitHub Actions](./github-actions.md) or [Kubernetes](./kubernetes.md) cookbooks. This page is for the adopter who needs to reason about failure modes.

> The workspace also ships several other independent plugins — most notably
> [`@vymalo/opencode-models-info`](./models-info.md), which enriches model
> metadata after auth is resolved, and [`@vymalo/opencode-otel`](./otel.md),
> the suite's only *observer*. Each is documented separately; this page
> covers the oauth2 plugin in depth, plus the one place oauth2 and
> models-info intersect (the [bearer propagation](#providertransform--registration-and-bearer-propagation)
> in step 5 below). otel's hook usage gets its own canonical account in
> [its section below](#vymaloopencode-otel--the-only-observer), since it is
> the one plugin in the suite whose registration surface rivals oauth2's in breadth.

> **[ADR-0016](adr/0016-provider-sync-extraction.md) (2026-09-04):** the model-sync engine this
> page describes — `OAuth2ModelSyncPlugin`, its cache, model discovery/normalization, and the
> sync scheduler — now lives in `@vymalo/opencode-provider-sync` (`ProviderModelSyncEngine`
> underneath; `opencode-oauth2`'s `OAuth2ModelSyncPlugin` is a thin subclass), extracted so
> `@vymalo/opencode-lightbridge` can compose it in a follow-up PR instead of forking it. This is a
> pure code-motion with **no behaviour change** — everything below still describes oauth2's actual
> runtime behavior accurately; only the file paths cited for `cache.ts` and `scheduler.ts` moved.
> See [`docs/provider-sync.md`](provider-sync.md) for the extracted package itself.

> **OpenCode v2.** oauth2 registers against three v2 seams, described in [the next section](#the-three-registrations):
> `ctx.provider.transform` (registration, model merge, bearer propagation — synchronous; the engine
> build and warmup run in a background queue that calls `ctx.provider.reload()`),
> `ctx.session.hook("model.request")` (per-request bearer) and `ctx.session.hook("http.response")`
> (the Responses-SSE repair). Servers come from `ctx.options.servers`; the per-provider block is
> `settings.oauth2`. Token handling, the cache and all five auth flows are unchanged
> ([ADR-0020](adr/0020-oauth2-integration-domain.md)).
>
> **Behaviour changes in v2.** (1) Invalid user config (bad `redirectPort`, unknown `authFlow`,
> non-boolean `responseApi`) no longer rejects plugin load: the plugin logs `oauth2_config_invalid`
> at `error` and manages no providers, so a typo yields a *missing provider* rather than a loud
> failure. Search the host log for `oauth2_config_invalid`. (2) Startup no longer blocks on warmup:
> the runtime builds in the background and `provider.reload()` fills in models, so the first login
> prompt appears after the UI is up. `options.{cacheNamespace,httpTimeoutMs,tokenExpirySkewMs}`
> configure the engine as `pluginConfig.oauth2ModelSync` did.

## The three registrations

The plugin registers exactly three things with the OpenCode v2 host (`Plugin.define({ id: "vymalo.oauth2", effect })`): a provider transform, a `model.request` session hook and an `http.response` session hook. Source: [`packages/opencode-oauth2/src/opencode.ts`](../packages/opencode-oauth2/src/opencode.ts).

### `provider.transform` — registration and bearer propagation

Runs whenever the host (re)assembles providers: at load and after every `ctx.provider.reload()`. It is **synchronous and cheap by contract** — nothing in it awaits. Everything slow happens in a serialised background build the transform merely schedules (step 4).

1. **Collect the managed providers.** `collectManagedProviders(editor, ctx.options, …)` walks the provider records for a `settings.oauth2` / `settings.oauth2ModelSync` block (per-provider, recommended) and merges in the plugin's own `options.servers` array. Duplicates are de-duplicated by `id`; the provider-embedded block wins on conflict. An invalid config (bad `redirectPort`, unknown `authFlow`, non-boolean `responseApi`) is logged as `oauth2_config_invalid` and the plugin manages nothing rather than taking down the provider pipeline for every plugin.
2. **Register and mark.** Each managed provider is created or updated on the editor with `package: "aisdk:@ai-sdk/openai-compatible"` and `settings.baseURL`. Setting `responseApi: true` instead registers it with `aisdk:@ai-sdk/openai` — the native OpenAI provider, whose default model targets the **Responses API** (`/v1/responses`) since AI SDK v5, rather than Chat Completions. Because that native provider throws if constructed without an API key, the plugin also stamps an inert placeholder key (`oauth2-managed-bearer`) when the user hasn't set one; the real token is injected per request, so the placeholder is never sent. Every managed provider also carries a `settings.oauth2` block (`markManaged`, `opencode.ts:71`): the one the user wrote, or a `{ managed: true, source: "options.servers" }` marker for one created from `options.servers`. **That marker is how other plugins recognise an oauth2-managed provider** — they cannot see oauth2's private `ctx.options` — which is why oauth2 must be listed before lightbridge and repo-auth.
3. **Merge discovered models** (`mergeDiscoveredModels`) from the engine's cache into each provider's models. If a server has no cached models yet (cold start, non-interactive warmup, refresh-token expired), it stays empty — the user sees no models for that provider until the background build or a chat request has authenticated.
4. **Schedule the build.** When the managed-server signature changes, the transform queues `applyServers`: build the `OAuth2ModelSyncPlugin`, `initialize()` (load cache), `start({ warmup: true })` (warmup iterates servers, attempts `syncServer(id, { interactive: <TTY-detected> })`, and starts a per-server scheduler, `syncIntervalMinutes`, default 60), resolve each server's cached bearer, then call **`ctx.provider.reload()`** so the transform runs again with models and bearers in hand. The first transform pass therefore registers providers with no models; startup never blocks on login. The runtime is **rebuilt** if the signature changes between passes; old schedulers are stopped first.
5. **Propagate the bearer.** For each managed provider, `propagateCachedBearer` stamps `Provider.Info.headers.Authorization = "<tokenType> <accessToken>"` — unless the user already set an `Authorization` header (case-insensitive), which always wins. The token was resolved *before* the transform, by `resolveCachedBearer`, a **refresh-only ensure** (`ensureAccessToken(id, { interactive: false })`): a valid warmed-up token is returned as-is, a near-expiry one is transparently refreshed, and anything that would need a fresh browser / device-code prompt is skipped (`oauth2_bearer_propagation_skipped_no_token`) rather than blocking startup on a second login. This makes the token visible to *later* transforms, most notably [`@vymalo/opencode-models-info`](./models-info.md) fetching an OAuth2-protected `settings.modelsInfoUrl`. It's the only coupling point between the two plugins, one-directional, via the provider record — neither plugin imports the other. A stale value here is harmless: `model.request` (below) overwrites per request with a freshly-ensured token, so the inference call is never affected. See [provider-sync.md → The `Authorization` handoff](provider-sync.md#the-authorization-handoff-to-models-info-v2-contract). Emits `oauth2_bearer_propagated_to_provider_headers` (or `oauth2_bearer_propagation_skipped_user_set` / `..._skipped_no_token`).

   > **Why refresh-only, not a raw cache read.** An earlier version stamped only if the *cached* token cleared a fixed 30s expiry skew. On a first interactive device-code login against a short-lived realm, the just-minted token could already be inside that window, so the header was never stamped and models-info fetched the metadata endpoint with no `Authorization` → HTTP 401 (`models_info_fetch_failed_no_cache`). Going through `ensureAccessToken` refreshes instead of giving up, so the downstream fetch reliably carries a usable token.

### `session.hook("model.request")` — per request

Runs before every model request. Source: same file, the `"model.request"` registration.

1. Resolve the provider id from `event.model.providerID`, after awaiting any in-flight background build (a request racing startup must not leave the provider without a bearer).
2. If the provider isn't one this plugin manages, **return without touching headers** — other providers are left alone.
3. `runtime.ensureAccessToken(providerId)` returns a fresh token (cached, refreshed, or freshly acquired).
4. Drop any `Authorization` variant already in `event.headers` (case-insensitive — the placeholder key's, a lowercase copy, the stamped record header), then set `event.headers.Authorization = "<tokenType> <accessToken>"` (default `tokenType` is `Bearer`).
5. **Opportunistic sync trigger.** If the provider has zero cached models *after* the auth call, kick off a background `syncServer(providerId)` and `ctx.provider.reload()` when models arrive. Failures are swallowed (next request retries).
6. **Fail closed.** If no usable token can be produced, the hook logs `oauth2_model_request_token_failed` and dies, so the request is refused locally rather than sent under a placeholder or stale credential.

This is the slow path: a chat request can block on the OAuth token endpoint round-trip. The fast path is the cache — once a valid access token is on disk, `ensureAccessToken` returns after a single cache read.

### `session.hook("http.response")` — Responses-SSE repair

For providers with `responseApi: true` only, it replaces `event.response` with the output of `repairResponsesResponse` ([`src/responses-repair.ts`](../packages/opencode-oauth2/src/responses-repair.ts)), which injects the `output_index` / `content_index` fields some gateways (e.g. Envoy AI Gateway) omit — without which AI-SDK/OpenCode fail to assemble the message (`text part <id> not found`). It is a no-op against a conformant gateway; only enable `responseApi` when the gateway actually implements the OpenAI Responses contract for the model in use. Emits `oauth2_provider_response_api_enabled`. (v1 did this by wrapping `provider.options.fetch`; `Provider.Info` has no such field on v2.)

### Sequence

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant OC as opencode
    participant Plugin as opencode-oauth2
    participant Cache as ~/Library/Caches/opencode-oauth2
    participant IdP as OAuth server
    participant Upstream as Provider API

    User->>OC: opencode (boot)
    OC->>Plugin: provider.transform (sync) + background build
    Plugin->>Cache: load cached state for each server
    Plugin->>OC: register provider(s) (no sync if uncached and non-TTY)
    Note over Plugin: scheduler started per server

    User->>OC: opencode run --model miaou/glm-5 "..."
    OC->>Plugin: session.hook model.request (model=miaou/glm-5)
    Plugin->>Cache: read token for "miaou"
    alt token valid
        Plugin-->>OC: Authorization: Bearer …
    else expired with refresh_token
        Plugin->>IdP: POST /token grant_type=refresh_token
        IdP-->>Plugin: new access_token
        Plugin->>Cache: save new token
        Plugin-->>OC: Authorization: Bearer …
    else no token / refresh failed
        Plugin->>IdP: flow-specific acquire (PKCE / device / JWT bearer / …)
        IdP-->>Plugin: access_token (+ maybe refresh_token)
        Plugin->>Cache: save token
        Plugin-->>OC: Authorization: Bearer …
    end
    OC->>Upstream: POST /v1/chat/completions
    Upstream-->>OC: stream completion
```

## Token lifecycle per flow

`ensureToken` (in [`src/oauth/client.ts`](../packages/opencode-oauth2/src/oauth/client.ts)) is the single dispatch point. The state machine for any cached token is:

```
isTokenValid(cached) → yes → use cached
                    ↓ no
  machine flow? → yes → re-acquire (no refresh attempt)
                ↓ no (user flow)
  cached.refreshToken? → yes → POST grant_type=refresh_token
                              ↓ ok    → use refreshed
                              ↓ fail  → fall through
                       ↓ no
  options.interactive === false → throw (warmup gives up; cached state preserved)
  authFlow=device_code → loginDeviceCode()
  default              → loginInteractive()  (browser + PKCE)
```

What each flow re-acquires:

| Flow | Re-acquire path | Interactive? | Refresh token expected? |
| --- | --- | --- | --- |
| `authorization_code` | PKCE: browser → loopback callback → code exchange | yes | **yes** (rejected without one — see [Token Policy](#tokenpolicy)) |
| `device_code` | RFC 8628: request device code → poll token endpoint | yes (user enters code in a browser; the process polls) | **yes** |
| `client_credentials` | POST `grant_type=client_credentials` with `client_secret` | no | no (not requested, not stored) |
| `jwt_bearer` | Resolve subject JWT → POST `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` | no | no |
| `token_exchange` | Resolve subject JWT → POST `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` (+ optional `audience`) | no | no |

The machine flows (`client_credentials`, `jwt_bearer`, `token_exchange`) dispatch **before** the refresh branch — re-presenting the platform identity is the canonical way to renew, so a stale refresh token from a different IdP run is never tried.

The `cached` token this state machine reads is **not** a process-local snapshot: oauth2's `getCached` override re-reads the on-disk state file on every call, so the refresh decision is always made against the last token *any* process persisted. See [Cache layout → Shared across processes](#shared-across-processes).

#### PKCE on the user flows

Both interactive flows send PKCE (RFC 7636) by default: a per-login `code_verifier` is generated, its `S256` `code_challenge` goes on the authorization request (`authorization_code`) or the device-authorization request (`device_code`), and the `code_verifier` is replayed on the token exchange / poll. This is mandatory for some IdPs — a Keycloak client with *Proof Key for Code Exchange Code Challenge Method* set rejects the request with `invalid_request: Missing parameter: code_challenge_method` if the challenge is absent, **including on the device endpoint**. Compliant servers that don't require PKCE simply ignore the extra parameters, so it's on unconditionally unless you set `pkce: false` per server (escape hatch for non-compliant IdPs that 400 on unknown parameters). The machine flows never use PKCE.

### `isTokenValid` policy

From `OAuthClient.isTokenValid`:

```ts
if (!token.expiresAt) {
  // machine flows: treat undefined expiry as INVALID (re-acquire cheap)
  // user flows:   treat undefined expiry as VALID (cost of re-auth is high)
  return !machineFlows.includes(this.server.authFlow);
}
return Date.now() + tokenExpirySkewMs < token.expiresAt;
```

`tokenExpirySkewMs` defaults to `30_000`. A token expiring in less than 30 seconds is treated as already expired, leaving headroom for the upstream round-trip.

Why the split: `expires_in` is optional in the OAuth spec. If your IdP omits it for `client_credentials`, the plugin doesn't know when the server's idea of the token expires — re-issuing one is a single POST, so we do that. For interactive flows (`authorization_code`, `device_code`), the cost is a browser dance, so we keep the older behavior: assume the cached token is still good until something explicitly fails (a 401 from upstream would surface as a chat error, prompting the user to reset auth manually).

## TTY-aware warmup

`OAuth2ModelSyncPlugin.start({ warmup, interactive })`:

```ts
const interactiveWarmup =
  options.interactive ?? Boolean(process.stdin?.isTTY && process.stdout?.isTTY);
```

Why: warmup at startup attempts a `syncServer` on every configured server. For uncached `authorization_code` / `device_code` providers, that would try to open a browser or block on device-code polling. In CI or a daemonized run, both stdin and stdout aren't TTYs — so the default falls back to non-interactive, the warmup throws "interactive authentication required", `syncServer` catches the error and preserves cached state. The provider stays in the OpenCode config with whatever models were cached previously (none on cold start).

When a chat request arrives later, the `model.request` hook calls `ensureAccessToken` (with no `interactive` option, so it defaults to interactive in `OAuthClient.ensureToken`), and on-demand auth runs.

Override when you know better:

- **`interactive: true`** when running under a process supervisor that doesn't expose a TTY but you do want first-run auth to attempt (rare).
- **`interactive: false`** in CI even on a runner that happens to allocate a pseudo-TTY (some self-hosted runners do) — guarantees no hang on a callback that nobody is going to complete.

`start({ warmup: true })` is called from the plugin's background build with default options; you only override by constructing the runtime yourself (e.g. embedding `OAuth2ModelSyncPlugin` outside OpenCode).

## Cache layout

Source: [`src/cache.ts`](../packages/opencode-provider-sync/src/cache.ts) (the `FileCacheStore` implementation and `resolveCacheDir`, `@vymalo/opencode-provider-sync` since ADR-0016) — oauth2's own [`src/cache.ts`](../packages/opencode-oauth2/src/cache.ts) is now a thin wrapper binding the `"opencode-oauth2"` on-disk segment shown in the table below.

### Directory

| OS | Path |
| --- | --- |
| macOS | `~/Library/Caches/opencode-oauth2/<cacheNamespace>/` |
| Linux | `${XDG_CACHE_HOME:-~/.cache}/opencode-oauth2/<cacheNamespace>/` |
| Windows | `${LOCALAPPDATA:-~/AppData/Local}/opencode-oauth2/<cacheNamespace>/` |

OpenCode-managed runtimes use `cacheNamespace = "opencode-oauth2-model-sync"` (hard-coded in `opencode.ts`); standalone embedders default to `"oauth2-model-sync"` (`validateConfig` default).

Directories are created with `0o700`; cache files with `0o600`. Writes are atomic (write to `.tmp`, then `rename`).

### File shape

One file per server, named `<serverId>.json`:

```json
{
  "serverId": "miaou",
  "updatedAt": 1737000000000,
  "lastSyncAt": 1737000000000,
  "token": {
    "accessToken": "eyJ...",
    "tokenType": "Bearer",
    "refreshToken": "eyJ...",
    "scope": "openid profile",
    "expiresAt": 1737003600000
  },
  "rawModels": [{ "id": "glm-5", "object": "model" }],
  "models": [{ "id": "glm-5", "displayName": "GLM 5" }]
}
```

`token.refreshToken` is **optional** in the file shape — `client_credentials` doesn't issue one. `accessToken` and `tokenType` are required; anything missing those gets the entire `token` field evicted on load (see `hasValidTokenShape`). `models` / `rawModels` survive eviction so a stale-but-known model list stays in OpenCode while re-auth happens.

### Shared across processes

Several OpenCode processes (several project windows, a CLI run alongside the desktop app) share **one** `<serverId>.json`, and a refresh token is single-use: after a rotation only the process that performed it holds a usable chain. So the state file — not the in-memory copy loaded at `initialize()` — is the source of truth, and `OAuth2ModelSyncPlugin.readCachedToken` **re-reads it on every cached-token read**, i.e. before every refresh decision, on the warmup path, the scheduler path and the per-request `model.request` path alike.

The adoption rule, in one line: **the persisted state wins unless memory is strictly newer** (`persisted.updatedAt >= runtime.state.updatedAt`), and it is adopted *wholesale* — token, `models`, `rawModels`, `lastSyncAt` together, since the file is one consistent snapshot and a field-by-field merge would pair one process's token with another's model list. Memory is kept when the file is missing, unreadable, invalid, strictly older, or carries no `token` at all (a tokenless file can't be more authoritative about a token it doesn't have, and honouring it would force a needless interactive re-login). Writes are unchanged: `setCached` and `syncServer` both build the next snapshot from the *current* in-memory state, so a write never rolls back a snapshot just adopted from disk.

Without this, process B kept serving its boot-time copy, replayed a refresh token process A had already rotated, and the IdP's reuse detection revoked the whole chain — logging **both** processes out ([#104](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/issues/104)).

Re-reading is all this plugin does. Coordinating the refresh itself — single-flight within a process, a cross-process lock, re-reading inside that lock, and the retry when the IdP answers `400` because another process rotated first — belongs to `TokenRuntime` in `@vymalo/opencode-auth-core`. The two halves are complementary: the lock is pointless if the holder then refreshes from a stale in-memory token, and the re-read alone still lets two processes race into a refresh.

Two `trace`/`debug` events make this visible in the log stream (never the token itself): `oauth2_token_adopted_from_cache` when a re-read yields a token different from memory, plus `oauth2_cache_reread_stale` / `oauth2_cache_reread_no_persisted_token` / `oauth2_cache_reread_failed` for the memory-wins branches.

> **[ADR-0017](adr/0017-lightbridge-all-in-one.md) (2026-09-04):** `@vymalo/opencode-lightbridge`'s
> human root token now lives in **this exact file** (`<serverId>.json`, keyed by `auth.id`) instead
> of its own bespoke store — so a developer who configures the same IdP (matching `id`/`issuer`/
> `clientId`) in both `opencode-oauth2` and lightbridge's `auth`/`register` blocks logs in **once**.
> lightbridge participates as a read/refresh-only client of the same `FileCacheStore` (via
> `LightbridgeRuntime`'s own lightweight `TokenRuntime`, not a second `ProviderModelSyncEngine`
> instance for that purpose) unless its `register` block is configured, in which case it runs a real
> `ProviderModelSyncEngine` of its own — guarded against colliding with an oauth2-managed id by the
> scheduler-ownership registry described in [Sync scheduler](#sync-scheduler) below. See
> [`docs/lightbridge.md`](lightbridge.md#register-provider-registration--model-discovery-adr-0017)
> for the consumer-facing contract and the mandatory old-cache migration.

### Eviction

The plugin never rotates the cache file itself — it overwrites in place. To force re-auth:

```sh
# remove just one server's cached state
rm ~/Library/Caches/opencode-oauth2/opencode-oauth2-model-sync/miaou.json

# nuke everything (all servers, all namespaces)
rm -rf ~/Library/Caches/opencode-oauth2/
```

After deletion, the next `model.request` (or warmup) triggers a fresh acquire. See [local development](./local-development.md#force-reauth) for when you need this.

## Sync scheduler

Source: [`src/scheduler.ts`](../packages/opencode-provider-sync/src/scheduler.ts) (moved to `@vymalo/opencode-provider-sync` unchanged, ADR-0016), driven from `ProviderModelSyncEngine.start` (`OAuth2ModelSyncPlugin`'s superclass — oauth2's own class is now a thin subclass over it).

- One scheduler per server. Interval is `server.syncIntervalMinutes * 60_000` ms; default 60 minutes.
- Each tick calls `syncServer(serverId)` — same path warmup uses, but with no `interactive` override (so it inherits the default behavior of `ensureToken`).
- **Failure handling.** `syncServer` catches every error, logs `sync_failed`, and **does not mutate runtime state**. The previously cached models stay available to OpenCode; the next interval retries.
- If a sync succeeds with a different model set, the cache is updated and OpenCode sees the new models on the next `provider.transform` pass (the engine calls `ctx.provider.reload()` when a sync changed the model set; a lazy sync triggered from `model.request` does the same).

You don't normally want to disable the scheduler (there's no setting for it). If the upstream catalog is static, the scheduler is cheap — a `/models` GET every hour.

> **[ADR-0017](adr/0017-lightbridge-all-in-one.md):** since `@vymalo/opencode-lightbridge` can now
> also run a `ProviderModelSyncEngine` of its own (its `register` block), TWO engine instances in
> **one process** targeting the same cache directory + server id is a real (if narrow) possibility —
> a failure mode the cross-process re-read logic above was never designed for (it assumes the other
> writer is a different OS process). `ProviderModelSyncEngine.start()` now claims a process-wide,
> in-memory ownership token keyed by `<cacheDir, serverId>` before running its warmup sync +
> scheduler; a second instance that loses the claim skips both (logged once at `debug`,
> `sync_scheduler_ownership_skipped`) and falls back to serving cached reads +
> on-demand `ensureAccessToken`/`syncServer` calls, which were already safe to run concurrently.
> `stop()` releases whatever this instance holds.

## Logging

Two layers of secret protection:

### Field-name redaction (logger level)

In `src/logging.ts`, `redactFields()` walks the structured-fields object and replaces any field whose key matches `/token|secret|password/i` with `"[redacted]"`. Applied to **every** log entry emitted by the plugin's own logger. So an inadvertently-logged `accessToken: "eyJ..."` becomes `accessToken: "[redacted]"` regardless of where it came from.

### Substring scrubbing (`scrubSecrets`)

In `src/oauth/http-utils.ts`, `scrubSecrets(text)` masks token-shaped substrings inside arbitrary error bodies:

- JSON tokens: `"access_token": "eyJ..."`, `"refresh_token": "..."`, `"id_token": "..."`, `"client_secret": "..."`, plus `client_assertion`, `code`, `device_code`, `password`, `assertion`, `subject_token`, `actor_token`.
- Form bodies: `client_secret=...`, `access_token=...`, etc., terminated by `&` or end-of-string.
- `Authorization` header values: `Bearer <token>`, `Basic <b64>`.
- Bare JWT-shaped strings: `eyJ<base64url>.<base64url>.<base64url>`.

Applied at every `bodyPreview` site:

- `oauth_client_credentials_failed`
- `oauth_jwt_bearer_failed`, `oauth_token_exchange_failed`
- `oauth_device_authorization_failed`, `oauth_device_code_poll_failed`
- `model_discovery_error_body`

So forwarding the plugin's structured logs to a centralized aggregator (Loki, Datadog, etc.) is safe — there's no path where the plugin emits a raw access token through its logger.

### What only goes to stderr

These are the **only** two things this plugin (or any plugin in the suite) ever writes to the
terminal — the deliberate carve-out from [ADR-0014](adr/0014-suite-wide-no-terminal-mirror.md)'s
otherwise-universal no-terminal-output rule. Both bypass the structured logger and write directly to
`process.stderr` so the **terminal user** can see them, but the values never enter centralized log
forwarding:

1. **Browser-open failure during `authorization_code`.** When `openExternalUrl` throws (no display, missing handler), the plugin writes the authorization URL — which contains the `state` nonce — straight to stderr. Logging it through the logger would land the nonce in shared aggregation, which could enable login-CSRF via a forged callback.
2. **Device-code user code + verification URL.** The user needs to read these out of their terminal to complete the flow. They are *also* logged (`oauth_device_code_issued`) — `user_code` is intentionally not redacted because it's an ephemeral single-use code with no value outside the active flow (RFC 8628 §3.2). But stderr is the reliable channel.

### URL redaction (`redactUrl`)

Anywhere the plugin logs a URL it ran (`tokenEndpoint`, `modelsUrl`), it goes through `redactUrl` first, which strips `user:pass@` userinfo, the query string, and the fragment. Configs like `https://user:pass@auth.example.com/realms/foo/token` don't leak credentials into the log.

### Event names you'll actually see

| Event | When | Notable fields |
| --- | --- | --- |
| `plugin_initialized` | first load | `serverCount` |
| `sync_start` | every scheduler tick or warmup | `serverId`, `interactive` |
| `sync_success` | model fetch succeeded | `modelCount`, `added`, `removed`, `renamed` |
| `sync_failed` | any error during sync | `serverId`, `error` (string) |
| `sync_startup_failed` | warmup failed | `serverId`, `error` |
| `oauth_login_started` | `authorization_code` PKCE began | `issuer`, `authorizationEndpoint` |
| `oauth_login_success` / `oauth_login_failed` | PKCE result | |
| `oauth_refresh_success` / `oauth_refresh_failed` | `refresh_token` exchange | |
| `oauth_device_code_issued` | RFC 8628 step 1 succeeded | `verificationUri`, `userCode`, `expiresIn` |
| `oauth_device_code_success` / `oauth_device_code_poll_failed` / `oauth_device_code_poll_transient_error` | RFC 8628 polling | `consecutiveFailures`, `nextIntervalSeconds` on transient |
| `oauth_client_credentials_started` / `_success` / `_failed` | `client_credentials` flow | `tokenEndpoint`, `status`, `bodyPreview` |
| `oauth_jwt_bearer_started` / `_success` / `_failed` | `jwt_bearer` flow | `subjectTokenSource`, `bodyPreview` |
| `oauth_token_exchange_started` / `_success` / `_failed` | `token_exchange` flow | `subjectTokenSource`, `bodyPreview` |
| `oauth_open_browser_failed` | `xdg-open`/`open`/`start` failed | `error` (URL goes to stderr separately) |
| `model_discovery_error_body` | `/v1/models` returned non-2xx | `modelsUrl`, `status`, `bodyPreview` |
| `model_discovery_empty` | `/v1/models` returned 0 models | `modelsUrl` |
| `oauth2_bearer_propagated_to_provider_headers` | bearer stamped onto `Provider.Info.headers` (provider transform, step 5) | `providerId` |
| `oauth2_bearer_propagation_skipped_user_set` | skipped — user already set `Authorization` | `providerId` |
| `oauth2_bearer_propagation_skipped_no_token` | skipped — refresh-only ensure couldn't produce a token without a fresh prompt | `providerId`, `error` |
| `oauth2_bearer_propagation_skipped_empty_token` | skipped — ensure resolved but returned no access token | `providerId` |
| `oauth2_token_adopted_from_cache` | a state-file re-read yielded a token different from the in-memory one (another process rotated it) | `serverId`, `hadInMemoryToken`, `persistedUpdatedAt`, `memoryUpdatedAt`, `modelCount` |
| `oauth2_cache_reread_stale` | re-read found a strictly older snapshot — memory kept | `serverId`, `persistedUpdatedAt`, `memoryUpdatedAt` |
| `oauth2_cache_reread_no_persisted_token` | state file missing, invalid, or carrying no `token` — memory kept | `serverId`, `hit`, `hasInMemoryToken` |
| `oauth2_cache_reread_failed` | the state-file read itself threw — memory kept | `serverId`, `error` |

**Log level of the happy path.** The lifecycle events at a *successful* boot — `plugin_initialized`, `sync_start`, `sync_success`, `oauth_refresh_success` (oauth2) and `models_info_enriched` (models-info) — are emitted at **`debug`**, not `info`. The **one exception** is `sync_success`: it stays at `debug` when the model set is unchanged, but is promoted to `info` when the diff is non-empty (`added`/`removed`/`renamed` > 0). None of this — including a failure at `warn`/`error` (`sync_failed`, `sync_startup_failed`, `oauth_refresh_failed`, `models_info_enrichment_failed`) — ever prints to the terminal by default: every level goes only to OpenCode's own log, through the host's Effect logger ([ADR-0014](adr/0014-suite-wide-no-terminal-mirror.md)). To see it on the terminal anyway, set `VYMALO_PLUGIN_CONSOLE_LOG=1`; to get the full per-tick lifecycle in the host log when diagnosing, set `OPENCODE_LOG_LEVEL=DEBUG`.

**The `trace` tier.** Below `debug` sits a `trace` level (priority 5) carrying the fine-grained, per-step breadcrumbs — every provider-transform step and provider considered (oauth2), each model match/merge decision (models-info), every parsed `x-ratelimit` header and throttle/tier choice (ratelimit), and every frame the bridge routes between agents and executors, plus host-vs-guest election (browser). It's deliberately high-volume, so it isn't its own host knob: **OpenCode's `DEBUG` maps to `trace`** (`fromOpenCodeLogLevel("DEBUG") → "trace"`), so running the host with `OPENCODE_LOG_LEVEL=DEBUG` unlocks the entire trace stream on top of the `debug` lifecycle events. There's no way to get `debug` without `trace` from the host — that's intentional, since "DEBUG" is the operator's universal "tell me everything" signal. One wrinkle: Effect's logger has no `trace` level either, so a `trace` record is emitted at Effect's `debug` (the finer gating already happened locally); the JSON-console fallback keeps the true `trace` label. **Gated twice on v2:** a record must pass the plugin's own `logLevel` (`options.logLevel`, else `OPENCODE_LOG_LEVEL`) *and* the host fiber's Effect minimum level (default `Info`), so `logLevel: "debug"` emits nothing at `debug` unless the host also permits it (`OPENCODE_LOG_LEVEL=DEBUG`) — the likeliest "why are my trace events missing" question. (Rationale + the alternatives we rejected: [ADR-0008](adr/0008-trace-log-tier.md).)

When OpenCode is the host, every record goes through the host's Effect logger (`Effect.logDebug` / `logInfo` / `logWarning` / `logError` with the fields as log annotations, on the context the plugin captured with `captureHostContext` inside its own Effect — ADR-0019) into OpenCode's own log file — not additionally to stderr. Stderr is reserved for the two carve-outs in [What only goes to stderr](#what-only-goes-to-stderr) above; the plugin's own structured logging never touches it by default ([ADR-0014](adr/0014-suite-wide-no-terminal-mirror.md)).

## Token policy (recap)

Refresh tokens are mandatory **for the flows that issue them**:

- `authorization_code`, `device_code`, `refresh_token` responses → must include `refresh_token` (refresh responses can omit it; the previous one is preserved via `fallbackRefreshToken`).
- `client_credentials`, `jwt_bearer`, `token_exchange` → no `refresh_token` requested or stored. Re-authentication is the renewal path.

If a flow that should have returned a refresh token didn't (`authorization_code` against a misconfigured IdP that suppresses `offline_access`), the exchange throws before the token lands in cache.

## Provider ID resolution

In the `model.request` hook, the provider id is `event.model.providerID`. If it is not in the set of providers the last provider transform found managed, the hook is a no-op and the request goes out untouched (which would 401 against an OAuth-protected gateway — useful signal in logs: `oauth2_model_request_skipped` at `trace` reports `managed: false`).

## `@vymalo/opencode-otel` — the only observer

Every other plugin in the suite either *registers* something (a provider, a tool, a request gate) or *reads and merges* provider/model state. `@vymalo/opencode-otel` does neither: it registers no tools, hosts no server, and mutates nothing except one `traceparent` header written onto primary model requests. It exists to answer "what actually happened in this session," not to change what happens. Full source: [`packages/opencode-otel/src/opencode.ts`](../packages/opencode-otel/src/opencode.ts).

### Registration surface

otel registers against five v2 seams — the broadest registration surface of any plugin in the suite after oauth2's:

- `ctx.event.subscribe({ types })` — **the only subscription to the host event stream in the suite** (apart from lightbridge's embedded `otel` module). It is a `Stream`, forked into the plugin scope with `Effect.forkScoped`, so closing the scope interrupts it. otel asks for exactly 15 event types (`EVENT_TYPES` in [`src/events.ts`](../packages/opencode-otel/src/events.ts): session lifecycle/status/agent/model, step started/ended/failed, compaction, text ended, permission asked/replied, branch updated, `location.shutdown`); the delta events are never delivered. That single subscription is what makes session lifecycle, token accounting, tool outcomes, permission decisions and compaction observable from one place. Everything else falls through on stated grounds ([otel.md → What is deliberately not collected](./otel.md#what-is-deliberately-not-collected)).
- `ctx.session.hook("prompt")` and `("context")` — the user prompt (shape only) and the sampling parameters; `context` opens the `chat` span.
- `ctx.session.hook("model.request")` — only when trace propagation is on (below).
- `ctx.tool.hook("execute.before" | "execute.after")` — tool spans and outcomes.
- `ctx.permission.hook("evaluate")` — config-resolved permission decisions.

otel never touches the credential-carrying seams: its `model.request` hook only ever *adds* a `traceparent`, it never reads or sets `Authorization` — the same "never touch what it doesn't need" posture as ratelimit (see [security.md](./security.md)). The full v1→v2 mapping is in [otel.md](./otel.md#migrating-from-v1).

### The one mutation: trace-context propagation, not authorization

When `traces` are enabled, the `model.request` hook writes a W3C `traceparent` into `event.headers` — but only for `kind: "primary"` requests, and only when exactly one `chat` span is in flight (`TelemetryRecorder.currentChatContext()`). With zero or more than one in-flight chat, it injects nothing rather than guess a parent — a missing trace link is recoverable, a fabricated one silently corrupts the trace. It never overwrites a `traceparent` a caller already set. (v1 did this by wrapping every provider's `options.fetch`; `Provider.Info` has no `fetch` field on v2, so there is no wrapper to compose and the order relative to `@vymalo/opencode-ratelimit` or oauth2 no longer matters — [otel.md](./otel.md#composing-with-other-plugins).)

### Flushing without a dispose hook

Otel registers no explicit teardown hook: the `location.shutdown` event and `session.idle` (the natural turn boundary) plus `beforeExit` / `SIGINT` / `SIGTERM` handlers already cover both the natural and the hard exit paths. See [otel.md → Flushing](./otel.md#flushing) for the detail on why metrics still wait for their own export interval even when traces and logs have already drained.

The signal handlers live in one shared function, `registerExitHandlers` in [`@vymalo/opencode-core-otel`](../packages/opencode-core-otel/src/exit-handlers.ts) (used by both `opencode-otel` and `opencode-lightbridge`), and they carry a rule that is easy to get wrong: **installing a SIGINT/SIGTERM listener replaces the runtime's default "terminate" action**, so a handler that flushes and returns leaves the process running. Where the plugin is the only listener it therefore shuts down (bounded to 2 s), removes its listeners and re-raises the same signal; where the host also listens it only flushes and never terminates. [ADR-0018](adr/0018-exit-handlers-reraise-the-signal.md) has the measurements (`opencode serve` ignored SIGTERM in 15 of 15 runs before) and the lifecycle.
