# ADR-0009 — OTLP over HTTP/protobuf, not gRPC

- **Status**: Accepted
- **Date**: 2026-08-12
- **Applies to**: `@vymalo/opencode-otel`

## Context

`@vymalo/opencode-otel` exports three OTel signals (traces, metrics, logs) to a collector. The
OpenTelemetry specification defines two transports for OTLP: **HTTP** (with a protobuf or JSON
payload) and **gRPC**. Most reference implementations ship both and let an operator pick with
`OTEL_EXPORTER_OTLP_PROTOCOL` — Claude Code does exactly this, offering `grpc`, `http/json` and
`http/protobuf`.

The constraint that decides it here is the **runtime**. OpenCode plugins are loaded by a host that
may be running under **Bun or Node**, and we do not control which. The gRPC exporter
(`@opentelemetry/exporter-*-otlp-grpc`) pulls in `@grpc/grpc-js`, which leans on Node's HTTP/2 stack
and native bindings in ways that have a long history of breaking or degrading under Bun. The HTTP
exporters use `fetch`, which both runtimes implement.

This is the same fork in the road as [ADR-0001](0001-bridge-transport-ws-not-bun-serve-or-socketio.md),
where the browser bridge chose the `ws` package over `Bun.serve` for the same dual-runtime reason.

## Decision

**Ship OTLP/HTTP with a protobuf payload as the only wire transport.** The `exporter` option accepts
`otlp` (HTTP/protobuf), `console` and `none`. There is no `protocol` option and no gRPC dependency
in the tree.

`OTEL_EXPORTER_OTLP_PROTOCOL` is deliberately **not** read: silently ignoring a `grpc` value while
still exporting over HTTP would be worse than not supporting the variable at all, because the
operator would have no signal that their setting did nothing.

## Consequences

**What this buys us**

- The plugin behaves identically under Bun and Node — no runtime-conditional export path, and no
  class of bug that only reproduces on half the user base.
- A materially smaller dependency tree: no `@grpc/grpc-js`, no protobuf runtime beyond what the
  OTLP proto exporters already carry, no native build step.
- One transport to test. The exporters are substitutable in the suite, so the wire format is
  exercised in exactly one place rather than two.

**What it costs us**

- An operator whose backend accepts *only* gRPC cannot point the plugin straight at it. They need an
  OpenTelemetry Collector in front, translating HTTP to gRPC. In practice a collector is already
  present in most deployments that care about this (for batching, redaction and fan-out), so the
  real cost is small — but it is a genuine extra hop for a direct-to-vendor setup.
- We diverge from Claude Code's configuration surface on this one variable. Documented in
  [`docs/otel.md`](../otel.md).

## Alternatives considered

**Ship both transports and switch on `OTEL_EXPORTER_OTLP_PROTOCOL`.** The complete answer, and what
we would do if Node were the only runtime. Rejected because it makes a Bun user's experience depend
on a setting whose failure mode is an unhandled error deep in a native module — the worst kind of
configuration cliff. Revisit if `@grpc/grpc-js` becomes dependably solid under Bun.

**Lazily import the gRPC exporter only when asked for.** Keeps the dependency out of the default
path, but does not fix the failure — it only defers it to the moment an operator opts in, which is
precisely when they least want a surprise. It also adds an async import to plugin startup.

**HTTP with a JSON payload instead of protobuf.** Simpler to debug by eye and marginally more
portable. Rejected because protobuf is meaningfully smaller on the wire for the volume of spans an
agentic session produces, every collector that accepts OTLP/HTTP accepts protobuf, and it is what
the incumbent `opencode-otel-plugin` already uses — so a collector configured for one works
unchanged for the other.
