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
- **`cache.ts`** — `resolveCacheDir` / `resolveStateDir(segment, namespace)` and the stores built on
  them (ADR-0022): `ServerCredentialStore` (the OAuth token, `<id>.json`, under the durable
  **state** root), `ModelCacheStore` (the discovered-model list, `<id>.models.json`, under the
  disposable **cache** root) and `ServerStateStore`, which merges the two into the in-memory
  `CachedServerState`. All write through auth-core's atomic `FileCacheStore` (per-writer temp +
  rename, `0o600`/`0o700`). `segment` identifies the **consuming plugin** (e.g. `"opencode-oauth2"`),
  not this package — every real consumer sets it explicitly via
  `ProviderModelSyncEngineOptions.cacheNamespaceSegment`, and the same relative path is used under
  both roots. The engine passes the credential directory to `TokenRuntime` as `stateDir`, so the
  refresh lock is `<stateDir>/locks/<id>.lock`, beside the token. Options `cacheDir` / `stateDir`
  inject exact directories (tests).
- **`scheduler.ts`** — `startScheduler`: a backoff-retrying interval runner (the retry window
  doubles per consecutive failure, capped at the configured interval).
- **`opencode-helpers.ts`** (exported from `./lib` only) — the **`ProviderEditor`** wiring a
  consumer composes inside `ctx.provider.transform` with its **own** settings-key literals:
  `collectManagedProviders`, `upsertManagedProvider` (the single add-or-update-in-place implementation —
  lightbridge's `register` module calls it rather than carrying a copy), `parsePluginOptionsServers`, `parseOAuthExtension`,
  `mergeDiscoveredModels`, `resolveCachedBearer` + `propagateCachedBearer`, `resolveProviderPackage`,
  `applyResponsesApiSettings`, `runtimeSignature`. These were private functions inside
  `opencode-oauth2`'s `opencode.ts` before the extraction, and operated on the v1 `config` object
  until the v2 cutover ([ADR-0019](adr/0019-opencode-v2-cutover.md)) — see
  [Editor-shaped helpers (v2)](#editor-shaped-helpers-v2).

## What it deliberately does not own

Three things stay with each consumer rather than being baked into the engine — see
[ADR-0016](adr/0016-provider-sync-extraction.md#decision) for the full reasoning:

1. **Settings-key literals.** Which `provider.settings.<key>` a consumer reads is passed in as the
   `settingsKeys` option, never hardcoded. `opencode-oauth2`'s are `["oauth2", "oauth2ModelSync"]`.
   The plugin's own options (`ctx.options`, v1's `pluginConfig.<key>`) are handed in by the caller
   — there is no key, because a v2 plugin's options already are its own scope.
   `opencode-lightbridge`'s `register` module takes a different shape entirely — it manages exactly
   ONE server per plugin instance, built directly from its own `auth`+`register` options rather
   than the `ctx.options.servers` / `provider.settings` channels `collectManagedProviders` reads —
   so it calls the engine and the per-provider helpers (`resolveProviderPackage`,
   `applyResponsesApiSettings`, `mergeDiscoveredModels`) directly rather than going through
   `collectManagedProviders`/`parsePluginOptionsServers`/`parseOAuthExtension`, which remain
   oauth2-only. See [ADR-0017](adr/0017-lightbridge-all-in-one.md).
2. **Auth-subset validation.** A consumer's own config module (layered on
   `@vymalo/opencode-auth-core`'s `validateAuthConfig`) normalizes and validates servers before
   constructing the engine. The engine accepts only already-validated `ProviderServerConfig`
   objects — it does no field-level validation of its own beyond "servers must be a non-empty
   array," a defensive floor rather than a validation contract to depend on.
3. **The Responses-API SSE repair.** Gateway-specific (observed: Envoy AI Gateway omitting
   `output_index`/`content_index` on Responses-API SSE frames). In v1 a consumer injected a
   `createResponsesRepairFetch` hook that this package installed as `provider.options.fetch`.
   `Provider.Info` has **no `fetch` field**, so that seam is **removed** from this package — there is
   no replacement hook here. `responseApi: true` still swaps the provider `package` and stamps the
   placeholder key; a consumer that needs the repair registers `ctx.session.hook("http.response")`
   itself (a consumer-port concern, tracked in `plans/opencode-v2.md`).

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

Composing the editor wiring inside a plugin's `ctx.provider.transform`:

```ts
import {
  collectManagedProviders,
  mergeDiscoveredModels,
  propagateCachedBearer,
  resolveCachedBearer
} from "@vymalo/opencode-provider-sync/lib";

// Effectful work happens BEFORE registering — transform callbacks are synchronous.
const bearers = new Map<string, string>(); // providerId -> "Bearer …", refreshed out of band
const stamped = new Map<string, string>(); // what propagateCachedBearer last wrote

yield* ctx.provider.transform((editor) => {
  const managed = collectManagedProviders(editor, ctx.options, logger, {
    settingsKeys: ["myPlugin", "myPluginModelSync"]
  });
  for (const server of managed.servers) {
    mergeDiscoveredModels(editor, server.id, engine.getServerModels(server.id));
    propagateCachedBearer(editor, server.id, bearers.get(server.id), logger, stamped);
  }
});

// Outside the transform: resolve a token, then ask the host to re-run transforms.
const authorization = await resolveCachedBearer("my-server", engine, logger);
if (authorization) {
  bearers.set("my-server", authorization);
  yield* ctx.provider.reload();
}
```

See [`packages/opencode-provider-sync/README.md`](../packages/opencode-provider-sync/README.md) for
the full development/testing commands.

## Editor-shaped helpers (v2)

v2 has no mutable global config object ([ADR-0019](adr/0019-opencode-v2-cutover.md)), so the v1
`OpenCodeConfig` / `OpenCodeProviderMap` / `OpenCodeProviderConfig` / `OpenCodeModelConfig` types
are gone, and every helper that took a whole `config` now takes the `ProviderEditor` a
`ctx.provider.transform(editor => …)` callback receives (`ProviderEditor` is re-exported here as a
type; `ProviderInfo` / `ModelInfo` alias `Provider.Info` / `Model.Info`). An editor is only valid
inside that callback, and the callback must stay synchronous and cheap.

| v1 | v2 |
| --- | --- |
| `collectManagedProviders(config, logger, { pluginConfigKey, optionKeys, createResponsesRepairFetch })` | `collectManagedProviders(editor, ctx.options, logger, { settingsKeys })` |
| `parsePluginConfigServers(config, logger, { pluginConfigKey })` | `parsePluginOptionsServers(ctx.options, logger)` — reads `options.servers` |
| `parseOAuthExtension(provider, { optionKeys })` reading `provider.options.<key>` | `parseOAuthExtension(provider, { settingsKeys })` reading `provider.settings.<key>` |
| `resolveProviderNpm(responseApi)` → `"@ai-sdk/openai-compatible"` | `resolveProviderPackage(responseApi)` → `"aisdk:@ai-sdk/openai-compatible"` |
| `applyResponsesApiOptions(options, …, { createResponsesRepairFetch })` | `applyResponsesApiSettings(settings, responseApi, providerId, logger)` — no `fetch` |
| `mergeDiscoveredModels(providerConfig, models)` | `mergeDiscoveredModels(editor, providerId, models)` |
| `propagateCachedBearer(providerConfig, id, runtime, logger)` (async) | `resolveCachedBearer(id, runtime, logger)` (async, outside the transform) **+** `propagateCachedBearer(editor, id, authorization, logger, stamped?)` (sync, inside it) |

Field mapping from v1 `provider.options`:

| v1 | v2 |
| --- | --- |
| `npm` | `Provider.Info.package`, `aisdk:`-prefixed |
| `options.baseURL`, `options.apiKey` | `Provider.Info.settings.baseURL` / `.apiKey` (open struct, handed to the provider package) |
| `options.headers` | `Provider.Info.headers` |
| `options.fetch` | none — dropped (see [Responses-API SSE repair](#what-it-deliberately-does-not-own)) |
| `options.oauth2` / `options.oauth2ModelSync` opt-in | `settings.oauth2` / `settings.oauth2ModelSync` |
| `pluginConfig.oauth2ModelSync.servers` | the plugin's own `options.servers` |
| model `{ id, name }` | `Model.Info` with `id` **and** `modelID`, `name`, plus `Model.Info.default(…)` values for every field v2 requires |

A newly added provider (from `options.servers`) gets `activation: "enabled"`: the gateway bearer is
injected per request, not held as a host connection, so `"auto"` could leave it inactive. A provider
the user already declared keeps its own `activation`, `id` and unrelated fields.

**Discovered models carry sentinels, not defaults.** `Model.Info` requires `limit`, `capabilities`,
`cost`, `status`, `enabled`, `time` and `variants`, which v1 left absent until
`@vymalo/opencode-models-info` filled them in. `mergeDiscoveredModels` creates models via
`discoveredModelPlaceholder`: only `id`/`modelID`/`providerID`/`name` are real; the rest are values
that mean "unknown" and cannot be mistaken for data (unlike `Model.Info.default(...)`'s 200k context
and text+image modalities):

| Field | Sentinel = "not known" |
| --- | --- |
| `limit` | `{ context: 0, output: 0 }` (the same zero v1's host backfilled) |
| `cost` | `[]` |
| `capabilities.tools` | `false` (models-info's mapper only ever sets `true`) |
| `capabilities.input` / `.output` | `[]` |
| `time.released` | `0` |

models-info's upstream-wins merge should treat exactly these as absent. Unverified: whether the host
tolerates empty modalities / a zero limit on a model that never gets enriched. `ProviderEditor.models.set`
replaces a provider's whole model list, so the helper writes the union of existing and discovered
models in one call; existing models keep every field except `name`, which discovery still overwrites
(as in v1).

### The `Authorization` handoff to models-info (v2 contract)

v1 stamped a bearer on `provider.options.headers.Authorization` at `config` time so that
`@vymalo/opencode-models-info`, whose `config` hook ran later, could reuse it to fetch an
OAuth-protected `modelsInfoUrl`. The coupling survives, relocated:

- **Where.** `Provider.Info.headers["Authorization"]` on the managed provider, value
  `"<tokenType || 'Bearer'> <accessToken>"`. Not `settings`, not `body`; `Provider.Info` has no
  `options`.
- **Who writes it.** The plugin that owns the managed provider (oauth2, or lightbridge's `register`
  module), inside its `ctx.provider.transform`, via `propagateCachedBearer`. Only managed
  providers are touched.
- **Never overwrites the user.** An `Authorization` header — matched case-insensitively — that the
  user declared always wins, and is logged as `oauth2_bearer_propagation_skipped_user_set`. The
  optional `stamped` map lets the helper recognise (and refresh) a value it wrote on an earlier pass,
  so refresh works whether or not the host hands each transform pass a fresh editor. (Defensive:
  the published types do not say which; unverified.)
- **Freshness.** The token is resolved *outside* the transform by `resolveCachedBearer` — a
  refresh-only, non-interactive `ensureAccessToken` (a near-expiry token is refreshed; anything
  needing a fresh login is skipped, `oauth2_bearer_propagation_skipped_no_token`). The owner caches
  the string and calls `ctx.provider.reload()` when it changes. If no token can be had, the header is
  simply **absent** — the consumer must treat absence as "no credential", not as an error.
- **Inference is unaffected.** The real per-request bearer is set by the owner's
  `session.hook("model.request")`; a stale header here can only ever affect a metadata fetch.
- **Ordering.** The v1 guarantee ("list oauth2 before models-info in `plugin`") came from
  config-hook order. In v2, *within one domain* a later transform sees an earlier one's changes
  (registration order); *across* domains the provider pipeline feeds the model pipeline. models-info
  registers on the **model** domain, so it must read the header from the provider record
  (`ModelEditor.provider.get(id)?.provider.headers`, or the provider domain's `list()`), never from
  its own state.
- **Consumer obligations (models-info port).** (1) Look the header up case-insensitively. (2) Its own
  explicit credential setting (the successor of `meta.modelsInfoHeaders`) overrides it on conflict,
  exactly as in v1. (3) Transform callbacks are synchronous, so the catalog must be fetched
  *before* the model transform is registered/reloaded, using the header value as observed from the
  provider domain at that time — and the fetch must be re-run (`ctx.model.reload()`) after the
  owner's `ctx.provider.reload()` if it failed with a 401 the first time.

> **Unverified against the host.** Whether `ModelEditor.provider` reflects the *output* of provider
> transforms (rather than only the pre-transform inputs its doc comment calls "immutable provider
> inputs") could not be confirmed from the published `@opencode/plugin@2.2.6` type definitions. The
> models-info port should verify this against a running host before relying on it, and fall back to
> reading the provider domain's `list()` if it does not.

## Consumers

> Both consumers have been ported to the v2 editor-shaped helpers (oauth2: [ADR-0020](adr/0020-oauth2-integration-domain.md);
> lightbridge: `packages/opencode-lightbridge/src/opencode.ts`). Both run the engine in a queued
> background build and call `ctx.provider.reload()` when models or a bearer arrive; the transform
> callbacks themselves stay synchronous.

- **`@vymalo/opencode-oauth2`** (live) — `OAuth2ModelSyncPlugin` is a thin subclass over the engine
  and uses the full helper set (`collectManagedProviders`, `mergeDiscoveredModels`,
  `resolveCachedBearer` + `propagateCachedBearer`, `runtimeSignature`), marking every provider it
  manages with `settings.oauth2` so other plugins can see it.
  `packages/opencode-oauth2/src/plugin.ts` validates oauth2's own config shape
  (`./config.js`'s `validateConfig`) and hands the engine an already-validated config plus oauth2's
  `"opencode-oauth2"` cache segment and service label.
- **`@vymalo/opencode-lightbridge`** (live, ADR-0017) — the optional `register` block builds ONE
  `ProviderModelSyncEngine` from `auth`+`register.baseURL`, and applies it with the per-provider
  helpers directly (`resolveProviderPackage`, `applyResponsesApiSettings`, `mergeDiscoveredModels`,
  `resolveCachedBearer` + `propagateCachedBearer`) — not `collectManagedProviders`, which is
  oauth2-only. It skips entirely when the provider record already carries oauth2's
  `settings.oauth2` marker. The engine is pointed at the SAME cache
  segment/namespace `opencode-oauth2` uses (`"opencode-oauth2"` /
  `"opencode-oauth2-model-sync"`) so a matching `id`/`issuer`/`clientId` shares its credential file (and
  therefore its login) with an oauth2-managed server of the same id — see
  [`docs/lightbridge.md`](lightbridge.md#register--provider-registration--model-discovery-adr-0017).
  No Responses-repair hook is injected (not needed for the gateways lightbridge currently targets).
  lightbridge's `LightbridgeRuntime` (the human-root/gateway-bearer wrapper, used whether or not
  `register` is configured) also participates in that same credential file as a lightweight, engine-free
  read/refresh-only `TokenRuntime` (it never touches the model record) — see ADR-0017 for why a full second engine isn't needed for that
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
