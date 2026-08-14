# ADR-0010 — SWC compiles JS, `tsc` still owns declarations and type-checking

- **Status**: Accepted
- **Date**: 2026-08-14
- **Applies to**: the nine published/library `packages/*` (excludes `plugin-bundle`, a Rolldown
  build, and `apps/browser-extension`, a WXT/Vite build)

## Context

Every library package's `build` script was `tsc -p tsconfig.json` — one `tsc` invocation doing
three jobs at once: type-checking the whole package, emitting ES2022/NodeNext-ESM `.js`, and
emitting `.d.ts` + `.js.map`. `typecheck` (`tsc --noEmit`) is the actual gate CI relies on for type
safety; `build`'s type-checking was, in effect, redundant work paid twice per package per
pre-push run.

SWC (`@swc/core` + `@swc/cli`) transpiles TypeScript to JavaScript without type-checking, at
native-code speed. It cannot be a drop-in replacement for `tsc -p tsconfig.json`, though, for one
hard reason: **SWC does not emit `.d.ts` files.** These are published npm packages whose
`package.json` `types` / `./lib` `exports` point at `dist/index.d.ts` / `dist/lib.d.ts` — shipping
without them breaks every TypeScript consumer.

## Decision

**Split emission in two:** SWC emits `.js` + `.js.map`; `tsc -p tsconfig.json --emitDeclarationOnly`
(same tsconfig, no new project file) emits `.d.ts` on top. Both write into the same `dist/`, so the
combined output is structurally identical to what `tsc -p tsconfig.json` alone produced — same
files, same nesting (e.g. `opencode-oauth2`'s `dist/oauth/*.js` subdirectory), same source-map
shape. Verified by diffing `find packages/*/dist -name "*.js" -o -name "*.d.ts"` before and after
across all nine packages: **identical file lists, 198 files, zero additions or omissions.**

```json
"build": "swc src -d dist --config-file ../../.swcrc --strip-leading-paths && tsc -p tsconfig.json --emitDeclarationOnly"
```

`typecheck` is untouched (`tsc -p tsconfig.json --noEmit`) — it stays the single type-safety gate;
`--emitDeclarationOnly` still fully type-checks (declaration emission cannot skip checking), so it
is not a *weaker* check, just a second `tsc` pass that also happens to leave `.d.ts` behind.

**One root `.swcrc`, not nine.** All nine packages extend the same `tsconfig.base.json`
(`ES2022` / `NodeNext` / `strict`) with no per-package deviation in target or module semantics, so a
single root `.swcrc` (`jsc.target: es2022`, `module.type: es6`, `sourceMaps: true`,
`exclude: ["\\.d\\.ts$"]`) mirrors that existing single-source-of-truth pattern instead of forking
nine near-identical copies that would drift. Every package's `build` script references it by the
same relative path (`../../.swcrc`), since every package sits one level under `packages/`.

The `exclude` pattern matters concretely: `opencode-code-index/src/tree-sitter-typescript.d.ts` is
an ambient module declaration with no runtime content. `tsc` silently skips emitting anything for
it (nothing to emit); SWC, given no `exclude`, happily "compiles" it into an empty
`tree-sitter-typescript.d.js` — a file `tsc` never produced. The `.swcrc` `exclude` closes that gap
at the config level rather than relying on every package's script to remember an `--ignore` flag.

`@swc/core` and `@swc/cli` are a single root `devDependency` (not per-package) — `pnpm`'s script
`PATH` walks up through parent `node_modules/.bin` directories, so `pnpm --filter <pkg> run build`
resolves the `swc` binary from the workspace root without each package redeclaring the dependency.
Verified directly (`pnpm --filter @vymalo/opencode-otel run build` succeeds with only the root
`devDependency` present).

## Consequences

**What this buys us:** a real, if narrow, decoupling — the `.js`-emit half of `build` is now
independent of the type-checker and could, in principle, run without blocking on a full project
type-check (useful if a future workflow wants "give me runnable JS fast" separately from "give me a
verified build"). ESM module semantics, `NodeNext` `.js`-extension import specifiers (SWC does not
rewrite or resolve them — it passes string literals through unchanged), and source maps are all
preserved exactly; verified by running the built `dist/index.js` / `dist/lib.js` for
`@vymalo/opencode-otel` and `@vymalo/opencode-browser-mcp` via dynamic `import()` and confirming the
expected exports resolve.

**What it costs us — measured, not assumed:** for this specific codebase, **the migration does not
make `pnpm -r build` faster, and single-package builds are measurably slower.** Repeated,
steady-state timings (rm -rf dist between runs, median of 3–5 runs):

| | before (`tsc` only) | after (`swc` + `tsc --emitDeclarationOnly`) |
|---|---|---|
| `pnpm -r build` (whole workspace) | ~2.43s | ~2.77s |
| `@vymalo/opencode-otel` alone | ~0.90s | ~0.98s |

The reason is structural, not incidental: `--emitDeclarationOnly` still fully type-checks (checking
is what dominates `tsc`'s cost on a codebase this size — raw emission was never the bottleneck), so
the `tsc` pass costs almost exactly what the old single-pass `tsc -p tsconfig.json` cost. SWC's own
transpile is genuinely fast (30–70ms per package, `--strip-leading-paths` output confirmed this in
testing) but that time is *added* on top as a second process launch, not substituted for anything
`tsc` was doing slowly. Net: two process starts instead of one, for a package set small enough that
`tsc`'s emit-side cost was never the pain point.

This is worth stating plainly because "switch to SWC for build speed" is the default motivation
reached for; it does not hold here. The decoupling (previous paragraph) is the actual payoff — not
speed — unless/until either (a) individual packages grow large enough that `tsc`'s JS-emission cost
becomes non-trivial next to its checking cost, or (b) a future workflow wants the JS artifact without
paying for a full type-check on every invocation.

## Alternatives considered

**Keep `tsc -p tsconfig.json` for `build`, do nothing.** The safe, do-nothing option, and given the
measured timing above, arguably the *correct* one on pure build-speed grounds for this codebase's
current size. Rejected here only because the task explicitly asked for the SWC engine switch — flagged
in the migration report as a build-time regression rather than silently presented as a win.

**`tsup` or `unbuild` (bundler wrapping SWC/esbuild with turnkey `.d.ts` rollup via `dts-bundle`
/ `rollup-plugin-dts`).** Would fold both emission steps into one tool and one invocation. Rejected
for now to keep the change minimal and match the existing per-file (non-bundled) `dist/` layout the
"byte-compatible structure" requirement calls for — bundling would collapse the current one-file-in
→ one-file-out shape (`dist/oauth/client.js` etc.) into fewer, larger emitted files, a much bigger
behavioral change than swapping the compiler underneath the same layout.

**`esbuild` instead of SWC for the JS half.** Same fundamental trade-off (no declaration emission,
same need to pair with `tsc --emitDeclarationOnly`) — the choice between esbuild and SWC here is a
coin flip on ecosystem preference, not a functional difference for this use case. SWC was what the
task specified.
