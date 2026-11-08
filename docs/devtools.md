# Devtools utilities (`@vymalo/opencode-devtools` + `-mcp`)

A belt of everyday, **deterministic, local** developer utilities the model can call directly —
maths, encoding, crypto primitives, date/time, structured-data conversion, and an opt-in HTTP
client. Two packages, one tool surface:

- **`@vymalo/opencode-devtools`** — the OpenCode plugin (v2 plugin API; registers the tools via `ctx.tool.transform`, one tool namespace per group).
- **`@vymalo/opencode-devtools-mcp`** — an MCP stdio server exposing the same catalog to any MCP
  client (Claude Code, Cursor, Cline, …).

Unlike `@vymalo/opencode-browser`, there is **no bridge, no server, no auth** — every tool is a pure
in-process function over an injected clock / randomness / `fetch`. The shared catalog lives in
`catalog.ts` (re-exported through `./lib`), so the plugin and the MCP server never drift.

> Why these and not memory / adb / database? Those already have mature MCP servers, so we **adopt**
> them rather than rebuild — see [`recommended-mcps.md`](recommended-mcps.md). The build-vs-adopt
> rationale is written up in [`plans/devtools.md`](../plans/devtools.md).

## Tool groups

Tools are organised into **groups**, gated by the `groups` option (same pattern as the browser
plugin's `page`/`control`/`debug`/`interactive`). The five deterministic, offline groups are on by
default; **`http` performs network egress and is opt-in.**

| Group | Default | Tools |
| --- | --- | --- |
| `math` | ✅ on | `math_eval`, `math_convert_unit`, `math_stats`, `math_base` |
| `codec` | ✅ on | `codec_base64`, `codec_hex`, `codec_url`, `codec_jwt_decode`, `codec_gzip` |
| `crypto` | ✅ on | `crypto_hash`, `crypto_hmac`, `crypto_uuid`, `crypto_ulid`, `crypto_random`, `crypto_keypair` |
| `datetime` | ✅ on | `datetime_now`, `datetime_parse`, `datetime_format`, `datetime_diff`, `datetime_convert_tz`, `datetime_cron` |
| `convert` | ✅ on | `convert_data`, `convert_query` |
| `http` | ⛔ opt-in | `http_request`, `http_graphql` |

Per-agent control is also available via OpenCode's tool allow/deny on the individual tool names.

### `math`
- **`math_eval`** — evaluate an expression at 64-digit precision (`(2+3)*4`, `sqrt(2)`, `5 km to miles`). Sandboxed — see [Security](#security).
- **`math_convert_unit`** — `value` + `from` + `to` across length/mass/time/temperature/data/energy/….
- **`math_stats`** — count/sum/min/max/mean/median/mode/variance/stdev over a number array.
- **`math_base`** — integer radix conversion (2–36), with binary/octal/decimal/hex echoed back.

### `codec`
- **`codec_base64`** — encode/decode, standard or `urlSafe` (base64url).
- **`codec_hex`** — hex encode/decode.
- **`codec_url`** — percent-encode/decode (`component` for a query value, else whole-URL).
- **`codec_jwt_decode`** — split + decode header/payload. **Signature is not verified** (`verified: false`); never trust it for auth.
- **`codec_gzip`** — gzip/deflate compress↔decompress; compressed bytes travel as base64.

### `crypto`
- **`crypto_hash`** / **`crypto_hmac`** — md5/sha1/sha256/sha512 digests (keyed for HMAC), with input/output encodings.
- **`crypto_uuid`** — UUID v4 (random) or v7 (time-ordered, sortable).
- **`crypto_ulid`** — 26-char Crockford-base32 sortable id.
- **`crypto_random`** — N strong random bytes (hex/base64/base64url).
- **`crypto_keypair`** — ed25519 / rsa / ec (P-256) keypair, PEM-encoded.

### `datetime`
- **`datetime_now`** — current time, optional IANA `zone`.
- **`datetime_parse`** — ISO / RFC 2822 / SQL / epoch-millis / custom Luxon `format` → normalized ISO + components.
- **`datetime_format`** — Luxon token string, or a preset (`iso`/`rfc2822`/`http`/`sql`/`relative`).
- **`datetime_diff`** — duration between two instants in chosen `units`.
- **`datetime_convert_tz`** — convert between IANA timezones (the instant is preserved).
- **`datetime_cron`** — explain a cron expression in English **and** list the next N runs.

### `convert`
- **`convert_data`** — interconvert JSON ⇄ YAML ⇄ TOML ⇄ CSV (CSV maps to/from row objects; TOML output needs a top-level table).
- **`convert_query`** — JSONPath query (`$.items[*].name`) over a JSON/YAML/TOML doc.

> For deep `jq`-style querying, adopt [`bitflight-devops/mcp-json-yaml-toml`](recommended-mcps.md);
> `convert` covers CSV interconversion + JSONPath, the gaps that server leaves.

### `http` (opt-in)
- **`http_request`** — method / url / headers / body; structured `{ status, headers, body }` (JSON auto-parsed).
- **`http_graphql`** — POST a query + variables; structured `{ data, errors }`.

## Configuration

### As an OpenCode plugin

Requires OpenCode **v2**. Plugin id `vymalo.devtools`.

```jsonc
// opencode.json
{
  "plugins": [
    "@vymalo/opencode-devtools",
    // or, to enable the http group + reach internal hosts:
    {
      "package": "@vymalo/opencode-devtools",
      "options": {
        "groups": ["math", "codec", "crypto", "datetime", "convert", "http"],
        "http": { "allowPrivateNetwork": false, "timeoutMs": 30000 }
      }
    }
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `groups` | the 5 offline groups | Which groups to register (`http` must be added explicitly). An empty/invalid list falls back to the defaults. |
| `http.allowPrivateNetwork` | `false` | Allow loopback / private / link-local / metadata hosts (the SSRF guard). |
| `http.timeoutMs` | `30000` | Per-request timeout. |
| `logLevel` | `info` | Minimum severity this plugin emits (`trace`/`debug`/`info`/`warn`/`error`; `DEBUG` unlocks `trace`). Falls back to `OPENCODE_LOG_LEVEL`. A gate, not an override: the host's own level still applies. |

#### How the tools register (v2)

`ctx.tool.transform` receives a `ToolEditor`. For each enabled group the plugin calls
`editor.namespace({ name: group, description })`, then `editor.add({ name, description, input,
options: { namespace: group }, execute })` for each tool. `input` is the catalog's own JSON Schema
(`toJsonSchema`, the emitter the MCP server also uses); v2 takes raw JSON Schema, not a zod shape.
The host exposes a namespaced tool as `<namespace>_<name>`, so `math` + `eval` stays `math_eval` and
every public tool name is unchanged from v1. `execute` returns `Effect<Tool.Result, Tool.Error>`: a
text result is `{ content }`, a JSON result adds `metadata`, and a thrown handler error becomes a
`Tool.Error` (logged as `devtools_tool_failed`).

#### Migrating from v1

`plugin` becomes `plugins`; the `["name", { ... }]` tuple becomes `{ "package": "name", "options": { ... } }`;
the host `config.logLevel` channel is gone (use `options.logLevel` or `OPENCODE_LOG_LEVEL`).
`groups`, `http` and `enabled` are unchanged. See the package
[README](../packages/opencode-devtools/README.md#migrating-from-v1) and
[ADR-0019](adr/0019-opencode-v2-cutover.md).

### As an MCP server

```jsonc
{
  "mcpServers": {
    "devtools": {
      "command": "npx",
      "args": ["-y", "@vymalo/opencode-devtools-mcp"],
      "env": {
        "OCD_GROUPS": "math,codec,crypto,datetime,convert",
        "OCD_HTTP_ALLOW_PRIVATE": "0",
        "OCD_HTTP_TIMEOUT": "30000"
      }
    }
  }
}
```

`OCD_GROUPS` is a comma list (invalid names are dropped; empty falls back to defaults). Logs go to
**stderr** (stdout carries the MCP JSON-RPC stream).

## Security

1. **`math_eval` is sandboxed.** It uses a hardened mathjs instance: `import`, `createUnit`,
   `reviver` and `splitUnit` are disabled, and `evaluate` parses mathjs's own expression language
   (not JavaScript) — so there is no path to arbitrary code execution. (`import("x")` and friends
   throw.)
2. **`http` is opt-in and SSRF-guarded.** With `allowPrivateNetwork: false` (default) the client
   refuses `localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (incl. the
   cloud metadata IP `169.254.169.254`), CGNAT `100.64/10`, and IPv6 loopback/unique-local/link-local.
   Only `http`/`https` protocols are allowed. **Caveat:** this is a *literal-host* guard — it does
   not resolve DNS, so a public name that resolves to a private IP (DNS rebinding) is not caught.
   Keep the group disabled on untrusted input unless you also control egress at the network layer.
3. **`codec_jwt_decode` does not verify signatures** — the result is explicitly `verified: false`.
4. **`convert_query` runs with `eval: false`.** JSONPath script/filter expressions (`[?(…)]`) execute JavaScript via the engine; since `path` is model-supplied, they're disabled — a filter expression returns a clear error rather than evaluating. Standard path queries are unaffected.
5. **`crypto_keypair` RSA modulus is clamped to 1024–4096 bits** — `generateKeyPairSync` is synchronous, so an arbitrarily large modulus would block the event loop (DoS).

## Not in v1 (deferred)

- **`http` save/replay collections** (named, persisted requests) — would add a stateful cache; the
  core `http_request`/`http_graphql` ship first.
- **Configurable `math` precision** — fixed at 64 digits for now.
- **Symbolic CAS / matrices** — out of scope (would mean bundling SymPy/Maxima); adopt
  `SHSharkar/MCP-Mathematics` if you need it. See [`recommended-mcps.md`](recommended-mcps.md).
