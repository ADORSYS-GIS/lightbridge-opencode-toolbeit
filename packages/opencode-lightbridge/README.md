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
  "plugins": [
    {
      "package": "@vymalo/opencode-lightbridge",
      "options": {
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
      }
    }
  ]
}
```

If you also run `@vymalo/opencode-oauth2`, list it **before** lightbridge: lightbridge detects an
oauth2-managed provider id from the `settings.oauth2` marker oauth2 stamps on the provider record.

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

## Migrating from v1

`0.18.0` targets the OpenCode **v2** plugin API; `0.17.x` was the last v1 release. See
[ADR-0019](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/adr/0019-opencode-v2-cutover.md)
for why there is no dual-support build.

**Staying on v1:** `0.17.0` is the last v1-compatible release and stays on npm; install it with `@0.17.0` (or the `opencode-v1` dist-tag, once published). It is frozen: no fixes are backported, so this defers the upgrade, it does not avoid it. See [Staying on v1](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/migration-v2.md#staying-on-v1).

| v1 | v2 |
| --- | --- |
| `"plugin": [["@vymalo/opencode-lightbridge", { ... }]]` | `"plugins": [{ "package": "@vymalo/opencode-lightbridge", "options": { ... } }]` |
| `config.provider[<auth.id>]` registered by `register` | provider editor: `package: "aisdk:@ai-sdk/openai-compatible"`, `settings.baseURL` |
| `chat.headers` (gateway bearer) | `session.hook("model.request")` |
| OTEL observers (`event`, `chat.message`, `tool.execute.*`, …) | `event.subscribe` + `prompt` / `context` / `tool` / `permission` hooks |
| trace propagation via `options.fetch` | `session.hook("http.request")` |
| host `config.logLevel` | `options.logLevel`, else `OPENCODE_LOG_LEVEL` |
| oauth2 collision via `pluginConfig` / `options.oauth2` | `settings.oauth2` marker on the provider record |

The `auth`, `gateway`, `otel` and `register` option blocks are unchanged, as is every event name
except where listed below.

### Behaviour changes in v2

- **Gateway failures now refuse the request.** A failed token resolution used to leave the request
  to go out bearer-less (the gateway 401'd); it now dies the hook so a stale stamped `Authorization`
  cannot ride along (`lightbridge_gateway_no_bearer`, now `warn`).
- **List oauth2 before lightbridge** so the oauth2 collision marker is visible on the first pass.
- **`session.diff`, `todo.updated` and `command.executed` are no longer observed** (no v2 mapping):
  the lines-of-code metric and `opencode.file_edited` event stop being produced.
- `experimental.compaction.autocontinue` is gone with no v2 equivalent.
- `./lib` drops `oauth2ManagedProviderIds` and `OpenCodeConfigLike`; `hasOAuth2Conflict` now takes
  a provider editor.

The full list is in
[`docs/lightbridge.md`](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/lightbridge.md#behaviour-changes-in-v2).
