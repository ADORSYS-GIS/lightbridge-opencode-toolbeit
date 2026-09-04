# `@vymalo/opencode-provider-sync`

Status: **implemented** — see [ADR-0016](adr/0016-provider-sync-extraction.md) (Accepted) and
`packages/opencode-provider-sync/`.

Goal, in one line: **one shared engine for "keep a set of OpenAI-compatible providers' model lists
in sync, behind a cached OAuth token, safely across multiple OpenCode processes (and, since
ADR-0017, multiple engine instances in one process) sharing one cache directory"** — extracted from
`@vymalo/opencode-oauth2` so a second plugin (`@vymalo/opencode-lightbridge`) could compose it
instead of forking it. See [ADR-0017](adr/0017-lightbridge-all-in-one.md) for that second consumer.

This is not itself an OpenCode plugin — it registers no `Plugin`, hosts no server, and is never
loaded directly by the OpenCode host. It is a library two plugins compose: `@vymalo/opencode-oauth2`
(`OAuth2ModelSyncPlugin extends ProviderModelSyncEngine`) and, since ADR-0017,
`@vymalo/opencode-lightbridge`'s optional `register` module.

## What it provides

- **`ProviderModelSyncEngine`** — the runtime. Per-server cached state
  (`initialize()`/`start()`/`stop()`), the cross-process-safe `ensureAccessToken` / `syncServer` /
  `syncAll` / `ensureServerReady` / `getServerModels` / `getProviderModelMap` /
  `getCachedToken` surface, and a periodic sync scheduler per server. Built on
  `@vymalo/opencode-auth-core`'s `TokenRuntime` for the actual token lifecycle (refresh
  single-flight, the cross-process lock, retry-on-rotation) — this package never re-implements any
  of that.
- **`model-discovery.ts`** — `fetchModels`/`buildModelsUrl`: fetches a provider's `/v1/models`
  (or `<baseURL>/v1/models` if `baseURL` doesn't already end in `/v1`) with the bearer, logging (but
  never throwing with) the response body on a non-2xx.
- **`model-normalization.ts`** — `normalizeModelId`/`normalizeModelList`/`diffModels`: turns raw
  model ids (`glm-5`, `qwen2-72b-instruct`) into readable display names (`GLM 5`, `Qwen2 72B
  Instruct`) and computes added/removed/renamed diffs between syncs.
- **`cache.ts`** — `resolveCacheDir(segment, namespace)` + `FileCacheStore`: the fused
  model+token on-disk state, atomic-write via auth-core's generic `FileCacheStore`. `segment`
  identifies the **consuming plugin** (e.g. `"opencode-oauth2"`), not this package — every real
  consumer sets it explicitly via `ProviderModelSyncEngineOptions.cacheNamespaceSegment` so an
  existing install's cache path never moves just because the engine it's built on does.
- **`scheduler.ts`** — `startScheduler`: a backoff-retrying interval runner (the retry window
  doubles per consecutive failure, capped at the configured interval).
- **`opencode-helpers.ts`** (exported from `./lib` only) — the `Hooks.config` wiring a consumer
  composes with its **own** config-key literals: `collectManagedProviders`,
  `parsePluginConfigServers`, `parseOAuthExtension`, `mergeDiscoveredModels`,
  `propagateCachedBearer`, `resolveProviderNpm`, `applyResponsesApiOptions`, `runtimeSignature`.
  These were private functions inside `opencode-oauth2`'s `opencode.ts` before this extraction.

## What it deliberately does not own

