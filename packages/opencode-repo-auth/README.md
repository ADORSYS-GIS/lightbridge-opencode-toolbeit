# `@vymalo/opencode-repo-auth`

[![npm](https://img.shields.io/npm/v/@vymalo/opencode-repo-auth?label=npm&color=CB3837&logo=npm)](https://www.npmjs.com/package/@vymalo/opencode-repo-auth)

**Bill each gateway request to the git project you're working on** — the same repo-as-principal
attribution CI already has, for local development. The developer logs in once as themselves, and
every request from an enrolled repo carries a short-lived, **project-scoped** bearer minted by a
single RFC 8693 token exchange presenting `project_id` (no `audience`, no mint step). See
[ADR-0011](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/adr/0011-repo-auth-project-id-token-exchange.md).

Part of the [OpenCode Toolbelt](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit).

> **Requires OpenCode v2.** This release targets the v2 plugin API and does not run on v1. Migrating from `0.17.x`? See [Migrating from v1](#migrating-from-v1).

## How it works

1. **Log in once** — `@vymalo/opencode-auth-core`'s `TokenRuntime` runs the configured OAuth flow
   (`device_code` for headless, or `authorization_code` with PKCE) against `issuer`, producing a
   human root token with `offline_access` for silent refresh.
2. **Exchange per project** — `exchangeTo(projectId, humanToken, { project_id })`, an RFC 8693 token
   exchange. The IdP resolves membership server-side and seals `{account_id, project_id}` into the
   returned JWT. The project token is short-lived and carries no refresh token; renewal is always a
   fresh exchange from the offline human root ("model b").
3. **Inject per request** — a `model.request` session hook stamps `Authorization: Bearer <project-token>` on
   the opted-in providers only. **Fail-closed**: an exchange failure injects no header (the gateway
   401s), so a request never runs under the wrong identity.

## Install

```sh
npm install @vymalo/opencode-repo-auth
```

```jsonc
// opencode.json
{
  "plugins": ["@vymalo/opencode-repo-auth"],
  "providers": {
    "gateway": {
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": {
        "baseURL": "https://api.example.com/v1",
        "repoAuth": {
          "projectId": "proj-123",
          "issuer": "https://auth.example.com/realms/lightbridge",
          "clientId": "opencode-cli",
          "scopes": ["openid", "offline_access"],
          "authFlow": "device_code"
        }
      }
    }
  }
}
```

The plugin opts in **per provider** via `settings.repoAuth`; a missing or malformed block
warns-and-skips that provider rather than aborting the whole transform. Loading never blocks on
login: a non-interactive warmup exchanges in the background and stamps `Provider.Info.headers.Authorization` (so `models-info` can fetch a protected `modelsInfoUrl`) only if it succeeds; with no login yet, the first model request logs in.

Plugin option: `logLevel` (`TRACE`/`DEBUG`/`INFO`/`WARN`/`ERROR`), else the host's `OPENCODE_LOG_LEVEL`.
Diagnostics go to OpenCode's own log, never the terminal (the device-code login prompt is the one
deliberate exception).

## `projectId` is declared, not derived

`projectId` comes from config — it is **never** derived from the git remote, because a repo may
belong to many projects. The git `origin` (worktree-aware, hardened against odd `.git` pointers) is
resolved for **logging only**. The exchanged token is cached per project, `0o600`, atomic-rename.

## Don't stack it with `oauth2`

`@vymalo/opencode-repo-auth` and `@vymalo/opencode-oauth2` both set `Authorization` — never enable
both on the **same** provider (the plugin skips a provider carrying `settings.oauth2` / `settings.oauth2ModelSync`, or owned by an Integration, and logs a conflict). Need one
credential across the gateway **and** OTEL export? Use the umbrella
[`@vymalo/opencode-lightbridge`](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/tree/main/packages/opencode-lightbridge)
instead of stacking plugins.

## Full reference

- [`docs/repo-auth.md`](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/repo-auth.md)
  — every field, the model-b renewal, the git-hardening cases, troubleshooting.
- [ADR-0011](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/adr/0011-repo-auth-project-id-token-exchange.md)
  — why `project_id` exchange (not an audience-scoped Source), and the alternatives considered.

## License

MIT

## Migrating from v1

`0.18.0` targets the OpenCode **v2** plugin API; `0.17.x` was the last v1 release. See
[ADR-0019](../../docs/adr/0019-opencode-v2-cutover.md) for why there is no dual-support build.

| v1 | v2 |
| --- | --- |
| `"plugin": [...]` | `"plugins": [...]` |
| `"provider": { ... }` | `"providers": { ... }` |
| `"npm": "@ai-sdk/openai-compatible"` | `"package": "aisdk:@ai-sdk/openai-compatible"` |
| `options.baseURL` | `settings.baseURL` |
| `options.meta.repoAuth` | `settings.repoAuth` |
| host `config.logLevel` drove the log level | `options.logLevel`, else `OPENCODE_LOG_LEVEL` |
| config-time bearer stamp onto `options.headers` | `Provider.Info.headers.Authorization`, resolved async then stamped on `provider.reload()`; never stamped if the exchange fails |

The `repoAuth` block's own fields, the exchange wire contract, the cache location (so an existing
login survives) and the surviving `repo_auth_*` event names are unchanged. `effect` `^4.0.0` is now a
peer dependency (the host supplies it).

