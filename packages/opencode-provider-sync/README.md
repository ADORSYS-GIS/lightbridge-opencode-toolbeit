# @vymalo/opencode-provider-sync

Shared provider-registration + model-discovery engine for the @vymalo OpenCode
plugin suite. Holds the OAuth-backed **model sync** machinery in **one place**
so plugins like [`@vymalo/opencode-oauth2`](../opencode-oauth2) and
[`@vymalo/opencode-lightbridge`](../opencode-lightbridge)'s `register` module
share it instead of forking it.

> Extracted from `@vymalo/opencode-oauth2` ([ADR-0016](../../docs/adr/0016-provider-sync-extraction.md)),
> the same way `@vymalo/opencode-auth-core` and `@vymalo/opencode-core-otel`
> were previously extracted from `oauth2` and `otel` respectively.
> `@vymalo/opencode-lightbridge` composes it too, since
> [ADR-0017](../../docs/adr/0017-lightbridge-all-in-one.md) — the second
> consumer that motivated the scheduler-ownership guard below.

## What it provides

- `ProviderModelSyncEngine` — the runtime: per-server cached state, a
  cross-process-safe `ensureAccessToken` / `syncServer` / `getServerModels`
  surface, and a periodic sync scheduler. Built on
  `@vymalo/opencode-auth-core`'s `TokenRuntime` for the actual token lifecycle.
- `model-discovery` / `model-normalization` — fetch a provider's `/v1/models`
  and turn raw ids into readable display names + add/remove/rename diffs.
- `cache.ts` — `resolveCacheDir(segment, namespace)` + `FileCacheStore`, the
  fused model+token on-disk state, atomic-write via auth-core's generic store.
- `scheduler.ts` — a backoff-retrying interval runner.
- Host-config wiring helpers (`./lib` only) — `collectManagedProviders`,
  `parsePluginConfigServers`, `parseOAuthExtension`, `mergeDiscoveredModels`,
  `propagateCachedBearer`, `resolveProviderNpm`, `applyResponsesApiOptions`,
  `runtimeSignature` — the `Hooks.config` plumbing a consumer plugin composes
  with its **own** config-key literals (see below).

## What it deliberately does NOT own

- **Config-key literals.** Which `pluginConfig.<key>` / `provider.options.<key>`
  a consumer reads is its own config surface — passed in as
  `pluginConfigKey` / `optionKeys` options, never hardcoded here. oauth2's are
  `"oauth2ModelSync"` and `["oauth2", "oauth2ModelSync"]`.
- **Auth-subset validation.** A consumer's own config module (layered on
  `@vymalo/opencode-auth-core`'s `validateAuthConfig`) normalizes/validates
  servers before constructing the engine — the engine accepts already-valid
  `ProviderServerConfig` objects and does no field-level validation of its own
  beyond "servers must be a non-empty array".
- **The Responses-API SSE repair fetch.** Gateway-specific (observed: Envoy AI
  Gateway) — a consumer injects its own `createResponsesRepairFetch`-shaped
  hook via `ApplyResponsesApiOptionsHooks` / `CollectManagedProvidersOptions`;
  this package never imports or implements the repair itself.

## Usage

```ts
import { ProviderModelSyncEngine } from "@vymalo/opencode-provider-sync";

const engine = new ProviderModelSyncEngine(
  { servers: [/* already-validated ProviderServerConfig objects */] },
  { cacheNamespaceSegment: "my-plugin", serviceLabel: "my-plugin" }
);

await engine.initialize();
await engine.start({ warmup: true });
const token = await engine.ensureAccessToken("my-server");
```

For the full surface (host-config helpers, cache, scheduler) import from
`@vymalo/opencode-provider-sync/lib`.

## Composing the `Hooks.config` wiring

A consumer plugin supplies its own config-key literals and (optionally) a
Responses-API repair hook, then delegates the rest:

```ts
import {
  collectManagedProviders,
  mergeDiscoveredModels,
  propagateCachedBearer,
  runtimeSignature
} from "@vymalo/opencode-provider-sync/lib";

const managed = collectManagedProviders(config, logger, {
  pluginConfigKey: "myPluginModelSync",
  optionKeys: ["myPlugin", "myPluginModelSync"],
  createResponsesRepairFetch: myOwnRepairFetch // optional
});
```

## Scheduler ownership (ADR-0017)

Since a second consumer can build its own `ProviderModelSyncEngine` instance in
the SAME process against the SAME cache directory (e.g. lightbridge's
`register` engine alongside oauth2's, for a shared server id), `start()`
claims a process-wide, in-memory ownership slot per `<cacheDir, serverId>`
before running warmup + starting the scheduler. An instance that loses the
claim skips both for that server (logged once at `debug`,
`sync_scheduler_ownership_skipped`; never throws) and still serves cached
reads and on-demand `ensureAccessToken`/`syncServer` calls, which were already
safe to run concurrently. `stop()` releases whatever the instance holds.

## Cross-process token safety

Several OpenCode processes can share one cache directory. `ensureAccessToken`
/ `syncServer` re-read the persisted per-server state on every cached-token
read (not the in-memory copy loaded at `initialize()`), so a refresh token
rotated by one process is adopted by another rather than replayed — replaying
an already-rotated refresh token against an IdP with reuse detection (RFC 6819
§5.2.2.3) revokes the whole chain and logs every process out. See
`ProviderModelSyncEngine`'s private `readCachedToken` for the adoption rule.
The cross-process lock, single-flight and retry-on-rotation logic itself lives
in `@vymalo/opencode-auth-core`'s `TokenRuntime` — this package only guarantees
every read sees the disk.

## Development

```bash
pnpm --filter @vymalo/opencode-provider-sync build
pnpm --filter @vymalo/opencode-provider-sync typecheck
pnpm --filter @vymalo/opencode-provider-sync test
pnpm --filter @vymalo/opencode-provider-sync coverage
```
