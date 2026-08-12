# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. [`AGENTS.md`](AGENTS.md) is a mirror of this file for other AI agents — keep the two in sync; when you edit one, copy the change across in the same PR.

## What this repo is

A **pnpm workspace** of OpenCode plugins under the `@vymalo` npm scope. There are **six** runtime plugins plus a Rolldown-based bundler — all plugins target OpenCode's plugin API (`@opencode-ai/plugin`) and ship to npm independently — plus **two** published **MCP servers** (one exposing the browser tools, one exposing the devtools utilities) for any MCP client, and one private **browser extension** app under `apps/` (the companion to the browser plugin/MCP server). There is also an **experimental, private** seventh runtime plugin, `@vymalo/opencode-code-index` (DuckDB + tree-sitter code indexing) — **not published**, not part of the supported suite, and may be removed; see [`docs/code-index.md`](docs/code-index.md).

| Package | Purpose |
| --- | --- |
| `packages/opencode-oauth2` → `@vymalo/opencode-oauth2` | OAuth2 / OIDC auth + dynamic model discovery for OpenAI-compatible providers. The mature plugin; five auth flows (`authorization_code`, `device_code`, `client_credentials`, `jwt_bearer`, `token_exchange`), persistent token cache, periodic sync scheduler. PKCE is on by default for the two interactive flows (`pkce: false` opts out per server). |
| `packages/opencode-models-info` → `@vymalo/opencode-models-info` | **Auth-agnostic** metadata enrichment plugin: fetches OpenRouter-shaped `/models` JSON and merges `limit` / `cost` / `modalities` / capability flags onto existing provider model entries. Runs as a `Hooks.config` hook *after* other plugins. |
| `packages/opencode-ratelimit` → `@vymalo/opencode-ratelimit` | **Auth-agnostic** rate-limit awareness plugin: in its `Hooks.config` hook it injects a custom `fetch` onto opted-in providers (`options.meta.rateLimit`) that reads Envoy Gateway / IETF draft-03 rate-limit headers (`x-ratelimit-limit/remaining/reset`), proactively throttles when `remaining` hits 0, and backs off + retries on `429`. Supports `tiers` (reset-magnitude policy bands with `wait`/`error` actions, so a 60s burst waits but a multi-day budget reset errors fast) and `scope: "model"\|"provider"` (per-model cooldown buckets for per-model gateway limits). The only response-observing plugin — OpenCode has no post-response hook, so wrapping `options.fetch` is the sole interception point. In-memory state only (no `cache.ts`). See [`docs/ratelimit.md`](docs/ratelimit.md). |
| `packages/opencode-browser` → `@vymalo/opencode-browser` | **Auth-agnostic** browser-automation plugin: registers `browser_*` **tools** (`Hooks.tool`) the model calls (open, click, type, scroll, screenshot, snapshot, …) and hosts a localhost WebSocket **bridge** (via the Node `ws` package, so it runs under both Bun and Node) that the companion extension dials. **34 tools** in four groups (`page`/`control`/`debug`/`interactive`, gated by the `groups` option; `debug` and `interactive` are opt-in); tabs are organized into **named groups**. The single source of truth for the tool surface is `catalog.ts` (shared with the MCP server). The bridge is an **auto-elect broker** (`broker.ts`) routing between **agents** (plugin/MCP/sessions) and **executors** (extensions) by named-group ownership — so multiple browsers and multiple agents can share one bridge. The only tool-registering plugin. Screenshots are written to disk (tool output is text-only). The `interactive` group adds **human-in-the-loop** feedback (`browser_request_feedback`): a blocking, branded in-page overlay (point/confirm/choose) that the broker can tear down via a `cancel` frame on abort/timeout — see [`plans/ui-feedback.md`](plans/ui-feedback.md). See [`docs/browser.md`](docs/browser.md) and [`plans/multi-client-routing.md`](plans/multi-client-routing.md). |
| `packages/opencode-browser-mcp` → `@vymalo/opencode-browser-mcp` | **MCP stdio server** (a `bin`) that hosts the same bridge (Node `ws` transport) and exposes the same group-filtered `browser_*` catalog over the Model Context Protocol — so non-OpenCode agents (Claude Code, Cursor, Cline, …) can drive the extension. Reuses `@vymalo/opencode-browser`'s catalog + JSON-Schema via `./lib`; returns screenshots as inline MCP image content. |
| `packages/opencode-devtools` → `@vymalo/opencode-devtools` | **Auth-agnostic** developer-utilities plugin: registers deterministic, in-process `math_*` / `codec_*` / `crypto_*` / `datetime_*` / `convert_*` (and opt-in `http_*`) **tools** (`Hooks.tool`) — **no bridge, no server, no auth**. Tools are organized into **groups** gated by the `groups` option (the five offline groups on by default; `http` performs network egress and is opt-in, SSRF-guarded). Single source of truth is `catalog.ts` (shared with the MCP server via `./lib`); handlers run over an **injected clock / randomness / `fetch`** for testability. Deliberately fills only the gaps where no mature MCP exists — memory/adb/db are *adopted* instead (see [`docs/recommended-mcps.md`](docs/recommended-mcps.md)). See [`docs/devtools.md`](docs/devtools.md) and [`plans/devtools.md`](plans/devtools.md). |
| `packages/opencode-devtools-mcp` → `@vymalo/opencode-devtools-mcp` | **MCP stdio server** (a `bin`) exposing the same group-filtered devtools catalog over the Model Context Protocol — so non-OpenCode agents (Claude Code, Cursor, Cline, …) get the same utilities. Reuses `@vymalo/opencode-devtools`'s catalog + JSON-Schema via `./lib`; pure local compute (no bridge), text-only results. Groups selected via `OCD_GROUPS`. |
| `packages/opencode-otel` → `@vymalo/opencode-otel` | **Auth-agnostic** OpenTelemetry plugin: the only **observer** in the suite — registers no tools, hosts no server, and mutates nothing except a `provider.options.fetch` wrapper for W3C trace-context propagation. Subscribes to `Hooks.event` (the whole SDK event stream) plus `chat.message` / `tool.execute.*` and translates them into OTLP **traces, metrics and logs**: real USD cost from `AssistantMessage.cost`, all five token types (`input`/`output`/`reasoning`/`cache_read`/`cache_write`), tool outcomes, permission decisions, API errors, lines of code, active time. Configurable from `opencode.json` **or** `OTEL_*` env (env wins) — the config-file channel is what makes it distributable through `.well-known/opencode`. **No content capture**: shape only, never prompt/response/tool text. Inert until an endpoint is configured. See [`docs/otel.md`](docs/otel.md) and [`plans/otel.md`](plans/otel.md). |
| `apps/browser-extension` → `@vymalo/opencode-browser-extension` (private) | Companion Chromium MV3 + Firefox extension for the browser plugin/MCP server. WXT + React + Tailwind + shadcn-style UI + TanStack Query + Dexie/IndexedDB. Its background worker connects out to the bridge and drives tabs via CDP (`chrome.debugger`) or a content-script fallback. **Not** published to npm. |
| `packages/opencode-code-index` → `@vymalo/opencode-code-index` (private, **experimental**) | Personal code-intelligence plugin: registers `code_*` **tools** (`Hooks.tool`) — `code_symbol`, `code_callers`, `code_callees`, `code_references`, `code_blast_radius`, plus `index_refresh`/`index_status`. Indexes the repo into an embedded **DuckDB** store (no server) with a **tree-sitter** symbol graph. Content-addressed by git **blob** and scoped per **branch** (a branch is a `path→blob` manifest), so branch/worktree switches re-index only the delta and `blast_radius` is branch-correct. The call graph is *sound but partial* — tree-sitter only, no type info (drops generic `obj.method()`). **Not published**; may be removed. See [`docs/code-index.md`](docs/code-index.md) and [`plans/code-index.md`](plans/code-index.md). |
| `packages/plugin-bundle` → `@vymalo/opencode-oauth2-bundle` (private) | Rolldown build that ships a single-file distribution of the oauth2 plugin. |

