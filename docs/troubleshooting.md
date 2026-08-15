# Troubleshooting

Symptom-keyed. Each entry covers what's happening internally, where to look in logs, and a diagnostic you can run.

The plugin emits structured JSON logs to stderr (and through `client.app.log()` when running under OpenCode). Anywhere this guide says "look for `<event>` in the logs", that's an event name in the `event` field of those entries — see [architecture.md → Logging](./architecture.md#logging) for the full table.

> This page covers `@vymalo/opencode-oauth2`, plus a handful of `@vymalo/opencode-otel` symptoms
> below that are cross-cutting enough to belong here. For the companion plugins, see the
> failure-mode tables in [models-info.md](./models-info.md) (metadata enrichment),
> [ratelimit.md](./ratelimit.md#failure-modes) (rate-limit throttling), and
> [otel.md](./otel.md#troubleshooting) (the full otel failure-mode list).

## `/models` doesn't list my provider after install

**What's happening.** The plugin loaded fine, but warmup at config-hook time ran non-interactively (CI, no TTY, or `interactive: false`) and the cache was empty. `ensureToken` threw `interactive authentication required`; `syncServer` caught it, logged `sync_startup_failed`, and preserved the empty cache. The provider stays registered in OpenCode's config but with no models attached, so the model list is empty.

**Look for.**

- `plugin_initialized` — confirms the plugin loaded.
- `sync_startup_failed` with `error: "interactive authentication required for server ..."` — confirms warmup gave up non-interactively.
- Absence of `sync_success` and `model_discovery_*`.

**Fix.** Trigger auth via an actual `opencode run` (the chat path calls `ensureToken` with `interactive: true` by default), or override warmup interactivity at start time. There's no `pluginConfig` knob for this — if you're embedding the runtime yourself, pass `interactive: true` to `start()`. From the OpenCode-hosted path, you can't override; just run a one-shot to bootstrap.

```sh
# Bootstrap auth interactively — completes the PKCE browser dance once,
# leaves a refresh token in cache for subsequent non-interactive runs.
opencode run --model "miaou/glm-5" "hello"
```

After that, the model list should populate within one scheduler tick (default 60 minutes) or on the next `opencode` restart (warmup picks up the cached refresh token and refreshes silently).

## `redirect_uri_mismatch` from the IdP during PKCE login

**What's happening.** The plugin started a loopback callback server on some `127.0.0.1:<port>`, set `redirect_uri=http://127.0.0.1:<port>/oauth2/callback` in the authorize URL, and the IdP rejected the value because it's not in the client's allowed-redirect-URI list.

**Look for.** The error surfaces in the browser, not the logs — the IdP returns it to the user before the callback runs. The plugin's `oauth_login_started` event will be present; `oauth_login_success` will not.

**Fix per IdP.**

| IdP | Add to allowed redirect URIs |
| --- | --- |
| Keycloak | `http://127.0.0.1:*/oauth2/callback` (with `+` wildcard enabled at realm level) **or** pin `redirectPort: 8765` and add `http://127.0.0.1:8765/oauth2/callback` literally |
| Auth0 | `http://localhost` is implicitly allowed for native apps; for explicit registration, pin `redirectPort` and add `http://127.0.0.1:<port>/oauth2/callback` to *Allowed Callback URLs* |
| Okta | Pin `redirectPort` and add `http://127.0.0.1:<port>/oauth2/callback` to *Sign-in redirect URIs* on the OIDC app |

The plugin's callback path is hard-coded as `/oauth2/callback`. The host is always `127.0.0.1` (not `localhost`) — register the literal `127.0.0.1`, not its DNS alias.

See [local-development.md → Fixed redirectPort vs random](./local-development.md#fixed-redirectport-vs-random) for the tradeoffs.

## `Missing parameter: code_challenge_method` (HTTP 400) on login

**What's happening.** The IdP requires PKCE on the flow you're using, and the request reached it without a `code_challenge`. Most common on **Keycloak** clients where *Advanced → Proof Key for Code Exchange Code Challenge Method* is set to `S256` — Keycloak then enforces PKCE on **both** the authorize endpoint (`authorization_code`) and the device-authorization endpoint (`device_code`).

**Look for.**

- `oauth_device_authorization_failed` with `status: 400` and `bodyPreview` containing `"error":"invalid_request","error_description":"Missing parameter: code_challenge_method"`, followed by `sync_failed` (`device authorization request failed (400)`).
- The equivalent on `authorization_code` surfaces in the browser at the authorize step.

**Fix.** The plugin sends PKCE on both interactive flows **by default**, so on a current version this just works — upgrade if you're on an older build that omitted it. The `code_verifier` is generated per login and replayed on the token exchange/poll automatically; no configuration is needed.

If you're hitting the *opposite* problem — a non-compliant IdP that rejects the extra `code_challenge` / `code_verifier` parameters — set `pkce: false` on that server's `oauth2` options to opt out. Leave it on (the default) for everything else; compliant servers that don't require PKCE simply ignore it.

## `OpenAI API key is missing` / wrong endpoint after enabling `responseApi`

**What's happening.** Setting `responseApi: true` swaps the provider's package from `@ai-sdk/openai-compatible` to the native `@ai-sdk/openai`, so OpenCode routes inference through the **Responses API** (`/v1/responses`) instead of Chat Completions (`/v1/chat/completions`). Two things change with that swap:

- The native provider **throws `OpenAI API key is missing` at construction** if no `apiKey` is set. The plugin handles this for you by stamping an inert placeholder key (`oauth2-managed-bearer`) when you haven't supplied one; the real OAuth bearer is still injected per request by `chat.headers`, so the placeholder is never actually sent. You should not see this error from the plugin's own providers — if you do, you likely hand-rolled an `@ai-sdk/openai` provider in `opencode.json` without an `apiKey` and without this plugin managing it.
- The native provider speaks the **OpenAI Responses wire format**, which is *not* the same as Chat Completions. The route must exist **and the chosen model must be served on it** — gateways often expose `/v1/responses` for only a subset of models. A model that 404s on `/v1/responses` (while working on `/v1/chat/completions`) is a model-routing gap, not a missing route.

**Look for.**

- `oauth2_provider_response_api_enabled` (debug) confirms the toggle was read for that provider, and the registered provider shows `npm: "@ai-sdk/openai"`.
- Inference 404 / 400 from the gateway despite successful auth and model discovery → either the gateway doesn't serve `/v1/responses`, or that specific model isn't routed there. Try another model.

**Fix.** Only enable `responseApi` when the gateway implements the OpenAI Responses contract at `<baseURL>/responses` for the model you're using. Otherwise leave it unset (the default) to stay on Chat Completions via `@ai-sdk/openai-compatible`.

## `text part <id> not found` on a `responseApi` provider

**What's happening.** Inference reaches the gateway and the model responds, but OpenCode aborts with `text part <msg_id> not found`. The gateway's Responses **SSE stream omits the `output_index` / `content_index` fields** that the canonical OpenAI Responses API always includes. AI-SDK / OpenCode key each streamed message part by those indices, so when they're absent the text part is never associated with its deltas. Observed against **Envoy AI Gateway** fronting a local model server.

**Look for.**

- The error fires *after* successful auth + model discovery, only with `responseApi: true`, and only when the model emits a reasoning item before the text (the missing indices desync part bookkeeping there).
- A raw `curl` of `<baseURL>/responses` with `"stream":true` shows events like `{"type":"response.output_text.delta","item_id":"msg_…","delta":"…"}` with **no** `output_index` / `content_index`.

**Fix.** The plugin repairs this automatically: when `responseApi` is on, it wraps the provider's `fetch` and injects the missing `output_index` (per item, in `output_item.added` order) and `content_index: 0` into the SSE before OpenCode parses it (see [`src/responses-repair.ts`](../packages/opencode-oauth2/src/responses-repair.ts)). The repair never overwrites indices a conformant gateway already sends, so it's a safe no-op there. The cleaner long-term fix is gateway-side — emit the indices so every OpenAI Responses client works.

## `model discovery failed (403)` after auth succeeded

**What's happening.** OAuth succeeded — you have a valid access token — but the upstream `/v1/models` endpoint returned 403. The access token is missing the scope or audience the gateway expects.

**Look for.**

- `oauth_*_success` events present (proves auth worked).
- `sync_failed` with `error: "model discovery failed (403) at https://api.example.com/v1/models"`.
- `model_discovery_error_body` with `status: 403` and a `bodyPreview` (token-shaped substrings are masked by `scrubSecrets`).

**Diagnose.** Copy the access token from the cache and curl `/v1/models` directly:

```sh
# Pull the access token from the cache (replace with your platform's path).
token=$(jq -r .token.accessToken \
  ~/Library/Caches/opencode-oauth2/opencode-oauth2-model-sync/miaou.json)

# Hit /v1/models with it.
curl -i \
  -H "Authorization: Bearer $token" \
  -H "Accept: application/json" \
  https://api.example.com/v1/models
```

If you get the same 403, decode the JWT to inspect the claims:

```sh
# Decode the payload (middle segment).
echo "$token" | cut -d. -f2 | base64 -d 2>/dev/null | jq .
```

Compare:

- **`scope`** (or `scp` — depends on IdP) against what your gateway requires. Adjust `scopes:` in `opencode.json` and force re-auth (see [local-development.md → Force re-auth](./local-development.md#force-reauth)).
- **`aud`** against what your gateway validates. For `token_exchange`, set `tokenExchangeAudience` to match.

## `models_info_fetch_failed_no_cache` (HTTP 401) — metadata not enriched

**What's happening.** `@vymalo/opencode-models-info` tried to fetch `meta.modelsInfoUrl`, the endpoint returned 401, and there was no previously-cached catalog to fall back to — so model metadata (context window, cost, modalities) is left un-enriched. The metadata endpoint is auth-protected and no `Authorization` header reached it.

**Look for.**

- `models_info_fetch_failed_no_cache` with the `url` and `error: "HTTP 401"`.
- For an oauth2-backed provider: `sync_success` for the provider *did* fire (so inference auth works), but the metadata fetch still 401'd.

**Fix.**

1. **List `@vymalo/opencode-oauth2` before `@vymalo/opencode-models-info`** in your `plugin` array. oauth2's `config` hook stamps the bearer onto `options.headers` and must run first. The bearer is now produced by a refresh-backed ensure, so a freshly-minted (even short-lived) token is propagated rather than skipped.
2. **On a one-off first-login 401, just re-run the command.** The token is on disk after the first login, so the next run stamps it before models-info's hook runs.
3. **Different credential for metadata?** Set `meta.modelsInfoHeaders.Authorization` — it overrides the inherited provider header.
4. **Endpoint not actually OpenRouter-shaped?** A vanilla `/v1/models` returns no mappable fields; point `modelsInfoUrl` at the richer metadata route. See [models-info.md → URL resolution](./models-info.md#url-resolution).

The cache TTL is already 24h by default (`meta.modelsInfoTtlSeconds`); once the fetch 200s once, reboots stay offline for the day. There's no way to pre-seed a placeholder cache for an endpoint that has never succeeded — see [models-info.md → "There's no cache yet"](./models-info.md#theres-no-cache-yet--can-i-get-a-1-day-ttl-entry).

## Cost / limits don't appear in the OpenCode UI despite `models_info_enriched`

**What's happening.** Enrichment worked — `models_info_enriched` reports `enrichedCount > 0` and the `cost` is present in OpenCode's resolved config — but the TUI shows no price or context window. The usual cause is a **missing `limit`**: your metadata endpoint returns `pricing` but no `context_length` / `top_provider`, so the plugin emits no `limit` (it never fakes one), and OpenCode backfills the runtime model's required `limit` to `{ context: 0, output: 0 }`. OpenCode's model UI is built around its `models.dev` catalog where every model has a real limit, so a `0/0` model is treated as incomplete and may suppress the cost line along with the limit.

**Confirm.** Start the headless server (`opencode serve` — it prints a base URL) and inspect the resolved config:

```sh
curl -s http://127.0.0.1:<port>/config/providers \
  | jq '.providers[] | select(.id=="<provider-id>") | .models["<model-id>"] | {cost, limit}'
```

`cost` populated + `limit: { context: 0, output: 0 }` is the signature of this case — proof the plugin did its job and the gap is the source data.

**Fix (server-side).** This is **not** a plugin issue — the metadata endpoint must include the size fields the mapper reads ([`mapping.ts`](../packages/opencode-models-info/src/mapping.ts) — `context` ← `top_provider.context_length ?? context_length`, `output` ← `top_provider.max_completion_tokens`):

```jsonc
{
  "id": "your-model",
  "pricing": { "prompt": "0.0000006", "completion": "0.0000021" },
  "context_length": 128000,
  "top_provider": { "context_length": 128000, "max_completion_tokens": 8192 }
}
```

Once both `context` and `output` are known, the plugin emits a real `limit`, and the cost/limit render in the UI. (`cost` was already correct — adding the limit is what makes both visible.)

## Model name shows the normalized id, not what the metadata endpoint returns

**What's happening.** With `@vymalo/opencode-oauth2` + `@vymalo/opencode-models-info` stacked, the UI shows e.g. `Kimi K2.6` even though your `models/info` endpoint returns `"name": "kimi-k2.6"`. oauth2's model discovery stamps a **normalized** display name onto every model entry *before* models-info runs ([`mergeDiscoveredModels`](../packages/opencode-oauth2/src/opencode.ts) → [`normalizeModelId`](../packages/opencode-oauth2/src/model-normalization.ts)). models-info's merge is **upstream-wins**, so it sees `name` already set and won't overwrite it — the endpoint's name never lands.

**Fix.** Opt `name` out of upstream-wins for that provider:

```jsonc
{
  "options": {
    "meta": {
      "modelsInfoUrl": "models/info",
      "modelsInfoOverwrite": ["name"]
    }
  }
}
```

See [models-info.md → Overriding upstream-wins](./models-info.md#overriding-upstream-wins). The same applies to any field oauth2 (or another plugin) pre-stamps; `name` is the only one oauth2 currently sets.

## Vision-capable model won't accept image attachments

**What's happening.** A model your `models/info` endpoint reports with `architecture.input_modalities: ["text", "image"]` shows no image/attachment support in OpenCode. The mapper *does* derive both `modalities.input` **and** `attachment: true` from that field ([`mapping.ts`](../packages/opencode-models-info/src/mapping.ts)), and — unlike `name` — oauth2 does **not** pre-stamp `modalities`/`attachment`, so upstream-wins doesn't block them. So if image input is missing, the enrichment isn't reaching the entry with current data. In order of likelihood:

1. **Stale cache.** The catalog is cached for `meta.modelsInfoTtlSeconds` (default 24h). If `image` was added to the endpoint within that window, the on-disk copy predates it. Clear it and relaunch: `rm -rf ~/Library/Caches/opencode-models-info/` (macOS; see [Caching](./models-info.md#caching-and-failure-modes) for Linux/Windows paths).
2. **The fetch is failing.** Look for `models_info_fetch_failed_no_cache` / `..._using_stale` — usually a 401 on an auth-protected metadata endpoint (see [the 401 section](#models_info_fetch_failed_no_cache-http-401--metadata-not-enriched)).
3. **id mismatch** between the discovered model (`/v1/models`, which becomes the config key) and the `models/info` entry — only matching ids get enriched.

**Confirm.** Start `opencode serve` and inspect the resolved config:

```sh
curl -s http://127.0.0.1:<port>/config/providers \
  | jq '.providers[] | select(.id=="<provider-id>") | .models["<model-id>"] | {attachment, modalities}'
```

`attachment: true` + `modalities.input` containing `image` means enrichment worked and the gap is elsewhere; their absence points back to one of the three causes above.

## `oauth_client_credentials_failed` 401 with `invalid_client`

**What's happening.** The IdP rejected the `client_id` + `client_secret` combination. Three common root causes for Keycloak; similar elsewhere.

**Look for.**

- `oauth_client_credentials_failed` with `status: 401` and `bodyPreview` containing `invalid_client` or `unauthorized_client`.
- The `bodyPreview` will have token-shaped values masked, but the `error` and `error_description` fields are usually preserved.

**Diagnose (Keycloak).**

1. **Service accounts disabled.** In Keycloak admin: *Clients → \<your client> → Capability config*. Ensure **Service accounts roles** is **on**. Without it, the client cannot use `client_credentials` regardless of secret validity.
2. **Wrong secret.** *Credentials* tab → confirm the secret matches `clientSecret` in your config. Rotated secrets in Keycloak invalidate the previous one immediately.
3. **Client type mismatch.** A *Public* client (no secret) cannot use `client_credentials`. Convert to *Confidential* in *Capability config → Client authentication: ON*.

Reproduce manually:

```sh
curl -i -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=YOUR_CLIENT&client_secret=YOUR_SECRET" \
  https://auth.example.com/realms/your-realm/protocol/openid-connect/token
```

A 200 here with an access token means the issue is in your config (typo in `clientId`/`tokenEndpoint`); a 401 with the same body confirms it's an IdP-side misconfig.

## `jwt_bearer` 401 — IdP rejects the assertion

**What's happening.** The IdP received the JWT (subject token) but rejected it. Causes from most to least common:

1. **`aud` mismatch.** The IdP expects a specific audience in the assertion; what you sent doesn't match.
2. **IdP-trust client misconfigured.** Keycloak's GitHub Actions identity provider has `Issuer URL` ≠ the literal `iss` in the JWT, or a *Token Exchange permission* policy that doesn't allow the requesting client.
3. **JWT expired.** GitHub Actions OIDC tokens are valid for ~10 minutes; if the plugin caches an expired one (shouldn't happen — `resolveSubjectToken` always re-fetches) or your clock skew is severe, the assertion fails signature validation.

**Look for.**

- `oauth_jwt_bearer_failed` with `status: 401` and `bodyPreview` containing `invalid_grant` or `invalid_token` and an error description like `assertion is expired` / `audience does not match`.

**Diagnose.** Look up the configured audience and the JWT's `aud`:

```sh
# In a GHA job — manually fetch the OIDC token and decode it.
oidc_token=$(curl -sS \
  -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://your-expected-audience" \
  | jq -r .value)
echo "$oidc_token" | cut -d. -f2 | base64 -d 2>/dev/null | jq '{aud, iss, sub, repository, workflow}'
```

For `kubernetes_sa`:

```sh
# From inside the pod.
jwt=$(cat /var/run/secrets/tokens/oauth2/token)
echo "$jwt" | cut -d. -f2 | base64 -d 2>/dev/null | jq '{aud, iss, sub}'
```

`aud` must match the IdP's expected audience exactly. See [github-actions.md → audience pinning](./github-actions.md#audience-pinning) and [kubernetes.md → IdP setup](./kubernetes.md#idp-setup-keycloak--dex).

## Headless context hangs on first run

**What's happening.** Stdin or stdout reports as a TTY when it isn't (some terminal multiplexers, broken PTY libs, certain CI runners with `tty: true` set). Warmup believes it's interactive, tries to open a browser or start device-code polling, and waits forever for a callback that never arrives.

**Look for.** `oauth_login_started` event but no `oauth_login_success` for several minutes. Process hangs at startup.

**Fix.** Currently no environment-variable override. If you're embedding the runtime, pass `interactive: false` to `start()`. If you're running under OpenCode-hosted mode and can't avoid the misdetection, set `CI=true` in the environment — most TTY-detection libs treat that as a signal to fake non-TTY behavior, though the plugin itself reads `process.stdin.isTTY` directly so this is only effective insofar as your shell or process supervisor honors it.

The principled fix on the embedder side:

```ts
import { OAuth2ModelSyncPlugin } from "@vymalo/opencode-oauth2/lib";
const runtime = new OAuth2ModelSyncPlugin(cfg, { /* ... */ });
await runtime.initialize();
await runtime.start({ warmup: true, interactive: false });
```

If you're stuck on the OpenCode-hosted path, the workaround is "delete the cache and run a one-shot `opencode run` from a real terminal to populate it, then resume the headless context which will refresh silently".

## Tokens not rotating in long-running pod

**What's happening.** The pod's projected SA token rotates fine (kubelet refreshes the file), but the access token from your IdP isn't rotating — same access token keeps being used past its expiry, eventually 401-ing against the upstream.

**Look for.**

- `oauth_jwt_bearer_success` with `hasExpiry: false` — the IdP isn't returning `expires_in`, so the plugin treats undefined-expiry as INVALID for machine flows (it should re-acquire every call). If you see this *and* persistent 401s, the problem is downstream.
- `oauth_jwt_bearer_failed` shortly after a successful auth: confirms re-auth is being attempted and failing.

**Most common root causes.**

1. **Missing `audience` on the projected token volume.** Without it, the SA token's `aud` defaults to the apiserver, not your IdP. The IdP rejects with `audience mismatch`. Fix: add `audience: <idp-audience>` to the `serviceAccountToken` source — see [kubernetes.md](./kubernetes.md#cronjob--scheduled-ai-task).
2. **Audience mismatch between `serviceAccountToken.audience` and `subjectTokenSource.audience`.** For `kubernetes_sa`, the plugin doesn't pass an `audience` to the IdP — the IdP reads it from the JWT itself. Make sure the SA-token's audience equals the IdP's expected audience.
3. **For GHA: missing `audience` in `subjectTokenSource`.** The `github_actions` source *does* set `audience` on the OIDC request URL — but if you've configured a different `audience` than your IdP expects, the resulting JWT will have the wrong `aud`. Both sides need to agree.

Diagnose by tailing logs and counting:

```sh
kubectl logs deploy/opencode-bot --tail=200 \
  | jq -Rr 'fromjson? // empty' \
  | jq -s 'group_by(.event) | map({event: .[0].event, count: length})'
```

If `oauth_jwt_bearer_started` count grows steadily but `oauth_jwt_bearer_success` plateaus, you have a failing re-auth.

## `sync_failed … ENOENT … rename '<serverId>.json.tmp' -> '<serverId>.json'`

**What's happening.** Several OpenCode instances started at nearly the same moment and all ran the oauth2 model sync for the same provider. The desktop app triggers this whenever it restores more than one project window at launch — each window is its own OpenCode process, and they all write the same cache file.

The model-sync cache writes atomically: write a temp file, then `rename` it onto the real path. Before this fix every writer used the **same** temp name (`<serverId>.json.tmp`), so two concurrent processes raced — process A's `rename` consumed the temp file process B had just written, and B's `rename` then failed with `ENOENT` on a temp file that no longer existed.

**Impact.** Cosmetic-but-noisy: the *other* instance's atomic write still lands, so the cache file is never corrupt — but the losing instance logs `ERROR sync_failed` and falls back to its in-memory/stale model list for that boot instead of the fresh sync.

**Look for.**

- An `ERROR sync_failed` whose `error` is an `ENOENT` on a `*.json.tmp -> *.json` rename.
- Multiple `creating instance` / `ratelimit_plugin_initialized` lines clustered within the same second just before it (the tell-tale parallel boot).

**Fix.** Upgrade to a build that includes the per-writer temp-name fix (temp files are now suffixed with `pid` + a uuid and unlinked on failure, so concurrent writers can't collide — see [ADR-0005](adr/0005-atomic-file-writes-per-writer-temp.md)). No config change needed. If you're pinned to an older version and can't upgrade, launching projects one at a time avoids the race.

## Provenance badge missing on npm

**What's happening.** The published package on npmjs.com is missing the "Built and signed on GitHub Actions" badge. Either the publish workflow didn't request OIDC, or npm rejected the provenance attestation.

**Look for.**

- In the workflow run logs (`Publish to npm` step): any line mentioning `provenance` and `error`.
- On the npm package page: the badge near the version.

**Causes.**

1. **`id-token: write` not granted to the job.** npm provenance generation requires OIDC. Confirm the `permissions:` block on the publish job includes `id-token: write`. The shipped [publish.yml](../.github/workflows/publish.yml) sets it at the workflow level — if you derived your own from an earlier version, double-check.
2. **`repository` field in `package.json` doesn't match the publishing workflow's repo.** npm validates the provenance attestation's repo URL against `package.json` `"repository"`. Mismatch → rejected. Fix:

   ```json
   {
     "repository": {
       "type": "git",
       "url": "git+https://github.com/vymalo/opencode-oauth2.git"
     }
   }
   ```
3. **`NPM_CONFIG_PROVENANCE` not set.** The shipped workflow sets it as a belt-and-braces — if you removed the env var, pnpm's `publish --provenance` flag should still work, but some pnpm/npm version combinations silently drop the flag.

Once fixed, the badge appears on the next published version (you can't backfill provenance for an already-published tarball).

## `[ERR_PNPM_IGNORED_BUILDS]` on CI install

**What's happening.** pnpm 11 enforces an opt-in `allowBuilds` list for native build scripts. If your project pulls in a transitive dep with a postinstall build (esbuild, msgpackr-extract, etc.) and `pnpm-workspace.yaml` doesn't allow it, pnpm fails the install on CI with this error.

**Look for.** Install step output:

```
ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: esbuild.
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

**Fix.** Add the package name to `allowBuilds` in `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  esbuild: true
  msgpackr-extract: true
```

The shipped `pnpm-workspace.yaml` allows these two by default (they're dependencies of vitest/vite + msgpack speedups). If you add a new dep that triggers the same error, audit the package's postinstall script before adding it — `allowBuilds` is the supply-chain-security gate.

**Why pnpm 11's behavior matters.** The legacy `onlyBuiltDependencies` array is silently ignored in `--frozen-lockfile` mode. A local `pnpm install` succeeds because pnpm interactively prompts; CI fails because there's no TTY. Always use `allowBuilds` (the explicit object shape) to keep dev and CI consistent.

## Telemetry silently stops mid-session (`@vymalo/opencode-otel`)

**What's happening.** The session looks entirely healthy but nothing new arrives at the collector. Every OTLP exporter is wrapped so a failed export reaches the host log stream (see `withFailureLogging` in [`src/export-logging.ts`](../packages/opencode-otel/src/export-logging.ts)) — without it, a rejected request would only surface through the OTel SDK's own internal `diag` channel, which nothing here subscribes to, and the failure would be invisible.

**Look for.**

- `otel_export_failed` — carries `signal` (`traces` | `metrics` | `logs`), `status` (the HTTP status the backend supplied, when there is one), `error` (the message, e.g. an OIDC gate's "authentication didn't succeed"), and `consecutiveFailures` (increments each failed export in a row, resets on the next success).
- `otel_export_recovered` — logged once the next export after a run of failures succeeds, with `afterFailures` showing how many were lost.
- A `status` of `401` or `403` means the collector rejected the credential — check the `Authorization` header value (static `headers`, or a `tokenCommand` helper) rather than the network path. Any other status (a `5xx`, a connection error with no status) points at the collector itself, not the plugin's credential.

**Fix.** For a static header, confirm it hasn't rotated out from under a long-running process — otel reads `headers` once at plugin load and never refreshes it. For anything short-lived, switch to `tokenCommand` (see [otel.md → Short-lived credentials](./otel.md#short-lived-credentials)) so the token is refreshed automatically ahead of its own expiry instead of going stale mid-session.

## Plugin appears to do nothing (`@vymalo/opencode-otel`)

**What's happening.** No spans, metrics or logs ever show up, and there's no export failure either — because no export was ever attempted. The plugin treats "installed but unconfigured" as a deliberate no-op: with no endpoint and no explicit exporter it initializes no providers, opens no sockets, and registers no hooks beyond the bare `config` hook needed to keep reading the host's log level.

**Look for.**

- `otel_plugin_inactive` at startup, with a `reason` field that tells you which of the two causes applies: `no_exporter_configured` (no `endpoint`/`OTEL_EXPORTER_OTLP_ENDPOINT` and no explicit `exporters`/`OTEL_*_EXPORTER` was found) versus `disabled` (`enabled: false` / `OPENCODE_OTEL_ENABLED=false` was set explicitly, overriding everything else).
- Its absence, together with `otel_plugin_enabled`, confirms the plugin *did* activate — if you see neither event at all, the plugin isn't loading; check the `plugin` array the same way the [generic oauth2 check](#generic-see-exactly-what-the-plugin-is-doing) below does, substituting `@vymalo/opencode-otel`.

**Fix.** Set `endpoint` in the plugin options or `OTEL_EXPORTER_OTLP_ENDPOINT` in the environment — either is sufficient on its own (see [otel.md → Quick start](./otel.md#quick-start)). Remember configuration is read once at plugin load: an environment variable exported after OpenCode has already started won't be picked up until the next launch.

## Traces arrive but metrics do not (`@vymalo/opencode-otel`)

**What's happening.** This is very often not a failure at all. Traces and logs flush at `session.idle` (the natural turn boundary) plus `beforeExit`/`SIGINT`/`SIGTERM` for hard exits, so they tend to show up quickly. Metrics only export on their own periodic interval — `metricExportIntervalMs` / `OTEL_METRIC_EXPORT_INTERVAL`, **60 seconds by default** — which is not tied to session boundaries at all.

**Look for.** No `otel_metrics_init_failed` and no `otel_export_failed` with `signal: "metrics"` — their absence plus an otherwise-quiet log is the signature of "just wait," not "something broke."

**Fix.** Wait out the interval, or lower `metricExportIntervalMs` for faster feedback while developing against a local collector. If a full 60+ seconds pass with the session still open and still nothing arrives, then treat it as a real failure and check for `otel_metrics_init_failed` (below) or `otel_export_failed` instead.

## Credential helper problems (`@vymalo/opencode-otel` `tokenCommand`)

**What's happening.** A `tokenCommand` credential helper either couldn't be run, exited non-zero, printed nothing to stdout, or its previously-cached token aged past `validUntil` with no successful refresh to replace it. Failure handling is deliberately asymmetric: if the cached token is still valid when a refresh attempt fails, nothing changes — replacing a current token with nothing would lose data for no reason. Only when there is no valid token left does the plugin send the export with no auth header at all, so it fails closed at the collector rather than replaying a credential that has already been refused.

**Look for.**

- `otel_token_command_failed` — either the process itself couldn't be spawned (`command`, `reason`), or it ran but exited non-zero / produced empty stdout (`command`, `exitCode`, `emptyStdout`, `stderrLength`, `durationMs`). Neither variant ever logs stdout or stderr content — stdout *is* the token, and a helper's stderr can echo back the request it was serving.
- `otel_token_expired` — the cached token's `validUntil` has passed and the most recent refresh attempt didn't produce a usable replacement; the export proceeds with no auth header.
- `otel_token_refreshed` (debug level) on the happy path — confirms a new token was picked up, with `source` telling you whether the next refresh is scheduled from the token's own JWT `exp` claim (`jwt_exp`) or from the `tokenRefreshMs` fallback interval (`refresh_interval`).

**Fix.** Reproduce the helper manually (`<your tokenCommand> ; echo $?`) — the contract is stdout-only-and-nothing-else on success, non-zero exit with empty stdout on failure. If refreshes keep landing on the `refresh_interval` fallback when you expected `jwt_exp`, the helper's output likely isn't a three-segment JWT, or its `exp` claim isn't a numeric Unix timestamp; `tokenRefreshMs` (default 4 minutes) is intentionally below Keycloak's common 5-minute default so it should still refresh in time either way.

## One signal missing while others work (`@vymalo/opencode-otel`)

**What's happening.** Traces, metrics and logs are three independent providers built in the same `config` hook pass — a failure constructing one is caught and logged without stopping the others, on the principle that partial telemetry beats an exception escaping into the host's plugin loader.

**Look for.** `otel_traces_init_failed`, `otel_metrics_init_failed`, or `otel_logs_init_failed`, each carrying an `error` message. Whichever signal's provider is missing from the log — `otel_plugin_enabled`'s `exporters` field still lists it as configured, but no spans/metrics/logs for that signal ever appear — is the one whose `_init_failed` event to search for.

**Fix.** The logged `error` message names the underlying exporter-construction failure — most often a malformed per-signal endpoint override (`endpoints.metrics`/`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` and friends bypass the base-`endpoint` URL-joining logic entirely and are used verbatim). Fix the offending per-signal config; the other two signals keep working unaffected in the meantime.

## Generic: see exactly what the plugin is doing

Pretty-print and filter the JSON logs:

```sh
opencode run --model "miaou/glm-5" "say hi" 2>&1 \
  | jq -Rr 'fromjson? // .' \
  | jq 'select(.event | test("oauth|sync|model"))'
```

If you don't see anything OAuth-related at all, the plugin isn't loading. Confirm:

```sh
opencode --version
npm ls -g | grep opencode-oauth2
cat $OPENCODE_CONFIG_DIR/opencode.json | jq '.plugin'
```

The `plugin` array must include `"@vymalo/opencode-oauth2"` (or a local path that re-exports it — see [local-development.md](./local-development.md#plugin-reexport-trick)).
