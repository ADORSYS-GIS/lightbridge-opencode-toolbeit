# ADR-0013 — The otel plugin's own diagnostics never reach the terminal

- **Status:** Superseded by [ADR-0014](0014-suite-wide-no-terminal-mirror.md) (2026-09). ADR-0014
  extends this ADR's console-mirror fix to the other eight plugins and overrides the "pure observer
  vs. session-mutating plugin" distinction this ADR drew below — no plugin in the suite prints its own
  `warn`/`error` to the terminal any more. The Context/Decision/Consequences below are preserved
  as-written for history; they no longer describe the suite's live behavior for the other plugins.
- **Scope:** `@vymalo/opencode-otel`'s own diagnostic logging — the `createOpenCodeLogger` host
  bridge in `packages/opencode-otel/src/opencode.ts`. Does **not** touch
  `@vymalo/opencode-core-otel` (the shared OTel engine also consumed by
  `@vymalo/opencode-lightbridge`) or any other plugin's logging.

## Context

[ADR-0008](0008-trace-log-tier.md) fixed the suite-wide logging convention: a clean run is silent
at `info`, lifecycle events sit at `debug`, and **only failures surface at `warn`/`error`** — which
`createOpenCodeLogger` enforces by always mirroring `warn`/`error` records to the console
(`consoleAll || level === "warn" || level === "error"`), on top of forwarding every record to
`client.app.log`. That convention is right for oauth2, models-info, ratelimit, browser and
repo-auth: those plugins mutate the session (inject a header, register a tool, throttle a request),
so a `warn`/`error` printed to the terminal is telling the developer about *their own* request that
just failed or degraded — actionable, and worth the interruption.

`@vymalo/opencode-otel` is different in one load-bearing way: it is the suite's **only pure
observer**. It registers no tools, injects no headers, and mutates nothing except a
`provider.options.fetch` wrapper for trace-context propagation (see [`../otel.md`](../otel.md)).
Its own failures — a collector unreachable, an OTLP export rejected, a `tokenCommand` credential
helper exiting non-zero (`otel_token_command_failed`, `packages/opencode-core-otel/src/token-source.ts:132,143`)
— describe telemetry going missing, never the developer's own work. Under ADR-0008's convention as
written, those `warn` records were printing to the terminal mid-session anyway, interrupting an
agentic run over a signal the developer has no way to act on right then — the fix, if there is one,
is a collector or a credential problem to chase later, not something to context-switch for while a
model is mid-turn.

## Decision

`createOpenCodeLogger`'s `write()` drops the unconditional `level === "warn" || level === "error"`
branch of its console-mirror check. The only thing left that turns the console mirror on is the
existing escape hatch, `VYMALO_PLUGIN_CONSOLE_LOG=1` (`consoleAll`):

```ts
if (consoleAll) {
  fallback[level](event, fields);
}
```

Everything else is untouched — this is a one-line, single-purpose change:

- **Severity is preserved.** A record keeps its true level (`warn` stays `warn`) all the way to
  `client.app.log`; only the *console* branch changes. The min-level gate
  (`LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[getMinLevel()]`) is untouched, so a `warn`/`error`
  record still passes it at the default `info` host level exactly as before and always reaches
  OpenCode's own log stream.
- **`trace`'s fold to `debug` on the wire is untouched** ([ADR-0008](0008-trace-log-tier.md):
  `const hostLevel = level === "trace" ? "debug" : level;`) — this ADR does not touch the `trace`
  tier at all.
- **No new option, no new env var.** `VYMALO_PLUGIN_CONSOLE_LOG` already existed as the suite's one
  console-mirror escape hatch; this ADR just narrows what triggers it *by default* for this one
  plugin, rather than adding a second knob.

## Consequences

**Positive**
- **A telemetry exporter can no longer interrupt the session it's observing.** No `warn`/`error`
  from this plugin ever writes to stdout/stderr on its own — a failed export, a dead collector, an
  expired `tokenCommand` never print mid-turn.
