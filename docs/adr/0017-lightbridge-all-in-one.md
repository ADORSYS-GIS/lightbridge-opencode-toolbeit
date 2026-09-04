# ADR-0017 — `@vymalo/opencode-lightbridge` becomes the all-in-one plugin: shared registration, shared cache, opt-in exchange

- **Status:** Accepted
- **Date:** 2026-09-04
- **Applies to:** `@vymalo/opencode-lightbridge` (`config.ts`, `plugin.ts`, `opencode.ts`, new
  `migration.ts`) and `@vymalo/opencode-provider-sync`'s `ProviderModelSyncEngine` (a new
  scheduler-ownership guard). **Amends** [ADR-0012](0012-single-auth-across-gateway-and-otel.md)'s
  "gateway bearer is always the RFC 8693 exchange" decision — ADR-0012's body is left untouched
  (ADRs are immutable once Accepted); this ADR records what changed and why.

## Context

[ADR-0016](0016-provider-sync-extraction.md) extracted `@vymalo/opencode-oauth2`'s model-sync
runtime into `@vymalo/opencode-provider-sync`'s `ProviderModelSyncEngine`, explicitly so
`opencode-lightbridge` could compose it "in a follow-up PR instead of forking it." This is that PR.

Three gaps stood between lightbridge and "the all-in-one plugin — everything oauth2 does, plus what
lightbridge already does":

1. **No provider registration / model discovery.** lightbridge's `gateway.providers: string[]` only
   injects a bearer onto providers **someone else** registered (typically by hand, in
   `opencode.json`). oauth2's whole value proposition — register the provider, discover its models,
   keep them in sync — was simply missing from lightbridge.
2. **Two credential stores for one identity.** The maintainer's own words: *"lightbridge and oauth2
   should save and read tokens at the same place."* A developer running BOTH plugins against the
   same IdP had to log in twice: oauth2 fuses its token into
   `<cacheRoot>/opencode-oauth2/<namespace>/<serverId>.json`; lightbridge kept a bare `TokenSet` at
   `<cacheRoot>/opencode-lightbridge/lightbridge.json`, keyed by the constant `"lightbridge"` instead
   of a real server id. Nothing correlated the two.
3. **The RFC 8693 exchange was unconditional.** ADR-0012 always exchanges the human token for a
   project-scoped one before using it as the gateway bearer. That's wrong for our own fleet: the
   IdP's device-code token is already fully project-scoped, and the `opencode-cli` client has no
   `token-exchange` grant registered — an unconditional exchange fails outright with
   `unauthorized_client`.

## Decision

### 1. `register` — provider registration + model discovery via the shared engine

A new, independent, optional config block:

```jsonc
{
  "auth": { "id": "gateway", "issuer": "...", "clientId": "...", "scopes": ["..."] },
  "register": {
    "baseURL": "https://gateway.example.com/v1",
    "name": "Lightbridge Gateway",
    "nameOverrides": { "glm-5": "GLM 5" },
    "syncIntervalMinutes": 30,
    "responseApi": false
  }
}
```

`register` is deliberately **NOT** nested under `gateway` and does not touch
`gateway.providers` — that field's simple header-injection behaviour is unchanged, and existing
configs using it keep working with zero edits (a hard requirement, verified by the unchanged
`gateway`-only tests in `test/opencode.test.ts`). When `register` is set, `opencode.ts` builds a
`ProviderModelSyncEngine` from `auth` + `register` (translating `auth`'s already-validated
`AuthServerConfig` into the engine's `ProviderServerConfig`, exactly the shape oauth2 builds from
its own `servers[]` entries) and, on every `config` hook call, merges the registered
npm/name/options/models into `config.provider[<auth.id>]` — the same
`resolveProviderNpm`/`applyResponsesApiOptions`/`mergeDiscoveredModels` helpers oauth2 calls, from
`@vymalo/opencode-provider-sync/lib`. `auth.id` doubles as the OpenCode provider id AND the shared
cache identity (see below).

### 2. One login, shared token cache with oauth2

**The human root token now lives in the SAME file `@vymalo/opencode-oauth2` writes** for a server of
this id: `<cacheRoot>/opencode-oauth2/opencode-oauth2-model-sync/<auth.id>.json` — the fused
`CachedServerState` shape (`token` + `models` + `rawModels`), not lightbridge's old bare `TokenSet`.
Two participants can share that file safely:

- **`register` configured:** lightbridge's own `ProviderModelSyncEngine` IS the writer (same as
  oauth2's), so sharing is automatic — set the same `id`/`issuer`/`clientId` in both plugins'
  configs and they resolve to the identical cache path.
- **`register` NOT configured** (the common case — just `auth` + `gateway`/`otel`):
  `LightbridgeRuntime` builds its own lightweight `TokenRuntime` for `auth.id`, persisting through
  `getCached`/`setCached` overrides into that SAME shared file — mirroring the override pattern
  `ProviderModelSyncEngine.buildTokenRuntime` already uses internally (extract `.token`, preserve
  `.models`/`.rawModels` on write) — but running no scheduler and no model-discovery HTTP calls of
  its own. It is a read/refresh-only participant in the shared file, never a second poller.

