# ADR-0020 — oauth2 on v2: none of the five auth flows becomes an Integration method

- **Status:** Accepted
- **Date:** 2026-11-08
- **Applies to:** `@vymalo/opencode-oauth2` (and, by the same reasoning, the `gateway`/`register`
  modules of `@vymalo/opencode-lightbridge`); the `.well-known/opencode` distribution channel
  ([`docs/well-known.md`](../well-known.md)). Follows [ADR-0019](0019-opencode-v2-cutover.md), which
  deferred this question to "its own ADR when the oauth2 port lands".

## Context

[ADR-0019](0019-opencode-v2-cutover.md) mapped v1's `auth` hook to `ctx.integration` and said
oauth2's five auth flows "move to `ctx.integration`". The port brief repeated that premise. Reading
the code and the v2 type definitions (`@opencode/plugin@2.2.6`,
`dist/effect/integration.d.ts`) shows it was wrong in two ways, and the decision below rests on that.

**1. v1 oauth2 never had an `auth` hook.** `opencode.ts` returned exactly two hooks, `config` and
`chat.headers`. The five flows (`authorization_code`, `device_code`, `client_credentials`,
`jwt_bearer`, `token_exchange`) never hung off a host-integrated login. They live inside
`@vymalo/opencode-auth-core`'s `OAuthClient`, are driven by its `TokenRuntime`, and the plugin
triggers them itself: interactively at warmup when a TTY is attached, and lazily from
`ensureAccessToken` on the first request. There was no v1 `auth` surface to port.

**2. v2's OAuth method models a host-owned credential and a host-driven flow.** The relevant types:

```ts
IntegrationOAuthMethodRegistration = {
  integrationID; method: { id, type: "oauth", label, form? };
  authorize: (answer: Form.Answer) => Effect<IntegrationOAuthAuthorization, unknown, Scope>;
  refresh?: (credential: Credential.OAuth) => Effect<Credential.OAuth>;
  label?: (credential) => string | undefined;
}
IntegrationOAuthAuthorization = { url, instructions, expiresAt? } &
  ({ mode: "auto"; callback: Effect<Credential.OAuth> } | { mode: "code"; callback: (code) => Effect<Credential.OAuth> })
Credential.OAuth = { type: "oauth", methodID, refresh: string, access: string, expires: Int, metadata? }
```

`authorize` must hand the host a URL (and instructions) *before* the flow completes; the host shows
it, waits on `callback`, and then **stores the resulting `Credential.OAuth` itself**. `refresh`
renews that stored credential. `ctx.integration.connection.{active,resolve,status}` read and annotate
host connections.

Four facts about this suite collide with that model:

- **The token store is the plugin's, by contract.** The human/IdP token lives at
  `<cacheRoot>/opencode-oauth2/opencode-oauth2-model-sync/<auth.id>.json`, shared with
  `@vymalo/opencode-lightbridge` ([ADR-0017](0017-lightbridge-all-in-one.md)), re-read from disk on
  every decision, and refreshed under an advisory cross-process lock
  ([ADR-0016](0016-provider-sync-extraction.md)). Lightbridge has no integration registration, so a
  credential held in the host's store is invisible to it.
- **Refresh tokens are single-use.** An IdP with reuse detection (RFC 6819 §5.2.2.3) revokes the whole
  chain when an already-rotated refresh token is replayed. Two holders of one chain — the host's
  `Credential.OAuth.refresh` and the cache file — is exactly the failure the cache design exists to
  prevent.
- **`auth-core`'s interactive flows are monolithic.** `OAuthClient.loginInteractive` generates the
  authorize URL, starts the local callback server, awaits the redirect and does the code exchange in
  one call; the only seam is `onAuthorizationUrl`. `acquireTokenViaDeviceCode` exposes **no** URL or
  user code at all — it writes the prompt straight to `process.stderr` (the single carve-out
  [ADR-0014](0014-suite-wide-no-terminal-mirror.md) permits). Producing an
  `IntegrationOAuthAuthorization` for device-code means either changing `auth-core` (out of scope for
  this port and shared with `repo-auth` and `lightbridge`) or re-implementing RFC 8628 in oauth2.
