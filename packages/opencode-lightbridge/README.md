# `@vymalo/opencode-lightbridge`

[![npm](https://img.shields.io/npm/v/@vymalo/opencode-lightbridge?label=npm&color=CB3837&logo=npm)](https://www.npmjs.com/package/@vymalo/opencode-lightbridge)

**One login, every egress.** The umbrella OpenCode plugin for [ADR-0012](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/adr/0012-single-auth-across-gateway-and-otel.md):
a single shared `TokenRuntime` drives **both** the LLM gateway bearer and the OTEL export
credential, because both validate the same `lightbridge-authz` issuer + `aud=lightbridge-api-key`.
Log in once as yourself; every egress that needs a project-scoped credential rides the same token.

Part of the [OpenCode Toolbelt](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit).

## Why this instead of `opencode-repo-auth` + `opencode-otel`

Running both standalone plugins works, but each holds its **own** credential in its **own** cache
namespace — two logins, two token stores, no relationship between them. `@vymalo/opencode-lightbridge`
composes `@vymalo/opencode-auth-core` (the OAuth/token-exchange primitive) and
`@vymalo/opencode-core-otel` (the OTel engine) over **one** `TokenRuntime`, so the project-scoped
token minted for the gateway is the exact same token OTEL presents to the collector. No forked
engine logic — this package is a thin composition layer over its two sibling libraries.

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
        "projectId": "proj-123",
        "providers": ["gateway"]
      },
      "otel": {
        "endpoint": "http://localhost:4318"
      }
    }]
  ]
}
```

- **`auth`** (required) — the one IdP login, an `AuthServerConfigInput` (same shape as
  `opencode-oauth2`/`opencode-repo-auth`'s per-provider auth block).
- **`gateway`** (optional) — `projectId` + the OpenCode provider ids to inject
  `Authorization: Bearer <project-token>` on, per request.
- **`otel`** (optional) — the same `OtelPluginOptions` shape as `@vymalo/opencode-otel`
  (`endpoint`, `exporters`, `serviceName`, …), minus `tokenCommand`/`tokenHeader`/`tokenPrefix`: the
  shared runtime supersedes that seam entirely.
- **`projectId`** (optional, top-level) — only needed when `otel` is configured **without**
  `gateway` (OTEL also consumes the project-scoped token, so it needs a project id from somewhere).
  When `gateway` is set, `gateway.projectId` is used automatically.

Omitting both `gateway` and `otel` is a valid, inert config — the plugin logs and no-ops.

## Scope: gateway + OTEL, not MCP

MCP is deliberately out of scope. OpenCode mints its own per-server MCP OAuth token into
`mcp-auth.json`, and `McpRemoteConfig.headers` is a static map with no per-request hook — sharing
this plugin's credential there would need a stdio credential-proxy sidecar, which isn't worth the
complexity today. MCP keeps using OpenCode's native per-server OAuth. See
[ADR-0012](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/adr/0012-single-auth-across-gateway-and-otel.md)
for the full reasoning.

## Full reference

- [`docs/lightbridge.md`](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/lightbridge.md)
  — the one-credential design, full config reference, the three egresses.
- [ADR-0012](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/adr/0012-single-auth-across-gateway-and-otel.md)
  — why one runtime, why MCP is excluded, the alternatives considered.
- [`docs/repo-auth.md`](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/repo-auth.md)
  and [`docs/otel.md`](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/otel.md)
  — the two standalone plugins this package composes; useful for the config shapes it reuses.

## License

MIT
