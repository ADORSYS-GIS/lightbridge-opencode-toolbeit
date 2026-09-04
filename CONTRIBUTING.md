# Contributing

Thanks for helping out! This is a [pnpm](https://pnpm.io) workspace of OpenCode plugins (the
`@vymalo` scope) plus a companion browser extension. This guide gets you from clone to PR.

## AI Governance

This repository follows the [ADORSYS-GIS AI Governance](https://adorsys-gis.github.io/ai-governance/)
discipline: **AI may accelerate the work, but humans own intent, verification, and consequences.**
AI output is not truth — review AI-generated code as untrusted, and never submit work you cannot explain.

- **Open issues** with the structured forms — [Epic](.github/ISSUE_TEMPLATE/epic.yml),
  [User Story](.github/ISSUE_TEMPLATE/user-story.yml), or
  [Development Ticket](.github/ISSUE_TEMPLATE/dev-ticket.yml). Blank issues are disabled on purpose.
- **Open pull requests** with the [pull request template](.github/PULL_REQUEST_TEMPLATE.md) and fill in
  every section — including the **AI Usage Declaration**, a **source-of-truth** link, and **verification
  evidence**. The advisory [`governance.yml`](.github/workflows/governance.yml) check flags a PR body
  missing any of the three (pinned to an immutable governance release SHA).
- **AI code review is advisory, never a merge gate.** Only deterministic checks (governance, lint,
  tests) may block. Treat every AI-review finding as a *claim* to verify against the cited lines, not a
  verdict. See the [AI Working Agreement](https://adorsys-gis.github.io/ai-governance/12-ai-working-agreement)
  and the [Doctrine](https://adorsys-gis.github.io/ai-governance/13-doctrine).

## Prerequisites

- **Node ≥ 22** (runtime packages set this in `engines`).
- **pnpm 11** (`packageManager` pins the exact version).
- For the browser extension: a Chromium browser and/or Firefox to load it unpacked.

## Bootstrap

```sh
pnpm install            # install the whole workspace
pnpm -r build           # oxc emits dist/ for library packages (no type check); wxt build for the extension
pnpm -r test            # vitest in each package that has tests
```

## The pre-push gate

Run all five before opening a PR — CI runs the same:

```sh
pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm lint && pnpm format:check
```

> **Order matters.** `@vymalo/opencode-browser-mcp` typechecks against
> `@vymalo/opencode-browser`'s built `./lib` export, so **build before typecheck/test** (CI does).

> **`pnpm build` never type-checks.** Library packages build with
> `node ../../scripts/build-package.mjs`, which uses [oxc](https://oxc.rs) to emit JS and `.d.ts`
> in one process with zero type analysis. `pnpm typecheck` (`tsc --noEmit`) is the only
> type-safety gate — a green build says nothing about types. See
> [ADR-0010](docs/adr/0010-oxc-build-isolated-declarations.md).

## Per-package iteration (faster)

```sh
pnpm --filter @vymalo/opencode-oauth2 test
pnpm --filter @vymalo/opencode-oauth2 build
pnpm --filter @vymalo/opencode-oauth2 exec vitest run path/to/file.test.ts
pnpm --filter @vymalo/opencode-oauth2 exec vitest run -t "ensureAccessToken"   # by name
pnpm --filter @vymalo/opencode-oauth2 exec vitest                              # watch mode
```

## Integration tests (Docker)

A reusable compose stack lives in [`test-env/`](test-env/). Integration suites **skip
themselves** when their env var is unset, so the default `pnpm test` stays hermetic.

```sh
pnpm test:env:up                                            # compose up (waits for health)
pnpm --filter @vymalo/opencode-models-info test:integration
pnpm test:env:down
# or one-shot:
pnpm test:integration
```

## Conventions

- **Biome, not ESLint/Prettier.** Config in [`biome.json`](biome.json): double quotes, 100-col,
  no trailing commas, semicolons always. Keep **0 lint warnings** — `noNonNullAssertion` is a
  warning the codebase stays clean of; don't introduce `!`.
- **Strict TypeScript** (`tsconfig.base.json`: `ES2022` + `NodeNext` + `strict` +
  `isolatedDeclarations`). The last one is a real authoring rule, not just a compiler flag: every
  exported symbol needs a type the compiler can read off its own file, because `build` derives
  `.d.ts` files with oxc's `isolatedDeclaration`, which never consults the type checker. In
  practice, add an explicit annotation on things like `export const FooPlugin: Plugin =
  createFoo()` and an explicit return type on every exported function — inference that reaches
  into another file is exactly what this rejects. A violation is caught by `pnpm typecheck`, with
  a pointer to the offending export. See
  [ADR-0010](docs/adr/0010-oxc-build-isolated-declarations.md). Use `node:` prefixes for
  built-ins.
- **kebab-case filenames** for `.ts/.tsx/.css/.md/.json/.sh`; `camelCase` vars/functions;
  `PascalCase` types/components; `SCREAMING_SNAKE_CASE` true constants.
- **Tests** live in `test/`, not co-located. Vitest everywhere.
- **Structured logging** — emit `snake_case` events through the existing logger (console + host
  log stream), never ad-hoc `console.log`. Redact secrets.
- **Lint/format scripts pass explicit paths** (`packages apps test-env *.json`) because
  `biome.json` excludes `**/.claude`; if you add a top-level lintable dir, add it to those
  scripts.

## Package layout

Each plugin follows the same shape:

```
packages/<plugin>/src/
├── index.ts      # tiny re-export — OpenCode discovers this (rejects non-Plugin exports)
├── opencode.ts   # plugin factory + default export
├── plugin.ts     # core runtime (split out so it stays testable)
├── lib.ts        # public library API (the "./lib" export subpath)
└── …
```

Two entry points per published package: `"."` → `dist/index.js` (kept intentionally tiny);
`"./lib"` → `dist/lib.js` (the embedder API — new utilities go here, not in `index.ts`).

## Commit & PR

- Conventional-commit style subjects (`feat(browser): …`, `fix(oauth2): …`, `docs: …`).
- Keep one concern per PR; open an issue first for substantial changes so we can align on scope.
- Make sure the pre-push gate is green and docs are updated alongside behavior changes.
- Use the [pull request template](.github/PULL_REQUEST_TEMPLATE.md) and complete the **AI Usage
  Declaration**, source-of-truth link, and verification evidence (see [AI Governance](#ai-governance)).

## Releasing (maintainers)

Versions are bumped **manually** — no changesets. All seventeen workspace packages sit on **one
version line** and are bumped together in a single PR that also adds the `CHANGELOG.md` entry: the
thirteen published ones (`opencode-auth-core`, `opencode-core-otel`, `opencode-provider-sync`,
`opencode-oauth2`, `opencode-models-info`, `opencode-ratelimit`, `opencode-browser`,
`opencode-browser-mcp`, `opencode-devtools`, `opencode-devtools-mcp`, `opencode-otel`,
`opencode-repo-auth`, `opencode-lightbridge`) plus four private (workspace root, `plugin-bundle`,
`browser-extension`, `opencode-code-index`).

After that PR merges, a maintainer publishes by dispatching the workflow:

```sh
gh workflow run publish.yml -f dry_run=false
```

It runs the gate, publishes the thirteen npm packages with provenance (shared libraries — auth-core,
core-otel, provider-sync — before the plugins that depend on them), attaches the extension zips,
and `wxt submit`s to the Chrome Web Store + Firefox AMO (each gated on its own store secrets, so a
store with no credentials is skipped rather than failing). `-f dry_run=true` validates everything,
store credentials included, without publishing.

> [!IMPORTANT]
> **Do not tag the commit or cut a GitHub Release.** This repo deliberately has neither — a release
> is the workflow run, not a tag. Changelog entries are anchored by `chore(release)` commit
> boundaries instead.

See the [Releasing section in CLAUDE.md](CLAUDE.md#releasing) for the full mechanics.

## Where to read next

- [`docs/README.md`](docs/README.md) — the documentation index.
- [`CLAUDE.md`](CLAUDE.md) — the live architectural map of the repo.
