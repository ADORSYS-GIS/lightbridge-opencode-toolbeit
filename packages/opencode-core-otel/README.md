# @vymalo/opencode-core-otel

Shared OpenTelemetry engine for the @vymalo OpenCode plugin suite. Holds the
exporter wiring, resource building, the telemetry recorder, and the
token-source seam in **one place** so [`@vymalo/opencode-otel`](../opencode-otel)
(and any future OTEL-aware plugin) can share it instead of forking it.

> Extracted from `@vymalo/opencode-otel`.

## What it provides

- `config.ts` — `resolveOtelConfig` and the env/command parsing it depends on.
- `providers.ts` — `createProviders` / `buildResource`, the OTLP exporter and
  SDK provider wiring for traces, metrics and logs.
- `recorder.ts` — `TelemetryRecorder`, the OpenCode-hook-to-OTEL-signal mapper.
- `instruments.ts` — the counters/histograms the recorder writes through.
- `token-source.ts` — bearer-token injection for authenticated OTLP exporters.
- `export-logging.ts` — failure-logging wrapper around exporters.
- `propagation.ts` — W3C trace-context propagation into provider `fetch`.
- `vcs.ts` — git remote/branch detection for resource attributes.
- `deferred.ts` — bounded-wait resource attributes for late-arriving events.
- `logging.ts` — structured logger with level filtering.
- `types.ts` — the shared config/option types.

## Usage

```ts
import { resolveOtelConfig, createProviders, TelemetryRecorder } from "@vymalo/opencode-core-otel";
```

For the full surface import from `@vymalo/opencode-core-otel/lib`.

## Development

```bash
pnpm --filter @vymalo/opencode-core-otel build
pnpm --filter @vymalo/opencode-core-otel typecheck
pnpm --filter @vymalo/opencode-core-otel test
pnpm --filter @vymalo/opencode-core-otel coverage
```
