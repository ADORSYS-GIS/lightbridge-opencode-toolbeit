# ADR-0011: repo-auth uses a `project_id` token exchange, not an audience-scoped Source exchange

Status: **Accepted**

## Context

Epic [#64](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/issues/64) wants local-dev OpenCode requests attributed and billed to the repo's project, the way CI already is. Ticket [#67](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/issues/67) originally specified the client half as: resolve git `origin` → Source id → RFC 8693 token exchange of the human token to `aud = <base>/sources/src-XXX`.

That contract changed on the IdP side before the plugin was built. Two reframes on #67 (2026-07-07) and the shipped [`lightbridge-keycloak-spi`](https://github.com/ADORSYS-GIS/lightbridge-keycloak-spi/blob/main/docs/architecture.md) define the live contract: a **single token exchange presenting a `project_id` form param** (no `audience`, no mint step). The SPI (`LightbridgeTokenExchangeProvider`, order 100) claims the request when `project_id` is present, resolves membership server-side via `lightbridge-authz` `POST /idp/v1/resolve-context`, and seals `{account_id, project_id}` into the returned JWT. A self-audience is rejected ("Requested audience not available"); non-membership fails closed (no token).

The plugin must reuse `@vymalo/opencode-auth-core` (extracted in #66 / PR #97) — the whole point of the extraction is that security-critical OAuth code lives in exactly one place. auth-core's only exchange primitive at extraction time (`exchangeToAudience`) sends an `audience` form param, which the SPI rejects.

## Decision

- The plugin performs a **single RFC 8693 token exchange presenting `project_id` as a form param** (`subject_token` = the human token), exactly per the live SPI contract. No `audience`, no mint step, no client-side resolve call.
- **`projectId` is declared** in `opencode.json` (`options.meta.repoAuth.projectId`), never derived from the git remote — a repo may belong to many projects.
- The project token is **cached per project** under a derived key (`identity-<hash(identity:projectId)>`, NTFS-safe, `0o600`, atomic rename), short-lived and **never refreshed**; renewal is **re-exchange from the offline human root** ("model b") — the human token carries an `offline_access` refresh token and renews itself silently.
- The bearer is injected **only on providers opted in via `options.meta.repoAuth`** (managed-provider guard), and the plugin **never runs on the same provider as `@vymalo/opencode-oauth2`** (guarded + documented).
- **auth-core gains a generic exchange primitive** (`OAuthClient.exchange({ subjectToken, extraParams })` + `TokenRuntime.exchangeTo(key, subjectToken, extraParams)`, with the cache key hashed for path-safety); `exchangeToAudience` remains as a backward-compatible wrapper.

## Consequences

**Buys us:**

- Matches the shipped IdP contract — the plugin works against the real SPI, not a design that was superseded.
- Fail-closed membership: a non-member gets no token, the gateway 401s, the request never runs under a wrong identity.
- Least-privilege credentials: the gateway only ever sees a short-lived, single-project token; the human token (the master credential) never leaves the plugin.
- Security-critical exchange code stays in auth-core — a refresh/PKCE/exchange fix lands in one place.

**Costs us:**

- auth-core needs a small, backward-compatible extension (generic exchange + hashed cache keys) before the plugin can build.
- `projectId` must be declared per repo; resolve-by-remote stays deferred.
- Two plugins must be kept off the same provider — enforced by a guard plus documentation.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| **`aud=Source` exchange** (ticket body) | The SPI rejects a self-audience ("Requested audience not available"); resolve-by-remote is deferred, so the Source id would have to be declared anyway. |
| **Mint `request_id` then exchange** (reframe 1) | Superseded by the SPI simplification — the SPI now takes `project_id` directly; a mint step adds a round trip and an endpoint dependency for nothing. |
| **Plugin-side resolve call** (client asks authz who the repo is) | Membership resolution is server-side by design (operator-controlled, revocable per ADR-0049); duplicating it client-side would leak repo identity and trust the client. |
| **Duplicate the exchange in the plugin** (own HTTP POST) | Re-creates the exact drift #66 exists to prevent — timeout/scrub/redact bugs land in two places. |
| **Pass `projectId` as `audience`** (no auth-core change) | The SPI explicitly rejects a self-audience; the exchange would fail closed every time. |