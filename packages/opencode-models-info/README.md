# @vymalo/opencode-models-info

> **Requires OpenCode v2.** This release targets the v2 plugin API and does not run on v1. Migrating from `0.17.x`? See [Migrating from v1](#migrating-from-v1).

OpenCode plugin that **enriches** model entries already contributed by other plugins (or by your config) with full metadata — context length, output limit, pricing, modalities, and the `tools` / `temperature` capability flags — by fetching from a provider-supplied **OpenRouter-shaped** endpoint.

Auth-agnostic by design: it registers a `model.transform` that runs on the host's model set, so it composes with `@vymalo/opencode-oauth2`, static API keys, or any other auth scheme without depending on any of them.

## Why use this

OpenCode supports rich per-model metadata (context window, USD/M-token cost, capability flags) but you usually have to handwrite it. If your provider exposes a JSON endpoint with this info (OpenRouter, LiteLLM with the OpenRouter-compat extension, your own gateway), this plugin fetches it once, merges it onto every model, caches the result, and stays out of the way.

## Installation

```sh
npm install @vymalo/opencode-models-info
```

`effect` (`^4.0.0`) is a **peer dependency** supplied by the OpenCode host — do not install a second copy.

Add it to your plugin list:

```json
{
  "plugins": ["@vymalo/opencode-models-info"]
}
```

## Usage

`settings.modelsInfoUrl` is **the HTTP(S) endpoint that returns the metadata JSON** — an absolute URL or a path resolved against `settings.baseURL`. Point it at your own provider's metadata endpoint:

```json
{
  "plugins": ["@vymalo/opencode-models-info"],
  "providers": {
    "my-provider": {
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": {
        "baseURL": "https://api.example.com/v1",
        "modelsInfoUrl": "https://api.example.com/v1/models",
        "modelsInfoTtlSeconds": 86400,
        "modelsInfoTimeoutMs": 5000
      }
    }
  }
}
```

An absolute URL is clearest. A relative path is also accepted — it resolves against `settings.baseURL` (e.g. `"models"` → `https://api.example.com/v1/models`); see [URL resolution](#url-resolution).

> **What shape must that endpoint return?** The JSON described in [Expected response shape](#expected-response-shape-openrouter) below — commonly called the **OpenRouter shape** because OpenRouter's `/models` endpoint returns it, but the plugin has no dependency on OpenRouter and never contacts it. The compatibility bar is low: a **bare top-level array** (no `data` wrapper) is accepted, and the mapping is **partial**, so your endpoint only needs to emit the fields you want enriched (e.g. just `id` + `context_length` + `pricing`). **But note:** a vanilla OpenAI-compatible `/v1/models` returns only `id` / `object` / `owned_by` — *none* of the fields this plugin maps — so pointing `modelsInfoUrl` there fetches successfully and enriches nothing. The endpoint has to actually carry the richer data.

That's it. After OpenCode starts:

1. The model transform picks up every provider with a `settings.modelsInfoUrl`.
2. It `GET`s that URL in the background, sending whatever `headers` the provider already has (so it composes with any auth plugin — see [Auth composition](#auth-composition)).
3. When the catalog lands, the plugin asks the host to `reload()` the model set, and each model whose `id` matches an entry in the response gets `limit`, `cost`, `capabilities.*` filled in — **only where they were not already set** (upstream wins; placeholders count as unset — see [Placeholder values](#placeholder-values-count-as-unset)).
4. The response is cached on disk for `modelsInfoTtlSeconds` (default 24h), keyed by `(providerId, url, modelsInfoHeaders)`. ETags are honored.
5. On fetch error with a valid cache, the stale snapshot is served — the plugin never blocks OpenCode startup on a network failure.
6. A background scheduler then keeps re-checking the endpoint on that same cadence for as long as the process runs, and a changed catalog is applied live — see [Periodic refresh](#periodic-refresh).

> **First model list vs. enriched model list.** The model transform must be synchronous, so it cannot wait for the catalog. The first run applies whatever is already in memory (nothing), starts the load, and the host re-runs the transform after `reload()`. With a warm disk cache that is effectively immediate; on a cold start the first model list a session sees is un-enriched.

### URL resolution

`modelsInfoUrl` resolves against `settings.baseURL` using standard WHATWG URL semantics:

| `baseURL`                  | `modelsInfoUrl`        | Resolved URL                          |
| -------------------------- | ---------------------- | ------------------------------------- |
| `https://x.test/v1`        | `models/info`          | `https://x.test/v1/models/info`       |
| `https://x.test/v1`        | `/models/info`         | `https://x.test/models/info`          |
| `https://x.test/v1`        | `https://o.test/m`     | `https://o.test/m`                    |

Two practical rules: drop the leading `/` to keep the metadata path under your inference API path; keep the leading `/` to escape to a different path under the same host. `Provider.Info` has no first-class base URL, so this plugin reads `settings.baseURL` — the key oauth2 / provider-sync stamp. With no `baseURL`, a relative `modelsInfoUrl` is used as written; use an absolute URL.

### Placeholder values count as unset

v2's `Model.Info` requires every field, so a plugin that discovers a model knowing only its id and name (`@vymalo/opencode-provider-sync`, behind oauth2/lightbridge) fills the rest with **sentinels meaning "unknown"**. Upstream-wins here treats those as *absent*, otherwise the models oauth2 discovers would never be enriched:

| `Model.Info` field | Sentinel (treated as absent) |
| --- | --- |
| `limit` | `{ context: 0, output: 0 }` |
| `cost` | `[]` |
| `capabilities.tools` | `false` |
| `capabilities.input` / `.output` | `[]` |
| `capabilities.temperature` | `undefined` |
| `name` | `""` |

Anything else is a real value and is never overwritten (except via [`modelsInfoOverwrite`](#forcing-endpoint-values-to-win)). Consequence: `tools: false` reads as "unknown", so a hand-set `tools: false` is not protected from a catalog that advertises tool support. Details and rationale in [`docs/models-info.md`](../../docs/models-info.md#placeholder-sentinel-values-are-absent--read-this-if-oauth2-discovers-your-models).

### Periodic refresh

Every opted-in provider also gets a background scheduler that re-fetches `modelsInfoUrl` — unconditionally (still cheap, via a conditional `ETag` request) — on the **same `modelsInfoTtlSeconds` cadence that already governs cache freshness**. There's no separate interval to configure: set `modelsInfoTtlSeconds` once and it controls both "how stale can the cache be" and "how often do we go check." Default is once a day (`86400`).

Unlike v1 (where `config` ran once and a refresh could only warm the cache for the next launch), a refresh that brings a **different** catalog now calls `ctx.model.reload()`, so a long-lived process picks the change up live. A `304` or an unchanged body does not reload. A failed check backs off (capped at the configured interval) and resumes the normal cadence once a check succeeds. Schedulers stop when a provider opts out, when its url/ttl/headers change (a fresh one starts), and when the plugin shuts down.

### Options

Per provider, on `Provider.Info.settings`:

| Setting                          | Default            | Notes                                                                 |
| -------------------------------- | ------------------ | --------------------------------------------------------------------- |
| `modelsInfoUrl`                  | _(required)_       | Absolute URL or path resolved against `settings.baseURL` (see above). |
| `modelsInfoTtlSeconds`           | `86400` (24h)      | Cache TTL — also the background refresh interval, see [Periodic refresh](#periodic-refresh). |
| `modelsInfoTimeoutMs`            | `5000`             | Per-fetch HTTP timeout.                                               |
| `modelsInfoHeaders`              | _(none)_           | Extra request headers. Override the provider's `headers` on conflict. Included in the cache key, so a tenant switch busts the cache. |
| `modelsInfoOverwrite`            | _(none)_           | Array of field names (`name`, `tools`, `temperature`, `cost`, `limit`, `input`, `output`) that the endpoint is allowed to overwrite even when already set. Opts those fields out of upstream-wins — see [Forcing endpoint values to win](#forcing-endpoint-values-to-win). Unknown names are ignored. |
| `modelsInfoHideTextOnly`         | `false`            | When `true`, makes the catalog authoritative for which models are shown: removes a model if the catalog reports it as text-in/text-out only, **or** if the catalog doesn't mention it at all — see [Hiding text-only models](#hiding-text-only-models). |
| `modelsInfoHideInternal`         | `false`            | When `true`, removes a model if the catalog reports a non-standard `internal: true` field for it. Independent of `modelsInfoHideTextOnly` — see [Hiding internal models](#hiding-internal-models). |
| `modelsInfoHideUnmatched`        | `false`            | When `true`, removes a model if the catalog has no entry for it at all — the membership half of `modelsInfoHideTextOnly`, without its modality filtering — see [Requiring a catalog entry](#requiring-a-catalog-entry). |

Plugin-level options (the plugin's entry in `plugins`):

| Option     | Default | Notes |
| ---------- | ------- | ----- |
| `logLevel` | `info`  | `trace`/`debug`/`info`/`warn`/`error` (`DEBUG` unlocks `trace`). Falls back to `OPENCODE_LOG_LEVEL`. The host's own minimum level still applies on top. |

### Auth composition

The plugin sends the union of the provider's `headers` and `settings.modelsInfoHeaders` (`modelsInfoHeaders` wins on conflict). This makes three common setups work without configuration:

1. **Public metadata endpoint** (e.g. OpenRouter's `/models`) — no auth needed.
2. **Static API key** — put a `Bearer` in the provider's `headers` once; both inference and metadata use it.
3. **OAuth2 via [`@vymalo/opencode-oauth2`](../opencode-oauth2/README.md)** — that plugin stamps the cached bearer into `Provider.Info.headers.Authorization` inside its `provider.transform`; this plugin reads it from the provider record and the metadata fetch inherits it. The chat-time path still uses freshly-refreshed tokens.

If you need a different token for the metadata endpoint than for inference (e.g. a service-account bearer), set it explicitly under `settings.modelsInfoHeaders.Authorization` — it'll override whatever the provider has set.

Because the bearer lives in a provider-domain value and this plugin reads it from the model domain, it looks in two places: the model editor's provider record, then the headers its own read-only `provider.transform` observed. List oauth2 **before** this plugin. If a fetch fails with no cache (typically HTTP 401), it is retried once a different provider header set appears.

> **Symptom of a missing credential:** the `models_info_fetch_failed_no_cache` warning with `error: "HTTP 401"`.

#### Example: with `@vymalo/opencode-oauth2`

```jsonc
{
  "plugins": ["@vymalo/opencode-oauth2", "@vymalo/opencode-models-info"],
  "providers": {
    "my-provider": {
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": {
        "baseURL": "https://api.example.com/v1",
        "modelsInfoUrl": "https://api.example.com/v1/models"
      }
    }
  }
}
```

oauth2 authenticates the provider and discovers its models; this plugin then fetches `modelsInfoUrl` using the token oauth2 stamped onto the provider headers, and enriches those discovered models. No `Authorization` header to manage — it's handled for you.

> **The displayed name.** oauth2's discovery stamps a **normalized** `name` onto each model (e.g. `kimi-k2.6` → `Kimi K2.6`). Because the merge is upstream-wins, that pre-set name blocks the endpoint's own `name` from landing. Add `"modelsInfoOverwrite": ["name"]` (next section) to let the endpoint name win.

### Forcing endpoint values to win

The merge is **upstream-wins** by default: a field already holding a real value is never overwritten, so hand-written config always takes precedence. But an upstream value isn't always hand-written — another plugin may auto-stamp one. The clearest case is oauth2's normalized `name`.

`settings.modelsInfoOverwrite` opts specific fields *out* of upstream-wins:

```jsonc
{
  "settings": {
    "modelsInfoUrl": "models/info",
    "modelsInfoOverwrite": ["name"]   // endpoint name beats oauth2's normalized one
  }
}
```

Listed fields still only change when the endpoint actually provides a value (a missing field never blanks an existing one), and unlisted fields keep the default behavior. Valid names are the mapped fields: `name`, `tools`, `temperature`, `cost`, `limit`, `input`, `output`.

> **Forcing a capability flag *off*.** `tools` and `temperature` are normally emitted *true-only*. Listing one in `modelsInfoOverwrite` also lets the endpoint assert `false` (to clear a stale `true`) — but only when the endpoint actually reports `supported_parameters`. If that data is absent the plugin can't tell true from false, so it leaves the field alone rather than inventing a `false`.

### Hiding text-only models

Some catalogs mix chat-only models in with multimodal ones, and you may only want to offer the multimodal set (vision, audio, etc.) in OpenCode's model picker. Set `modelsInfoHideTextOnly: true` to make the **`modelsInfoUrl` catalog authoritative for which models exist**, not just their metadata:

```jsonc
{ "settings": { "modelsInfoUrl": "models/info", "modelsInfoHideTextOnly": true } }
```

With the flag on, a model is **removed** from the provider in either of two cases:

1. **The catalog reports it as text-only** — `architecture.input_modalities` / `.output_modalities` are both present and resolve to exactly `["text"]`.
2. **The catalog doesn't mention it at all** — no entry in the response matches the model's `id` (or upstream `modelID`). This makes the catalog take total precedence over whatever populated the provider's models first.

A removed model can't be selected, the same as if it had never been listed. It never *adds* a model the catalog knows about but discovery/config didn't already list. Case 1 only fires when the endpoint's modality data is actually present; a matched model with no `architecture` is left alone rather than hidden on a guess. Both cases log at debug (`models_info_model_hidden_text_only`, `models_info_model_hidden_unmatched`).

### Requiring a catalog entry

Case 2 above is useful on its own, without the modality filtering. Set `modelsInfoHideUnmatched: true` to get just that:

```jsonc
{ "settings": { "modelsInfoUrl": "models/info", "modelsInfoHideUnmatched": true } }
```

- A model with no catalog entry is hidden, regardless of modality.
- A matched text-only model is left alone by this flag on its own (it's still subject to `modelsInfoHideTextOnly`'s modality check if that flag is *also* set).
- `modelsInfoHideTextOnly` and `modelsInfoHideUnmatched` reach the same removal for an unmatched model — either alone is enough, setting both is redundant, not additive.

### Hiding internal models

If your catalog serves both externally-usable and internal-only models, flag them explicitly and set `modelsInfoHideInternal: true`:

```jsonc
{ "settings": { "modelsInfoUrl": "models/info", "modelsInfoHideInternal": true } }
```

Your catalog entry adds a non-standard `internal: true` field:

```json
{ "id": "internal-only-model", "internal": true, "architecture": { "input_modalities": ["text", "image"], "output_modalities": ["text"] } }
```

**Don't reach for `modelsInfoHideTextOnly` to hide internal models** — it hides on **modality**, so a legitimate text-only *external* model gets hidden right along with your internal ones, and a multimodal internal model sails through. `modelsInfoHideInternal` reacts only to the `internal` field:

- `internal: true` + flag → hidden, regardless of modality.
- `internal` absent or `false` → never hidden by this flag.
- Unknown (`internal` absent) is left alone, not treated as `false`.

All three flags compose freely. `modelsInfoHideInternal` does **not** extend the unmatched path — that is governed by `modelsInfoHideTextOnly` or `modelsInfoHideUnmatched`. Logs at debug (`models_info_model_hidden_internal`).

### Expected response shape (OpenRouter)

```json
{
  "data": [
    {
      "id": "model-a",
      "name": "Model A",
      "context_length": 128000,
      "pricing": { "prompt": "0.000003", "completion": "0.000015" },
      "architecture": { "input_modalities": ["text", "image"], "output_modalities": ["text"] },
      "top_provider": { "max_completion_tokens": 4096 },
      "supported_parameters": ["tools", "temperature", "reasoning"]
    }
  ]
}
```

A bare top-level array (no `data` wrapper) is also accepted.

### Field mapping

| OpenRouter                                              | OpenCode `Model.Info`                                       |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `context_length` + `top_provider.max_completion_tokens` | `limit.context` / `limit.output`                            |
| `pricing.prompt` / `.completion` (USD/token)            | `cost[0].input` / `cost[0].output` (USD per 1M tokens — converted) |
| `pricing.input_cache_read` / `.input_cache_write`       | `cost[0].cache.read` / `cost[0].cache.write` (`0` when absent — required in v2) |
| `architecture.input_modalities` / `.output_modalities`  | `capabilities.input` / `capabilities.output` (filtered to `text \| audio \| image \| video \| pdf`; both sides required) |
| `supported_parameters: ["tools" or "tool_choice"]`      | `capabilities.tools: true`                                  |
| `supported_parameters: ["temperature"]`                 | `capabilities.temperature: true`                            |
| `name`                                                  | `name` (if absent)                                          |

v1's `reasoning` and `attachment` are **no longer mapped**: `Model.Info` has no field for either. A non-text `capabilities.input` is what signals attachment support in v2.

## Cache location

| OS      | Path                                                                 |
| ------- | -------------------------------------------------------------------- |
| macOS   | `~/Library/Caches/opencode-models-info/`                             |
| Linux   | `${XDG_CACHE_HOME:-~/.cache}/opencode-models-info/`                  |
| Windows | `%LOCALAPPDATA%\opencode-models-info\`                               |

Files are named by `sha256(providerId::url::modelsInfoHeaders)`, `0o600`, atomic-rename-on-write. The layout is unchanged from v1, so an existing cache is reused.

## Migrating from v1

`0.18.0` targets the OpenCode **v2** plugin API; `0.17.x` was the last v1 release. See [ADR-0019](../../docs/adr/0019-opencode-v2-cutover.md) for why there is no dual-support build.

| v1 | v2 |
| --- | --- |
| `"plugin": [...]` | `"plugins": [...]` |
| `"provider": { ... }` | `"providers": { ... }` |
| `"npm": "@ai-sdk/openai-compatible"` | `"package": "aisdk:@ai-sdk/openai-compatible"` |
| `options.baseURL` | `settings.baseURL` |
| `options.meta.modelsInfoUrl` (and `…TtlSeconds`, `…TimeoutMs`, `…Headers`, `…Overwrite`, `…HideTextOnly`, `…HideInternal`, `…HideUnmatched`) | the same keys, flat on `settings` |
| `options.headers` (read for the fetch) | `Provider.Info.headers` |
| `pluginConfig.models-info.logLevel` | the plugin's own `options.logLevel` |
| host `config.logLevel` drove the log level | `options.logLevel`, else `OPENCODE_LOG_LEVEL` |
| `config` hook awaited the fetch before models were seen | `model.transform` + `ctx.model.reload()`; first model list may be un-enriched |
| refresh only warmed the cache for the next launch | a changed catalog reloads live |
| `modelsInfoOverwrite`: `tool_call`, `modalities` | `tools`; `input` and `output` (separately) |
| `modelsInfoOverwrite`: `reasoning`, `attachment` | _removed_ — `Model.Info` has no such field |
| mapped `reasoning`, `attachment` | _removed_ (non-text `capabilities.input` implies attachments) |
| mapped `cost` object `{ input, output, cache_read?, cache_write? }` | `cost[0]` = `{ input, output, cache: { read, write } }` (cache `0` when absent) |
| mapped `modalities: { input, output }`, `tool_call` | `capabilities.input`, `capabilities.output`, `capabilities.tools` |
| "already set" = `field !== undefined` | placeholder-aware: sentinel values count as unset ([table](#placeholder-values-count-as-unset)) |

Every `models_info_*` log event name is unchanged. Records now go to the host's Effect logger (ADR-0014 still holds: nothing is written to the terminal), and are filtered a second time by the host's `MinimumLogLevel`.

## Testing

Unit tests run against mocked `fetch`:

```sh
pnpm --filter @vymalo/opencode-models-info test
```

Integration tests run against a real HTTP server (WireMock) from the workspace's shared [`test-env/`](../../test-env/) compose stack. They skip themselves when `INTEGRATION_MODELS_INFO_URL` is unset:

```sh
pnpm test:env:up                                                # from repo root
pnpm --filter @vymalo/opencode-models-info test:integration
pnpm test:env:down

# Or one-shot from repo root: spin up, run all integration suites, tear down.
pnpm test:integration
```

The integration suite exercises real network round-trips, ETag handling (`304 Not Modified`), `modelsInfoHeaders` propagation, and the disk cache — all against a fixed catalog fixture under [`test-env/wiremock/__files/openrouter-catalog.json`](../../test-env/wiremock/__files/openrouter-catalog.json).

## Library API

For embedding the enrichment logic outside the plugin (e.g. tests or custom tooling), import from the `/lib` subpath:

```ts
import {
  applyMetadata,
  createModelsInfoEngine,
  FileCacheStore,
  mapOpenRouterEntry
} from "@vymalo/opencode-models-info/lib";
```

## License

MIT
