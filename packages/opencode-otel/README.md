# `@vymalo/opencode-otel`

[![npm](https://img.shields.io/npm/v/@vymalo/opencode-otel?label=npm&color=CB3837&logo=npm)](https://www.npmjs.com/package/@vymalo/opencode-otel)

**OpenTelemetry export for OpenCode.** Ships what actually happens in a session — cost, tokens, tool
calls, permission decisions, errors, lines of code — as standard OTLP **traces, metrics and logs**,
to any OpenTelemetry backend. The OpenCode counterpart to
[Claude Code's monitoring](https://code.claude.com/docs/en/monitoring-usage) and
[Codex's `[otel]` block](https://learn.chatgpt.com/docs/config-file/config-advanced).

Part of the [OpenCode Toolbelt](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit).

## Install

```sh
npm install @vymalo/opencode-otel
```

```jsonc
// opencode.json
{
  "plugin": [
    ["@vymalo/opencode-otel", { "endpoint": "http://localhost:4318" }]
  ]
}
```

Or configure it entirely from the environment:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
```

With **neither** configured the plugin is completely inert — no providers, no sockets, no hooks.

## Why another one

[`opencode-otel-plugin`](https://github.com/felixti/opencode-otel-plugin) already covers traces and
metrics well, and this package deliberately reuses its GenAI-semconv vocabulary so both land on the
same dashboards. What it adds:

- **The logs signal** — `user_prompt`, `assistant_response`, `tool_result`, `tool_decision`,
  `api_error` and friends. This is the developer-interaction stream; Claude Code ships 17 log event
  types against 8 metrics, and it is where the interesting data lives.
- **Real USD cost.** OpenCode's host computes `AssistantMessage.cost`; this exports it directly, so
  there is no price table to maintain and nothing to drift when a provider changes rates.
- **All five token types** — `input`, `output`, `reasoning`, `cache_read`, `cache_write`. On a
  cached agentic session cache-read is routinely the majority of tokens, so summing input+output
  alone measures a different quantity.
- **Permission decisions**, including ones a config auto-resolved without asking (`permission.ask`
  covers both; `opencode.permission.source` distinguishes `user` from `auto`).
- **Repository identity** — `vcs.repository.url.full`, `vcs.repository.name`, `vcs.owner.name`,
  `vcs.provider.name`, `vcs.ref.head.*` — read straight off disk, credentials stripped.
- **`opencode.json` configuration**, not just environment variables — required for
  `.well-known/opencode` distribution.

Run one or the other, not both: they would double-count.

## At a glance

| Signal | What you get |
| --- | --- |
| **Metrics** | `opencode.cost.usage` (USD), `gen_ai.client.token.usage` (5 token types), `gen_ai.client.operation.duration`, session/request/compaction counts, active time, lines of code, tool invocations, permission decisions |
| **Logs** | `opencode.session_start` / `_idle`, `user_prompt`, `assistant_response`, `tool_result`, `tool_decision`, `api_error`, `file_edited`, `compaction`, `command_executed` |
| **Traces** | `invoke_agent opencode` → `chat {model}` → `execute_tool {name}`, with W3C `traceparent` propagated into provider requests |

## Privacy

**No content is captured** — not prompts, responses, tool arguments or API bodies. Log records carry
shape only: lengths, counts, durations, sizes, outcomes, error classes.

Resource attributes identify the **machine and project, never the developer**. The git author email
is not collected; add `OTEL_RESOURCE_ATTRIBUTES="enduser.id=…"` if you want per-person attribution.

Session id is attached to logs and spans always, but to **metrics only** when `includeSessionId` is
enabled — it is unbounded cardinality and metric backends bill per series.

## Transport

OTLP over **HTTP with a protobuf payload**, only. gRPC is deliberately absent: OpenCode plugins run
under Bun as well as Node, and `@grpc/grpc-js` is unreliable there. Put a collector in front if your
backend needs gRPC. See
[ADR-0009](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/adr/0009-otel-otlp-http-not-grpc.md).

## Short-lived credentials

A static `Authorization` header is read once at plugin load and never refreshed — fine for a
long-lived API key, wrong for a collector behind a short OIDC token. Set `tokenCommand` to an
executable that prints a fresh token on stdout; it is re-run before the token's `exp` claim (or
`tokenRefreshMs`, when there is none) expires. See
[docs/otel.md → Short-lived credentials](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/otel.md#short-lived-credentials).

## When exports fail

A rejected OTLP request — an expired credential, an unreachable collector — reaches the host log
stream as `otel_export_failed` (signal, HTTP status where known, `consecutiveFailures`); recovery is
reported once as `otel_export_recovered`. Previously this only went to the OTel SDK's own `diag`
channel, which nothing subscribed to, so telemetry could stop silently. See
[docs/otel.md → Troubleshooting](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/otel.md#troubleshooting).

## Full reference

- [`docs/otel.md`](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/docs/otel.md)
  — every option, metric, log event and attribute; backend recipes; troubleshooting.
- [`plans/otel.md`](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/blob/main/plans/otel.md)
  — design rationale, the prior-art sweep, and the OpenCode-event → OTel-signal mapping table.

## License

MIT
