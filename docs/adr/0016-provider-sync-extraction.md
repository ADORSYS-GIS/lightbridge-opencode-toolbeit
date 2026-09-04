# ADR-0016 — Extract the provider-registration/model-sync engine into `@vymalo/opencode-provider-sync`

- **Status:** Accepted
- **Date:** 2026-09-04
- **Applies to:** `@vymalo/opencode-oauth2`'s runtime (`OAuth2ModelSyncPlugin`, `cache.ts`,
  `model-discovery.ts`, `model-normalization.ts`, `scheduler.ts`, the `Hooks.config` wiring
  helpers in `opencode.ts`) and the new `@vymalo/opencode-provider-sync` package.

## Context

`@vymalo/opencode-lightbridge` is meant to become an all-in-one plugin: one shared credential
([ADR-0012](0012-single-auth-across-gateway-and-otel.md)) driving every egress a project needs —
the gateway bearer, the OTEL export credential, and (the missing piece today) **registering an
OpenAI-compatible provider and discovering its models**. That third capability exists today only
inside `@vymalo/opencode-oauth2`: the `OAuth2ModelSyncPlugin` class, its cached, cross-process-safe
`ensureAccessToken`/`syncServer` surface, model discovery + normalization, the sync scheduler, and
the `Hooks.config` plumbing that reads `provider.options.oauth2` / `pluginConfig.oauth2ModelSync`
and merges discovered models into OpenCode's provider map.

None of that logic is oauth2-specific in its *mechanism* — it is a generic "keep a set of
OpenAI-compatible providers' model lists in sync, behind a cached OAuth token, safely across
multiple OpenCode processes sharing one cache directory" engine. Forking it into lightbridge would
duplicate ~800 lines of cache/cross-process/scheduler logic that already has hard-won correctness
properties (see the `readCachedToken` cross-process adoption rule, and the single-use-refresh-token
reuse-detection hazard it exists to avoid) and a large existing test suite backing them.

This mirrors the precedent already set twice in this repo: `@vymalo/opencode-auth-core` (the OAuth
token-flow primitive) and `@vymalo/opencode-core-otel` (the OTel export engine) were both extracted
from their originating plugins (`oauth2` and `otel` respectively) for exactly this reason — see the
0.15.0 CHANGELOG entry. Both extractions shipped **with no behaviour change** to the plugin they
were pulled out of, and both left the plugin-specific config-key literals and glue behind in the
originating package rather than folding them into the shared core. This ADR is the same move for
the model-sync engine.

## Decision

**Extract the engine-neutral parts of `opencode-oauth2`'s model-sync runtime into a new published
package, `@vymalo/opencode-provider-sync`.** It provides:

- `ProviderModelSyncEngine` (renamed from `OAuth2ModelSyncPlugin`) — per-server cached state, the
  cross-process-safe `ensureAccessToken` / `syncServer` / `getServerModels` surface, built on
  `@vymalo/opencode-auth-core`'s `TokenRuntime` for the token lifecycle itself.
- `model-discovery.ts` / `model-normalization.ts` / `scheduler.ts` — moved verbatim.
- `cache.ts` — the fused model+token `FileCacheStore`, generalized: `resolveCacheDir(segment,
  namespace)` now takes the on-disk **segment** (`opencode-oauth2`, previously hardcoded) as a
  parameter, because the segment identifies the *consuming plugin*, not the engine.
- `opencode-helpers.ts` (`./lib` only) — the `Hooks.config` wiring a consumer composes with its own
  config-key literals: `collectManagedProviders`, `parsePluginConfigServers`,
  `parseOAuthExtension`, `mergeDiscoveredModels`, `propagateCachedBearer`, `resolveProviderNpm`,
  `applyResponsesApiOptions`, `runtimeSignature`. These were private functions inside oauth2's
  `opencode.ts`; they are now the package's public surface because a second consumer
  (`opencode-lightbridge`, a follow-up PR — not this one) needs to call them with its **own**
  config-key literals.

**What stays out of the engine, deliberately:**

- **Config-key literals.** Which `pluginConfig.<key>` / `provider.options.<key>` a consumer reads is
  its own config surface, passed in as `pluginConfigKey` / `optionKeys` options rather than
  hardcoded. oauth2's are unchanged (`"oauth2ModelSync"` / `["oauth2", "oauth2ModelSync"]`) — they
  simply moved from module-level constants in `opencode.ts` to explicit call-site arguments.
