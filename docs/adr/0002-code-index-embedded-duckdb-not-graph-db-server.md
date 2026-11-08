# ADR-0002 — Code index store: embedded DuckDB, not a graph-DB server

- **Status:** Withdrawn (2026-11-08) — `@vymalo/opencode-code-index` was dropped at the OpenCode v2 cutover
  ([ADR-0019](0019-opencode-v2-cutover.md)) rather than ported. The package was private, experimental and never
  published. The Context/Decision/Consequences below are preserved as-written for history; the code they describe
  no longer exists in this repository.
- **Scope:** `@vymalo/opencode-code-index` — the store backing the `code_*` tools.

> **Note:** the package this ADR describes (`packages/opencode-code-index`) was removed on 2026-11-08, so there is no
> code to find. This record is kept only for the reasoning behind the embedded DuckDB store.

## Context

The code-index plugin answers structural questions plain grep can't cheaply do —
`code_callers`, `code_blast_radius` (transitive dependents), `code_references`. Those are
**graph** queries over a symbol/edge graph, plus (later, deferred) **vector** similarity
over prose. The plugin is a **personal, per-project** tool that the user will spin up across
many repos, so the store's bootstrap cost and idle footprint matter as much as query power.

The suite's whole ethos is "no heavy infra, runs under Bun *and* Node, atomic-file caches"
— standing up a database **server** per project cuts hard against it (see the cost calculus
in [`plans/code-index.md`](../../plans/code-index.md)).

## Decision

Use **embedded DuckDB** (`@duckdb/node-api`) as the single store: a per-repo `*.duckdb`
file, no server. The symbol graph lives in plain relational tables; `blast_radius` is a
**recursive CTE** — no graph extension. Vectors (deferred prose tier) will use DuckDB's
`vss`/HNSW so graph + similarity share one embedded file.

The store sits behind a thin class (`CodeIndexStore`) so the backend is swappable: a power
user with a giant monorepo can point it at Neo4j/Qdrant later, but that is never the default.

## Consequences

**Positive**
- Zero infra: one file, no `docker up`, idle cost ≈ a file on disk — the per-project,
  "won't cost me when I'm not using it" requirement.
- `blast_radius` is a single recursive CTE, validated by a spike before building — no
  `duckpgq` extension to load, no Cypher engine to embed.
- DuckDB ships **prebuilt** binaries (no node-gyp), so it adds no native build step.
- Graph + future vectors in one engine/file → no second store to keep consistent.

**Negative / cost**
- DuckDB `BIGINT` surfaces as JS `BigInt`; we use `INTEGER` for line numbers and `Number()`
  counts so results stay JSON-clean (documented in `store.ts`).
- Recursive CTEs are fine at code-graph scale but would underperform a purpose-built graph
  engine on a very large monorepo — the escape hatch (pluggable backend) exists for that.

## Alternatives considered

### Neo4j (or FalkorDB) — rejected as default
A real property-graph engine with Cypher is the "obvious" reach for call graphs. But it's a
**server** (or Redis module) — a per-project container is the single heaviest dependency in
the suite and a large adoption tax for a personal tool. Cypher's ergonomics don't pay for
that when one recursive CTE already answers `blast_radius`. Kept as an *opt-in* backend for
genuinely large repos, not the default.

### Qdrant / Chroma (vector DB) — rejected
These only serve the *prose* half, and that half is **deferred**. Even then they're servers;
embedded `sqlite-vec` / DuckDB `vss` dominate them for a single-user, per-project tool.

### CozoDB (embedded multi-model: graph + vector + relational) — rejected
The most elegant fit on paper (Datalog recursion + native vectors in one embedded file). But
it is **effectively abandoned — last commit 2024.** Adopting a dead engine for a tool meant
to live for years is the wrong trade; DuckDB has a large, active community and the same
embedded multi-model story via extensions.

### SQLite + `sqlite-vec` + recursive CTEs — viable, not chosen
Would also work and is lighter still. DuckDB was preferred for stronger analytical SQL
(`SQL/PGQ` via `duckpgq` if we ever want it), columnar speed on the larger scans, and a
first-class `vss` HNSW index for the prose tier — without giving up the single-embedded-file
property. The store seam means a switch later would be localized.