The literal segment/namespace (`"opencode-oauth2"` / `"opencode-oauth2-model-sync"`) is pinned as a
constant in `plugin.ts` (`ROOT_CACHE_SEGMENT`/`ROOT_CACHE_NAMESPACE`) rather than imported from
`@vymalo/opencode-oauth2` — lightbridge does not depend on that package; the two packages agree on
this on-disk contract the same way they already agree on token-cache *shape*
(`@vymalo/opencode-auth-core`'s `TokenSet`).

**Scope of sharing:** only the human/IdP **root** token relocates. The project-scoped token
lightbridge produces via the (now opt-in) RFC 8693 exchange has no oauth2 equivalent — oauth2 never
exchanges — and stays exactly where it always was
(`<cacheRoot>/opencode-lightbridge/lightbridge-<hash>.json`), unchanged in shape and location. It is
short-lived (minutes); losing it on an upgrade costs one extra exchange call, not a re-login, so it
was deliberately excluded from the migration below.

**Mandatory migration (no forced re-login).** An existing lightbridge install's root token at the
OLD location (`<cacheRoot>/opencode-lightbridge/lightbridge.json`, a bare `TokenSet`) is adopted
into the new shared location the first time it's needed (`migration.ts`,
`migrateRootTokenIfNeeded`): if the new location has no state yet, and the old file holds a
structurally usable token (even if expired — a refresh token still makes it worth adopting), it is
copied into a fresh `CachedServerState` at the new location. The old file is left in place
(non-destructive); the check is idempotent, so every call after the first is a cheap no-op once the
new location has any state. `LightbridgeRuntime.getProjectToken` and `.reset()` route through this
before touching the shared store. Test coverage proves a pre-existing valid or expired-but-refreshable
old-format token results in **zero** login/refresh network calls on first use post-upgrade.

### 3. `gateway.exchange` — RFC 8693 exchange becomes opt-in, defaulting to `false`

```jsonc
{ "gateway": { "providers": ["gateway"], "exchange": true } }
```

- **`exchange: false` (NEW DEFAULT):** the IdP access token from `auth` is used directly as
  `Authorization: Bearer <token>` for both the gateway and OTEL. No second network call, no
  `token-exchange` grant required. This is what our own fleet needs today.
