# @vymalo/opencode-ratelimit

OpenCode plugin that makes OpenAI-compatible providers **rate-limit aware**. It reads the IETF draft-03 rate-limit response headers emitted by [Envoy Gateway](https://gateway.envoyproxy.io/docs/tasks/traffic/global-rate-limit/)'s global rate limiting (`x-ratelimit-limit` / `-remaining` / `-reset`), proactively pauses new requests when the quota is exhausted, and backs off + retries on HTTP `429` — so your OpenCode client cooperates with the gateway instead of hammering it.

Auth-agnostic by design: it observes OpenCode's HTTP request/response hooks and never reads or sets `Authorization`, so it composes with `@vymalo/opencode-oauth2`, static API keys, or no auth at all.

> **Requires OpenCode v2.** This release targets the v2 plugin API and does not run on v1. Migrating from `0.17.x`? See [Migrating from v1](#migrating-from-v1).

## Why use this

OpenCode has no built-in client-side rate-limit handling. If your inference sits behind a gateway that advertises a quota on every response, a burst of requests (streaming + title generation + parallel tool calls) blows through the limit and earns a wall of `429`s. This plugin observes the advertised quota and the reset window and waits the right amount of time — automatically, per provider.

## How it works

Four registrations on OpenCode's native request lifecycle:

1. **`provider.transform`** — read which providers opted in via `settings.rateLimit`. Reads only; it never mutates a provider.
2. **`http.request`** — pre-request gate. If the last response said `remaining: 0`, hold new requests until `x-ratelimit-reset` elapses.
3. **`http.response`** — read the rate-limit headers and update per-bucket state.
4. **`retry`** — on a `429`, return the reset window (`x-ratelimit-reset`, or `Retry-After` as a fallback) as the host's retry delay, up to `maxRetries`; or decline the retry so the `429` surfaces immediately.

The response body is never read — only `status` and `headers` — so the streaming body reaches OpenCode intact. Because `retry` hands the delay to OpenCode, the plugin never blocks a request thread on a `429`; the host sleeps, cancellably, and counts the attempts.

> **Where the headers live.** Envoy attaches its rate-limit `BackendTrafficPolicy` to a specific route — in practice `/v1/chat/completions`, **not** `/v1/models`. So the plugin sees the quota on the inference calls that matter, and a `curl` of `/v1/models` may show no `x-ratelimit-*` at all. The `limit` header is also commonly *multi-policy*, e.g. `x-ratelimit-limit: 200, 200;w=60, 200000;w=60, 50000000;w=2592000` — the parser takes the first token as `limit`, while `remaining`/`reset` already track whichever bucket is closest to its cap (which is all the throttle logic needs).

## Installation

```sh
npm install @vymalo/opencode-ratelimit
```

## Usage

A provider opts in via `settings.rateLimit`. All fields are optional:

```json
{
  "plugins": ["@vymalo/opencode-ratelimit"],
  "providers": {
    "my-provider": {
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": {
        "baseURL": "https://api.example.com/v1",
        "rateLimit": {
          "enabled": true,
          "maxWaitMs": 0,
          "maxRetries": 5,
          "headerPrefix": "x-ratelimit"
        }
      }
    }
  }
}
```

The plugin's own options (currently just `logLevel`) go on its `plugins` entry:

```json
{
  "plugins": [
    { "package": "@vymalo/opencode-ratelimit", "options": { "logLevel": "debug" } }
  ]
}
```

> **`logLevel` is a gate, not an override.** Records go to OpenCode's own logger, which applies the
> host's level too — and Effect's default minimum is `Info`. So `"logLevel": "debug"` alone will not
> surface `debug`/`trace` records; the host has to permit them as well
> (`OPENCODE_LOG_LEVEL=DEBUG`). Both gates must be open.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Set `false` to opt a provider out while keeping the block. Omitting the whole `rateLimit` block also opts out. |
| `scope` | `model` | `model` keys cooldown state per `(provider, model)`; `provider` shares one cooldown across the whole provider. See [Per-model scope](#per-model-scope). |
| `maxWaitMs` | `0` | Upper bound on any single wait, in ms. **`0` = unlimited** (wait the full reset window). |
| `maxRetries` | `5` | How many times a `429` is retried before the response is handed back as-is. |
| `headerPrefix` | `x-ratelimit` | Lowercased prefix of the draft-03 triple. Remap for gateways that use e.g. `ratelimit-*`. |
| `tiers` | — | Optional array of policy bands keyed by reset magnitude. Replaces flat `maxWaitMs`/`maxRetries` with per-window behavior. See [Tiered policies](#tiered-policies). |

Ordering in `plugins` does not matter for this plugin. Each v2 plugin registers against a different domain, and this one touches neither auth nor the provider definition.

### Tiered policies

A single `maxWaitMs` can't tell a **per-minute burst reset** (≤60s — worth waiting through) from a **monthly-budget reset** (days away — should error fast): both arrive as the same `x-ratelimit-reset`. The discriminator is the reset's *magnitude*, and `tiers` lets you act on it. Each tier matches resets up to `maxResetSeconds` (first match wins; ascending, catch-all last):

```jsonc
// providers.<id>.settings
"rateLimit": {
  "scope": "model",
  "tiers": [
    { "maxResetSeconds": 120, "action": "wait", "maxWaitMs": 0, "maxRetries": 3 }, // ≤2min: wait it out
    { "action": "error" }                                                          // longer: surface the 429 now
  ]
} }
```

| Tier field | Default | Meaning |
| --- | --- | --- |
| `maxResetSeconds` | `null` (catch-all) | Inclusive upper bound, in seconds, of the resets this tier matches. |
| `action` | `wait` | `wait` throttles + backs off; `error` surfaces the `429` **immediately** (no wait, no retry). |
| `maxWaitMs` | `0` | (`wait` only) cap on a single wait; `0` = unlimited. |
| `maxRetries` | `5` | (`wait` only) `429` retries before surfacing. |

Notes:
- A catch-all tier (no `maxResetSeconds`) is auto-appended if you don't supply one; the implicit fallback is `wait` (the safe direction — never hammer the gateway). For "error on anything unexpectedly long," add an explicit `{ "action": "error" }` last.
- The flat `maxWaitMs`/`maxRetries` form still works — it's normalized into a single catch-all `wait` tier.
- An `error`-tier `remaining: 0` does **not** pre-arm the gate; the next request hits a real `429` and is surfaced immediately.

### Per-model scope

If your gateway buckets per model (e.g. Envoy `BackendTrafficPolicy` selectors that include the model), `scope: "model"` (the default) keys cooldown state per `(provider, model)` — so exhausting one model's bucket never blocks requests to a sibling model that still has quota. The model comes straight off the hook event, so there is no body parsing and no fallback case. Use `scope: "provider"` if your gateway buckets per provider/account.

## Caveats

### Long waits can be cut short by OpenCode's own timeouts

The pre-request gate holds the request inside OpenCode's own request path, so it competes with the provider's `headerTimeout` / `chunkTimeout`. With the default `maxWaitMs: 0`, a 55-second reset window means a 55-second hold — which OpenCode may abort if it exceeds the header timeout. When that happens the wait is cancelled cleanly (a `ratelimit_wait_aborted` event is logged and the abort is propagated as a normal cancellation). The `429` backoff is the host's own retry delay and is not subject to this.

If you expect long waits, raise the provider's `headerTimeout` (and `chunkTimeout`) above your largest reset window:

```json
"settings": { "headerTimeout": 90000, "chunkTimeout": 90000 }
```

### State is in-memory only

Unlike `@vymalo/opencode-oauth2` and `-models-info`, this plugin keeps **no cache on disk** — rate-limit windows are measured in seconds, so per-process state is all that matters and surviving a restart would be pointless (and stale).

### Concurrency

During a known cooldown window all in-flight callers share a **single** timer (a 10-way burst produces one wait, not ten) and resume together; each still honors its own request `signal`. Outside a cooldown, requests flow concurrently and each response's headers correct the shared state — a burst that races past `remaining: 0` is mopped up by the `429` backoff path.

## Logged events

Structured events flow through OpenCode's log stream (service `opencode-ratelimit-plugin`) with a JSON-console fallback:

| Event | Level | When |
| --- | --- | --- |
| `ratelimit_plugin_initialized` | info | once per config load (`providerCount`) |
| `ratelimit_provider_enabled` | info | a provider opted in |
| `ratelimit_provider_skipped` | debug | a provider did not opt in |
| `ratelimit_quota` | debug | every response (`remaining`, `limit`, `resetSeconds`) |
| `ratelimit_throttle_wait` | info | pre-request gate engaged |
| `ratelimit_429_backoff` | warn | a `429` was retried (`wait` tier) |
| `ratelimit_failfast` | warn | a `429` was surfaced immediately (`error` tier — reset too far out to wait) |
| `ratelimit_wait_aborted` | warn | a wait was cancelled by the request signal |
| `ratelimit_giveup` | error | `maxRetries` exhausted, `429` returned as-is |
| `ratelimit_header_parse_failed` | debug | a response's headers could not be parsed |

## Library API

The `./lib` subpath exports the testable internals for embedders: `parseRateLimit`, `parseRateLimitOptions`, `makeRateLimitFetch`, `installRateLimiter`, `createProviderState`, and the `createOpencodeRatelimitPlugin` factory.

## License

MIT

## Migrating from v1

`0.18.0` targets the OpenCode **v2** plugin API; `0.17.x` was the last v1 release. See
[ADR-0018](../../docs/adr/0018-opencode-v2-cutover.md) for why there is no dual-support build.

| v1 | v2 |
| --- | --- |
| `"plugin": [...]` | `"plugins": [...]` |
| `"provider": { ... }` | `"providers": { ... }` |
| `"npm": "@ai-sdk/openai-compatible"` | `"package": "aisdk:@ai-sdk/openai-compatible"` |
| `options.baseURL` | `settings.baseURL` |
| `options.meta.rateLimit` | `settings.rateLimit` |
| `options.headerTimeout` / `chunkTimeout` | `settings.headerTimeout` / `chunkTimeout` |
| `pluginConfig.ratelimit.logLevel` | the plugin's own `options.logLevel` |
| host `config.logLevel` drove the log level | `options.logLevel`, else `OPENCODE_LOG_LEVEL` |

The `rateLimit` block's own fields — `enabled`, `scope`, `maxWaitMs`, `maxRetries`,
`headerPrefix`, `tiers` — are unchanged, as is every `ratelimit_*` event name.
