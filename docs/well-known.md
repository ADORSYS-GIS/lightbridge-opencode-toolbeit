# Distributing config via `.well-known/opencode`

How an OpenCode server hands a ready-made provider + plugin setup to a user with a single `opencode auth login <url>` — no hand-written `opencode.json`, no plugin install step. This is the distribution channel the `@vymalo` plugins are built for: the server advertises *"use these plugins, this provider, this issuer"* and the client wires itself up.

> **OpenCode v2.** This page was written against the v1 host. Under v2 the manifest is
> `{ auth?, config?, remote_config? }` and a well-known origin becomes an **Integration**. The
> `auth` block is the same `{ command, env }` shape shown below (it was already command-based in v1).
> Inside `config`, `plugin` becomes `plugins` (entries `{ package, options }`), `provider` becomes
> `providers`, and `options.baseURL` / `options.oauth2` / `options.meta.*` become `settings.*`; the
> oauth2 server list moves from `pluginConfig.oauth2ModelSync.servers` to the plugin's own
> `options.servers`. A v1 and a v2 client cannot share one document. `remote_config` is a host
> feature and is **not** a fit for OAuth2-managed gateways (the config is fetched before the plugin's
> bearer exists). See [ADR-0020](adr/0020-oauth2-integration-domain.md). The v1 examples below are
> kept for reference; the v2 form of the oauth2 example is at the end of this page.

> This page documents **OpenCode host behavior** as observed end-to-end against a live server, cross-checked against the `@opencode-ai/sdk` `Auth` types. It is not behavior implemented in this repo — the plugins are downstream consumers of it. Where the exact host mechanics aren't observable from the outside, that's called out.

## The endpoint

A server publishes a JSON document at `https://<host>/<base>/.well-known/opencode`. Fetch it directly to see exactly what a client will receive:

```sh
curl https://ai-v2.camer.digital/opencode/.well-known/opencode | jq .
```

```jsonc
{
  "auth": {
    "command": ["sh", "-c", "echo plugin-managed"],
    "env": "OPENAI_API_KEY"
  },
  "config": {
    "$schema": "https://opencode.ai/config.json",
    "plugin": ["@vymalo/opencode-oauth2", "@vymalo/opencode-models-info"],
    "provider": {
      "camer-digital": {
        "name": "Camer Digital",
        "options": {
          "baseURL": "https://api.ai-v2.camer.digital/v1",
          "meta": { "modelsInfoUrl": "models/info" },
          "oauth2": {
            "authFlow": "device_code",
            "clientId": "opencode-cli",
            "issuer": "https://auth.verif.fyi/realms/camer-digital",
            "scopes": ["openid", "profile", "offline_access"],
            "syncIntervalMinutes": 60
          }
        }
      }
    }
  }
}
```

Two top-level blocks, with very different jobs.

## The `auth` block → a credential record

`auth` tells OpenCode how to obtain the provider's API key at login:

- `command` — a shell command OpenCode runs once during `opencode auth login`. Its **stdout** becomes the credential value.
- `env` — the environment variable name the provider reads that value from (here `OPENAI_API_KEY`, what the OpenAI-compatible SDK reads).

After login, OpenCode stores a credential of type `wellknown` in `auth.json` (the SDK type is `WellKnownAuth = { type: "wellknown"; key; token }`):

```jsonc
// ~/.local/share/opencode/auth.json  (Linux; ~/Library/... on macOS)
"https://ai-v2.camer.digital/opencode": {
  "type": "wellknown",
  "key": "OPENAI_API_KEY",   // <- auth.env
  "token": "plugin-managed"  // <- stdout of auth.command
}
```

### The `echo plugin-managed` placeholder pattern

Notice the command is just `echo plugin-managed` — it doesn't fetch a real key. That's deliberate. This server's real credential is an **OAuth2 token managed per-request by `@vymalo/opencode-oauth2`**, not a static API key. So the well-known `auth` step only needs to satisfy OpenCode's "every provider has *some* key" requirement with a harmless placeholder; the oauth2 plugin's `model.request` hook then overwrites `Authorization` with a freshly-ensured Bearer on every request (see [architecture.md](./architecture.md#sessionhookmodelrequest--per-request)).

The upshot: `OPENAI_API_KEY=plugin-managed` would, on its own, send `Authorization: Bearer plugin-managed` and 401 — but for any provider the oauth2 plugin manages, that value is never actually used at request time. It's a stub that keeps OpenCode happy until the plugin takes over.

> If your server uses a **static** key instead of a managed token, make `command` emit the real key (e.g. `["sh","-c","cat /etc/opencode/key"]`) and drop the oauth2 plugin. Then `env`/`token` carries the actual credential and no per-request override happens.

## The `config` block → merged into the running config

This is the part that was opaque from the outside, and the answer to *"where is the config of `https://ai-v2.camer.digital/opencode`? I can't find it locally."*

**It isn't stored locally.** OpenCode resolves the `wellknown` credential on launch — re-fetching the `.well-known/opencode` document — and merges its `config` block into the in-memory config it assembles:

- `config.plugin` → the listed plugins are loaded (installed on demand from npm). This is how `@vymalo/opencode-oauth2` and `@vymalo/opencode-models-info` end up active without you adding them to a local `opencode.json`.
- `config.provider` → the `camer-digital` provider (baseURL, `oauth2` extension, `meta.modelsInfoUrl`) is added to `config.provider`, exactly as if you'd hand-written it.

So the provider definition lives **on the server**, fetched fresh each launch. The only on-disk footprint on the client is the one-line `wellknown` pointer in `auth.json`. To inspect what you're actually running, `curl` the endpoint (above) — there is no local file to read.

