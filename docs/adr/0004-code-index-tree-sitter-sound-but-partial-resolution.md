# ADR-0004 — Code index call graph: tree-sitter only, "sound but partial"

- **Status:** Withdrawn (2026-11-08) — `@vymalo/opencode-code-index` was dropped at the OpenCode v2 cutover
  ([ADR-0019](0019-opencode-v2-cutover.md)) rather than ported. The package was private, experimental and never
  published. The Context/Decision/Consequences below are preserved as-written for history; the code they describe
  no longer exists in this repository.
- **Scope:** `@vymalo/opencode-code-index` — `extract.ts` and what becomes a call edge.

> **Note:** the package this ADR describes (`packages/opencode-code-index`) was removed on 2026-11-08, so there is no
> code to find. This record is kept only for the reasoning behind the tree-sitter 'sound but partial' resolution.

## Context

A precise call graph needs **type information**: resolving `obj.method()` to a definition
requires knowing `obj`'s type. The accurate sources for that are a language server
(`tsserver`) or a SCIP/LSIF indexer — both heavy, slow, and (for tsserver) TypeScript-only.

A spike ran tree-sitter extraction over two real files in this repo to measure what's
achievable *without* types. Findings:

- **Definitions extract cleanly and completely** (classes, methods, functions, arrow-const
  functions) — the `symbol` table is solid.
- **Call edges split ~50/50.** Bare `foo()`, `new Ctor()`, and `this.method()` resolve by
  name. The other half are `obj.method()` — but **most of that is noise** (`Date.now()`,
  `arr.push()`, `logger.debug()`) on builtins/library objects, not edges to our own symbols.

## Decision

Build the call graph from **tree-sitter alone**, and accept that it is **sound but partial**.

Emit edges only for what resolves without types:

- bare identifier calls `foo()` and `new Ctor()` → confidence `name`,
- `this.method()` within a class → confidence `this`.

**Drop** generic `obj.method()` member dispatch — it's mostly noise and can't be resolved
soundly without type info. Every edge carries a `confidence` column (`name` | `this` |
`typed`) so a future enrichment tier can **upgrade edges in place**. Tool output is labelled
*structural* so the model knows method-dispatch edges may be missing.

The consequence is a graph that **under-reports, never over-reports**: a `blast_radius` may
miss an OO dispatch edge, but every edge it *does* show is real.

## Consequences

**Positive**
- Zero type-checker dependency: fast, language-additive (a grammar + extension mapping adds a
  language), and works on any blob without a build.
- The graph is trustworthy in the direction that matters — no fabricated edges to mislead the
  model.
- The `confidence` tag is the seam for a precise tier later, with no schema change.

**Negative / cost**
- Cross-object method chains can be missing from `code_callers` / `code_blast_radius`. This is
  documented in `docs/code-index.md` and surfaced in every tool's output.
- Bare-name resolution can be ambiguous across same-named symbols (paired with the manifest
  scoping in [ADR-0003](0003-code-index-content-addressed-blob-per-branch-manifest.md)).

## Alternatives considered

### TypeScript language server / SCIP as the default — rejected
Gives precise dispatch, but: heavy runtime, slow indexing, and tsserver is TS-only (defeats
the language-additive goal). Too much weight for a personal per-project tool's *default*.
Kept as a planned **opt-in enrichment tier** that upgrades `confidence: typed` edges.

### Index every `obj.method()` by bare method name — rejected
Cheap, but **unsound**: it manufactures edges to unrelated same-named methods and floods the
graph with builtin/library noise (the spike's other ~50%). A graph the model can't trust is
worse than a smaller one it can.

### Regex/ctags-style extraction — rejected
Even less structure than tree-sitter (no reliable enclosing-scope or def-kind), for no
saving — tree-sitter is already dependency-light and gives precise spans and kinds.
