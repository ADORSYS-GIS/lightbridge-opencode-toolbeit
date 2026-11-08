# Product Requirements Document (PRD)

> **Historical design record (OpenCode v1).** Written against the v1 plugin API (`Hooks.*`, `chat.headers`, `options.meta.*`, `pluginConfig`, `provider.options.fetch`). The suite is now v2-only ([ADR-0019](../docs/adr/0019-opencode-v2-cutover.md)); read those names as the v1 design, and see [`docs/architecture.md`](../docs/architecture.md) for current behaviour and config.

## Product Name

**OpenCode OAuth2 Model Sync Plugin**

## Version

v2.0

## Summary

Build an OpenCode plugin that authenticates users via OAuth2/OIDC, discovers models from OpenAI-compatible servers, normalizes model IDs into human-readable names, and periodically syncs model availability. The product will be delivered as a **pnpm workspace** with:

* a **runtime plugin package** for OpenCode,
* a **dedicated packaging sub-package** using **Rolldown**,
* and an optional **Rust native sub-package** exposed to Node through **Node-API / napi-rs** for performance-sensitive work. OpenCode supports npm-loaded plugins and OpenAI-compatible custom providers, Rolldown is a Rust-based bundler with a Rollup-compatible API, and Node-API is ABI-stable across Node versions; napi-rs is built specifically for Rust-based Node addons. ([OpenCode][1])

---

## 1. Background

Teams increasingly consume AI through OpenAI-compatible gateways and enterprise providers secured with OAuth2/OIDC. These providers usually expose a `/v1/models` endpoint, but model lists change over time and model IDs are not user-friendly. OpenCode can already load plugins from npm and configure custom providers via `@ai-sdk/openai-compatible`, so the gap is automating authentication, discovery, naming, and sync. ([OpenCode][1])

---

## 2. Problem Statement

Today, users must manually:

* configure OpenAI-compatible providers,
* manage OAuth2 access externally,
* maintain model lists,
* and interpret raw model IDs such as `glm-5` or `qwen2-72b-instruct`.

This causes:

* stale provider configurations,
* poor first-run UX,
* repeated manual setup across environments,
* inconsistent naming,
* and operational friction when model inventories change.

---

## 3. Product Vision

Provide a plugin that makes any OAuth2-secured, OpenAI-compatible model server feel native inside OpenCode:

* configure an issuer and API base URL,
* log in on first use,
* discover models automatically,
* present readable model names,
* and keep the provider list fresh through scheduled sync.

---

## 4. Goals

### Primary Goals

* Support OAuth2/OIDC login using Authorization Code + PKCE.
* Discover models from OpenAI-compatible `/v1/models` endpoints.
* Normalize model IDs into readable display names.
* Periodically sync models and keep a last-known-good cache.
* Package the solution with a dedicated Rolldown sub-package.
* Allow optional Rust acceleration for hot paths.

### Secondary Goals

* Support multiple servers in one config.
* Allow display-name overrides.
* Provide structured logging.
* Keep the runtime plugin thin and maintainable.

---

## 5. Non-Goals

This product will not:

* implement inference routing itself,
* proxy all model requests through the plugin,
* replace OpenCode’s provider system,
* host an OAuth2 server,
* build a GUI admin console,
* or require Rust for baseline functionality.

---

## 6. Users

### Primary Users

* developers using OpenCode with enterprise or self-hosted AI providers,
* platform teams exposing OpenAI-compatible gateways,
* internal developer enablement teams.

### Secondary Users

* teams with Rust expertise who want higher performance for parsing and transformation work,
* maintainers who need repeatable packaging and release workflows.

---

## 7. User Stories

As a user, I want to configure a provider with an `issuer` and `baseURL` so I do not need to hardcode token endpoints.

As a user, I want login to start automatically on first use so I do not manually fetch tokens.

As a user, I want model IDs like `glm-5` shown as `GLM 5` so model selection is easier.

As a user, I want the plugin to refresh models regularly so newly available models appear without manual edits.

As a maintainer, I want packaging isolated in its own sub-package so the plugin runtime stays simple.

As a Rust-capable maintainer, I want performance-sensitive work moved into a native module without rewriting the whole plugin.

---

## 8. Success Metrics

* First successful setup in under 10 minutes for a typical provider.
* Login success rate above 95% in supported environments.
* Scheduled sync success rate above 99% when the provider is healthy.
* Fallback to cached models on sync failure 100% of the time.
* Native module remains optional; plugin still works without it.

---

## 9. Product Scope

### In Scope

* OpenCode plugin package loaded from npm.
* OAuth2/OIDC discovery from issuer.
* Auth Code + PKCE login.
* Token refresh and local token storage.
* `/v1/models` fetch and parsing.
* Model display-name normalization.
* Scheduled sync and caching.
* Rolldown-based bundling in a separate package.
* Optional Rust native module via Node-API/napi-rs.