This also explains a sequencing quirk you may notice in the logs: a `config`-hook log line can show the plugin managing provider `camer-digital` on one run but a *different*, locally-defined provider on another. The well-known's `provider` block only reaches the plugin once OpenCode has resolved and merged it; a local `opencode.json` provider is visible immediately. If both define a provider, you'll see both — make sure their `id`s don't collide (see gotchas).

## Where everything lives — the three locations

| Thing | Location | Notes |
| --- | --- | --- |
| The well-known **pointer** | `auth.json` → `"<url>": { type: "wellknown", key, token }` | All that's persisted on the client. `token` is the placeholder, not a real secret here. |
| The **provider + plugin** definition | The server's `.well-known/opencode` document | Re-fetched on launch; never written to a local `opencode.json`. |
| The **OAuth2 access/refresh token** | The oauth2 plugin's own state dir (ADR-0022), e.g. `~/.local/state/opencode-oauth2/<namespace>/<serverId>.json` (Linux) / `~/Library/Application Support/opencode-oauth2/<namespace>/<serverId>.json` (macOS), `0o600` | Managed entirely by `@vymalo/opencode-oauth2`, **not** in `auth.json`. Absent until a login actually succeeds. See [architecture.md → Cache layout](./architecture.md#cache-layout). |

## The CLI

```sh
# Adopt a server's setup. Runs auth.command, stores the wellknown pointer,
# and (for oauth2 providers) triggers the configured login flow.
opencode auth login https://ai-v2.camer.digital/opencode

# See what's stored. The wellknown entry shows up keyed by URL.
opencode auth list

# Remove it.
opencode auth logout
```

## Gotchas worth knowing

These are the two traps we actually hit bringing this up.

### 1. The provider `id` must match what the plugin manages

`@vymalo/opencode-oauth2` keys everything — its token cache, its `model.request` injection, its model sync — by the **provider id** (the key under the config's providers map, here `camer-digital`). If you *also* have a locally-defined provider for the same backend under a different id (say `cd`), you'll have two providers: the plugin authenticates one and you may invoke the other, yielding a silent 401. Pick one id and delete the duplicate. The fastest tell is the `serverId` field in the plugin's log events — it's the id the plugin is actually working on.

### 2. "Logged in" instantly, with no device-code prompt

On a `device_code` provider you expect a *"visit this URL, enter this code"* prompt. If `opencode auth login` finishes instantly having only run `sh -c echo plugin-managed`, **no OAuth happened** — only the well-known `auth.command` ran. That means the oauth2 plugin didn't pick up the provider on that invocation (commonly because the well-known `provider` block hadn't been merged into the config the plugin's hook saw yet). Re-run an OpenCode command (e.g. `opencode models`); on the next launch the merged provider reaches the plugin, the device-code flow runs for real, and you'll see `oauth_device_code_issued` with a verification URL. Confirm success with a `<serverId>.json` appearing in the oauth2 state dir (`~/Library/Application Support/opencode-oauth2/…` on macOS).

> Keycloak device-code clients with PKCE enforced will 400 the first device request with `Missing parameter: code_challenge_method` — the plugin sends PKCE by default to satisfy that; see [troubleshooting.md](./troubleshooting.md#missing-parameter-code_challenge_method-http-400-on-login).

## Serving your own `.well-known/opencode`

It's just a static (or dynamically-rendered) JSON document at that path. Minimal oauth2 + models-info example, mirroring the one above:

```jsonc
{
  "auth": { "command": ["sh", "-c", "echo plugin-managed"], "env": "OPENAI_API_KEY" },
  "config": {
    "$schema": "https://opencode.ai/config.json",
    "plugin": ["@vymalo/opencode-oauth2", "@vymalo/opencode-models-info"],
    "provider": {
      "your-provider-id": {
        "name": "Your Provider",
        "options": {
          "baseURL": "https://api.example.com/v1",
          "meta": { "modelsInfoUrl": "models/info" },
          "oauth2": {
            "authFlow": "device_code",
            "issuer": "https://auth.example.com/realms/yours",
            "clientId": "opencode-cli",
            "scopes": ["openid", "profile", "offline_access"],
            "syncIntervalMinutes": 60
          }
        }
      }
    }
  }
}
```

List `@vymalo/opencode-oauth2` **before** `@vymalo/opencode-models-info` so the bearer is stamped on the provider headers before the metadata fetch runs ([why](./models-info.md#auth-composition)). For the full provider/option reference see the [oauth2 README](../packages/opencode-oauth2/README.md) and [models-info README](../packages/opencode-models-info/README.md).

### The same document for OpenCode v2

```jsonc
{
  "auth": { "command": ["sh", "-c", "echo plugin-managed"], "env": "OPENAI_API_KEY" },
  "config": {
    "plugins": [
      { "package": "@vymalo/opencode-oauth2" },
      { "package": "@vymalo/opencode-models-info" }
    ],
    "providers": {
      "your-provider-id": {
        "name": "Your Provider",
        "settings": {
          "baseURL": "https://api.example.com/v1",
          "oauth2": {
            "authFlow": "device_code",
            "issuer": "https://auth.example.com/realms/yours",
            "clientId": "opencode-cli",
            "scopes": ["openid", "profile", "offline_access"],
            "syncIntervalMinutes": 60
          }
        }
      }
    }
  }
}
```

The `oauth2` block's fields are unchanged. The exact v2 key names inside `config` follow
[ADR-0019](adr/0019-opencode-v2-cutover.md) and have not been checked against a live v2 host.
