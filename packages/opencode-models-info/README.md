# @vymalo/opencode-models-info

OpenCode plugin that **enriches** model entries already contributed by other plugins (or by your `opencode.json`) with full metadata — context length, output limit, pricing, modalities, and capability flags (`tool_call`, `reasoning`, `attachment`) — by fetching from a provider-supplied **OpenRouter-shaped** endpoint.

Auth-agnostic by design: the plugin runs as an OpenCode `config` hook *after* other plugins have populated providers and headers, so it composes with `@vymalo/opencode-oauth2`, static API keys, or any other auth scheme without depending on any of them.

## Why use this

OpenCode supports rich per-model metadata (context window, USD/M-token cost, tool-call/reasoning/attachment flags) but you usually have to handwrite it in `opencode.json`. If your provider exposes a JSON endpoint with this info (OpenRouter, LiteLLM with the OpenRouter-compat extension, your own gateway), this plugin fetches it once, merges it onto every model, caches the result, and stays out of the way.

## Installation

```sh
npm install @vymalo/opencode-models-info
```

Add it to your `opencode.json` plugin list:

```json
{
  "plugin": ["@vymalo/opencode-models-info"]
}
```

## Usage

`meta.modelsInfoUrl` is **the HTTP(S) endpoint that returns the metadata JSON** — an absolute URL or a path resolved against `options.baseURL`. Point it at your own provider's metadata endpoint:

```json
{
  "plugin": ["@vymalo/opencode-models-info"],
  "provider": {
    "my-provider": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://api.example.com/v1",
        "meta": {
          "modelsInfoUrl": "https://api.example.com/v1/models",
          "modelsInfoTtlSeconds": 86400,
          "modelsInfoTimeoutMs": 5000
        }
      },
      "models": { "my-model-large": {} }
    }
  }
}
```

