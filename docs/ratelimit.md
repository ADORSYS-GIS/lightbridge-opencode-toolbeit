# Rate-limit awareness

How `@vymalo/opencode-ratelimit` runs inside OpenCode: the three request-lifecycle hooks it registers, how it composes with any auth scheme, and — most importantly — how its waits interact with OpenCode's own request timeouts.

> **OpenCode v2.** This plugin targets the v2 plugin API ([ADR-0018](adr/0018-opencode-v2-cutover.md)). It does not run on OpenCode v1. The per-provider opt-in moved from `options.meta.rateLimit` to `settings.rateLimit`, and the plugin's own options now come from its `plugins` entry rather than `pluginConfig`.

For the copy-paste config reference (every option, the event table), see the package README: [`packages/opencode-ratelimit/README.md`](../packages/opencode-ratelimit/README.md). This page is for the adopter who needs to reason about the mechanism and its failure modes.

## What it does

If your OpenAI-compatible inference sits behind a gateway that advertises a quota on every response — Envoy Gateway's [global rate limit](https://gateway.envoyproxy.io/docs/tasks/traffic/global-rate-limit/) is the motivating case — this plugin makes OpenCode honor it. It reads the IETF draft-03 triple, proactively pauses requests once the window is exhausted, and backs off + retries on `429`.

Envoy emits these on **both** 200 and 429 responses, e.g.:

```
x-ratelimit-limit:     3, 3;w=60
x-ratelimit-remaining: 2
x-ratelimit-reset:     48
```