### Out of Scope

* Browser extensions.
* Full Rust-only plugin runtime.
* Custom OpenCode core patches.
* Billing, usage analytics, or pricing metadata in v1 unless returned trivially.

---

## 10. Functional Requirements

### 10.1 Workspace Structure

The product must be delivered as a pnpm workspace with at least three packages:

* `packages/opencode-oauth2`: runtime plugin package
* `packages/plugin-bundle`: packaging/build-only package using Rolldown
* `packages/native-core`: optional Rust native package

This separation is required so packaging concerns do not leak into plugin runtime logic.

### 10.2 Runtime Plugin

The OpenCode plugin package must:

* load configuration,
* validate schema,
* initialize logging,
* load token/model cache,
* trigger login on demand,
* call `/v1/models`,
* expose discovered models as OpenCode-compatible provider metadata,
* and schedule periodic sync.

OpenCode supports custom providers using `@ai-sdk/openai-compatible` with `options.baseURL` and model maps, so the plugin must target that shape. ([OpenCode][1])

### 10.3 Packaging Sub-Package

The build package must:

* use Rolldown as the bundler,
* own the bundling config,
* emit the plugin artifact,
* externalize Node built-ins,
* externalize the native addon dependency,
* and produce ESM output suitable for the runtime package.

Rolldown provides a bundler API and is designed as a Rust-based bundler with a Rollup-compatible API. ([Rolldown][2])

### 10.4 Native Sub-Package

The native package must:

* expose a narrow Node-facing API,
* use Node-API rather than direct V8 bindings,
* be buildable and publishable independently,
* and remain optional at runtime.

Node-API is stable and ABI-compatible across Node versions when used exclusively, which makes it the correct foundation for native addon longevity. ([Node.js][3])

### 10.5 OAuth2/OIDC

The plugin must support:

* issuer-based discovery,
* authorization code + PKCE,
* localhost callback handling or equivalent local interactive flow,
* token refresh if refresh tokens are available,
* re-login if refresh fails or is unavailable.

Configurable fields:

* `issuer`
* `clientId`
* `scopes`
* optional endpoint overrides:

  * `authorizationEndpoint`
  * `tokenEndpoint`
  * `jwksUri`

### 10.6 Model Discovery

The plugin must call:

* `GET {baseURL}/v1/models`

It must:

* parse the response,
* retain raw IDs as source of truth,
* generate readable display names,
* diff with cached results,
* and update the effective provider model map.

### 10.7 Model Name Normalization

The plugin must convert model IDs into readable names.

Examples:

* `glm-5` → `GLM 5`
* `gpt-4o-mini` → `GPT 4o Mini`
* `qwen2-72b-instruct` → `Qwen2 72B Instruct`

Normalization rules:

* split on separators such as `-`, `_`, `/`, `:`
* uppercase known acronyms and vendor tokens
* preserve version-like numeric forms
* title-case remaining tokens
* allow config overrides per model ID

### 10.8 Periodic Sync

The plugin must support:

* sync on startup warm-up,
* sync on first real use if needed,
* periodic sync using a configurable interval.

Default:

* `syncIntervalMinutes = 60`

Failure behavior:

* preserve last-known-good models,
* log error,
* retry with backoff.

### 10.9 Caching

The plugin must persist:

* tokens,
* last sync timestamp,
* raw model list,
* normalized model list.

Suggested location:

* OpenCode-appropriate config/cache directory on the host.

### 10.10 Logging

The plugin must emit structured logs for:

* initialization,
* login start/success/failure,
* token refresh,
* sync start/success/failure,
* native module availability,
* fallback to pure TypeScript path.

---

## 11. Technical Requirements

### 11.1 Language and Tooling

* pnpm workspace
* TypeScript for runtime package
* Rolldown for packaging sub-package
* Biome for linting/formatting
* optional Rust via napi-rs for native package

### 11.2 Packaging Constraints

* the runtime plugin package must not own bundling logic directly,
* the dedicated packaging package must be the only place where Rolldown config lives,
* the final plugin package must be publishable independently.

### 11.3 Native Boundary Constraints

The Rust module must only contain performance-sensitive logic such as:

* batch model normalization,
* model diffing,
* cache hashing/serialization helpers,
* OAuth metadata normalization if profiling justifies it.

The Rust module must not own:

* OpenCode lifecycle wiring,
* browser login orchestration,
* scheduling,
* or provider registration.

### 11.4 Fallback

A pure TypeScript implementation must exist for all native functionality so the plugin remains operational when the native module is unavailable.

---

## 12. Proposed Package Design

### 12.1 `opencode-oauth2`

Responsibilities:

* OpenCode integration
* config validation
* OAuth orchestration
* HTTP calls
* cache control
* scheduling
* provider generation

