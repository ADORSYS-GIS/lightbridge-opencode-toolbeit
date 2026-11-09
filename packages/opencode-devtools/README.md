# @vymalo/opencode-devtools

> A belt of everyday, **deterministic, local** developer utilities for the model — maths, encoding,
> crypto, date/time, structured-data conversion, and an opt-in HTTP client.

[![npm](https://img.shields.io/npm/v/@vymalo/opencode-devtools)](https://www.npmjs.com/package/@vymalo/opencode-devtools)
![node: >=22](https://img.shields.io/badge/node-%3E%3D22-339933)
![license: MIT](https://img.shields.io/badge/license-MIT-blue)

> **Requires OpenCode v2.** This release targets the v2 plugin API and does not run on v1. Migrating from `0.17.x`? See [Migrating from v1](#migrating-from-v1).

An OpenCode plugin that registers a set of pure, in-process tools the model can call — no bridge, no
server, no auth. Tools are organised into **groups** (gated by the `groups` option, like the browser
plugin): `math`, `codec`, `crypto`, `datetime`, `convert` (on by default) and an opt-in, SSRF-guarded
`http` group. The same tool surface ships as an MCP server: [`@vymalo/opencode-devtools-mcp`](../opencode-devtools-mcp).

## Install

```jsonc
// opencode.json
{
  "plugins": ["@vymalo/opencode-devtools"]
}
```

Enable the `http` group (off by default — it performs network egress):

```jsonc
{
  "plugins": [
    {
      "package": "@vymalo/opencode-devtools",
      "options": {
        "groups": ["math", "codec", "crypto", "datetime", "convert", "http"],
        "http": { "allowPrivateNetwork": false }
      }
    }
  ]
}
```

## Tools at a glance

| Group | Tools |
| --- | --- |
| `math` | `math_eval` (64-digit), `math_convert_unit`, `math_stats`, `math_base` |
| `codec` | `codec_base64`, `codec_hex`, `codec_url`, `codec_jwt_decode`, `codec_gzip` |
| `crypto` | `crypto_hash`, `crypto_hmac`, `crypto_uuid` (v4/v7), `crypto_ulid`, `crypto_random`, `crypto_keypair` |
| `datetime` | `datetime_now`, `datetime_parse`, `datetime_format`, `datetime_diff`, `datetime_convert_tz`, `datetime_cron` |
| `convert` | `convert_data` (JSON/YAML/TOML/CSV), `convert_query` (JSONPath) |
| `http` *(opt-in)* | `http_request`, `http_graphql` |

Full reference, config, and the security model: [`docs/devtools.md`](../../docs/devtools.md).

## Why not memory / adb / database too?

Those already have mature MCP servers, so we **adopt** them rather than rebuild — see
[`docs/recommended-mcps.md`](../../docs/recommended-mcps.md). devtools fills only the gaps: the small
deterministic utilities nobody else maintains well.

## License

MIT

## Migrating from v1

`0.18.0` targets the OpenCode **v2** plugin API; `0.17.x` was the last v1 release. See
[ADR-0019](../../docs/adr/0019-opencode-v2-cutover.md) for why there is no dual-support build.

**Staying on v1:** `0.17.0` is the last v1-compatible release and stays on npm; install it with `@0.17.0` (or the `opencode-v1` dist-tag, once published). It is frozen: no fixes are backported, so this defers the upgrade, it does not avoid it. See [Staying on v1](../../docs/migration-v2.md#staying-on-v1).

| v1 | v2 |
| --- | --- |
| `"plugin": [...]` | `"plugins": [...]` |
| `["@vymalo/opencode-devtools", { ... }]` tuple | `{ "package": "@vymalo/opencode-devtools", "options": { ... } }` |
| `pluginConfig` / the tuple's options | the plugin's own `options` (`ctx.options`) |
| `groups`, `http`, `enabled` options | unchanged |
| host `config.logLevel` drove the log level | `options.logLevel`, else `OPENCODE_LOG_LEVEL` |
| `Hooks.tool` map built with `tool.schema` (zod) | `ctx.tool.transform`, raw JSON Schema input, one tool *namespace* per group |
| tool names `math_eval`, `codec_base64`, ... | unchanged (namespace `math` + tool `eval` is exposed as `math_eval`) |

Every tool's arguments, result text and `devtools_*` log event name are unchanged. `effect` is now a
**peer dependency** supplied by OpenCode; do not install a second copy.

The `./lib` subpath (shared with `@vymalo/opencode-devtools-mcp`) no longer re-exports the plugin
factory, `createDevtoolsTools` or the logger implementations; it carries the catalog, schema,
options and execution context only, and has no `effect` dependency.
