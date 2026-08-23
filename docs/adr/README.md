# Architecture Decision Records

Short, dated records of decisions that shaped this workspace and the reasoning behind
them — so a future reader (or a future us) can see *why* a thing is the way it is without
reverse-engineering it from the code or the git log.

We only write an ADR when a decision is **load-bearing and non-obvious**: it closes off
alternatives someone would reasonably reach for, or it encodes a constraint that isn't
visible from the code alone. Routine choices don't need one.

## Format

Each record is `NNNN-kebab-title.md`, numbered in order, and follows a light
[MADR](https://adr.github.io/madr/)-style shape:

- **Status** — `Accepted` / `Superseded by ADR-NNNN` / `Deprecated`. Records are
  append-only: we don't rewrite a decision, we supersede it with a new one and link both ways.
- **Context** — the forces in play when the decision was made.
- **Decision** — what we chose, stated plainly.
- **Consequences** — what this buys us and what it costs us.
- **Alternatives considered** — what we rejected and *why* (this is the part future-you
  will actually come back for).

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-bridge-transport-ws-not-bun-serve-or-socketio.md) | Browser-bridge transport: the `ws` package, not `Bun.serve` or socket.io | Accepted |
| [0002](0002-code-index-embedded-duckdb-not-graph-db-server.md) | Code index store: embedded DuckDB, not a graph-DB server | Accepted (experimental) |
| [0003](0003-code-index-content-addressed-blob-per-branch-manifest.md) | Code index: content-addressed by git blob, scoped per branch | Accepted (experimental) |
| [0004](0004-code-index-tree-sitter-sound-but-partial-resolution.md) | Code index call graph: tree-sitter only, "sound but partial" | Accepted (experimental) |
| [0005](0005-atomic-file-writes-per-writer-temp.md) | Atomic on-disk state: per-writer temp file + rename | Accepted |
| [0006](0006-bridge-token-source-of-truth.md) | Bridge token: `bridge.json` as single source of truth (host-only write, reload-on-mismatch) | Accepted |
| [0007](0007-bridge-handshake-rejection.md) | Bridge handshake rejection: explicit reject frame, slow-retry, fingerprint logging | Accepted |
| [0008](0008-trace-log-tier.md) | A `trace` log tier, unlocked by OpenCode's `DEBUG` | Accepted |
| [0009](0009-otel-otlp-http-not-grpc.md) | OTLP over HTTP/protobuf, not gRPC | Accepted |
| [0010](0010-oxc-build-isolated-declarations.md) | Build with oxc under `isolatedDeclarations`; `tsc` keeps type-checking | Accepted |
| [0011](0011-repo-auth-project-id-token-exchange.md) | repo-auth: `project_id` token exchange, not an audience-scoped Source exchange | Accepted |
| [0012](0012-single-auth-across-gateway-and-otel.md) | One credential across gateway + OTEL: `@vymalo/opencode-lightbridge` umbrella over one `TokenRuntime` (login via authz `/authorize`; MCP out of scope) | Accepted |