### 12.2 `plugin-bundle`

Responsibilities:

* Rolldown config
* production bundling
* sourcemaps
* release assembly
* external dependency handling

### 12.3 `native-core`

Responsibilities:

* Node-API addon
* batch transforms
* diffing
* deterministic normalization helpers

---

## 13. Architecture

### High-Level Flow

1. OpenCode loads the npm plugin.
2. Plugin validates config and reads cache.
3. On first use or scheduled refresh, plugin ensures a valid token.
4. Plugin calls `/v1/models`.
5. Models are normalized.
6. Provider model definitions are updated.
7. Cache is written.
8. Scheduler repeats based on interval.

### Native Path

* If native module is available, normalization and diffing are delegated to Rust.
* If not, the TypeScript path is used transparently.

---

## 14. API and Config Shape

Example config:

```jsonc
{
  "plugin": ["@your-org/opencode-oauth2-model-sync"],
  "pluginConfig": {
    "oauth2ModelSync": {
      "servers": [
        {
          "id": "example-ai",
          "name": "Example AI",
          "issuer": "https://auth.example.com",
          "baseURL": "https://api.example.com/v1",
          "clientId": "opencode-client",
          "scopes": ["openid", "profile", "offline_access"],
          "syncIntervalMinutes": 60,
          "nameOverrides": {
            "glm-5": "GLM 5"
          }
        }
      ]
    }
  }
}
```

---

## 15. Non-Functional Requirements

### Performance

* Model sync should complete in under 3 seconds under normal network conditions for modest model lists.
* Large model-list transforms should benefit from batch native processing where available.

### Reliability

* Failed sync must not erase cached models.
* Invalid token state must trigger refresh or re-auth.
* Native module load failure must not break the plugin.

### Security

* PKCE required for interactive OAuth flow.
* Tokens must never be logged.
* Token storage must use restrictive file permissions where supported.
* Node-API must be preferred over unstable V8-specific bindings for native longevity. ([Node.js][3])

### Maintainability

* Runtime, packaging, and native concerns must remain separated.
* Native API surface should be small and versioned.

---

## 16. Risks and Mitigations

### Risk: Native packaging complexity

Impact: medium
Mitigation: pure TS fallback, narrow native boundary, prebuilt binaries later.

### Risk: OAuth provider variance

Impact: medium
Mitigation: issuer discovery first, endpoint overrides supported.

### Risk: OpenAI-compatible API variance

Impact: medium
Mitigation: tolerant parsing, config-driven base URL and endpoint override potential.

### Risk: Plugin lifecycle constraints in OpenCode

Impact: medium
Mitigation: keep provider generation compatible with documented custom provider shape. ([OpenCode][1])

---

## 17. Release Plan

### Phase 1

* pnpm workspace scaffold
* TypeScript runtime package
* Rolldown packaging package
* Biome and tests

### Phase 2

* OAuth discovery and login
* `/v1/models` fetch
* TS normalization
* caching and logs

### Phase 3

* periodic sync
* provider update flow
* production packaging

### Phase 4

* Rust native package with batch normalization and diffing
* optional loading
* TS fallback hardening

### Phase 5

* CI, cross-platform builds, documentation, publish

---

## 18. Acceptance Criteria

The product is accepted when:

* a user can install the npm plugin in OpenCode,
* configure one OAuth2-secured OpenAI-compatible provider,
* log in interactively,
* see discovered models with readable names,
* observe scheduled sync updating the model list,
* and use the plugin successfully both with and without the native module.

---

## 19. Open Questions

* Does OpenCode expose a direct runtime mutation path for providers, or should the plugin materialize provider definitions into an intermediate state consumed by OpenCode?
* Should device-code flow be added for headless environments in v1.1?
* Should model metadata beyond name and ID be included when present?
* Should prebuilt native binaries be part of the first public release or a follow-up?

---

## 20. Final Recommendation

Proceed with a **hybrid architecture**:

* TypeScript for the OpenCode-facing runtime,
* Rolldown in a dedicated build-only sub-package,
* Rust through Node-API/napi-rs for batch transformation hot paths,
* and a mandatory pure TypeScript fallback.

That gives the team a maintainable product now and a clean path to performance improvements later, while aligning with the current OpenCode provider model, Rolldown’s intended bundling role, and Node-API’s stability guarantees. ([OpenCode][1])

If you want, I can turn this PRD into an engineering-ready TAD next.

[1]: https://opencode.ai/docs/providers?utm_source=chatgpt.com "Providers | opencode"
[2]: https://rolldown.rs/?utm_source=chatgpt.com "Rolldown"
[3]: https://nodejs.org/api/n-api.html?utm_source=chatgpt.com "Node-API | Node.js v25.8.1 Documentation"