- **Three of the five flows are not interactive at all.** `client_credentials`, `jwt_bearer` and
  `token_exchange` have no URL to show, no user, and no callback; they are a `fetch` against the
  token endpoint. `IntegrationOAuthAuthorization` requires a `url` and `instructions`.

## Decision

**None of the five flows is registered as an `ctx.integration` method. All five stay on the
plugin-owned `TokenRuntime` inside `ProviderModelSyncEngine`, exactly as in v1.** The port changes
how the token reaches the request, not how it is acquired:

- `chat.headers` → `ctx.session.hook("model.request")`. It awaits any in-flight build, calls
  `engine.ensureAccessToken(providerID)` (refresh-only semantics unchanged; interactive login still
  allowed on the request path), and sets `event.headers.Authorization`, removing any
  differently-cased variant first. On failure it logs `oauth2_model_request_token_failed` and dies —
  fail closed, as v1's thrown error did — rather than sending the request under a placeholder key.
- Provider registration and model merge → `ctx.provider.transform` via `collectManagedProviders` /
  `mergeDiscoveredModels` / `propagateCachedBearer`. The transform is synchronous; the engine build,
  warmup and bearer resolution run in a serialised background queue and call `ctx.provider.reload()`
  when they finish. The first transform pass therefore registers providers with no models; the
  reload fills them in.
- Servers come from `ctx.options.servers`; per-provider opt-ins move from
  `options.oauth2`/`options.oauth2ModelSync` to `settings.oauth2`/`settings.oauth2ModelSync`.
- `createResponsesRepairFetch` is replaced by `repairResponsesResponse`, called from
  `ctx.session.hook("http.response")` for providers that opted into `responseApi`.
- The on-disk cache layout, namespace and the ADR-0017 pre-migration path are untouched.

`ctx.integration` is not used, and no managed provider sets `integrationID`. The plugin id is
`vymalo.oauth2`.

**A managed provider is identifiable from its `Provider.Info` alone.** `@vymalo/opencode-repo-auth`
guards against double-managing a provider, and in v2 it can see only the provider record (another
plugin's `ctx.options` is private). So every provider oauth2 manages carries `settings.oauth2` (or
`settings.oauth2ModelSync`): a user-declared block is left in place, never consumed or stripped, and a
provider materialised purely from `options.servers` is stamped with
`settings.oauth2 = { managed: true, source: "options.servers" }`. The marker has no
issuer/clientId/scopes, so `parseOAuthExtension` ignores it on later passes.

**`.well-known/opencode` stays the primary distribution channel; the plugin needs no code for it.**
The v2 manifest is `{ auth?, config?, remote_config? }`, and a well-known origin becomes an
**Integration**. Consequences for this suite:

- *`auth` is command-based, but so was v1's.* The documented v1 manifest already carried
  `{ "command": [...], "env": "..." }` (the `echo plugin-managed` placeholder pattern in
  [`docs/well-known.md`](../well-known.md)); the port brief's framing of the move "from an OAuth
  block" does not match the v1 document this repo has always documented. What actually changes is
  that the resulting credential is attached to an Integration. The placeholder pattern survives
  only if `model.request` can overwrite whatever `Authorization` the host builds from that
  credential — see *Unverified*.
- *The `config` block is renamed, not removed.* `plugin` → `plugins` (entries become
  `{ package, options }`), `provider` → `providers`, `options.*` → `settings.*`. An operator serving
  the manifest must re-render it for v2; v1 clients and v2 clients cannot share one document.
- *`remote_config` is not adopted as the default.* It is a host feature (a URL the host fetches,
  with `{env:VAR}`-substituted headers), so there is nothing for a plugin to implement. Whether
  operators *should* use it is the real question. It fits a gateway that authenticates with a static
  key supplied through `auth.env`. It does **not** fit this suite's headline case — an OAuth2-managed
  gateway — because the config fetch happens before plugins load, so the plugin's bearer does not
  exist yet and cannot be placed in a header. For OAuth gateways the config therefore stays inline in
  `config`, or the config URL stays unauthenticated. Revisit if the host gains an OAuth-capable
  well-known (it currently has `auth.command` only).

## Consequences