`x-ratelimit-reset` is **seconds until the bucket resets** and is the primary backoff signal. Envoy Gateway does **not** currently emit `Retry-After` ([envoyproxy/gateway#9078](https://github.com/envoyproxy/gateway/issues/9078)), so `Retry-After` is only consulted as a fallback when some other gateway provides it.

Two things observed against a real deployment, worth knowing when you debug:

- **The headers ride the throttled route, usually `/v1/chat/completions` — not `/v1/models`.** Envoy attaches the `BackendTrafficPolicy` per route, so a `curl` of `/v1/models` can come back with no `x-ratelimit-*` even though the chat endpoint is fully instrumented. Probe the chat endpoint (with a valid bearer) when verifying the gateway side.
- **`x-ratelimit-limit` is often multi-policy**, e.g. `200, 200;w=60, 200000;w=60, 50000000;w=2592000` (a per-window request cap, a token cap, a monthly cap…). The parser takes the first token as the displayed `limit`; `remaining` and `reset` are single values Envoy sets for whichever bucket is closest to its cap — which is exactly what the throttle decision keys on, so the multiple policies need no special handling.

## Three hooks, not one fetch wrapper

Under the v1 plugin API this plugin had no choice but to inject a custom `fetch` into
`provider.options.fetch`: `Hooks` had **no post-response hook**, so a wrapper around the transport
was the only place a plugin could ever see a response's status and headers.

V2 removes that constraint. `Provider.Info` has no `options` and no `fetch` field at all, and the
HTTP exchange is hooked natively. The plugin now registers three things on `ctx.session`, plus one
provider transform that reads the opt-in set:

| Hook | Job |
| --- | --- |
| `provider.transform` | Read each provider's `settings.rateLimit`. Reads only — it never mutates a provider. Reruns on every provider reload, so the opt-in set stays current. |
| `http.request` | **Pre-request gate.** If the last response reported `remaining: 0`, hold the request until `x-ratelimit-reset` elapses. |
| `http.response` | **Read** the rate-limit headers, update per-bucket state, emit `ratelimit_quota`, and arm or clear the gate for the *next* callers. |
| `retry` | **Decide a `429`.** A `wait` tier returns `{ retry: true, delay }`; an `error` tier returns `{ retry: false }` so the `429` surfaces immediately. |

Two consequences worth knowing:

- **The plugin no longer owns the retry loop.** On a `429` it returns a delay and *OpenCode* sleeps,
  cancellably, and counts the attempts (`event.attempt`). V1 slept inside the wrapper and counted
  its own retries. The observable policy is the same; who does the waiting is not.
- **The model no longer comes from the request body.** V1 sniffed `model` out of the JSON body to
  support `scope: "model"`. V2 hands it over as `event.model`, so that parsing — and its
  provider-wide fallback for unparseable bodies — is gone.

The response is never read, only its `status` and `headers`, so the streaming body reaches OpenCode
untouched.

## Auth composition

None of the four hooks reads or sets `Authorization`. OpenCode's per-request `model.request` hook (which `@vymalo/opencode-oauth2` uses to inject a fresh bearer) and the provider's own `headers` handle auth. So this plugin is **auth-agnostic** and works with oauth2, a static API key, or no auth.

Ordering is now cosmetic. Under v1 the `config` hooks ran in registration order and this plugin had to compose with any `fetch` a prior plugin had installed. In v2 each plugin registers against a different domain, and this plugin touches neither auth nor the provider definition — so its position in `plugins` cannot affect correctness (unlike the oauth2 → models-info coupling, which still can).

## The timeout interaction (the important part)

The pre-request gate delays the request **before** it is sent, inside OpenCode's own request path, so a long hold still competes with the provider's `headerTimeout` / `chunkTimeout`. With the default `maxWaitMs: 0` (unlimited), a 55-second reset window is a 55-second hold — and if that exceeds the header timeout, OpenCode aborts the request mid-wait.

The `429` backoff no longer has this problem: it is the host's own retry delay now, not a wait inside a transport call.

The plugin handles this defensively rather than hanging:

- Every wait honors the request's own `AbortSignal` (`event.request.signal`). A single shared cooldown timer serves all concurrent waiters, but each waiter races it against its **own** signal — so one request's cancellation never aborts the others.
- On an aborted wait it logs `ratelimit_wait_aborted` (warn) and re-throws the `AbortError`, which OpenCode treats as a normal cancellation.

If you genuinely want to wait out long windows, raise the provider's timeouts above your largest expected reset:

```json
"settings": { "headerTimeout": 90000, "chunkTimeout": 90000 }
```

These are the same keys OpenCode consumes, so they belong in the provider's `settings` next to `baseURL`.

Two knobs trade off against this:

- **`maxWaitMs`** caps any single wait. Set it (e.g. `10000`) if you'd rather return a `429`/abort quickly than freeze the UI for the full window. `0` keeps the "always wait the full reset" behavior.
- **`maxRetries`** bounds the `429` retry loop. After it's exhausted the `429` is returned to OpenCode unchanged, so the host's own error handling takes over.

## Tiered policies (burst vs budget)

A single `maxWaitMs`/`maxRetries` pair can't distinguish a **per-minute burst reset** (≤60s, worth waiting through) from a **monthly-budget reset** (days away, should error fast) — Envoy reports both as the same `x-ratelimit-reset` for whichever bucket is binding, and never labels which window it is. The reset's **magnitude** is the one reliable signal, so the `tiers` array maps reset-duration bands to behavior:

```jsonc
// providers.<id>.settings
"rateLimit": {
  "tiers": [
    { "maxResetSeconds": 120, "action": "wait", "maxWaitMs": 0, "maxRetries": 3 },
    { "action": "error" }
  ]
}
```

On every `remaining: 0` or `429`, the plugin reads the reset, selects the first tier whose `maxResetSeconds` covers it (ascending, catch-all last), and either **waits** (throttle + bounded retry) or **errors** (surface the `429` immediately — no wait, no retry). The flat form is just sugar for a single catch-all `wait` tier. An auto-appended catch-all defaults to `wait` (the safe direction); add an explicit `{ "action": "error" }` to fail fast on anything longer than your wait bands. This is what lets "≤2min → pause; days → error now" be expressed without `maxRetries` gymnastics.

## Per-model scope

`scope` (default `"model"`) controls how cooldown state is partitioned:

- **`"model"`** keys state per `(provider, model)`. The model comes straight off the hook event (`event.model`) — v2 supplies it, so there is no body parsing and no fallback case. Use this when the gateway buckets per model — e.g. an Envoy `BackendTrafficPolicy` whose selector includes the model — so exhausting one model's bucket doesn't gate its siblings.
- **`"provider"`** shares one cooldown across the whole provider. Use it when the gateway buckets per provider/account.

Getting this wrong is a real symptom, not just a nicety: with `"provider"` against per-model buckets, a 429 on model A needlessly blocks models B/C that still have quota.

## Concurrency

Outside a cooldown, requests flow concurrently and each response's headers correct the per-bucket state. A burst that races past `remaining: 0` before any response lands isn't gated — but Envoy answers the overflow with `429`s, which the backoff path mops up. During a known cooldown, all callers converge on one shared timer and resume together. This keeps the happy path fully parallel (streaming + title-gen + tool calls) while still respecting a hard stop.

## State

In-memory, per process, per bucket (`cooldownUntilMs` + the shared-timer bookkeeping), where a bucket is a provider or a `(provider, model)` pair depending on `scope`. There is **no disk cache** (a deliberate divergence from the other two plugins): a reset window is seconds, so persisting it across restarts would only ever serve stale data.

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Requests never throttle | Provider didn't opt in, or gateway emits no `x-ratelimit-*` | Add `settings.rateLimit` to the provider; confirm the gateway sends the draft-03 triple (check `headerPrefix`). |
| `ratelimit_wait_aborted` during long waits | Gate hold exceeded OpenCode's `headerTimeout` | Raise `settings.headerTimeout` / `chunkTimeout`, or set a smaller `maxWaitMs`. |
| `ratelimit_giveup` then a `429` surfaces | `maxRetries` exhausted while still limited | Raise `maxRetries`, or accept the host-level `429`. |
| UI freezes for a long time on a monthly/budget exhaustion | One `wait` tier (or flat config) treats the multi-day reset as waitable | Add a `tiers` entry with `{ "action": "error" }` for the long band (see [Tiered policies](#tiered-policies-burst-vs-budget)). |
| Exhausting one model blocks other models | `scope: "provider"` against per-model gateway buckets | Set `scope: "model"` (the default). |
| Quota tracked but no waits on a custom gateway | Header names differ | Set `headerPrefix` (e.g. `ratelimit`). |
