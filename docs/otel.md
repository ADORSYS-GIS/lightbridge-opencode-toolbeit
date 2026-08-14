# `@vymalo/opencode-otel` — OpenTelemetry export

Exports what actually happens in an OpenCode session — cost, tokens, tool calls, permission
decisions, errors, lines of code — as standard OTLP **traces, metrics and logs**, to any
OpenTelemetry backend. The OpenCode counterpart to
[Claude Code's monitoring](https://code.claude.com/docs/en/monitoring-usage) and
[Codex's `[otel]` block](https://learn.chatgpt.com/docs/config-file/config-advanced).

Design rationale, prior-art sweep and the full signal-mapping table live in
[`plans/otel.md`](../plans/otel.md). The transport decision is
[ADR-0009](adr/0009-otel-otlp-http-not-grpc.md).

## Quick start

```jsonc
// opencode.json
{
  "plugin": [
    ["@vymalo/opencode-otel", { "endpoint": "http://localhost:4318" }]
  ]
}
```

Or with nothing in config at all, using the standard environment variable:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
```

Either is enough. **With neither, the plugin does nothing** — it initializes no providers, opens no
sockets and registers no hooks, so installing it unconfigured costs nothing.

To see it locally, point it at a Jaeger with OTLP ingest enabled:

```bash
docker run -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest
```

## Configuration

Configurable **from `opencode.json` or from `OTEL_*` environment variables**, and this matters:
`.well-known/opencode` distribution (see [well-known.md](well-known.md)) serves the `config` block
but cannot set environment variables, so an env-only plugin could not be distributed that way.

**Precedence: the environment overrides plugin options.** Options are the base layer — a served
`.well-known` document ships a working default for a whole organization — and `OTEL_*` variables
override per machine, so a developer can point at a local collector without editing served config.
Headers merge key-by-key rather than replacing the map, so overriding one auth token does not
require restating the rest.

| Option | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | `OPENCODE_OTEL_ENABLED` | `true` | Master switch. `false` returns inert hooks. |
| `endpoint` | `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP/HTTP base URL. Signal paths (`/v1/traces`, …) are appended. |
| `endpoints.{traces,metrics,logs}` | `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` | — | Per-signal full URL, used verbatim. |
| `headers` | `OTEL_EXPORTER_OTLP_HEADERS` | `{}` | Sent with every OTLP request. Env form is `k=v,k2=v2`, percent-decoded. |
| `exporters.{traces,metrics,logs}` | `OTEL_{TRACES,METRICS,LOGS}_EXPORTER` | `otlp` when an endpoint is set, else `none` | One of `otlp`, `console`, `none`. |
| `serviceName` | `OTEL_SERVICE_NAME` | `opencode` | `service.name` resource attribute. |
| `environment` | `OPENCODE_OTEL_ENVIRONMENT` | — | Sets `deployment.environment.name`. Codex's `[otel] environment`. |
| `resourceAttributes` | `OTEL_RESOURCE_ATTRIBUTES` | `{}` | Extra resource attributes. |
| `metricExportIntervalMs` | `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | |
| `logExportIntervalMs` | `OTEL_BLRP_SCHEDULE_DELAY` / `OTEL_LOGS_EXPORT_INTERVAL` | `5000` | |
| `traceExportIntervalMs` | `OTEL_BSP_SCHEDULE_DELAY` / `OTEL_TRACES_EXPORT_INTERVAL` | `5000` | |
| `metricTemporality` | `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` | `delta` | `delta` or `cumulative`. |
| `includeSessionId` | `OTEL_METRICS_INCLUDE_SESSION_ID` | `false` | Attach the session id to **metrics**. See [Cardinality](#cardinality). |
| `filteredTools` | `OTEL_OPENCODE_FILTERED_TOOLS` | `[]` | Tool names to exclude from spans (still counted in metrics). |
| `propagateTraceContext` | `OPENCODE_OTEL_PROPAGATE_TRACE_CONTEXT` | `true` when traces are on | Inject W3C `traceparent` into provider requests. |

The Claude-Code-style aliases (`OTEL_LOGS_EXPORT_INTERVAL`, `OTEL_TRACES_EXPORT_INTERVAL`) are
accepted alongside the OTel spec names so an existing env block moves across unchanged.

> **No `OTEL_EXPORTER_OTLP_PROTOCOL`.** The only wire transport is OTLP/HTTP with a protobuf
> payload. gRPC is deliberately absent because OpenCode plugins run under Bun as well as Node — see
> [ADR-0009](adr/0009-otel-otlp-http-not-grpc.md). Put a collector in front if your backend needs gRPC.

### Backend examples

<details>
<summary><strong>Grafana Cloud</strong></summary>

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://otlp-gateway-prod-us-central-0.grafana.net/otlp"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic $(printf '%s' '<instance-id>:<api-key>' | base64)"
```

</details>

<details>
<summary><strong>Honeycomb</strong></summary>

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.honeycomb.io"
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=<your-api-key>"
```

</details>

<details>
<summary><strong>Dynatrace</strong></summary>

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://{environment-id}.live.dynatrace.com/api/v2/otlp"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Api-Token {token}"
export OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE="delta"
```

Dynatrace drops cumulative metrics silently, so the delta preference is mandatory there. It is
already this plugin's default.

</details>

## What gets collected

### Metrics

| Metric | Instrument | Unit | Attributes |
| --- | --- | --- | --- |
| `opencode.cost.usage` | counter | `USD` | `gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.agent.name` |
| `gen_ai.client.token.usage` | histogram | `{token}` | above + `gen_ai.token.type` |
| `gen_ai.client.operation.duration` | histogram | `s` | above + `error.type` |
| `opencode.session.count` | counter | `{session}` | `opencode.session.kind` (`root` \| `child`) |
| `opencode.session.request.count` | counter | `{request}` | model, provider, agent |
| `opencode.session.compaction.count` | counter | `{compaction}` | — |
| `opencode.active_time.total` | counter | `s` | — |
| `opencode.lines_of_code.count` | counter | `{line}` | `opencode.change.type` (`added` \| `removed`), `code.language` |
| `opencode.tool.invocations` | counter | `{invocation}` | `gen_ai.tool.name`, `opencode.tool.status` (`ok` \| `error`) |
| `opencode.permission.decision.count` | counter | `{decision}` | `gen_ai.tool.name`, `opencode.permission.decision` |
| `opencode.command.executed.count` | counter | `{command}` | `opencode.command.name` |

`opencode.permission.decision.count` also carries `opencode.permission.source` — `user` for a prompt
someone answered, `auto` for one your config resolved without asking. Both are counted; a build that
auto-allows everything still reports its decisions.

**Cost is a real number, not an estimate.** OpenCode's host computes `AssistantMessage.cost` in USD
and this plugin exports it directly — there is no price table to maintain and nothing to drift out
of date when a provider changes rates.

**`gen_ai.token.type` has five values**, not two: `input`, `output`, `reasoning`, `cache_read`,
`cache_write`. This is the difference that matters most in practice — on a cached agentic session
cache-read is routinely the majority of tokens consumed, so a dashboard that sums only input and
output is not slightly low, it is measuring a different quantity. Sum across all five for true
consumption; use `cache_read` alone as your cache-hit signal.

### Log events

Each record carries an `event.name` attribute and the session id as `gen_ai.conversation.id`.

| `event.name` | Notable attributes |
| --- | --- |
| `opencode.session_start` | `opencode.session.kind`, `opencode.session.parent_id`, `opencode.directory` |
| `opencode.session_idle` | `opencode.session.duration_ms`, `opencode.session.request_count`, `opencode.cost.usage`, token totals |
| `opencode.user_prompt` | `opencode.prompt.length`, `opencode.prompt.part_count`, `opencode.prompt.parts.*`, agent, model |
| `opencode.assistant_response` | all five `gen_ai.usage.*` counts, `opencode.cost.usage`, `opencode.response.duration_ms`, `opencode.response.length`, `gen_ai.response.finish_reasons`, `gen_ai.request.*` sampling parameters |
| `opencode.tool_result` | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `opencode.tool.status`, `opencode.tool.duration_ms`, `opencode.tool.output.size` |
| `opencode.tool_decision` | `opencode.permission.decision`, `opencode.permission.source`, `opencode.permission.id`, `gen_ai.tool.name` |
| `opencode.api_error` | `error.type`, `http.response.status_code`, `opencode.error.retryable`, `opencode.retry.attempt` |
| `opencode.file_edited` | `code.language`, `opencode.file.additions`, `opencode.file.deletions` |
| `opencode.compaction` | — |
| `opencode.compaction_autocontinue` | `opencode.compaction.overflow`, `opencode.compaction.autocontinue_enabled`, `gen_ai.agent.name` |
| `opencode.command_executed` | `opencode.command.name`, `opencode.command.has_arguments` |
| `opencode.todo_updated` | `opencode.todo.total`, `opencode.todo.{status}` counts |

### Traces

```
invoke_agent opencode          ← root, one per session (session.created → session.idle)
├── chat {model}               ← one per assistant message
├── execute_tool {name}        ← one per tool call
└── session_compaction         ← instant span
```

A `chat` span opens at the `chat.params` hook — immediately before the provider request — and closes
when the assistant message completes, so it covers the whole round-trip rather than only the part
after the response starts arriving. It represents one **assistant message**, which may internally
span several provider round-trips; `opencode.session.request.count` counts the same unit, so the two
always agree.

Set `filteredTools` to keep high-volume `read`/`glob`/`grep` calls out of the trace without losing
their counts:

```jsonc
{ "filteredTools": ["read", "glob", "grep"] }
```

#### Trace-context propagation

When traces are on, the plugin wraps each provider's `options.fetch` and injects a W3C `traceparent`
into outgoing model requests, so an OpenCode session and its gateway-side spans form **one trace**.
This is the same interception seam [`@vymalo/opencode-ratelimit`](ratelimit.md) uses, composed the
same way — the existing fetch is captured at install time and delegated to, so stacking the two in
either order works.

One honest limitation: the propagated context is the single in-flight `chat` span. **When two or
more chats are in flight at once the plugin injects nothing rather than guessing a parent** — a
missing link is recoverable, a fabricated one silently corrupts the trace. An existing `traceparent`
on the request is never overwritten.

## Privacy

**No content is captured.** Not prompts, not responses, not tool arguments, not API bodies. Log
records carry *shape* only — lengths, counts, durations, sizes, outcomes and error classes. There is
no `OTEL_LOG_USER_PROMPTS` equivalent because there is nothing to gate.

**Resource attributes identify the machine and the project, never the developer:**

| Attribute | Source |
| --- | --- |
| `service.name` | `serviceName`, default `opencode` |
| `service.version` | the `installation.updated` event |
| `deployment.environment.name` | `environment` |
| `host.name` | `os.hostname()` |
| `opencode.project.name` | OpenCode project id |
| `opencode.directory`, `opencode.worktree` | plugin input |
| `vcs.repository.ref.name` | the `vcs.branch.updated` event |

`service.version` and `vcs.repository.ref.name` are the two attributes OpenCode only reveals as
*events*, which arrive after the OTel resource is already fixed. They are declared as deferred
(promise-valued) resource attributes, which exporters await before the first export. The wait is
bounded — **2 seconds by default** — so a host that never emits them delays the first export briefly
and then omits the attribute, rather than blocking export forever.

Unlike some implementations, the git author email is **not** collected. If you want per-developer
attribution, opt in explicitly — which also keeps the choice visible in config rather than implicit
in the binary:

```bash
export OTEL_RESOURCE_ATTRIBUTES="enduser.id=dev@example.com,team.id=platform"
```

### Cardinality

`gen_ai.conversation.id` is attached to **logs and spans always**, and to **metrics only when
`includeSessionId` is on**. Session id is unbounded cardinality and metric backends bill per series,
so the default keeps it off. Turn it on when you need per-session metric drill-down and your backend
can afford it.

## What is deliberately not collected

The plugin observes 5 of the 19 plugin hooks and 16 of the 32 SDK event types. The rest are left
alone on purpose, and it is worth knowing which, so an absence is never mistaken for a bug.

| Source | Why not |
| --- | --- |
| `chat.headers`, `shell.env` | Carry credentials and environment. Reading them to emit shape would mean handling secrets for no telemetry gain. |
| `experimental.chat.messages.transform`, `experimental.chat.system.transform` | Content — the conversation and the system prompt. |
| `tool.definition` | Tool descriptions, static and identical every run. |
| `lsp.client.diagnostics` | The payload is `{serverID, path}` only — **no severity and no counts**. Emitting it would produce one high-volume event per diagnostics publish with nothing to aggregate. Worth revisiting if the event ever carries counts. |
| `command.execute.before` | Redundant: `command.executed` already carries the name and arguments. |
| `tui.*` (3 events), `pty.*` (4 events) | Terminal-UI and pseudo-terminal churn, unrelated to agent behaviour. |
| `lsp.updated`, `server.connected`, `installation.update.available`, `session.updated` | Lifecycle noise with no measurable dimension. |
| `file.edited` | Carries no `sessionID`, so it cannot be attributed. Line counts come from `session.diff` instead. |
| `message.removed`, `message.part.removed` | Deletions of already-reported records; re-reporting them would double-count. |

`auth` / `provider` / `tool` are registration hooks, not observation points — this plugin registers
nothing.

## Flushing

The OpenCode plugin API has no dispose hook, so buffered telemetry would be lost when a short CLI
invocation exits. The plugin flushes on **`session.idle`** — the natural turn boundary — and
registers `beforeExit` / `SIGINT` / `SIGTERM` handlers for hard exits. Metrics still export on their
own interval (60s by default) for long-running sessions.

If you see traces but no metrics, wait out the interval or end the session; that is the batch
window, not a failure.

## Composing with other plugins

Order-independent. It reads the config object other plugins have already assembled and does not
mutate provider definitions — the one thing it writes is the `options.fetch` wrapper for trace
propagation, which composes with `@vymalo/opencode-ratelimit`'s wrapper in either order.

```jsonc
{
  "plugin": [
    "@vymalo/opencode-oauth2",
    "@vymalo/opencode-models-info",
    "@vymalo/opencode-ratelimit",
    ["@vymalo/opencode-otel", { "endpoint": "http://localhost:4318" }]
  ]
}
```

## Troubleshooting

**Nothing arrives.** Check the endpoint is reachable from the OpenCode process
(`curl -o /dev/null -w '%{http_code}' http://localhost:4318/v1/traces` — expect `200` or `405`), and
that the variable was set *before* OpenCode started: configuration is read once at plugin load.

**The plugin logs `otel_plugin_inactive`.** No endpoint and no explicit exporter were found. The
`reason` field distinguishes `no_exporter_configured` from `disabled`.

**One signal is missing.** Look for `otel_traces_init_failed` / `otel_metrics_init_failed` /
`otel_logs_init_failed` in the host log stream. Each signal is built independently, so one failing
leaves the others running.

**Traces appear, metrics do not.** See [Flushing](#flushing) — the default metric interval is 60
seconds.

**Nothing at all, and no plugin logs.** Run OpenCode with `--log-level DEBUG` to unlock the `trace`
tier (see [ADR-0008](adr/0008-trace-log-tier.md)), or set `VYMALO_PLUGIN_CONSOLE_LOG=1` to mirror
plugin diagnostics to stdout.

## Relationship to `opencode-otel-plugin`

[`opencode-otel-plugin`](https://github.com/felixti/opencode-otel-plugin) is a competent, actively
maintained plugin covering **traces and metrics**. This package deliberately reuses its GenAI-semconv
attribute vocabulary and span shape, so both land on the same dashboards. It differs by adding the
**logs signal** (the developer-interaction event stream), **real USD cost**, **cache and reasoning
tokens**, **permission decisions**, and **`opencode.json` configuration** for `.well-known`
distribution. Run one or the other, not both — they would double-count.