- **Auth-subset validation.** oauth2's `validateConfig` (layered on auth-core's
  `validateAuthConfig`) is unchanged and stays in `opencode-oauth2/src/config.ts`. The engine
  accepts only already-validated `ProviderServerConfig` objects and does no field-level validation
  of its own beyond "servers must be a non-empty array" — a defensive floor for a caller that
  bypasses its own config layer entirely (as the test suite's direct-engine-construction tests do),
  not a validation contract lightbridge or any other consumer should rely on.
- **The Responses-API SSE repair fetch.** `createResponsesRepairFetch` is Envoy-AI-Gateway-specific
  and stays in `opencode-oauth2`. The engine's `applyResponsesApiOptions` /
  `collectManagedProviders` accept it as an **injected hook**
  (`ApplyResponsesApiOptionsHooks.createResponsesRepairFetch`) rather than importing it — a future
  consumer with no such gateway quirk simply omits the hook.

`opencode-oauth2` now composes the engine (`OAuth2ModelSyncPlugin extends ProviderModelSyncEngine`,
validating its own config and binding its own `opencode-oauth2` cache segment + service label
before calling `super()`) and is **behaviourally unchanged**: every symbol its `lib.ts` exported
before this change still exports the same name from the same subpath — physically-moved symbols are
re-exported from `@vymalo/opencode-provider-sync` under their original names.

## Consequences

**Positive**

- **One implementation of the cross-process token-adoption rule, the sync scheduler, and model
  discovery/normalization** behind one seam, the same shape as the auth-core/core-otel precedent.
  A future `opencode-lightbridge` gateway module reuses it instead of forking it.
- **oauth2's public surface and behaviour are unchanged.** `OAuth2ModelSyncPlugin`, `PluginOptions`,
  `resolveCacheDir`, `FileCacheStore`, and every other `lib.ts` export still resolve, and the
  existing test suite passes with only import-path adjustments — no test assertions changed.
- **The engine's public surface is exercised by a real second call site's worth of design pressure**
  even before lightbridge lands: the config-key/option-key parameterization and the injected
  Responses-repair hook were both driven by "what would a second, differently-named consumer need,"
  not designed speculatively.

**Negative / cost**

- **A new published package** (a thirteenth workspace package, twelfth... — see the version-line
  bump list) with its own `package.json`/`README.md`/coverage thresholds to maintain, and a new
  entry in `publish.yml`'s dependency-ordered publish sequence (published alongside auth-core and
  core-otel, before anything that depends on it).
- **`opencode-oauth2` gains a new workspace dependency** (`@vymalo/opencode-provider-sync`), and a
  release now needs that package on the registry before oauth2's tarball can be pushed — the same
  bootstrap ordering constraint auth-core/core-otel already introduced for their dependents.
- **The engine's config-key genericization is unverified by a second real consumer** until the
  lightbridge follow-up PR lands. If that PR reveals the parameterization is wrong in some way (e.g.
  lightbridge needs more than a single `pluginConfigKey` string), this ADR's shape may need a
  follow-up amendment.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| **Fork the model-sync engine into `opencode-lightbridge` directly** (the "do nothing here" option) | Duplicates the cross-process cache-adoption logic, the scheduler, and model discovery/normalization — code with subtle correctness properties (single-use refresh-token reuse detection) and a large existing test suite. Every future fix would need to land twice. |
| **Fold the config-key literals into the shared engine as a fixed `"oauth2ModelSync"` default, overridable by lightbridge** | Reintroduces oauth2-specific naming into a package meant to be plugin-neutral, and a "default that oauth2 happens to want" is not meaningfully different from hardcoding it — it just delays the parameterization by one release rather than avoiding it. Explicit `pluginConfigKey`/`optionKeys` arguments make every consumer's config surface visible at its own call site. |
| **Move the Responses-API SSE repair into the shared engine, gated by an `enableResponsesRepair: boolean` flag** | The repair is Envoy-AI-Gateway-specific (see its own module doc in `responses-repair.ts`); a boolean flag would still require the engine to import and ship the repair implementation for every consumer, including ones that never need it. An injected hook keeps the dependency direction correct — the engine takes a function, it never owns gateway-specific behaviour. |
| **Have the engine call a consumer-supplied `validateConfig` function itself** (full inversion of control over validation) | Rejected in favour of the simpler "accept already-validated objects" contract: auth-subset validation differs enough per consumer (oauth2's PKCE/redirect-port/flow-required-field checks vs. whatever lightbridge's gateway module needs) that forcing a common validation function *signature* across consumers would constrain that surface for no real reuse benefit — the actual reusable primitive is already `@vymalo/opencode-auth-core`'s `validateAuthConfig`, which both oauth2's `config.ts` and any future consumer's config module already layer on directly. |

## Related

- [`docs/provider-sync.md`](../provider-sync.md) — the package's own user-facing reference.
- [ADR-0012](0012-single-auth-across-gateway-and-otel.md) — the shared `TokenRuntime` precedent this
  extraction follows, and the umbrella plugin (`opencode-lightbridge`) that will consume this
  engine in a follow-up PR.
- The 0.15.0 `CHANGELOG.md` entry — the auth-core/core-otel extraction precedent ("extracted...with
  no behaviour change").
