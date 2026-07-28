# Model metadata enrichment

How `@vymalo/opencode-models-info` runs inside OpenCode: the hooks it registers, how it composes with any auth scheme, where it caches, how it stays fresh over a long-lived process, and what happens when the metadata endpoint misbehaves.

For the copy-paste config reference (every option, the full OpenRouter→OpenCode field-mapping table), see the package README: [`packages/opencode-models-info/README.md`](../packages/opencode-models-info/README.md). This page is for the adopter who needs to reason about composition and failure modes. The original design rationale lives in [`plans/models-info-plan.md`](../plans/models-info-plan.md).

## What it does

OpenCode supports rich per-model metadata — context window, output limit, USD-per-1M-token cost, and `tool_call` / `reasoning` / `attachment` capability flags — but you normally hand-write it in `opencode.json`. If your provider exposes an OpenRouter-shaped `/models` endpoint, this plugin fetches it once, merges the metadata onto your model entries, caches the result, and stays out of the way.

You point the plugin at that endpoint with `options.meta.modelsInfoUrl` — **the HTTP(S) URL (absolute, or a path resolved against `options.baseURL`) that returns the metadata JSON**: `{ "data": [ { "id", "context_length", "pricing", … } ] }`. This JSON is commonly called the **OpenRouter shape** (it's what OpenRouter's `/models` returns), but the plugin has no dependency on OpenRouter and never contacts it — any endpoint that returns the shape works: a self-hosted gateway, a LiteLLM proxy, or a custom metadata route. The compatibility bar is low: a bare top-level array (no `data` wrapper) is accepted, and the field mapping is partial, so an endpoint only needs to emit the fields you want enriched.

> **Not the vanilla `/v1/models`.** A standard OpenAI-compatible `/v1/models` returns only `id` / `object` / `owned_by` — none of the fields this plugin maps. Pointing `modelsInfoUrl` at it fetches successfully and enriches nothing. The URL must return the richer OpenRouter shape.

It is **auth-agnostic** and does **not** depend on `@vymalo/opencode-oauth2`. It only mutates the already-assembled OpenCode config, so it works with static API keys, oauth2, or no auth at all.

## The hooks

The plugin registers two OpenCode hooks: `config` (plugin load) and `dispose` (plugin teardown, used only to stop the background refresh scheduler below). Source: [`packages/opencode-models-info/src/opencode.ts`](../packages/opencode-models-info/src/opencode.ts).

Because the host runs every plugin's `config` hook in registration order, by the time this one fires, other plugins (oauth2, or your static config) have already populated `config.provider[*]` — including `options.headers`. The hook then, for every provider:

1. **Opts in or skips.** Reads `options.meta.modelsInfoUrl`. No URL → the provider is left untouched. Safe to enable globally.
2. **Resolves the URL** against `options.baseURL` (see [URL resolution](#url-resolution)).
3. **Loads the catalog** — from the on-disk cache if fresh, otherwise fetches (see [Caching](#caching-and-failure-modes)).
4. **Merges** derived metadata onto each model whose `id` (or declared `id`) matches an entry in the catalog. The merge is **upstream-wins**: any field already set on the model entry is never overwritten. Running the hook twice is a no-op. Fields listed in `meta.modelsInfoOverwrite` are exempt — see [Overriding upstream-wins](#overriding-upstream-wins).
5. **(Re)starts the background refresh scheduler** for each opted-in provider — see [Periodic refresh](#periodic-refresh).

Providers run in parallel (`Promise.allSettled`); one bad endpoint never blocks another's enrichment, and any unexpected throw is surfaced as a `models_info_enrichment_failed` log event rather than silently swallowed.

## Overriding upstream-wins

Upstream-wins assumes a value already on a model entry is there on purpose — typically a handwritten `opencode.json`. That assumption breaks when **another plugin auto-stamps a field**. The canonical case: `@vymalo/opencode-oauth2`'s model discovery writes a *normalized* `name` (`kimi-k2.6` → `Kimi K2.6`) onto every model before this hook runs, so the endpoint's own `name` is frozen out and the UI shows the normalized label instead of what your metadata endpoint returns.

`meta.modelsInfoOverwrite` is the escape hatch — an array of field names that the endpoint may overwrite even when already set:

```jsonc
{
  "options": {
    "baseURL": "https://api.example.com/v1",
    "meta": {
      "modelsInfoUrl": "models/info",
      "modelsInfoOverwrite": ["name"]
    }
  }
}
```

- Only the **mapped fields** are valid: `name`, `attachment`, `reasoning`, `temperature`, `tool_call`, `cost`, `limit`, `modalities`. Unknown names are silently ignored (so a typo can't clobber an unrelated field).
- An overwrite field still only changes when the endpoint **actually provides** a value — a missing field never blanks an existing one.
- Unlisted fields keep the default upstream-wins behavior, so a handwritten override you *do* want to keep stays safe.

**Capability flags can be forced *off*, but only when the endpoint reports them.** Normally the mapper emits the boolean flags (`tool_call`, `reasoning`, `temperature`, `attachment`) as *true-only* — an absent capability stays unset. Listing one in `overwrite` lets the endpoint also assert `false` and clear a stale `true` another plugin stamped — **but only when the source actually carried the signal** (`supported_parameters` for the three parameter flags, `architecture.input_modalities` for `attachment`). If the endpoint omits that data entirely, the plugin genuinely doesn't know the answer, so it leaves the field untouched rather than fabricating a `false`. To force a capability off, make sure your endpoint emits the relevant array (even an empty `supported_parameters: []` counts as "no params").

## Hiding text-only models / catalog-authoritative membership

`meta.modelsInfoHideTextOnly: true` makes the `modelsInfoUrl` catalog authoritative for which models exist, not just their metadata — useful when you only want to offer multimodal models in OpenCode's picker, or when you want the richer catalog to take total precedence over whatever populated `provider.models` first (a hand-written `opencode.json`, or `@vymalo/opencode-oauth2`'s own `/v1/models` discovery).

With the flag on, a model's entry is **deleted** from `provider.models` (not just left un-enriched) in either case:

- The catalog matches it and reports modalities as exactly text-in/text-out (`architecture.input_modalities` / `.output_modalities` both present and resolve to `["text"]`).
- The catalog has no entry matching its `id` (or declared `id`) at all.

Both are "known before we assert" — same rule as the capability flags in [Overriding upstream-wins](#overriding-upstream-wins): a matched model the catalog gives no modality data for is left alone rather than hidden on a guess, and the flag never *invents* a model the catalog knows about but discovery/config never listed — it only prunes what's already in `provider.models`. It's a hard delete: a hidden model becomes unselectable, same as if it were never in `models` to begin with. See the [package README](../packages/opencode-models-info/README.md#hiding-text-only-models) for the full example.

## Auth composition

The fetch sends the union of the provider's `options.headers` and the meta-specific `meta.modelsInfoHeaders` (meta wins on conflict). That single rule covers the three common setups:

| Setup | What you do |
| --- | --- |
| **Public metadata endpoint** (e.g. OpenRouter's `/models`) | Nothing — no auth needed. |
| **Static API key** | Put the `Bearer` in `options.headers` once; both inference and the metadata fetch use it. |
| **OAuth2 via `@vymalo/opencode-oauth2`** | Nothing — that plugin stamps a freshly-ensured (refresh-on-near-expiry) bearer onto `options.headers.Authorization` at config time, *before* this plugin's hook runs (list it **first** in `plugin`), so this plugin inherits it automatically. See [architecture.md](./architecture.md#config--plugin-load). |

If the metadata endpoint needs a *different* credential than inference (e.g. a service-account token), set `meta.modelsInfoHeaders.Authorization` — it overrides whatever the provider carries.

> **Why this works with oauth2 without coupling.** The two plugins never import each other. oauth2 writes its token into the shared, already-resolved provider config; this plugin reads whatever is there. The oauth2 `chat.headers` hook still injects a freshly-refreshed token per chat request, so a slightly-stale config-time header can only ever affect *this* plugin's metadata fetch — never the actual inference call.

## URL resolution

`meta.modelsInfoUrl` resolves against `options.baseURL` with standard WHATWG URL semantics:

| `baseURL` | `modelsInfoUrl` | Resolves to | Use when |
| --- | --- | --- | --- |
| `https://x.test/v1` | `models/info` | `https://x.test/v1/models/info` | metadata sits under the inference path |
| `https://x.test/v1` | `/models/info` | `https://x.test/models/info` | metadata sits at a different path on the same host |
| `https://x.test/v1` | `https://o.test/m` | `https://o.test/m` | metadata lives on a different host entirely |

Rule of thumb: **drop the leading `/`** to keep the metadata path under your API path; **keep the leading `/`** to escape to the host root.

## Periodic refresh

`config` is the hook that actually enriches models, and it runs once at plugin load — re-running only on certain config edits, never on a timer (see [The hooks](#the-hooks)). That's fine for a short CLI invocation, but a long-lived process (a desktop window, an embedded server) would otherwise be stuck with whatever the catalog looked like at boot for as long as it stays up.

To close that gap, every opted-in provider also gets a background scheduler ([`src/scheduler.ts`](../packages/opencode-models-info/src/scheduler.ts)) that keeps re-checking `modelsInfoUrl` — unconditionally, though still cheap via a conditional `ETag` request — on the **same `meta.modelsInfoTtlSeconds` cadence that already governs cache freshness**. There's deliberately no second interval to configure: the TTL knob already means "how often should this go stale," and reusing it as the refresh cadence keeps the two in lockstep instead of risking a TTL and a refresh interval drifting apart. Default is once a day (`86400`).

This is a **cache-warming** mechanism, not a live-update one: it refreshes the on-disk cache for the *next* `config` run, but it cannot push a change into an already-open session, because a `config` hook has no channel to hot-patch a running one — OpenCode's plugin API doesn't expose one. A failed check backs off (capped at the configured interval, mirroring `@vymalo/opencode-oauth2`'s own scheduler) rather than hammering a down endpoint, and resumes the normal cadence once a check succeeds. The scheduler is stopped and restarted whenever `config` reruns (so a rebuilt config never leaks a duplicate timer per provider) and stopped for good on `dispose`. Its own timer is `unref()`'d, so it never by itself keeps a short-lived CLI process alive.

## Caching and failure modes

The catalog is cached on disk so repeated boots don't re-hit the network.

- **Location** — per-OS cache dir under the `opencode-models-info` namespace: `~/Library/Caches/opencode-models-info/` (macOS), `${XDG_CACHE_HOME:-~/.cache}/opencode-models-info/` (Linux), `%LOCALAPPDATA%\opencode-models-info\` (Windows). Files are `0o600`, written via atomic rename.
- **Key** — `sha256(providerId :: resolvedUrl :: modelsInfoHeaders)`. The user-set `meta.modelsInfoHeaders` are part of the key (switching an `x-tenant` selector busts the cache), but the provider's other headers are **not** — a rotating OAuth2 bearer must not thrash the cache.
- **TTL** — `meta.modelsInfoTtlSeconds`, default 24h. The current config TTL is applied on every write, including `304` revalidations, so tightening it in `opencode.json` takes effect on the next revalidation.
- **Revalidation** — the stored `ETag` is sent as `If-None-Match`; a `304` reuses the cached models and just bumps `fetchedAt`.

Failure handling is deliberately non-fatal — the plugin must never block OpenCode startup:

| Situation | Behavior |
| --- | --- |
| Fetch fails (network, timeout, non-2xx) **with** a cached snapshot | Serve the **stale** snapshot; log `models_info_fetch_failed_using_stale`. |
| Fetch fails **without** any cache | Skip enrichment for that provider; log `models_info_fetch_failed_no_cache`. |
| First boot, never fetched | No cache exists yet — that's normal. The first **successful** fetch writes the cache, and the default 24h TTL keeps subsequent boots offline. |
| Response is malformed (non-empty body that filters down to zero valid entries) | Treated as a parse error → falls back to stale cache, **never** overwrites good data with `[]`. |
| Disk cache write fails (read-only `$HOME`, etc.) | Best-effort: log `models_info_cache_write_failed` and still enrich from the freshly-fetched in-memory record. |

Per-fetch timeout defaults to 5s (`meta.modelsInfoTimeoutMs`).

### "There's no cache yet — can I get a 1-day-TTL entry?"

The cache **is** 1-day-TTL by default (`meta.modelsInfoTtlSeconds`, `86400`). There is no separate "seed the cache" step and no negative cache for failures — `models_info_fetch_failed_no_cache` means the fetch itself failed (commonly HTTP 401: the metadata endpoint is auth-protected and no `Authorization` reached it) **and** there was no prior good copy to fall back to. The fix is to make the fetch succeed once; the cache then fills automatically and survives reboots for the TTL. In order of likelihood:

1. **Auth-protected endpoint, no token reaching it.** Ensure `@vymalo/opencode-oauth2` is listed **before** this plugin so its bearer is stamped on `options.headers` first (see [Auth composition](#auth-composition)). On the very first interactive login this is now handled by the oauth2 plugin's refresh-backed propagation — if you hit a 401 *before* upgrading, just run the command again: the second run reads the token from cache before either hook runs.
2. **A different credential is needed for metadata than for inference.** Set `meta.modelsInfoHeaders.Authorization` (or a static `x-tenant`, etc.) — these override the inherited provider headers and are part of the cache key.
3. **The endpoint is genuinely unreachable.** Hand-write the metadata in `opencode.json`; the merge is upstream-wins, so your values stick and the plugin enriches nothing over them.

## Log events

All structured, `snake_case`, emitted through both the JSON console and OpenCode's `client.app.log`:

| Event | Level | Meaning |
| --- | --- | --- |
| `models_info_enriched` | info | A provider's models were enriched (`enrichedCount` / `hiddenCount` / `totalModels` / `sourceModels`). |
| `models_info_model_hidden_text_only` | debug | A model was deleted from `provider.models` because `meta.modelsInfoHideTextOnly` is set and the catalog reported it as text-only. |
| `models_info_model_hidden_unmatched` | debug | A model was deleted from `provider.models` because `meta.modelsInfoHideTextOnly` is set and the catalog has no entry for it at all. |
| `models_info_fetched` | info | A live fetch succeeded and the cache was written. |
| `models_info_cache_hit` | debug | Served from a fresh cache entry; no network. |
| `models_info_not_modified` | debug | `304` revalidation; cached models reused. |
| `models_info_fetch_failed_using_stale` | warn | Fetch failed; stale cache served. |
| `models_info_fetch_failed_no_cache` | warn | Fetch failed and nothing cached; provider left un-enriched. |
| `models_info_cache_write_failed` | warn | Disk write failed; enrichment proceeded from memory. |
| `models_info_enrichment_failed` | error | Unexpected throw while enriching a provider. |
| `models_info_refresh_scheduler_started` | trace | A background refresh scheduler was started for a provider (see [Periodic refresh](#periodic-refresh)). |
| `models_info_scheduler_tick` | trace | A scheduled refresh fired. |
| `models_info_scheduler_retry` | warn | A scheduled refresh failed; backing off before the next attempt. |

## Field mapping (summary)

The exact conversions live in [`packages/opencode-models-info/src/mapping.ts`](../packages/opencode-models-info/src/mapping.ts) and the full table is in the package README. Highlights worth knowing:

- OpenRouter `pricing.prompt` / `.completion` are **USD per token** strings; OpenCode `cost.input` / `.output` are **USD per 1M tokens** numbers — converted (`× 1_000_000`, rounded to 6 dp).
- `limit` is only emitted when **both** `context` and `output` are known (OpenCode rejects a partial `limit`). `context` comes from `top_provider.context_length ?? context_length`, `output` from `top_provider.max_completion_tokens`. **If your endpoint omits these, no `limit` is set — and OpenCode then backfills the runtime model's required `limit` to `{ context: 0, output: 0 }`, which its UI treats as incomplete and may render with no cost/limit shown even though `cost` is present.** See [the troubleshooting note](./troubleshooting.md#cost--limits-dont-appear-in-the-opencode-ui-despite-models_info_enriched).
- Modalities are filtered to OpenCode's enum (`text | audio | image | video | pdf`); a non-text input modality also sets `attachment: true`.
- `tool_call` / `reasoning` / `temperature` are derived from `supported_parameters`.