- **`exchange: true`:** today's ADR-0012 behaviour, byte-for-byte unchanged — `exchangeTo(projectKey,
  humanToken, projectId ? { project_id } : {})`, cached under its own project-scoped key, re-exchanged
  on expiry.

**Default chosen: `false`.** This is a deliberate **breaking change** for any existing ADR-0012
deployment that relies on the exchange (call out loudly in the CHANGELOG, not silently defaulted) —
justified because (a) "opt-in" as a word means off-by-default, matching the requirement precisely;
(b) it matches the maintainer's own fleet, which cannot use the exchange at all today
(`unauthorized_client` — the client has no `token-exchange` grant); (c) most IdP setups hand out a
token that is already correctly scoped for the gateway, so exchanging it is one more network round
trip and one more failure mode for no benefit in the common case. Anyone who needs the exchange
(multi-tenant project-scoping through a shared human identity) sets `gateway.exchange: true`
explicitly and gets ADR-0012's behaviour back exactly as it was.

### 4. Guards

**4a — provider-id collision (config-detectable, static).** If `auth.id` is ALSO managed by
`@vymalo/opencode-oauth2` in the same host config — via `pluginConfig.oauth2ModelSync.servers[].id`
or a provider's own `options.oauth2`/`options.oauth2ModelSync` block — lightbridge's `register`
module skips ENTIRELY: no `ProviderModelSyncEngine` is constructed, `config.provider[id]` is never
touched. Mirrors `@vymalo/opencode-repo-auth`'s `hasOAuth2Conflict`/`oauth2ManagedProviderIds`
precedent (which defers to oauth2 the same way) — kept as lightbridge's own local copy rather than a
shared import, consistent with `@vymalo/opencode-provider-sync`'s existing stance that each
consumer's config-key literals are not centralized. Logged at `debug`
(`lightbridge_register_skipped_oauth2_conflict`) — per [ADR-0014](0014-suite-wide-no-terminal-mirror.md),
nothing reaches the terminal — and fails safe: the gateway/OTEL bearer still works, because
`LightbridgeRuntime`'s lightweight participation in the shared cache file (§2) is unaffected by this
guard; only the OpenCode-provider-registration ownership is skipped.

**4b — double scheduling (runtime, in-process).** Two `ProviderModelSyncEngine` instances in ONE
process targeting the same cache file — oauth2's and lightbridge's `register` engine, or two of
lightbridge's own across a config hot-reload — is a failure mode the existing cross-process re-read
logic was never designed for (it assumes the *other* writer is a different OS process). Fixed
generically inside the shared engine itself: `ProviderModelSyncEngine.start()` claims a process-wide,
in-memory ownership slot keyed by `<cacheDir, serverId>` before running warmup + starting its
scheduler for each server; an instance that loses the claim skips both (never throws — logged once at
`debug`, `sync_scheduler_ownership_skipped`) and still serves cached reads and on-demand
`ensureAccessToken`/`syncServer` calls, which were already safe to run concurrently (file-lock
coordinated refresh, idempotent GETs). `stop()` releases whatever the instance holds. This protects
every current and future consumer of the engine, not just lightbridge.

## Consequences

**Positive**

- lightbridge is now genuinely "everything oauth2 does, plus what it already did" — one plugin
  entry can register a provider, discover its models, inject the gateway bearer, and export OTEL,
  all off one shared credential.
- One login serves both plugins when configured against the same IdP — the maintainer's explicit
  ask — with a mandatory, tested, non-destructive migration for existing installs.
- The exchange becoming opt-in unblocks our own fleet without forcing every other ADR-0012 adopter
  to change anything beyond adding one boolean if they need the old behaviour.
- The scheduler-ownership guard is a real robustness improvement to `@vymalo/opencode-provider-sync`
  itself, benefiting any future third consumer, not just this pairing.

**Negative / cost**

- **Breaking change for existing `gateway`/`otel` users relying on the exchange** — they must add
  `gateway.exchange: true` on upgrade or their gateway calls start presenting the raw IdP token
  instead of a project-scoped one (silently the "more privileged" token, not less — the IdP token is
  what the exchange was narrowing *from* — but still a behavioural change worth the loud CHANGELOG
  entry).
- **A new workspace dependency**: `opencode-lightbridge` now depends on
  `@vymalo/opencode-provider-sync` (previously oauth2-only).
- **The exchanged project-scoped token is NOT part of the cache-sharing story** — by design (§2), but
  worth restating: there is no cross-plugin benefit for that half of lightbridge's token surface,
  only for the human root.
- Two engines' worth of `ProviderModelSyncEngine` machinery (oauth2's, lightbridge's `register`) can
  now coexist in one process; the ownership guard makes that SAFE, not free — a developer running
  both against the same id in a non-colliding-by-config way (different ids, shared segment) still
  pays for whichever engine wins the race to warm up first, the other simply reads.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| **Give lightbridge its own `pluginConfig.lightbridgeModelSync.servers[]` + `provider.options.lightbridge` channels, mirroring oauth2's exactly** | Lightbridge conceptually manages ONE provider per plugin instance (`auth` + `register`), not an arbitrary list — forcing the multi-server host-config channel shape would add indirection with no real consumer need. The single-server `register` block reuses the SAME engine and the SAME `opencode-helpers.ts` merge functions oauth2 uses; only the *config surface* differs, deliberately, and even that draws inspiration from oauth2's shape (`servers[].id` ↔ `auth.id`). |
| **Default `gateway.exchange` to `true` (preserve ADR-0012 behaviour untouched)** | Fails the maintainer's own fleet outright (`unauthorized_client`) and contradicts "opt-in," which means off-by-default. A loud breaking-change CHANGELOG entry is the honest cost of getting the default right, not a reason to keep the wrong default. |
| **Route the human root token through the FULL `ProviderModelSyncEngine` even when `register` is not configured** | Rejected: the engine requires a `baseURL` to run model discovery against, which an `auth`-only (no `register`) config doesn't have. Forcing one would mean either inventing a fake `baseURL` or making it optional in the engine — both worse than the chosen design (a lightweight, engine-free `TokenRuntime` wrapper that shares the exact same file format). |
| **Delete the exchanged-token store entirely and migrate it too** | Considered and rejected — no oauth2 equivalent exists to migrate it INTO, and the token is short-lived enough that losing it costs one exchange call, not a re-login. Migrating something with no shared destination would just be data motion for its own sake. |
| **Put the scheduler-ownership guard only in lightbridge (skip constructing a second engine when oauth2 already owns the id)** | Done too (§4a), but insufficient alone — it only covers the *config-detectable* collision. A generic, engine-level guard (§4b) also covers in-process hot-reload self-collision and any future third consumer, and costs nothing for the common single-engine-per-id case. |

## Related

- [ADR-0012](0012-single-auth-across-gateway-and-otel.md) — the umbrella plugin and the exchange
  behaviour this ADR amends (body left untouched; this ADR is the record of what changed).
- [ADR-0016](0016-provider-sync-extraction.md) — the engine extraction this ADR's `register` module
  and scheduler-ownership guard build on directly.
- [ADR-0014](0014-suite-wide-no-terminal-mirror.md) — why the collision guard logs at `debug`, not
  louder.
- [`docs/lightbridge.md`](../lightbridge.md) — the consumer-facing contract, config reference, and
  migration notes.
- [`docs/architecture.md`](../architecture.md) — cache-layout and sync-scheduler sections, both
  amended with lightbridge's participation.