The plugins are deliberately decoupled: `opencode-models-info`, `opencode-ratelimit`, and `opencode-browser` do not import from `opencode-oauth2` (or each other) and work with any auth scheme (static API key, oauth2, none) because they only mutate the already-resolved OpenCode config (browser additionally hosts its own bridge). Soft ordering recommendation when stacking them in `plugin`: oauth2 → models-info → ratelimit (config hooks run in registration order; ratelimit's fetch wrapping is auth-independent so its position is cosmetic, but models-info genuinely needs the oauth2 bearer first — see the composition contract below).

## Common commands

```sh
pnpm install                 # bootstrap workspace
pnpm -r build                # compile all packages (tsc → dist/)
pnpm -r typecheck            # tsc --noEmit across packages
pnpm -r test                 # vitest run in each package that has tests (fast, no coverage)
pnpm coverage                # vitest run --coverage per package; FAILS below per-package thresholds
pnpm lint                    # biome lint (full repo)
pnpm format                  # biome format --write
pnpm format:check            # biome format (no write) — part of the pre-push gate
```

Pre-push gate (run all five before opening a PR): `pnpm -r build && pnpm -r typecheck && pnpm coverage && pnpm lint && pnpm format:check`. (`pnpm coverage` runs the tests **and** enforces coverage; CI runs the same. Use the faster `pnpm -r test` for local iteration.)

Coverage thresholds are per-package, declared in each `vitest.config.ts` (`test.coverage.thresholds`), set a few points below current so a regression fails CI without exact-match churn. `@vymalo/opencode-browser` is the bar (~88%+); `opencode-browser-mcp` excludes its stdio `bin` (`mcp.ts`) from the metric (it's e2e-only); the **browser extension floor is intentionally low** (chrome/DOM/React glue is verified manually — raise it once a fake-browser harness lands).

Per-package iteration (much faster):

```sh
pnpm --filter @vymalo/opencode-oauth2 test
pnpm --filter @vymalo/opencode-oauth2 build
pnpm --filter @vymalo/opencode-models-info typecheck
```

Single-test run inside a package:

```sh
pnpm --filter @vymalo/opencode-oauth2 exec vitest run path/to/file.test.ts
pnpm --filter @vymalo/opencode-oauth2 exec vitest run -t "ensureAccessToken"   # by test name
```

Watch mode: `pnpm --filter <pkg> exec vitest` (no `run`).

### Integration tests (Docker)

A reusable compose stack of HTTP backends lives under [`test-env/`](test-env/). Currently a WireMock service stubs the OpenRouter-shaped `/v1/models` endpoint for `@vymalo/opencode-models-info`; a Keycloak service is sketched-in (commented out) for the upcoming `@vymalo/opencode-oauth2` integration suite.

```sh
pnpm test:env:up               # docker compose up (waits for healthcheck)
pnpm --filter @vymalo/opencode-models-info test:integration
pnpm test:env:down             # docker compose down -v
# or one-shot:
pnpm test:integration          # compose up → all packages' integration suites → compose down
```

Integration tests live under `test/integration/**/*.test.ts`, run via a separate `vitest.integration.config.ts`, and **skip themselves** when `INTEGRATION_MODELS_INFO_URL` is unset — so the default `pnpm test` stays hermetic. Stubs are at [`test-env/wiremock/mappings/`](test-env/wiremock/mappings/) and [`test-env/wiremock/__files/`](test-env/wiremock/__files/); editing them needs either a `wiremock` container restart or `curl -X POST http://127.0.0.1:18080/__admin/mappings/reset`.

## Architecture: how the plugins fit OpenCode

OpenCode plugins implement a `Hooks` object (see `@opencode-ai/plugin`'s `index.d.ts`). The two hooks this repo uses:

- **`Hooks.config(input: SDKConfig)`** — runs once at plugin load, mutates the assembled OpenCode config (`input.provider`, `input.pluginConfig`, etc.). Both plugins use this — oauth2 to **register** managed providers and merge discovered models; models-info to **enrich** whatever providers/models are already there.
- **`Hooks["chat.headers"](input, output)`** — runs per chat request. Only oauth2 uses this; it injects `Authorization: Bearer <token>` for providers it manages.

The whole picture sits in [`docs/architecture.md`](docs/architecture.md). If you're modifying hook behavior, read it first — it documents token lifecycle per flow, cache layout, the TTY-aware warmup logic, and which events you should expect in the log stream.

### Distribution via `.well-known/opencode`

The primary way these plugins reach users: a server publishes a `.well-known/opencode` document (an `auth` block + a `config` block listing `plugin` + `provider`), and `opencode auth login <url>` adopts it — no local `opencode.json` needed. OpenCode re-fetches and merges that `config` on every launch, so the provider definition is **not** stored on the client (only a `wellknown` pointer lands in `auth.json`; the real OAuth token lives in the oauth2 plugin's own cache). When debugging "where is this provider configured?", the answer is usually "served from the well-known URL, fetched fresh each boot." Full mechanics + gotchas in [`docs/well-known.md`](docs/well-known.md).

### Per-package file layout convention

All plugins follow the same shape:

```
packages/<plugin>/
├── src/
│   ├── index.ts        # OpenCode entry — re-exports default plugin
│   ├── opencode.ts     # Plugin factory: createXxxPlugin(opts) → Plugin
│   ├── lib.ts          # Public library API (exposed via "./lib" subpath in exports)
│   ├── plugin.ts       # Core runtime logic (split from opencode.ts so it stays testable)
│   ├── cache.ts        # FileCacheStore — per-OS cache dir, atomic rename, 0o600
│   ├── logging.ts      # JSON console logger, host log-level mapping, secret redaction
│   └── …
└── test/               # vitest, *.test.ts
```

`opencode-ratelimit` follows the same shape **minus `cache.ts`** (its rate-limit state is in-memory only — a reset window is seconds, so persisting it would only serve stale data) and **plus `headers.ts`** (a pure parser for the `x-ratelimit-*` triple). It is also the only plugin that injects a custom `fetch` into `provider.options.fetch` (the sole way to observe response status/headers, since OpenCode has no post-response hook) rather than only reading/merging config.

`opencode-browser` follows the same shape **minus `cache.ts`** (broker state is in-memory) and **plus**: `protocol.ts` (the dependency-free wire-frame contract, mirrored into the extension), `transport.ts` (the `BridgeTransport` seam + `isAddrInUse`) and `node-transport.ts` (the `ws`-backed host transport + guest socket, runs under Bun *and* Node — shared with the MCP server via `./lib`; async `listen` for bind-based election), `broker.ts` (role-aware broker: executors + agents + group-ownership routing, DI-tested), `agent-client.ts` (guest-agent WS client), `endpoint.ts` (try-bind → host-or-guest auto-election with failover), `token-file.ts` (shared `bridge.json`), `catalog.ts` + `schema.ts` (the neutral tool surface), and `tools.ts` (the OpenCode `Hooks.tool` adapter over the catalog). It is the only plugin that **registers tools** and **hosts a server**. The companion extension under `apps/browser-extension` is a WXT project (not the per-package `src/` layout) — its engine lives in `src/background/` (bridge client, command router, group registry, CDP + content executors, `page-actions` injected via `chrome.scripting.executeScript`, `feedback`/`feedback-overlay`/`feedback-side-panel` for the `interactive` HITL flow) and its UI in `src/entrypoints/{popup,options,sidepanel}` over Dexie (the `sidepanel` is the docked annotation fallback for overlay-blocked pages).

**Important — two entry points per published package:**

- `"."` resolves to `dist/index.js` and is what OpenCode discovers. The host iterates every named export and rejects anything that isn't a `Plugin` function, so `index.ts` is kept *intentionally tiny* (a single `export { default } from "./opencode.js";`). See [`packages/opencode-oauth2/src/index.ts`](packages/opencode-oauth2/src/index.ts) and the matching `slim main entry` fix in commit history.
- `"./lib"` resolves to `dist/lib.js` and is the library API for embedders. New utility exports go through `lib.ts`, not `index.ts`.

### Composition contract (models-info)

`@vymalo/opencode-models-info` runs after other `config` hooks have populated `input.provider`. It opts in per provider via `options.meta.modelsInfoUrl` and the merge is **upstream-wins**: a field already present on a model entry is never overwritten. This is deliberate — it means the plugin is safe to enable globally and lets handwritten `opencode.json` config take precedence. The escape hatch is `options.meta.modelsInfoOverwrite` (array of mapped field names) — fields listed there are exempt from upstream-wins so the endpoint value can replace one another plugin auto-stamped. The motivating case: oauth2's discovery writes a *normalized* `name` (`kimi-k2.6` → `Kimi K2.6`) onto every model, which upstream-wins then freezes; `"modelsInfoOverwrite": ["name"]` lets the endpoint's real name win. (`modalities`/`attachment` are *not* pre-stamped by oauth2, so vision support enriches without an override — if it's missing, suspect a stale cache or failed fetch, not the merge.) `options.meta.modelsInfoHideTextOnly` is the membership-side counterpart: instead of overwriting a field, it *deletes* a model from `provider.models` outright — when the catalog reports it text-only, or when the catalog has no entry for it at all — making `modelsInfoUrl` authoritative for which models exist even over oauth2's own `/v1/models` discovery. Off by default; see [`docs/models-info.md`](docs/models-info.md#hiding-text-only-models--catalog-authoritative-membership).

**The one cross-plugin coupling.** Despite being decoupled at the import level, the two plugins meet at the shared config object: oauth2's `config` hook stamps a freshly-ensured bearer onto `provider.options.headers.Authorization`, and models-info forwards `options.headers` when it fetches `modelsInfoUrl`. So an OAuth2-protected metadata endpoint works automatically — **but only if `@vymalo/opencode-oauth2` is listed before `@vymalo/opencode-models-info` in `plugin`** (config hooks run in registration order). The bearer comes from a refresh-only ensure (`ensureAccessToken(id, { interactive: false })`) so a near-expiry token is refreshed rather than skipped; `chat.headers` re-injects a fresh token per request, so a stale config-time header can only ever affect the metadata fetch, never inference. Symptom of getting this wrong: `models_info_fetch_failed_no_cache` (HTTP 401).

When changing the mapping in [`packages/opencode-models-info/src/mapping.ts`](packages/opencode-models-info/src/mapping.ts):

- OpenRouter's `pricing.prompt` / `.completion` are USD-per-token strings; OpenCode's `cost.input` / `cost.output` are USD-per-1M-tokens numbers. The conversion (`* 1_000_000` then round to 6 decimals) lives in `mapping.ts`. Don't move it.
- `limit` only emits if **both** `context` (`top_provider.context_length ?? context_length`) and `output` (`top_provider.max_completion_tokens`) are known — partial `limit` blocks are invalid in OpenCode's schema. Consequence worth knowing: if the source endpoint omits these, OpenCode backfills the runtime model's required `limit` to `{0,0}` and its UI treats the model as incomplete, hiding `cost` too even though it enriched fine. This is a *source-data* gap, not a plugin bug — see [`docs/troubleshooting.md`](docs/troubleshooting.md).
- Modalities are filtered to OpenCode's enum (`text | audio | image | video | pdf`) — `"file"` and other OpenRouter values are dropped.
- `tool_call` / `reasoning` / `temperature` are derived from the entry's `supported_parameters` array (`tools`/`tool_choice` → `tool_call`; `reasoning`/`reasoning_effort`/`thinking` → `reasoning`). The mapper only ever sets these to `true`; a capability the UI shows as disabled usually means the field is absent from the endpoint payload.

## Conventions worth knowing

- **Biome, not ESLint/Prettier.** Config in [`biome.json`](biome.json) — double quotes, 100-col, no trailing commas, semicolons always. `noNonNullAssertion` is a warning the existing code stays clean of; mirror that in new code (`@vymalo/opencode-oauth2` has 0 warnings, treat that as the bar).
- **Strict TS.** Base config is in [`tsconfig.base.json`](tsconfig.base.json) — `ES2022` + `NodeNext` + `strict: true`. Per-package tsconfig only sets `rootDir`/`outDir`. `lib.ts` re-exports are the public surface.
- **Vitest** is the test runner; each package owns a `vitest.config.ts` (with a `coverage` block + per-package thresholds enforced by `pnpm coverage`). Tests live in `test/`, not co-located. Coverage uses the v8 provider (`@vitest/coverage-v8`).
- **Node ≥ 22** for the runtime packages (set in each package.json `engines`). Use `node:` prefixed imports for built-ins (`node:fs/promises`, `node:crypto`).
- **Logging pattern**: every plugin emits structured events through both a JSON console fallback and `client.app.log` (so the host log stream picks them up). Event names use `snake_case` (`models_info_cache_hit`, `oauth2_token_refreshed`). Add new events to that pattern, not ad-hoc `console.log`.
- **Cache layout** mirrors per-OS conventions — `~/Library/Caches/<ns>/` on macOS, `XDG_CACHE_HOME` on Linux, `LOCALAPPDATA` on Windows. Each plugin uses its own namespace (`opencode-oauth2`, `opencode-models-info`). Disk writes are atomic-rename + `0o600`.

## Shell / GitHub gotchas

- **Default shell is zsh** on this laptop. `bash -c` scripts in tooling should stay POSIX-portable or be invoked under zsh explicitly.
- **`gh` auth** lives in the interactive zsh profile. If `gh` looks unauthenticated under a plain non-interactive shell, retry under `zsh -i -c '…'` — `GITHUB_TOKEN` is loaded from `.zshrc`.
- **Biome and the `.claude` worktree path.** `biome.json` excludes `**/.claude`, and Claude Code worktrees live under `.claude/worktrees/<id>/`. A bare `biome … .` therefore self-excludes (the `.` arg resolves under `.claude`) and silently processes **zero** files. To avoid that trap, the root `lint` / `format` / `format:check` scripts pass **explicit paths** (`packages apps test-env *.json`) instead of `.` — Biome evaluates `includes` relative to `biome.json`, so those relative paths never hit the `.claude` exclusion and the scripts work identically from a worktree or the main checkout. If you add a new top-level lintable directory, add it to those three scripts (otherwise it won't be checked). `biome.json` also excludes `**/.output` and `**/.wxt` (WXT's generated build + type output under `apps/browser-extension`).

## Working methodology (how we collaborate here)

The rhythm this repo is built on — follow it unless the user says otherwise:

- **Implement and document together.** A change and its docs land in the same PR — never "code now, docs later". If you touch behavior, update the relevant `docs/`, README, ADR, and `CHANGELOG.md` in the same change. One PR per concern: keep each PR scoped to a single coherent topic rather than bundling unrelated work.
- **Branch → PR → squash-merge.** Work on a branch off `main`, run the pre-push gate (`pnpm -r build && pnpm -r typecheck && pnpm coverage && pnpm lint && pnpm format:check`), then open a PR with `gh`. **Always squash-merge** with `gh pr merge <n> --squash --admin` — never a plain merge commit, never a rebase-merge. One squashed commit per PR keeps `main` linear and the changelog attributable.
- **Merge and publish only when explicitly asked.** Open PRs and push freely, but **do not merge or publish on your own initiative** — wait for the user to say "merge it" / "publish" / "release". When they do say "publish" or "release", that means `gh workflow run publish.yml -f dry_run=false` (see [Releasing](#releasing)) — **never** create a GitHub Release or git tag.
- **One version line, one changelog entry.** All twelve packages bump together; the bump PR also adds the `CHANGELOG.md` entry for that version. See [Releasing](#releasing) and [Changelog](#changelog).
- **Shell + `gh` under interactive zsh.** `gh` (and push) auth lives in the interactive zsh profile — run them as `zsh -i -c '…'` (see [Shell / GitHub gotchas](#shell--github-gotchas)).

## Releasing

Versions are bumped **manually** — there are no changesets and no release scripts. `@vymalo/opencode-oauth2`, `@vymalo/opencode-models-info`, `@vymalo/opencode-ratelimit`, `@vymalo/opencode-browser`, `@vymalo/opencode-browser-mcp`, `@vymalo/opencode-devtools`, `@vymalo/opencode-devtools-mcp`, and `@vymalo/opencode-otel` are the **eight** published packages; the workspace root, `@vymalo/opencode-oauth2-bundle`, `@vymalo/opencode-browser-extension` (the WXT app), and `@vymalo/opencode-code-index` (experimental) are `private`. `opencode-browser-mcp` depends on `opencode-browser`, and `opencode-devtools-mcp` on `opencode-devtools`, via `workspace:*` (pnpm rewrites them to the real version on publish); the bundle depends on oauth2 the same way — so a version bump touches only `package.json` `version` fields (no lockfile change). All twelve packages (the eight published plus the four private) are kept on the **same version line** — currently `0.12.0` — and bumped together in **one PR that also updates [`CHANGELOG.md`](CHANGELOG.md)** (see below).

Publishing runs through the **`publish.yml` workflow**, never a local `npm publish`: trigger it with `gh workflow run publish.yml -f dry_run=false` (off `main`, after the bump PR merges). It builds and publishes the eight npm packages at the new version. **Do not create a GitHub Release or a git tag** — the repo deliberately has none; releases are driven by the workflow run, not by tags. The **browser-extension** is private (never npm) but is still a release artifact: `publish.yml` runs `wxt zip` (Chrome + Firefox + a Firefox sources zip) and attaches the zips, so the browser feature ships as **three** things — `@vymalo/opencode-browser` (npm), `@vymalo/opencode-browser-mcp` (npm), and the extension zip(s). A separate `submit-extension` job (`needs: publish`) also runs `wxt submit` to push the extension to the **Chrome Web Store** and **Firefox AMO** — each store is gated on its own repo secrets (`CHROME_*` / `FIREFOX_*`) so a store with no credentials is skipped, not failed; a `workflow_dispatch` with `dry_run: true` runs `wxt submit --dry-run` to validate creds without uploading. Store setup + the secret list live in [`docs/browser.md`](docs/browser.md) → "Publishing the extension to the web stores" (local creds go in `apps/browser-extension/.env.submit`, gitignored; template at `.env.submit.example`).

### Changelog

Every release is recorded in [`CHANGELOG.md`](CHANGELOG.md) — [Keep a Changelog](https://keepachangelog.com/) format, SemVer. Because all twelve packages share one version line, there is a **single consolidated entry per version** (not per-package files); tag each line with the package it touches (`oauth2`, `models-info`, `ratelimit`, `browser`, `browser-mcp`, `browser-extension`, `code-index`, `devtools`, `devtools-mcp`, `otel`) and link the PR. Group changes under `Added` / `Changed` / `Fixed` / `Documentation`. **Update the changelog in the same PR as the version bump** — the bump and its notes land together. Entries are attributed by `chore(release)` bump-commit boundaries (there are no git tags to anchor them).

## Design docs and plans

- [`plans/prd.md`](plans/prd.md) — original oauth2 PRD with the phased roadmap.
- [`plans/models-info-plan.md`](plans/models-info-plan.md) — design doc for the metadata plugin, including the OpenRouter→OpenCode field mapping table.
- [`plans/multi-client-routing.md`](plans/multi-client-routing.md) — design (final) for the browser bridge's auto-elect broker: multi-executor + multi-agent routing by group ownership, host-or-guest election, failover.
- [`plans/ui-feedback.md`](plans/ui-feedback.md) — design (draft) for human-in-the-loop browser feedback: a `browser_request_feedback` tool that paints an annotation overlay and blocks on the user; needs a `CancelFrame` + per-command timeout first.
- [`plans/code-index.md`](plans/code-index.md) — design (draft) for the **experimental** code-index plugin: DuckDB engine choice, the content-addressed-blob + per-branch-manifest + scope-tier model, the tree-sitter "sound but partial" resolution strategy (validated by spikes), and the deferred remote-embeddings prose tier. User-facing reference: [`docs/code-index.md`](docs/code-index.md).
- [`plans/devtools.md`](plans/devtools.md) — design for the **devtools** utilities plugin + MCP: the build-vs-adopt prior-art sweep, why it's one grouped plugin (not N), the tool surface per group, the `math` sandbox + `http` SSRF decisions, and what's deferred. User-facing reference: [`docs/devtools.md`](docs/devtools.md); the adopt-these guide: [`docs/recommended-mcps.md`](docs/recommended-mcps.md).
- [`plans/otel.md`](plans/otel.md) — design for the **otel** plugin: the build-vs-adopt sweep against the existing `opencode-otel-plugin` (which covers traces+metrics but has no logs signal, no cost, and no cache tokens), the Claude Code / Codex → OpenCode signal mapping, the config-precedence decision, the no-content-capture posture, and what's deferred. User-facing reference: [`docs/otel.md`](docs/otel.md).
- [`docs/`](docs/) — the architecture doc is canonical for hook behavior. Also: [`well-known.md`](docs/well-known.md) (`.well-known/opencode` distribution), [`models-info.md`](docs/models-info.md) (enrichment composition + caching), [`ratelimit.md`](docs/ratelimit.md) (rate-limit policy/tiers), [`browser.md`](docs/browser.md) (browser-automation dual plugin — topology, wire protocol, tool reference, executors, security), [`devtools.md`](docs/devtools.md) (devtools utilities — groups, tool reference, `math`/`http` security), [`otel.md`](docs/otel.md) (OpenTelemetry export — config precedence, every metric/log/span, privacy & cardinality), [`recommended-mcps.md`](docs/recommended-mcps.md) (mature MCPs to adopt instead of rebuilding), [`troubleshooting.md`](docs/troubleshooting.md) (symptom-keyed fixes), plus GitHub Actions / Kubernetes cookbooks and local-dev setup.
- [`docs/adr/`](docs/adr/) — Architecture Decision Records: load-bearing, non-obvious decisions and *why* (e.g. [ADR-0001](docs/adr/0001-bridge-transport-ws-not-bun-serve-or-socketio.md) — the browser bridge uses `ws`, not `Bun.serve` or socket.io; ADR-0002–0004 the code-index engine; ADR-0005–0008 atomic on-disk writes, the bridge-token source-of-truth, handshake rejection, and the `trace` log tier; ADR-0009 why OTLP ships over HTTP/protobuf and not gRPC). Add one when a choice closes off alternatives someone would reasonably reach for.

<!-- ai-governance:stanza -->
<!-- BEGIN: AI Governance stanza (managed by ADORSYS-GIS/ai-governance) -->
## AI Governance

AI may accelerate the work, but humans own intent, verification, and consequences.
AI output is not truth: review AI-generated code as untrusted, and never submit work you cannot explain.

When opening issues or pull requests in this repo:

- Use the provided **issue forms** (Epic, User Story, Dev Ticket) and the **pull request template** — do not open blank issues/PRs.
- Fill in the **AI Usage Declaration** honestly (what AI was used for, what you verified).
- Include a **source-of-truth link** (a URL or `#123` reference). No source of truth means the work is not ready.
- Provide **verification evidence** (commands, logs, links, or checked verification boxes). No evidence means it is not done.

Source of truth and full doctrine: https://adorsys-gis.github.io/ai-governance/
This stanza is intentionally thin — read the site; do not duplicate the doctrine here.
<!-- END: AI Governance stanza -->