Three things stay with each consumer rather than being baked into the engine — see
[ADR-0016](adr/0016-provider-sync-extraction.md#decision) for the full reasoning:

1. **Config-key literals.** Which `pluginConfig.<key>` / `provider.options.<key>` a consumer reads
   is passed in as `pluginConfigKey` / `optionKeys` options, never hardcoded. `opencode-oauth2`'s
   are `"oauth2ModelSync"` and `["oauth2", "oauth2ModelSync"]`. `opencode-lightbridge`'s `register`
   module takes a different shape entirely — it manages exactly ONE server per plugin instance,
   built directly from its own `auth`+`register` options rather than the host-config
   `pluginConfig`/`provider.options` channels `collectManagedProviders` reads — so it calls the
   engine and the per-provider merge helpers (`resolveProviderNpm`, `applyResponsesApiOptions`,
   `mergeDiscoveredModels`) directly rather than going through `collectManagedProviders`/
   `parsePluginConfigServers`/`parseOAuthExtension`, which remain oauth2-only. See
   [ADR-0017](adr/0017-lightbridge-all-in-one.md).
2. **Auth-subset validation.** A consumer's own config module (layered on
   `@vymalo/opencode-auth-core`'s `validateAuthConfig`) normalizes and validates servers before
   constructing the engine. The engine accepts only already-validated `ProviderServerConfig`
   objects — it does no field-level validation of its own beyond "servers must be a non-empty
   array," a defensive floor rather than a validation contract to depend on.
3. **The Responses-API SSE repair fetch.** Gateway-specific (observed: Envoy AI Gateway omitting
   `output_index`/`content_index` on Responses-API SSE frames). A consumer injects its own
   `createResponsesRepairFetch`-shaped hook via `ApplyResponsesApiOptionsHooks` /
   `CollectManagedProvidersOptions.createResponsesRepairFetch`; this package never imports or
   implements the repair itself, and omitting the hook is a valid, inert configuration (`responseApi:
   true` still swaps the provider `npm` and stamps the placeholder key — it just leaves
   `options.fetch` untouched).

## Cross-process token safety

Several OpenCode processes (several project windows, a CLI run alongside the desktop app) can share
one cache directory. A refresh token is single-use: after a rotation, only the process that
performed it holds a usable chain — an IdP with reuse detection (RFC 6819 §5.2.2.3) revokes the
whole chain if an already-rotated refresh token is replayed, logging *every* process out.

`ProviderModelSyncEngine.ensureAccessToken` / `syncServer` therefore re-read the persisted
per-server state on **every** cached-token read — not the in-memory copy loaded once at
`initialize()`. The adoption rule (private method `readCachedToken`): the persisted state wins
unless memory is strictly newer, and it is adopted **wholesale** (token, models, rawModels,
lastSyncAt together) — a field-by-field merge would pair one process's token with another's model
list. Memory is kept when the file is missing, unreadable, invalid, strictly older, or carries no
token.

The cross-process lock, single-flight, and retry-on-rotation logic itself lives in
`@vymalo/opencode-auth-core`'s `TokenRuntime` — this package only guarantees every read the engine
makes sees the disk, not a stale in-memory snapshot. The two halves are complementary: the lock is
pointless if the holder then refreshes from a stale in-memory token, and the re-read alone still
lets two processes race into a refresh.

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

Composing the `Hooks.config` wiring:

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

See [`packages/opencode-provider-sync/README.md`](../packages/opencode-provider-sync/README.md) for
the full development/testing commands.

## Consumers

- **`@vymalo/opencode-oauth2`** (live) — `OAuth2ModelSyncPlugin` is now a thin subclass:
  `packages/opencode-oauth2/src/plugin.ts` validates oauth2's own config shape (unchanged —
  `./config.js`'s `validateConfig`) and hands the engine an already-validated config plus oauth2's
  `"opencode-oauth2"` cache segment and service label. Every symbol `opencode-oauth2`'s `lib.ts`
  exported before this extraction still exports the same name from the same subpath — no consumer
  of `@vymalo/opencode-oauth2` needs to change anything.
- **`@vymalo/opencode-lightbridge`** (live, ADR-0017) — the optional `register` block builds ONE
  `ProviderModelSyncEngine` from `auth`+`register.baseURL`, pointed at the SAME cache
  segment/namespace `opencode-oauth2` uses (`"opencode-oauth2"` /
  `"opencode-oauth2-model-sync"`) so a matching `id`/`issuer`/`clientId` shares its cache file (and
  therefore its login) with an oauth2-managed server of the same id — see
  [`docs/lightbridge.md`](lightbridge.md#register--provider-registration--model-discovery-adr-0017).
  No Responses-repair hook is injected (not needed for the gateways lightbridge currently targets).
  lightbridge's `LightbridgeRuntime` (the human-root/gateway-bearer wrapper, used whether or not
  `register` is configured) also participates in that same cache file as a lightweight, engine-free
  read/refresh-only `TokenRuntime` — see ADR-0017 for why a full second engine isn't needed for that
  half.

## Scheduler ownership (ADR-0017)

Since a second consumer can now run its own `ProviderModelSyncEngine` instance in the SAME process
against the SAME cache directory as the first (lightbridge's `register` engine alongside oauth2's,
or two of one plugin's own engines across a config hot-reload), `start()` claims a process-wide,
in-memory ownership slot keyed by `<cacheDir, serverId>` before running warmup + starting the
scheduler for each server. An instance that loses the claim skips both entirely for that server —
logged once at `debug` (`sync_scheduler_ownership_skipped`), never throws — and still serves cached
reads and on-demand `ensureAccessToken`/`syncServer` calls normally (those were already safe to run
concurrently: file-lock-coordinated refresh, idempotent GETs). `stop()` releases whatever the
instance holds. This is a generic improvement to the engine, not lightbridge-specific — it protects
any future third consumer the same way. See
[`docs/architecture.md` → Sync scheduler](architecture.md#sync-scheduler) for the fuller writeup and
[ADR-0017](adr/0017-lightbridge-all-in-one.md) for the motivating scenario.
