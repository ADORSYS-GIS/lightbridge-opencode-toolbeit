# OpenTelemetry plugin (design)

Status: **draft → implemented in 0.13.0.** New published package: `@vymalo/opencode-otel` (OpenCode
plugin). User-facing reference: [`docs/otel.md`](../docs/otel.md).

Goal, in one line: **give OpenCode the telemetry surface Claude Code and Codex already ship** — so an
organization can answer "what is this agent costing us, where does the time go, and what did it
actually do" from a standard OTLP backend, with no bespoke collector.

## Context

Two reference implementations set the bar:

- **[Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage)** — the maximal
  surface. Three signals (metrics + logs + beta traces), **8 metrics** and **17 log event types**,
  everything configured through standard `OTEL_*` environment variables, with a dense privacy layer
  (`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`, …) and explicit metric-cardinality switches
  (`OTEL_METRICS_INCLUDE_SESSION_ID`, …).
- **[Codex](https://learn.chatgpt.com/docs/config-file/config-advanced)** — the minimal surface. A
  logs-only pipeline configured from the **config file** (`[otel]` with `environment`, `exporter`,
  `log_user_prompt`), emitting a handful of `codex.*` events.

The interesting split between them is *not* the event list — it's the **configuration channel**.
Claude Code is env-only; Codex is file-only. This repo needs both, and that is a load-bearing
requirement rather than a nicety: plugins here are distributed through
[`.well-known/opencode`](../docs/well-known.md), where a server publishes the `config` block and the
client stores nothing. An env-only plugin cannot be configured that way at all.

## Prior-art sweep (build vs adopt)

This repo's standing rule — see [`plans/devtools.md`](devtools.md) and
[`docs/recommended-mcps.md`](../docs/recommended-mcps.md) — is **only build where no mature option
already exists**. So the incumbent was evaluated properly before committing to a build.

**[`opencode-otel-plugin`](https://github.com/felixti/opencode-otel-plugin)** (felixti, v0.11.1,
MIT, actively released, 116 tests) is a real and competent plugin. It exports **traces + metrics**
over OTLP/HTTP-protobuf, follows the
[GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) properly
(`invoke_agent` → `chat` → `execute_tool` span tree, `gen_ai.client.token.usage`,
`gen_ai.client.operation.duration`), and configures from standard `OTEL_*` env vars.

Verdict: **build**, because the gaps are structural rather than incremental.

| Gap | Why it is not a small patch |
| --- | --- |
| **No logs signal at all** — no `@opentelemetry/sdk-logs` dependency, no `OTEL_LOGS_EXPORTER` | This is precisely the "developer interactions" half of the ask. Claude Code ships 17 log event types against 8 metrics; the interactions live in the log stream, not the counters. Adding it means a third provider, a third exporter, a redaction layer, and a privacy model — not a patch. |
| **No cost export** | OpenCode hands over `AssistantMessage.cost` as a real USD number computed by the host. The incumbent drops it, so every downstream user reconstructs spend by multiplying token counts against a hand-maintained price table. `claude_code.cost.usage` is the single most-requested number in this space. |
| **Token metric omits cache + reasoning** | It records `input`/`output` only, while OpenCode reports `tokens.cache.read`, `tokens.cache.write` and `tokens.reasoning`. On a cached agentic session cache-read is routinely the majority of tokens — a dashboard summing input+output is not slightly low, it is measuring something else. |
| **No permission / decision telemetry** | `permission.updated` + `permission.replied` map cleanly onto Claude Code's `tool_decision` and `code_edit_tool.decision`. Absent. |
| **Env-only configuration** | Unusable through `.well-known/opencode`, which is this repo's primary distribution channel. |
| **Privacy defaults** | Puts the git author email into resource attributes (`enduser.id`, `host.user.email`) unconditionally. This suite's default is to identify machines, not humans, unless asked. |

Where the incumbent is right, we follow it rather than inventing: **GenAI semconv attribute names**,
**OTLP/HTTP-protobuf as the default transport**, and the `invoke_agent` → `chat` → `execute_tool`
span shape. Divergence for its own sake helps nobody, and a shared attribute vocabulary means both
plugins' data lands on the same dashboards.

## What OpenCode actually exposes

Verified against `@opencode-ai/plugin@1.15.10` / `@opencode-ai/sdk@1.15.10` typings, not assumed.

`Hooks.event` receives the **entire SDK event stream** (32 event types). The payload that makes this
plugin viable:

```ts
AssistantMessage = {
  cost: number,                                              // real USD, host-computed
  tokens: { input, output, reasoning, cache: { read, write } },
  modelID, providerID, mode /* = agent name */,
  time: { created, completed? },
  error?: ProviderAuthError | UnknownError | MessageOutputLengthError
        | MessageAbortedError | ApiError { statusCode, isRetryable, responseHeaders },
  finish?: string
}
```

`StepFinishPart` carries the same `cost` + `tokens` shape **per LLM request**, which is the correct
granularity for a `chat` span — an `AssistantMessage` may span several provider round-trips.

### Signal mapping

| Claude Code signal | OpenCode source | Status |
| --- | --- | --- |
| `cost.usage` | `AssistantMessage.cost` / `StepFinishPart.cost` | ✅ better — real USD, no price table |
| `token.usage` | `.tokens` incl. `cache.read/write`, `reasoning` | ✅ better — 5 token types, not 2 |
| `api_request` | `message.updated` (`time.created` → `time.completed`) | ✅ |
| `api_error` | `session.error`, `AssistantMessage.error`, `session.status` `retry` (carries `attempt`) | ✅ |
| `user_prompt` | `chat.message` hook (`UserMessage` + `Part[]`) | ✅ |
| `assistant_response` | `message.updated`, `experimental.text.complete` | ✅ |
| `tool_result` | `tool.execute.before` / `.after`, `ToolPart.state.time.{start,end}` | ✅ |
| `tool_decision`, `code_edit_tool.decision` | `permission.updated` + `permission.replied` | ✅ |
| `lines_of_code.count` | `session.diff` → `FileDiff.additions` / `.deletions` | ✅ |
| `session.count` | `session.created` | ✅ |
| `active_time.total` | `session.status` busy ↔ idle transitions | ✅ |
| — (no analogue) | `session.compacted`, `command.executed`, `todo.updated` | ✅ OpenCode-specific, worth emitting |
| `commit.count`, `pull_request.count` | none — only inferable by sniffing `bash` arguments | ⚠️ **deferred**, see below |
| `mcp_server_connection`, `auth` | not exposed by the host | ❌ out of reach |
| `api_request_body` / `api_response_body` | only via a wrapped `provider.options.fetch` | ❌ deferred with content logging |

## Decisions

**One plugin, no MCP twin.** Unlike `browser` and `devtools`, there is no tool surface here — the
plugin registers zero tools and the model never calls it. It observes. An MCP server would have
nothing to expose.

**Three signals, one switch each.** `traces` / `metrics` / `logs` are independently toggleable, all
on by default when an endpoint is configured. With no endpoint and no explicit exporter, the plugin
initializes nothing and returns inert hooks — installing it must never cost anything.

**Config precedence: `OTEL_*` env overrides plugin options.** Plugin options are the base layer (so
`.well-known/opencode` can ship a working default for a whole org); environment variables override
per-machine (so a developer can point at a local Jaeger without editing served config). This is the
standard 12-factor direction and it is the only precedence that keeps both channels useful.

**OTLP/HTTP-protobuf only; no gRPC.** OpenCode plugins run under **Bun and Node**.
`@grpc/grpc-js` is a known liability under Bun, and shipping a transport that fails on half the
supported runtimes is worse than not shipping it — the same reasoning that picked `ws` in
[ADR-0001](../docs/adr/0001-bridge-transport-ws-not-bun-serve-or-socketio.md). Recorded as
[ADR-0009](../docs/adr/0009-otel-otlp-http-not-grpc.md). Operators who need gRPC put a collector in
front, which is the normal deployment anyway.

**No content capture in v1.** No prompt text, no assistant text, no tool arguments, no API bodies.
Log records carry *shape* — lengths, counts, durations, sizes, outcomes, error classes — never the
content itself. This means v1 needs no redaction engine and no `OTEL_LOG_USER_PROMPTS` equivalent to
get wrong, and it is the default posture the rest of the suite already takes. Content logging is a
deliberate follow-up, gated and off by default, once the shape is proven.

**Identify the machine, not the human.** Resource attributes carry `service.name`, `service.version`,
`host.name`, `opencode.project.name`, `opencode.directory`, `opencode.worktree` and the VCS branch.
The git author email is **not** collected. An operator who wants per-developer attribution opts in
explicitly (`resourceAttributes`, or the standard `OTEL_RESOURCE_ATTRIBUTES`), which also keeps the
choice auditable in config rather than implicit in the binary.

**Flush at session boundaries.** The plugin API has no dispose/shutdown hook, so buffered spans and
log records would be lost on a short CLI invocation. `session.idle` is the natural flush point — it
fires exactly when a turn completes — backed by `beforeExit` / `SIGINT` / `SIGTERM` handlers for the
hard-exit case. Handlers are registered once and the process listeners are not allowed to keep the
event loop alive.

## Metrics

| Metric | Instrument | Unit | Attributes |
| --- | --- | --- | --- |
| `opencode.cost.usage` | counter (double) | `USD` | `gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.agent.name` |
| `gen_ai.client.token.usage` | histogram | `{token}` | + `gen_ai.token.type` = `input` \| `output` \| `reasoning` \| `cache_read` \| `cache_write` |
| `gen_ai.client.operation.duration` | histogram | `s` | `gen_ai.operation.name`, model, provider, `error.type` |
| `opencode.session.count` | counter | `{session}` | `opencode.session.kind` = `root` \| `child` |
| `opencode.session.request.count` | counter | `{request}` | model, provider |
| `opencode.session.compaction.count` | counter | `{compaction}` | — |
| `opencode.active_time.total` | counter (double) | `s` | — |
| `opencode.lines_of_code.count` | counter | `{line}` | `opencode.change.type` = `added` \| `removed` |
| `opencode.tool.invocations` | counter | `{invocation}` | `gen_ai.tool.name`, `opencode.tool.status` = `ok` \| `error` |
| `opencode.permission.decision.count` | counter | `{decision}` | `gen_ai.tool.name`, `opencode.permission.decision` |
| `opencode.command.executed.count` | counter | `{command}` | `opencode.command.name` |

Session id is attached to **logs and spans** (`gen_ai.conversation.id`), and to metrics only when
`includeSessionId` is enabled — off by default, mirroring Claude Code's cardinality switches but
choosing the safer default, because a metrics backend charges per series.

## Log events

Emitted as OTLP log records with an `event.name` attribute, following the Codex naming shape.

| Event | Attributes |
| --- | --- |
| `opencode.session_start` | session id, parent session id, `opencode.session.kind`, directory |
| `opencode.session_idle` | session id, duration, request count, cost, tokens |
| `opencode.user_prompt` | session id, agent, model, provider, `opencode.prompt.length`, part counts by type |
| `opencode.assistant_response` | session id, model, provider, agent, `opencode.response.length`, tokens (all 5), cost, `gen_ai.response.finish_reasons`, duration |
| `opencode.tool_result` | session id, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `opencode.tool.status`, `duration_ms`, `opencode.tool.output.size`, `error.type` |
| `opencode.tool_decision` | session id, tool, `opencode.permission.decision`, permission id |
| `opencode.api_error` | session id, model, provider, `error.type`, `http.response.status_code`, `opencode.error.retryable`, `opencode.retry.attempt` |
| `opencode.file_edited` | session id, `code.language`, additions, deletions |
| `opencode.compaction` | session id |
| `opencode.command_executed` | session id, `opencode.command.name` |

Severity follows the event: errors map to `ERROR`, everything else to `INFO`.

## Traces

Follows the incumbent's shape so the two are interchangeable on a dashboard:

```
invoke_agent opencode              ← root, one per session; started on session.created, ended on session.idle
├── chat {model}                   ← one per LLM request
├── execute_tool {name}            ← one per tool call, started/ended by the tool hooks
└── session_compaction             ← instant span
```

`chat` spans propagate **W3C trace context** into the provider request by wrapping
`provider.options.fetch` in the `config` hook — the same interception seam
`@vymalo/opencode-ratelimit` uses, and composed the same way (capture the existing fetch at install
time, delegate to it, never to ourselves). That makes an OpenCode session and its gateway-side spans
one connected trace, which is the thing neither Claude Code nor Codex gives you today.

Tool spans can be filtered by name (`filteredTools`) to keep high-volume `read`/`glob`/`grep` calls
out of the trace while still counting them in metrics.

## Not in v1

- **Content logging** — prompts, responses, tool arguments, raw API bodies. Needs a redaction engine
  and a per-field gate model before it is safe to offer.
- **gRPC transport** — see the ADR. Use a collector.
- **`commit.count` / `pull_request.count`** — the incumbent infers these by pattern-matching `bash`
  command strings. That is a guess about intent (it counts `git commit --amend`, `--dry-run`, and a
  failed commit identically) and it requires reading command text, which conflicts with the
  no-content-capture posture. Better served by the VCS system itself.
- **Prometheus exporter** — pull-based scraping needs a listening socket, which makes this plugin a
  server. Out of scope; a collector converts.
- **`OTEL_METRICS_INCLUDE_*` cardinality matrix** — only `includeSessionId` is implemented, since it
  is the one attribute with genuinely unbounded cardinality.
