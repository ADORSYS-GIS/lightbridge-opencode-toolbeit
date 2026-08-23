# `@vymalo/opencode-repo-auth`

[![npm](https://img.shields.io/npm/v/@vymalo/opencode-repo-auth?label=npm&color=CB3837&logo=npm)](https://www.npmjs.com/package/@vymalo/opencode-repo-auth)

**Bill each gateway request to the git project you're working on** — the same repo-as-principal
attribution CI already has, for local development. The developer logs in once as themselves, and
every request from an enrolled repo carries a short-lived, **project-scoped** bearer minted by a
single RFC 8693 token exchange presenting `project_id` (no `audience`, no mint step). See
[ADR-0011](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/adr/0011-repo-auth-project-id-token-exchange.md).

Part of the [OpenCode Toolbelt](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit).

## How it works

1. **Log in once** — `@vymalo/opencode-auth-core`'s `TokenRuntime` runs the configured OAuth flow
   (`device_code` for headless, or `authorization_code` with PKCE) against `issuer`, producing a
   human root token with `offline_access` for silent refresh.
2. **Exchange per project** — `exchangeTo(projectId, humanToken, { project_id })`, an RFC 8693 token
   exchange. The IdP resolves membership server-side and seals `{account_id, project_id}` into the
   returned JWT. The project token is short-lived and carries no refresh token; renewal is always a
   fresh exchange from the offline human root ("model b").
3. **Inject per request** — a `chat.headers` hook stamps `Authorization: Bearer <project-token>` on
   the opted-in providers only. **Fail-closed**: an exchange failure injects no header (the gateway
   401s), so a request never runs under the wrong identity.

## Install

```sh
npm install @vymalo/opencode-repo-auth
```

```jsonc
// opencode.json
{
  "plugin": ["@vymalo/opencode-repo-auth"],
  "provider": {
    "gateway": {
      "options": {
        "baseURL": "https://api.example.com/v1",
        "meta": {
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
}
```

The plugin opts in **per provider** via `options.meta.repoAuth`; a missing or malformed block
warns-and-skips that provider rather than aborting the whole config hook.

## `projectId` is declared, not derived

`projectId` comes from config — it is **never** derived from the git remote, because a repo may
belong to many projects. The git `origin` (worktree-aware, hardened against odd `.git` pointers) is
resolved for **logging only**. The exchanged token is cached per project, `0o600`, atomic-rename.

## Don't stack it with `oauth2`

`@vymalo/opencode-repo-auth` and `@vymalo/opencode-oauth2` both set `Authorization` — never enable
both on the **same** provider (the plugin guards against this and logs a conflict). Need one
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