- **Nothing is lost.** Every record — including every `warn`/`error` — still reaches
  `client.app.log` at its true level. `otel_token_command_failed`, `otel_traces_init_failed`,
  `otel_export_failed` and the rest remain fully diagnosable; they just live in OpenCode's own log,
  not the terminal.
- **One-line, low-risk change.** Nothing about level, gating, or the OTLP signals themselves moves;
  only the console-mirror predicate changes. Every existing `logger.warn(...)` call site in
  `@vymalo/opencode-core-otel` and `@vymalo/opencode-otel` keeps working unmodified.
- **The escape hatch still works.** `VYMALO_PLUGIN_CONSOLE_LOG=1` restores console mirroring for
  every level this plugin emits — someone actively debugging the exporter still gets the old
  behaviour on demand.

**Negative / cost**
- **A silent failure is silent on the terminal by design.** If a developer doesn't know to check
  OpenCode's own log or set `VYMALO_PLUGIN_CONSOLE_LOG=1`, an exporter that has been failing for an
  entire session gives no visible signal. This is the deliberate trade — see Alternatives — but it
  does mean discoverability now depends on knowing where to look; [`../otel.md`](../otel.md)'s
  Troubleshooting section is the pointer.
- **A one-plugin exception to ADR-0008's console-mirror rule.** Every other plugin in the suite
  still prints its own `warn`/`error` to the terminal by default; a reader auditing "does this
  plugin talk to my terminal on failure" needs to know `opencode-otel` is the one exception, and
  why.

## Alternatives considered

### Cap the plugin's own levels at `debug` — rejected

An earlier draft of this change mapped every record above `debug` (`info`/`warn`/`error`) down to
`debug` for the min-level gate as well as the console-mirror decision — silencing the console *and*
demoting the record's severity everywhere, including on the wire to `client.app.log`. Rejected: the
default host log level is `info` (`DEFAULT_LOG_LEVEL`, `packages/opencode-core-otel/src/logging.ts`),
so a record capped to `debug` fails the min-level gate under the *default* configuration and is
dropped **before it reaches `client.app.log` at all** — a real failure (a dead collector, a rejected
export) would then be recorded nowhere, not even in OpenCode's own log, unless the operator happened
to already be running at `--log-level DEBUG`. That is a strictly worse outcome than the terminal
interruption this ADR is trying to avoid: better to have the failure sit un-printed but always
diagnosable in the host log than to have it vanish outright under the common case.

### A dedicated env var / plugin option (e.g. `otelLogToTerminal: false`) — rejected

Would add a second knob to discover, document, and keep in sync with `VYMALO_PLUGIN_CONSOLE_LOG`,
for a behaviour that should never have been on by default in the first place — this plugin has no
legitimate case for interrupting the terminal on its own initiative. The existing
`VYMALO_PLUGIN_CONSOLE_LOG` escape hatch already covers "I want to see it anyway"; adding a second,
narrower toggle just for this plugin would make the logging contract harder to reason about without
buying any control an operator actually needs.

### Demote the shared `opencode-core-otel` log call sites instead — rejected

The `logger.warn(...)` call sites this ADR is really about (`otel_token_command_failed`,
`otel_export_failed`, `otel_traces_init_failed`, …) live in `@vymalo/opencode-core-otel`, which is
also consumed by `@vymalo/opencode-lightbridge` (see [ADR-0012](0012-single-auth-across-gateway-and-otel.md)).
Changing severity or console behaviour there would silently change `opencode-lightbridge`'s
behaviour too, with no ADR of its own reviewing whether that's wanted for a plugin that *also*
injects the gateway `Authorization` header — i.e. is not a pure observer. The fix therefore belongs
at the one place that is genuinely otel-plugin-specific: the `createOpenCodeLogger` bridge in
`packages/opencode-otel/src/opencode.ts`, which is otel's *own* logger, not the shared engine's.
