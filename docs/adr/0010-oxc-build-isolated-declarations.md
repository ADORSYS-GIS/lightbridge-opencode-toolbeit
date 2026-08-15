# ADR-0010 — Build with oxc under `isolatedDeclarations`; `tsc` keeps type-checking

- **Status**: Accepted
- **Date**: 2026-08-14
- **Applies to**: every library package in `packages/*`

## Context

Every library package built with `tsc -p tsconfig.json`, which type-checks *and*
emits JS *and* emits declarations in one pass. Each package also declares `typecheck`
(`tsc --noEmit`), which CI runs separately. **The build was therefore type-checking a second
time**, and type-checking is what dominates the cost — not emission.

The obvious move, replacing `tsc` with a fast transpiler, does not work on its own: SWC, esbuild
and oxc all emit JS but **cannot emit `.d.ts`**, because deriving a declaration from a file in
isolation is undecidable in general — an exported `const x = f()` needs the checker to know what
`f` returns. The usual workaround is `swc && tsc --emitDeclarationOnly`, and we
[prototyped exactly that](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/tree/chore/build-with-swc).
It made the build **slower** — 2.43s → 2.77s for the workspace — because `--emitDeclarationOnly`
still runs the full checker, so SWC's transpile became a second process launch added on top of a
cost that never went away.

TypeScript's `isolatedDeclarations` (5.5+) removes the undecidability: it rejects any export whose
type cannot be read off the file itself, which means a syntax-only tool *can* emit declarations
soundly. The relevant question was what that costs us. Measured across ~16,000 lines in nine
packages: **8 violations**, seven of them the identical `export const XxxPlugin = createXxx();`
missing a `: Plugin` annotation, plus one optional constructor parameter. The codebase was already
written this way.

## Decision

**`build` emits, `typecheck` checks, and they are different tools.**

- `tsconfig.base.json` sets `isolatedDeclarations: true`, so the compiler rejects any export whose
  type a single-file tool could not determine.
- Each package's `build` runs `scripts/build-package.mjs`, which uses
  [`oxc-transform`](https://www.npmjs.com/package/oxc-transform) to emit JS *and* declarations in
  **one process**, with no type checking at all.
- `typecheck` (`tsc --noEmit`) is unchanged and remains the sole type-safety gate. It is what makes
  the declaration emit sound; without it, a violation would silently degrade a published `.d.ts`.

oxc rather than SWC because oxc does both jobs: SWC needs a second tool for declarations, and at
this scale process startup dominates, so a second launch costs more than either tool's actual work
(SWC's JS emit measured 0.35s wall against 31–71ms of compute).

## Consequences

**What this buys us**

| | `tsc` | oxc |
| --- | --- | --- |
| whole workspace (`pnpm -r build`) | 2.32–2.82s | **0.95–0.99s** |
| one package (`opencode-otel`) | 0.87–0.92s | **0.29–0.30s** |

Roughly 2.4x on the workspace, 3x per package, and the gap widens as the code grows — the build's
cost is now proportional to file count rather than to type complexity.

The published artefacts are unchanged: the same **303 files**, the same names and nesting, source
maps with the same fields and the same relative `sources`.

**What it costs us**

- **`isolatedDeclarations` is a permanent constraint on how exports are written.** Every exported
  symbol needs a type annotation the compiler can read locally. Today that costs 8 lines, but it
  applies to all future code, and it occasionally forces an explicit type where inference read
  better.
- **`oxc-transform` is pre-1.0** (0.144.0) and is now load-bearing for published `.d.ts` files. A
  regression in its declaration emit would ship broken types. Mitigated by `typecheck` running the
  real compiler over the same source on every CI run, so a divergence surfaces as a type error
  rather than silently.
- **`build` no longer catches type errors.** Anyone who runs only `pnpm build` locally gets a
  successful build over broken code. The pre-push gate and CI both run `typecheck`, so this is a
  local-workflow change rather than a correctness one — but it is a real change in habit.
- **A hand-written build script**, because oxc ships no CLI. ~100 lines, shared by all nine
  packages.

## Alternatives considered

**Keep `tsc`.** Zero risk, no new dependency, and 2.4x slower forever. Rejected because the second
type-checking pass is pure waste — the first one already ran in `typecheck`.

**`swc` + `tsc --emitDeclarationOnly`.** The conventional answer, prototyped and **measured
slower** than what it replaced. Rejected on evidence rather than principle; the branch is parked at
`chore/build-with-swc` with its own measurements.

**`tsc --build` with project references and incremental caching.** Would cut rebuild time without a
new dependency or an export-annotation constraint, but only for *incremental* builds — CI builds
cold every time, which is where the cost actually lands. Worth revisiting for local iteration.

**oxc for JS, `tsc --emitDeclarationOnly` for types.** Halfway house: no `isolatedDeclarations`
constraint, but it keeps the expensive checking pass, so it lands at roughly SWC's numbers. The
whole win comes from *not type-checking during build*; anything that retains it retains the cost.
