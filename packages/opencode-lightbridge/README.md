# `@vymalo/opencode-lightbridge`

[![npm](https://img.shields.io/npm/v/@vymalo/opencode-lightbridge?label=npm&color=CB3837&logo=npm)](https://www.npmjs.com/package/@vymalo/opencode-lightbridge)

**The all-in-one plugin.** One credential drives everything: provider registration + model
discovery ([`register`](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/adr/0017-lightbridge-all-in-one.md) —
"everything `@vymalo/opencode-oauth2` does"), the LLM gateway bearer (`gateway`), and the OTEL
export credential (`otel`) — see [ADR-0012](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/adr/0012-single-auth-across-gateway-and-otel.md)
and [ADR-0017](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/adr/0017-lightbridge-all-in-one.md).
Log in once as yourself; every module that needs a credential rides the same login — and since
ADR-0017, that login is shared with `@vymalo/opencode-oauth2` too, when both target the same IdP.

Part of the [OpenCode Toolbelt](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit).

## Why this instead of `opencode-oauth2` + `opencode-repo-auth` + `opencode-otel`

Running the standalone plugins works, but each holds its **own** credential in its **own** cache
namespace — up to three logins, three token stores, no relationship between them.
`@vymalo/opencode-lightbridge` composes `@vymalo/opencode-provider-sync` (the model-sync engine,
for `register`), `@vymalo/opencode-auth-core` (the OAuth/token-exchange primitive), and
`@vymalo/opencode-core-otel` (the OTel engine) over **one shared credential**, so the same token
that registers your provider is the one the gateway injects and OTEL presents to the collector. No
forked engine logic — this package composes its sibling libraries.

## Install

```sh
npm install @vymalo/opencode-lightbridge
```

```jsonc
// opencode.json
{
  "plugin": [
    ["@vymalo/opencode-lightbridge", {
      "auth": {
        "id": "lightbridge",
        "issuer": "https://authz.example.com/realms/lightbridge",
        "clientId": "opencode-cli",
        "scopes": ["openid", "offline_access"],
        "authFlow": "device_code"
      },
      "gateway": {
        "providers": ["gateway"],
        "exchange": false
      },
      "otel": {
        "endpoint": "http://localhost:4318"
      },
      "register": {
        "baseURL": "https://gateway.example.com/v1"
      }
    }]
  ]
}
```

- **`auth`** (required) — the one IdP login, an `AuthServerConfigInput` (same shape as
  `opencode-oauth2`/`opencode-repo-auth`'s per-provider auth block). `auth.id` also doubles as the
  OpenCode provider id `register` uses and the shared cache identity (see below).
- **`register`** (optional, [ADR-0017](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/adr/0017-lightbridge-all-in-one.md)) —
  register `auth`'s IdP as an OpenCode provider and keep its models in sync, via the same
  `@vymalo/opencode-provider-sync` engine `opencode-oauth2` uses. Requires `register.baseURL`.
- **`gateway`** (optional) — the OpenCode provider ids to inject a bearer on, per request (plus an
  optional `gateway.exchange`/`projectId`).
- **`gateway.exchange`** (optional, default `false`) — `false`: use the IdP access token directly.
  `true`: RFC 8693-exchange it for a project-scoped token first (ADR-0012's original behaviour).
- **`otel`** (optional) — the same `OtelPluginOptions` shape as `@vymalo/opencode-otel`
  (`endpoint`, `exporters`, `serviceName`, …), minus `tokenCommand`/`tokenHeader`/`tokenPrefix`: the
  shared runtime supersedes that seam entirely.
- **`projectId`** (optional, top-level or under `gateway`) — only meaningful when
  `gateway.exchange: true`. **Fully optional**: omit it and the exchange sends no `project_id`, so
  the backend mints a token for your **default project**. An explicit top-level `projectId` wins
  over `gateway.projectId`.

Omitting `gateway`, `otel` and `register` is a valid, inert config — the plugin logs and no-ops.

**One login, shared with oauth2.** Configure the same `id`/`issuer`/`clientId` as an
`@vymalo/opencode-oauth2` server entry and logging in through either plugin makes the token
available to both — no second device-code/browser flow. An existing pre-ADR-0017 install's cached
login is migrated automatically on first use; no re-login is forced. See
[`docs/lightbridge.md`](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/lightbridge.md#one-login-shared-cache-with-oauth2-adr-0017).

## Scope: gateway + OTEL, not MCP

MCP is deliberately out of scope. OpenCode mints its own per-server MCP OAuth token into
`mcp-auth.json`, and `McpRemoteConfig.headers` is a static map with no per-request hook — sharing
this plugin's credential there would need a stdio credential-proxy sidecar, which isn't worth the
complexity today. MCP keeps using OpenCode's native per-server OAuth. See
[ADR-0012](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/adr/0012-single-auth-across-gateway-and-otel.md)
for the full reasoning.

## Full reference

- [`docs/lightbridge.md`](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/lightbridge.md)
  — the all-in-one design, full config reference, migration notes.
- [ADR-0012](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/adr/0012-single-auth-across-gateway-and-otel.md)
  — why one runtime, why MCP is excluded, the alternatives considered.
- [ADR-0017](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/adr/0017-lightbridge-all-in-one.md)
  — `register`, the shared cache with oauth2, and the exchange becoming opt-in.
- [`docs/repo-auth.md`](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/repo-auth.md),
  [`docs/otel.md`](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/otel.md) and
  [`docs/architecture.md`](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/architecture.md)
  (oauth2) — the standalone plugins this package composes; useful for the config shapes it reuses.

## License

MIT