An absolute URL is clearest. A relative path is also accepted — it resolves against `baseURL` (e.g. `"models"` → `https://api.example.com/v1/models`); see [URL resolution](#url-resolution).

> **What shape must that endpoint return?** The JSON described in [Expected response shape](#expected-response-shape-openrouter) below — commonly called the **OpenRouter shape** because OpenRouter's `/models` endpoint returns it, but the plugin has no dependency on OpenRouter and never contacts it. The compatibility bar is low: a **bare top-level array** (no `data` wrapper) is accepted, and the mapping is **partial**, so your endpoint only needs to emit the fields you want enriched (e.g. just `id` + `context_length` + `pricing`). **But note:** a vanilla OpenAI-compatible `/v1/models` returns only `id` / `object` / `owned_by` — *none* of the fields this plugin maps — so pointing `modelsInfoUrl` there fetches successfully and enriches nothing. The endpoint has to actually carry the richer data.

That's it. After OpenCode starts:

1. The hook picks up every provider with a `meta.modelsInfoUrl`.
2. It `GET`s that URL once, sending whatever `options.headers` the provider already has (so it composes with any auth plugin — see [Auth composition](#auth-composition)).
3. Each model entry whose `id` matches an entry in the response gets `limit`, `cost`, `modalities`, `tool_call`, `reasoning`, `attachment`, etc. filled in — **only where they were not already set** (upstream wins).
4. The response is cached on disk for `modelsInfoTtlSeconds` (default 24h), keyed by `(providerId, url, modelsInfoHeaders)`. ETags are honored.
5. On fetch error with a valid cache, the stale snapshot is served — the plugin never blocks OpenCode startup on a network failure.

### URL resolution

`meta.modelsInfoUrl` resolves against `options.baseURL` using standard WHATWG URL semantics:

| `baseURL`                  | `modelsInfoUrl`        | Resolved URL                          |
| -------------------------- | ---------------------- | ------------------------------------- |
| `https://x.test/v1`        | `models/info`          | `https://x.test/v1/models/info`       |
| `https://x.test/v1`        | `/models/info`         | `https://x.test/models/info`          |
| `https://x.test/v1`        | `https://o.test/m`     | `https://o.test/m`                    |

Two practical rules: drop the leading `/` to keep the metadata path under your inference API path; keep the leading `/` to escape to a different path under the same host.

### Options

| Option                          | Default            | Notes                                                                 |
| ------------------------------- | ------------------ | --------------------------------------------------------------------- |
| `meta.modelsInfoUrl`            | _(required)_       | Absolute URL or path resolved against `options.baseURL` (see above). |
| `meta.modelsInfoTtlSeconds`     | `86400` (24h)      | Cache TTL.                                                            |
| `meta.modelsInfoTimeoutMs`      | `5000`             | Per-fetch HTTP timeout.                                               |
| `meta.modelsInfoHeaders`        | _(none)_           | Extra request headers. Override `options.headers` on conflict. Included in the cache key, so a tenant switch busts the cache. |
| `meta.modelsInfoOverwrite`      | _(none)_           | Array of field names (`name`, `attachment`, `reasoning`, `temperature`, `tool_call`, `cost`, `limit`, `modalities`) that the endpoint is allowed to overwrite even when already set. Opts those fields out of upstream-wins — see [Forcing endpoint values to win](#forcing-endpoint-values-to-win). Unknown names are ignored. |
| `meta.modelsInfoHideTextOnly`   | `false`             | When `true`, makes the `modelsInfoUrl` catalog authoritative for which models are shown: drops a model from `provider.models` entirely if the catalog reports it as text-in/text-out only, **or** if the catalog doesn't mention it at all — see [Hiding text-only models](#hiding-text-only-models). |

### Auth composition

The plugin sends the union of `options.headers` and `meta.modelsInfoHeaders` (meta wins on conflict). This makes three common setups work without configuration:

1. **Public metadata endpoint** (e.g. OpenRouter's `/models`) — no auth needed.
2. **Static API key** — drop a `Bearer` into `options.headers` once, both inference and metadata use it.
3. **OAuth2 via [`@vymalo/opencode-oauth2`](../opencode-oauth2/README.md) ≥ 0.4.0** — that plugin stamps the cached bearer into `options.headers.Authorization` at config time so the metadata fetch inherits it automatically. The chat-time path still uses freshly-refreshed tokens.

If you need a different token for the metadata endpoint than for inference (e.g. a service-account bearer), set it explicitly under `meta.modelsInfoHeaders.Authorization` — it'll override whatever the provider has set.

#### Example: with `@vymalo/opencode-oauth2`

List the oauth2 plugin **first** so its `config` hook runs before this one — that's what puts the bearer on `options.headers` in time for the metadata fetch:

```jsonc
{
  "plugin": ["@vymalo/opencode-oauth2", "@vymalo/opencode-models-info"],
  "provider": {
    "my-provider": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://api.example.com/v1",
        "oauth2": {
          "issuer": "https://auth.example.com",
          "clientId": "opencode-client",
          "scopes": ["openid", "profile", "offline_access"]
        },
        "meta": { "modelsInfoUrl": "https://api.example.com/v1/models" }
      }
    }
  }
}
```

oauth2 authenticates the provider and discovers its models; this plugin then fetches `modelsInfoUrl` using the token oauth2 stamped onto the provider headers, and enriches those discovered models. No `models` block and no `Authorization` header to manage — both are handled for you.

> **The displayed name.** oauth2's discovery stamps a **normalized** `name` onto each model (e.g. `kimi-k2.6` → `Kimi K2.6`). Because the merge is upstream-wins, that pre-set name blocks the endpoint's own `name` from landing — so the UI shows the normalized label, not the one your metadata endpoint returns. Add `"modelsInfoOverwrite": ["name"]` (next section) to let the endpoint name win.

### Forcing endpoint values to win

The merge is **upstream-wins** by default: a field already present on a model entry is never overwritten, so a handwritten `opencode.json` always takes precedence. But an upstream value isn't always handwritten — another plugin may auto-stamp one. The clearest case is `@vymalo/opencode-oauth2`, which writes a normalized `name` onto every discovered model; to upstream-wins that's indistinguishable from a deliberate user value, so the endpoint's `name` can never replace it.

`meta.modelsInfoOverwrite` opts specific fields *out* of upstream-wins:

```jsonc
{
  "options": {
    "meta": {
      "modelsInfoUrl": "models/info",
      "modelsInfoOverwrite": ["name"]   // endpoint name beats oauth2's normalized one
    }
  }
}
```

Listed fields still only change when the endpoint actually provides a value (a missing field never blanks an existing one), and unlisted fields keep the default upstream-wins behavior. Valid names are the mapped fields: `name`, `attachment`, `reasoning`, `temperature`, `tool_call`, `cost`, `limit`, `modalities`.

> **Forcing a capability flag *off*.** The boolean flags (`tool_call`, `reasoning`, `temperature`, `attachment`) are normally emitted *true-only*. Listing one in `modelsInfoOverwrite` also lets the endpoint assert `false` (to clear a stale `true`) — but only when the endpoint actually reports the underlying data (`supported_parameters`, or `architecture.input_modalities` for `attachment`). If that data is absent the plugin can't tell true from false, so it leaves the field alone rather than inventing a `false`.

### Hiding text-only models

Some catalogs mix chat-only models in with multimodal ones, and you may only want to offer the multimodal set (vision, audio, etc.) in OpenCode's model picker. Set `meta.modelsInfoHideTextOnly: true` to make the **`modelsInfoUrl` catalog authoritative for which models exist**, not just their metadata:

```jsonc
{
  "options": {
    "meta": {
      "modelsInfoUrl": "models/info",
      "modelsInfoHideTextOnly": true
    }
  }
}
```

With the flag on, a model's entry is **deleted** from `provider.models` outright in either of two cases:

1. **The catalog reports it as text-only** — `architecture.input_modalities` / `.output_modalities` are both present and resolve to exactly `["text"]`.
2. **The catalog doesn't mention it at all** — no entry in the `modelsInfoUrl` response matches the model's `id` (or declared `id`). This is what makes the catalog take total precedence over whatever populated `provider.models` first (a static `opencode.json`, or `@vymalo/opencode-oauth2`'s own `/v1/models` discovery) — anything the richer catalog doesn't vouch for is dropped, not just left un-enriched.

This is a hard delete, not a flag — a hidden model can't be selected at all, the same as if it had never been listed in `models` to begin with. It never *adds* a model the catalog knows about but discovery/config didn't already list — only membership already present in `provider.models` can be pruned. Case 1 only fires when the endpoint's modality data is actually present; a model the plugin can't classify (missing `architecture`) but that *is* matched in the catalog is left alone rather than hidden on a guess. Case 2 fires purely on absence from the catalog, independent of modality data. Both cases log at debug (`models_info_model_hidden_text_only`, `models_info_model_hidden_unmatched`) and are reflected in the `hiddenCount` on the summary `models_info_enriched` event.

> **Composes with `modelsInfoOverwrite`.** Turning on `modelsInfoHideTextOnly` doesn't change how surviving models are merged — upstream-wins (or your `modelsInfoOverwrite` list) still governs individual fields. It only changes which model entries survive to be merged at all.

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

| OpenRouter                                              | OpenCode                  |
| ------------------------------------------------------- | ------------------------- |
| `context_length` + `top_provider.max_completion_tokens` | `limit.context` / `limit.output` |
| `pricing.prompt` / `.completion` (USD/token)            | `cost.input` / `cost.output` (USD per 1M tokens — converted) |
| `pricing.input_cache_read` / `.input_cache_write`       | `cost.cache_read` / `cost.cache_write` |
| `architecture.input_modalities` / `.output_modalities`  | `modalities.input` / `modalities.output` (filtered to OpenCode's enum) |
| `supported_parameters: ["tools" or "tool_choice"]`      | `tool_call: true`         |
| `supported_parameters: ["reasoning" / "thinking" / …]`  | `reasoning: true`         |
| `supported_parameters: ["temperature"]`                 | `temperature: true`       |
| Non-text input modality present                         | `attachment: true`        |
| `name`                                                  | `name` (if absent)        |

## Cache location

| OS      | Path                                                                 |
| ------- | -------------------------------------------------------------------- |
| macOS   | `~/Library/Caches/opencode-models-info/`                             |
| Linux   | `${XDG_CACHE_HOME:-~/.cache}/opencode-models-info/`                  |
| Windows | `%LOCALAPPDATA%\opencode-models-info\`                               |

Files are named by `sha256(providerId::url)`, `0o600`, atomic-rename-on-write.

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

For embedding the enrichment logic outside an OpenCode hook (e.g. tests or custom tooling), import from the `/lib` subpath:

```ts
import { enrichConfig, FileCacheStore, createJsonConsoleLogger } from "@vymalo/opencode-models-info/lib";
```

## License

MIT
