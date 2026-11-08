# Models Info Plugin — Plan

> **Historical design record (OpenCode v1).** Written against the v1 plugin API (`Hooks.*`, `chat.headers`, `options.meta.*`, `pluginConfig`, `provider.options.fetch`). The suite is now v2-only ([ADR-0019](../docs/adr/0019-opencode-v2-cutover.md)); read those names as the v1 design, and see [`docs/models-info.md`](../docs/models-info.md) for current behaviour and config.

## Name

`@vymalo/opencode-models-info`

## Summary

A second, **independent** OpenCode plugin that enriches the model listings already contributed by other plugins (or by the user's static `opencode.json`) with full metadata — context length, output limit, pricing, modalities, tool-call / reasoning / attachment capability flags — by fetching from a provider-supplied `modelsInfoUrl`. Auth-agnostic: it reuses whatever `headers` the provider config has already been resolved with by the time OpenCode runs the `config` hook, so it composes naturally with `@vymalo/opencode-oauth2`, static API keys, or any other auth scheme.

## Why a separate plugin

* The oauth2 plugin's job is authentication + discovery (provider/model **identity**). Metadata enrichment is a different concern (model **attributes**) and is useful even for providers that don't need OAuth2.
* Splitting keeps both plugins single-purpose, smaller blast radius, and lets users opt into one without the other.

## Non-goals

* No auth code. Authentication is the upstream plugin's job (or static config). We send whatever `headers`/auth the resolved provider config already carries.
* No model discovery (provider/model list). We only **enrich** entries that already exist after the `config` hook chain.
* No live cost telemetry, billing, or usage tracking — only the static metadata the provider advertises.

## Design

### Hook

Register `Hooks.config` (signature `(input: SDKConfig) => Promise<void>`). The host calls every plugin's `config` hook in registration order; by the time we run, the oauth2 plugin (or any other) has already populated `input.provider[*]`. We mutate the config in place to add metadata fields.

### Opt-in per provider

A provider opts in by setting `options.meta.modelsInfoUrl` (and optionally `options.meta.modelsInfoTtlSeconds`, `options.meta.modelsInfoHeaders`) in its OpenCode provider config. Providers without `meta.modelsInfoUrl` are left untouched.

* `modelsInfoUrl: string` — required. Absolute URL or path relative to `options.baseURL`.
* `modelsInfoTtlSeconds?: number` — cache TTL. Default `86400` (24h).
* `modelsInfoHeaders?: Record<string,string>` — extra headers merged onto the fetch (rare; for endpoints that need a different auth shape than the inference endpoint).
* `modelsInfoFormat?: "openrouter"` — reserved for future schema variants; defaults to `"openrouter"`.

### Endpoint contract (OpenRouter shape)

```json
{ "data": [
  {
    "id": "model-a",
    "name": "Model A",
    "context_length": 128000,
    "pricing": {
      "prompt":     "0.000003",   // USD per token
      "completion": "0.000015",
      "input_cache_read":  "0",
      "input_cache_write": "0"
    },
    "architecture": {
      "input_modalities":  ["text", "image"],
      "output_modalities": ["text"],
      "tokenizer": "..."
    },
    "top_provider": { "max_completion_tokens": 4096 },
    "supported_parameters": ["tools", "tool_choice", "temperature", "reasoning", "..."]
  }
] }
```

Single batched GET — no N+1. If the server returns a bare array (no `data` wrapper) we accept that too.

### Mapping → OpenCode `ProviderConfig.models[id]`

| OpenRouter field                                           | OpenCode field          | Conversion                                                                                                       |
| ---------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `context_length`                                           | `limit.context`         | as-is                                                                                                            |
| `top_provider.max_completion_tokens`                       | `limit.output`          | as-is                                                                                                            |
| `pricing.prompt`                                           | `cost.input`            | `parseFloat(str) * 1_000_000` (OpenCode cost fields are USD per **1M tokens**)                                   |
| `pricing.completion`                                       | `cost.output`           | × 1M                                                                                                              |
| `pricing.input_cache_read`                                 | `cost.cache_read`       | × 1M                                                                                                              |
| `pricing.input_cache_write`                                | `cost.cache_write`      | × 1M                                                                                                              |
| `architecture.input_modalities`                            | `modalities.input`      | filter to OpenCode's enum                                                                                        |
| `architecture.output_modalities`                           | `modalities.output`     | same                                                                                                             |
| `supported_parameters.includes("tools")`                   | `tool_call`             | boolean                                                                                                          |
| `supported_parameters.includes("reasoning")`               | `reasoning`             | boolean                                                                                                          |
| `architecture.input_modalities.includes("image"\|"pdf"…)`  | `attachment`            | boolean                                                                                                          |
| `supported_parameters.includes("temperature")`             | `temperature`           | boolean (when explicitly listed)                                                                                 |
| `name`                                                     | `name`                  | only if existing entry has no `name`                                                                              |

**Merge policy:** for every field we map, we only write if the existing value is `undefined` (i.e. upstream wins). Idempotent — running twice is a no-op.

### Cache

* Mirror oauth2's `FileCacheStore` pattern: per-OS cache dir (`~/Library/Caches/opencode-models-info/` on macOS, `XDG_CACHE_HOME` on Linux, `LOCALAPPDATA` on Windows).
* Key = sha256 of `(providerId + "::" + resolvedUrl)`, file `<key>.json`.
* Shape: `{ fetchedAt, ttlSeconds, etag?, raw }`.
* Read flow:
  * If cache hit AND not expired → use it; no network.
  * If expired or miss → fetch with conditional `If-None-Match` if etag stored. On `304`, bump `fetchedAt`. On `200`, write new file (atomic rename, `0o600`).
  * If fetch fails AND stale cache exists → **serve stale**, log a warning, schedule background refresh on next run. Never block the config hook on a network error.
* In-memory L1 keyed the same way for the lifetime of the process (avoids re-reading the same JSON if multiple providers point at the same URL).

### Timeouts & failure modes

* Per-fetch timeout: default 5s, override via `options.meta.modelsInfoTimeoutMs`.
* All errors are caught per provider — one bad endpoint does not block other providers' enrichment.
* Logging via the host's `config.logLevel` (same mapping helper as oauth2 — copy or re-export).

## Package layout

```
packages/opencode-models-info/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── src/
│   ├── index.ts            # OpenCode entry — re-exports default plugin from opencode.ts
│   ├── opencode.ts         # Plugin factory, registers Hooks.config
│   ├── plugin.ts           # Core enrichment logic (provider-iteration, merge)
│   ├── fetcher.ts          # HTTP fetch with timeout + etag
│   ├── cache.ts            # Disk + in-memory TTL cache (mirrors oauth2 cache.ts)
│   ├── mapping.ts          # OpenRouter → OpenCode ModelConfig field mapping
│   ├── config.ts           # Validate per-provider opts (meta.modelsInfoUrl, ttl, etc.)
│   ├── logging.ts          # Re-export from @vymalo/opencode-oauth2/lib if cheap, else copy
│   └── types.ts            # OpenRouter response shape + cache record shape
└── test/
    ├── mapping.test.ts
    ├── cache.test.ts
    └── plugin.test.ts      # Hook integration with a fake config object
```

`logging.ts` — copy the small `LogLevel`/`createJsonConsoleLogger` shape rather than introduce a workspace dependency on the oauth2 package. Keeps the new plugin standalone and trivially publishable.

## Steps

1. Scaffold package — `package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md` stub. Workspace pickup is automatic via `packages/*`.
2. `types.ts` — OpenRouter response + cache record.
3. `config.ts` — `parseMetaOptions(providerOptions)` → typed opts or `null` (opted out). Validation.
4. `mapping.ts` — pure functions: `mapOpenRouterEntry(entry) → Partial<ModelConfigFields>` + `mergeIntoModel(existing, mapped)` (upstream-wins). Pure → easy to unit test.
5. `cache.ts` — `FileCacheStore` with `get(key)`, `put(key, record)`, TTL check, in-memory L1.
6. `fetcher.ts` — `fetchOpenRouterModels(url, {headers, timeoutMs, etag})` → `{ status, etag?, data?, raw? }`.
7. `plugin.ts` — `enrichConfig(input, deps)`:
   * For each provider in `input.provider`:
     * `opts = parseMetaOptions(provider.options)`; if null, skip.
     * `record = await cacheGetOrFetch(opts, provider)`.
     * For each model in `provider.models`, look up the same id in `record.data`, run `mergeIntoModel`.
   * Run providers in parallel (`Promise.allSettled`).
8. `opencode.ts` — `createPlugin(opts?)` → returns a function matching `Plugin` signature, exposing `{ config }` hook. Honors host `config.logLevel`.
9. `index.ts` — `export { default } from "./opencode.js";` (matches oauth2 layout for OpenCode's discovery contract).
10. Tests — mapping (rounding, modality filter, missing fields), cache (TTL expiry, atomic write), plugin (fake config in, mutated config out, stale-on-error fallback).
11. Plugin bundle integration — add to `packages/plugin-bundle` exports / docs if applicable.
12. README — usage example showing `options.meta.modelsInfoUrl` in `opencode.json`.
13. Workspace touchups — `pnpm install` (if needed for new deps; aim for zero — `@opencode-ai/plugin` is the only runtime dep, same as oauth2).
14. `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm lint`. Fix anything red.
15. Single commit on `main` (per user instruction — no PR).

## Open questions for later (not blocking v0)

* If `modelsInfoUrl` is **relative** to `baseURL`, we resolve via `new URL(rel, baseURL).toString()`. Document this.
* OpenRouter's `pricing.request` (per-request) and `pricing.image` — no OpenCode field for these yet; ignore in v0, easy to add later.
* `release_date`, `experimental`, `status` ("alpha"|"beta"|"deprecated") — OpenRouter has no direct equivalent; leave to upstream.
* Future: a `provider` hook to re-enrich at runtime if OpenCode ever exposes one (today only `config` is contributor-time).