- **No host-visible sign-in.** There is no `opencode auth login`-style entry for an oauth2 server and
  no host connection status. Login happens as it did in v1: interactive warmup when a TTY is
  attached, otherwise on the first request. In a v2 host that runs plugins in a TTY-less server
  process, warmup will be non-interactive and the first request carries the login (device-code prompt
  on stderr, per the ADR-0014 carve-out) — slower and less visible than a host-driven flow. This is
  the main thing a host-integrated design would improve, and it is accepted for now.
- **Startup is no longer blocked on warmup.** v1's `config` hook awaited warmup, so the runtime
  existed before any request. The v2 transform must be synchronous, so the build runs in the
  background; `model.request` awaits the queue to compensate, but a request that races a slow
  interactive warmup now waits on it.
- **Bad user config is reported, not thrown.** v1 rejected the `config` hook with the validation
  message (`redirectPort`, `authFlow`, `responseApi`). A throw inside a v2 transform would take down
  the provider pipeline for every plugin, so the plugin logs `oauth2_config_invalid` at `error` and
  manages nothing. Per [ADR-0014](0014-suite-wide-no-terminal-mirror.md) that log is not on the
  terminal; a misconfigured provider is simply absent until the host log is read.
- **Periodic sync still does not push models into the host.** As in v1, the scheduler refreshes the
  cache; the provider list is rebuilt after warmup and after the lazy first-request sync, not on every
  tick.
- **Lightbridge is unaffected** and keeps one shared login with oauth2 through the unchanged cache
  file.

## Alternatives considered

**Register `authorization_code` and `device_code` as `oauth` methods; keep the machine flows internal.**
The brief's suggested split, and the obvious reading of the type surface. Rejected on inspection:
it gives the host a `Credential.OAuth` that the plugin must mirror from the cache file, with
`refresh` delegating back to the engine so the host never rotates the chain itself. That is a second
copy of a single-use credential with no consumer (the request path reads the engine, and lightbridge
cannot see the host store). `device_code` additionally cannot be expressed without changing
`auth-core` or duplicating RFC 8628, and `authorization_code` needs an `onAuthorizationUrl`
capture-and-race around a monolithic call. All cost, no behaviour the plugin does not already have.
Worth revisiting if `auth-core` grows a split `begin`/`complete` API and a host exists to verify the
flow against.

**Register all five.** Rejected: three have no URL, no user and no callback, and would be forced
through `IntegrationOAuthAuthorization` with fabricated `url`/`instructions`. That is the "force it
into the API" outcome the port brief warned against.

**An `external` method (`IntegrationExternalMethod` / `Credential.External`).** The one type that
matches the ownership model — its credential is documented as "managed outside the credential store"
— and `connection.status` could then surface "sign-in required". Rejected *for now*, not
conclusively: the published types say nothing about how a connection of this kind is created, what
`resolve` returns for it, or what the host does with it at request time, and it adds no function the
plugin lacks today. This is the candidate to try first once a v2 host is available.

**Have `model.request` die on every failure vs. log-and-continue.** Log-and-continue would let the
request leave under the `oauth2-managed-bearer` placeholder (responses mode) or a stale header and
fail at the gateway with a 401 that hides the cause. Dying keeps v1's fail-closed behaviour. What the
host does with a hook defect is unverified (below).

## Unverified without a running v2 host

- **Header order.** That `event.headers` in `model.request` already contains the provider/connection
  headers and that nothing re-applies a credential after the hook runs. The whole placeholder pattern
  and the `responseApi` placeholder key depend on it.
- **Defect handling.** How the host surfaces a defect from a `model.request` hook (the fail-closed
  path); the hook type allows no typed failure.
- **`provider.reload()` semantics.** That it re-runs every transform with fresh editors, and that
  `ProviderEditor` state does not persist between passes (the `stamped` map in
  `propagateCachedBearer` is defensive for the other case).
- **`http.response` timing.** That the hook receives the response before its body is consumed, so a
  replaced `Response` is what the AI SDK parses. The repair is verified end to end against the AI SDK
  with the hook invoked by a test harness, not by the host.
- **Zero-limit / empty-modality models.** Whether the host tolerates discovered models that
  models-info has not enriched (see [`docs/provider-sync.md`](../provider-sync.md)).
- **`remote_config`.** Its exact schema and load order are taken from the port brief, not from the
  type definitions, which do not describe the manifest.
- **TTY availability** for interactive warmup inside a v2 plugin host.
