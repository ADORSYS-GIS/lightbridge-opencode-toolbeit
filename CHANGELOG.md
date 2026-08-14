# Changelog

All notable changes to the **OpenCode Toolbelt** — the `@vymalo/*` plugin suite for [OpenCode](https://opencode.ai) — are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

All twelve workspace packages move on **one version line** and are released together, so a single entry covers the whole suite. Each line is tagged with the package it touches (`oauth2`, `models-info`, `ratelimit`, `browser`, `browser-mcp`, `browser-extension`, `code-index`, `devtools`, `devtools-mcp`, `otel`). PR references link to the change.

## [Unreleased]

### Added

- **otel:** OTLP export failures now reach the host log stream as `otel_export_failed` — with the signal, the HTTP status where the backend supplies one, the error message and a `consecutiveFailures` count — and recovery is reported once as `otel_export_recovered`. Previously a rejected export (an expired credential, a wrong audience, an unreachable collector) was reported only through the OTel SDK's own `diag` channel, which nothing subscribed to: telemetry stopped silently while the session looked healthy. Implemented by decorating this plugin's own exporters rather than calling `diag.setLogger`, which is process-global and would hijack the channel for the host and every other plugin.
- **otel:** A new `tokenCommand` option (env `OPENCODE_OTEL_TOKEN_COMMAND`) for collectors behind a short-lived credential — an executable that prints a fresh access token on stdout, re-run before the current one expires. Needed because a static `Authorization` header is read once at plugin load and never refreshed, so a five-minute OIDC token goes stale and every subsequent export fails. Expiry comes from the token's own `exp` claim where it is a JWT (base64-decoded, deliberately **not** signature-verified — the plugin is not authenticating anything, it only needs to know when to ask again), minus a 30-second margin; `tokenRefreshMs` applies otherwise. Concurrent exports share one helper invocation. The token is never logged, and a failure logs the *length* of the helper's stderr rather than its contents. See [`docs/otel.md`](docs/otel.md#short-lived-credentials).
- **otel:** Failure handling for the credential helper is deliberately asymmetric: a helper that fails while the cached token is still valid changes nothing, since that token is current rather than stale, but one that fails with no valid token left produces **no auth header at all** — so the export fails closed at the collector instead of retrying forever with a dead credential. A rejected export also drops the cached token, so the next attempt re-runs the helper rather than replaying something already refused.

### Fixed

- **all plugins:** Raised the `pnpm-workspace.yaml` audit overrides to clear four high-severity advisories that were failing `publish.yml`'s `pnpm audit --audit-level=high` gate and blocking the 0.13.0 release. `fast-uri` was already pinned to `^3.1.4` for two earlier host-confusion advisories, but a third ([GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7), backslash authority introducer) has a floor of 3.1.5 — the old pin satisfied the advisories it was written for and silently resolved below the new one. Also pinned `ip-address` ≥10.3.1 ([GHSA-mwp4-54f8-5fhr](https://github.com/advisories/GHSA-mwp4-54f8-5fhr), SSRF via leading-zero octets; transitive through `@modelcontextprotocol/sdk` → `express-rate-limit`), and `postcss` ≥8.5.18 / `nanoid` ≥3.3.18 from the vite + WXT toolchain — devDependencies only, but the gate does not distinguish. Each override now carries its advisory ids so a future reader can tell whether the entry is still earning its place. `vite` moved 8.0.14 → 8.2.1 within its existing `^8` range.

### Documentation

- **otel:** An integration test that drives a **real** `OTLPTraceExporter` against a local HTTP server, proving the async `headers` factory the credential helper depends on is actually awaited and its `Authorization` header reaches the wire — including that the factory is re-invoked per export rather than cached, which is what makes refresh work at all. The rest of the suite substitutes the exporter, so the SDK's own header consumption was previously unverified: the whole feature rode on a contract nothing exercised.
- **otel:** A backend recipe for an OIDC-protected collector (the OpenTelemetry Collector's `oidc` extension), covering the static-header and credential-helper cases and how to verify auth with `curl` before wiring the plugin in. Notes that such collectors commonly expose HTTP only, which matches this plugin's transport — worth checking before assuming a gRPC endpoint exists, particularly behind an ingress that would need explicit h2c configuration to carry gRPC.


## [0.13.0] — 2026-08-14

### Added

- **otel:** A new published plugin, `@vymalo/opencode-otel` — OpenTelemetry export of developer interactions as OTLP **traces, metrics and logs**, the OpenCode counterpart to [Claude Code's monitoring](https://code.claude.com/docs/en/monitoring-usage) and [Codex's `[otel]` block](https://learn.chatgpt.com/docs/config-file/config-advanced). Exports **real USD cost** straight from the host's `AssistantMessage.cost` (no price table to maintain), **all five token types** including `cache_read` / `cache_write` / `reasoning` (on a cached agentic session cache-read is routinely the majority of tokens, so an input+output-only dashboard measures a different quantity), tool results with durations and outcomes, permission decisions, API errors with status codes and retry attempts, lines of code by language, active time, and compactions. Configurable from **`opencode.json` or standard `OTEL_*` environment variables** — environment overrides options, so a `.well-known/opencode` document can ship an org-wide default that a developer can still redirect at a local collector. Completely inert until an endpoint or explicit exporter is configured. See [`docs/otel.md`](docs/otel.md) and [`plans/otel.md`](plans/otel.md).
- **otel:** Full coverage of the host's observation surface — **5 of 19 plugin hooks** and **16 of 32 SDK event types**, up from 5 and 11. New hooks: `chat.params` (sampling parameters, and a `chat` span that now opens *before* the provider request, which is what makes trace-context propagation work for the first request of a turn), `permission.ask`, `experimental.text.complete` (assistant response size), `experimental.compaction.autocontinue` (whether context overflow forced the compaction). New events: `installation.updated`, `vcs.branch.updated`, `todo.updated`, `session.deleted`, `server.instance.disposed` (a host-driven drain, more reliable than waiting for a process signal). Everything still excluded is listed with its reason in [`docs/otel.md`](docs/otel.md#what-is-deliberately-not-collected) — including `lsp.client.diagnostics`, whose payload carries no severity or counts to aggregate.
- **otel:** Session traces (`invoke_agent opencode` → `chat {model}` → `execute_tool {name}`) following the GenAI semantic conventions, with W3C `traceparent` injected into provider requests by wrapping `provider.options.fetch` — the same seam `@vymalo/opencode-ratelimit` uses, composed the same way. When two or more chats are in flight the plugin injects **nothing** rather than guessing a parent: a missing link is recoverable, a fabricated one silently corrupts the trace.
- **otel:** No content is captured in this release — no prompts, responses, tool arguments or API bodies; log records carry shape only (lengths, counts, durations, sizes, outcomes, error classes). Resource attributes identify the machine and project, never the developer: unlike some implementations the git author email is not collected, and per-person attribution is an explicit `OTEL_RESOURCE_ATTRIBUTES` opt-in. Session id reaches metrics only behind `includeSessionId`, since it is unbounded cardinality.

### Fixed

- **otel:** `service.version` and `vcs.repository.ref.name` were documented resource attributes that could never appear. OpenCode reveals both only as events (`installation.updated`, `vcs.branch.updated`), which arrive after the OTel `Resource` is fixed at provider construction — so the values had nowhere to go and every span, metric and log shipped without them. Both are now deferred (promise-valued) resource attributes, which exporters await before the first export, with a bounded 2-second wait so a host that never emits them cannot block export forever. The exit handlers abandon any still-pending attribute before draining, because their timers are `unref`'d and would otherwise never fire on `beforeExit`, hanging the final flush.
- **otel:** Auto-resolved permissions were invisible. `permission.replied` only fires for prompts a human answered, so a configuration that auto-allows tools reported no decisions at all and `opencode.permission.decision.count` silently undercounted. `permission.ask` now counts already-decided prompts as `opencode.permission.source: "auto"`; one still awaiting an answer is left to `permission.replied` as `"user"`, so the two paths cannot double-count.
- **otel:** Per-session bookkeeping grew for the life of the process — irrelevant to a CLI invocation, a slow leak in a long-running OpenCode server. Finished-message and tool-call state is dropped at `session.idle`, and everything for a session at `session.deleted`. The cumulative-diff memory deliberately survives an idle: `session.diff` reports a session's whole diff each time, so forgetting the last-seen totals for a session that later resumes would re-count it. `TelemetryRecorder.pendingStateSize()` exposes the sizes so a leak is answerable without a heap dump.
- **otel:** Republished through `publish.yml`, so `0.13.0` carries a SLSA provenance attestation like every other package in the suite. `@vymalo/opencode-otel@0.12.0` was published out-of-band with a local `npm publish`, which cannot generate provenance at all — that version is on npm, functional and signed, but unattested, and npm does not permit republishing over an existing version. Prefer `0.13.0`.

### Documentation

- **otel:** [ADR-0009](docs/adr/0009-otel-otlp-http-not-grpc.md) records why OTLP ships over HTTP/protobuf only and gRPC is absent — OpenCode plugins run under Bun as well as Node, and `@grpc/grpc-js` is unreliable there. Same dual-runtime reasoning as [ADR-0001](docs/adr/0001-bridge-transport-ws-not-bun-serve-or-socketio.md). `OTEL_EXPORTER_OTLP_PROTOCOL` is deliberately unread rather than silently ignored.
- **otel:** [`plans/otel.md`](plans/otel.md) records the build-vs-adopt sweep against the existing [`opencode-otel-plugin`](https://github.com/felixti/opencode-otel-plugin), which covers traces and metrics well and whose GenAI-semconv vocabulary this package deliberately reuses so both land on the same dashboards. Run one or the other, not both.

## [0.12.0] — 2026-07-31

### Added

- **models-info:** A new opt-in `meta.modelsInfoHideUnmatched` provider option. When `true`, deletes a model from `provider.models` if the catalog has no entry matching its id at all — the membership half of `meta.modelsInfoHideTextOnly`'s behavior, without its modality filtering. A consumer that turned `modelsInfoHideTextOnly` off entirely (because it was hiding legitimate text-only external models) also silently lost catalog-authoritative membership pruning, since both deletion paths shared that one flag — clients started seeing stale/renamed/removed model ids that never got pruned. `modelsInfoHideUnmatched` reaches the same deletion path independently; `modelsInfoHideTextOnly`'s own unmatched-hiding is unchanged (documented since 0.10.0). Either flag alone is enough — setting both is redundant, not additive. See [`docs/models-info.md`](docs/models-info.md#requiring-a-catalog-entry-without-modality-filtering). (#79)

## [0.11.0] — 2026-07-30

### Added

- **models-info:** A new opt-in `meta.modelsInfoHideInternal` provider option, independent of `meta.modelsInfoHideTextOnly`. When `true`, deletes a matched model from `provider.models` if the catalog reports a non-standard `internal: true` field for it. `modelsInfoHideTextOnly` was being used by some adopters as a stand-in for "hide internal models," but it hides based on **modality**, not access scope — a legitimate text-only *external* model gets hidden right along with genuinely internal ones, and a multimodal internal model sails through unhidden. `modelsInfoHideInternal` reacts only to `internal`, composes freely with `modelsInfoHideTextOnly`, and does not extend the unmatched-model deletion path (still governed solely by `modelsInfoHideTextOnly`). Off by default; only fires when the catalog's `internal` field is actually present — a matched model the catalog gives no `internal` value for is left alone. See [`docs/models-info.md`](docs/models-info.md#hiding-internal-models). (#73)

## [0.10.0] — 2026-07-28

### Added

- **models-info:** A new opt-in `meta.modelsInfoHideTextOnly` provider option. When `true`, the `modelsInfoUrl` catalog becomes authoritative for which models exist, not just their metadata: a model is deleted from `provider.models` outright (instead of being enriched) if the catalog reports it as text-in/text-out only, **or** if the catalog has no entry for it at all — letting the richer metadata endpoint take total precedence over whatever populated `provider.models` first (hand-written config, or `@vymalo/opencode-oauth2`'s own `/v1/models` discovery). Off by default; the text-only check only fires when the catalog's `architecture.input_modalities` / `.output_modalities` are actually present, and the flag never adds models the catalog knows about but discovery/config never listed — it only prunes existing entries. See [`docs/models-info.md`](docs/models-info.md#hiding-text-only-models--catalog-authoritative-membership).
- **models-info:** A background scheduler now keeps every opted-in provider's catalog warm on the same `meta.modelsInfoTtlSeconds` cadence that already governs cache freshness (default once a day, no separate interval to configure) — closing the gap where a long-lived OpenCode process (a desktop window, an embedded server) would otherwise only ever see the catalog as it looked at boot, since the `config` hook doesn't rerun on a timer. It's a cache-warming mechanism for the *next* `config` run, not a live update into an already-open session — no such channel exists in OpenCode's plugin API. Backs off on failure, is stopped/restarted whenever `config` reruns (no leaked duplicate timers), stopped on `dispose`, and its own timer is `unref()`'d so it never keeps a short-lived CLI invocation alive by itself. See [`docs/models-info.md`](docs/models-info.md#periodic-refresh).

### Fixed

- **all plugins:** Pinned the transitive dependency `fast-uri` (pulled in via `@modelcontextprotocol/sdk` → `ajv`, a dependency of `browser-mcp` / `devtools-mcp`) to `^3.1.4` via a `pnpm-workspace.yaml` override, clearing two high-severity host-confusion advisories ([GHSA-v2hh-gcrm-f6hx](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx), [GHSA-4c8g-83qw-93j6](https://github.com/advisories/GHSA-4c8g-83qw-93j6)) that were failing `publish.yml`'s `pnpm audit --audit-level=high` gate.

## [0.9.0] — 2026-06-29

### Added

- **devtools / devtools-mcp:** A new pair of packages — `@vymalo/opencode-devtools` (OpenCode plugin) and `@vymalo/opencode-devtools-mcp` (MCP stdio server) — giving the model a belt of everyday, deterministic, local developer utilities, gated into named **tool groups**. Five groups are on by default (`math`: arbitrary-precision eval, unit & base conversion, stats; `codec`: base64/hex/url, JWT decode, gzip; `crypto`: hash/hmac, uuid v4/v7, ulid, random bytes, keypairs; `datetime`: parse/format/diff, timezone conversion, cron explain + next-runs; `convert`: JSON/YAML/TOML/CSV interconversion + JSONPath), and an **opt-in** `http` group (request + GraphQL) guarded against SSRF (loopback/private/link-local hosts are blocked unless `http.allowPrivateNetwork` is set). No bridge, no auth — pure in-process compute over an injected clock / randomness / fetch. The tool surface is shared with the MCP server via `./lib`, mirroring the browser plugin. The build-vs-adopt rationale (why these gaps, why memory/mobile/db are *adopted* instead) is in [`plans/devtools.md`](plans/devtools.md) and [`docs/devtools.md`](docs/devtools.md).

### Documentation

- **devtools:** New [`docs/devtools.md`](docs/devtools.md) (tool reference, groups, security model, config) and [`docs/recommended-mcps.md`](docs/recommended-mcps.md) — a guide to the mature third-party MCP servers we deliberately **adopt rather than rebuild** (memory, android/iOS, database), per the suite's "don't duplicate a good existing MCP" principle.
- **browser / all plugins:** Four new ADRs capturing the load-bearing decisions behind the 0.8.1 bridge/logging fixes — [ADR-0005](docs/adr/0005-atomic-file-writes-per-writer-temp.md) (atomic on-disk writes: per-writer temp + rename), [ADR-0006](docs/adr/0006-bridge-token-source-of-truth.md) (`bridge.json` as token source-of-truth: host-only write + reload-on-mismatch), [ADR-0007](docs/adr/0007-bridge-handshake-rejection.md) (handshake rejection: explicit reject frame, slow-retry not dormant, fingerprint logging — incl. the dormant→slow-retry reversal), and [ADR-0008](docs/adr/0008-trace-log-tier.md) (`trace` log tier gated by OpenCode `DEBUG`). Cross-linked from `browser.md`, `architecture.md`, `troubleshooting.md`, and the ADR index.

## [0.8.1] — 2026-06-17

### Added

- **code-index** *(experimental, private — not published)*: a personal code-intelligence plugin (`@vymalo/opencode-code-index`). Registers `code_*` tools — `code_symbol`, `code_callers`, `code_callees`, `code_references`, `code_blast_radius`, plus `index_refresh` / `index_status` — backed by an embedded **DuckDB** store and a **tree-sitter** symbol graph. The index is content-addressed by git blob and scoped per branch (a branch is a `path→blob` manifest), so branch/worktree switches re-index only the delta and `blast_radius` stays branch-correct. Call-graph resolution is *sound but partial* (tree-sitter only, no type info). Lives in the workspace for convenience; may be removed. See [`docs/code-index.md`](docs/code-index.md) and [`plans/code-index.md`](plans/code-index.md).
- **all plugins:** A new `trace` log tier (below `debug`) carrying fine-grained, per-step breadcrumbs — config-hook steps and providers considered (oauth2), each model match/merge decision (models-info), every parsed `x-ratelimit` header and throttle/tier choice (ratelimit), and every bridge frame routed between agents and executors plus host/guest election (browser). It's unlocked by running the host at `--log-level DEBUG` (OpenCode's `DEBUG` now maps to `trace`), so a clean run stays quiet but "tell me everything" is one flag away. ~85 new events. ([#56](https://github.com/vymalo/opencode-oauth2/pull/56))

### Fixed

- **oauth2:** Fix a `sync_failed … ENOENT … rename '<serverId>.json.tmp' -> '<serverId>.json'` crash when several OpenCode instances boot at once (e.g. the desktop app restoring every project window in parallel) and all sync the same provider. The model-sync cache wrote to a **shared** `<serverId>.json.tmp` temp file, so one writer's atomic rename consumed the temp file another was about to rename. Temp files are now per-writer (`pid` + uuid) and cleaned up on failure. The `models-info` cache was hardened the same way (uuid + orphan cleanup). ([#54](https://github.com/vymalo/opencode-oauth2/pull/54))
- **browser / browser-extension:** A rejected bridge handshake (`browser_handshake_rejected reason=bad_token`) no longer floods the bridge ~once a second. The broker sends a `rejected` frame before closing, so the extension can tell a token rejection from a network drop: it shows a clear, neutral error (the token may be stale/rotated, or a different host is running) and **backs off to a slow retry** instead of hammering. Crucially it still **auto-recovers** the moment a good host returns — e.g. after you restart the process that owns the bridge port — with no manual reconnect. ([#55](https://github.com/vymalo/opencode-oauth2/pull/55))
- **browser:** Fix bridge **token divergence** — the failure where the extension sends the *current* token but a long-lived host (e.g. an IDE-embedded OpenCode) keeps rejecting it. Three changes: (1) `bridge.json` is now written **atomically** (temp + `rename`), so a concurrent boot can't catch a torn/empty file and regenerate a fresh token over the shared one; (2) only the **host** writes the file (not every instance at load), and only when the file doesn't already match its `(port, token)` — so a port change and an explicit operator token stay authoritative, while a concurrent host doesn't thrash it (an explicit token is also never overridden by a file reload); (3) on a bad-token handshake the host **re-reads `bridge.json` and adopts a rotated token**, so a rotation reaches a running host without a restart (logged `browser_bridge_token_reloaded`). ([#57](https://github.com/vymalo/opencode-oauth2/pull/57))

### Changed

- **browser:** `browser_handshake_rejected` now logs non-secret token **fingerprints** (`expected` vs `got`, plus `role`/`client`) instead of a bare `reason`, so a token mismatch is diagnosable from the log without exposing the secret — a same-length, different-value pair points at a stale/rotated host rather than a paste error. ([#55](https://github.com/vymalo/opencode-oauth2/pull/55))

## [0.8.0] — 2026-06-14

The release that turns the **browser** plugin from "drives tabs" into "collaborates with a human", and reframes the whole repo as a suite rather than a single auth plugin.

### Added

- **browser:** Human-in-the-loop UI feedback — a new opt-in `interactive` tool group with `browser_request_feedback`, a blocking, branded in-page overlay (point / confirm / choose) that the broker can tear down via a `cancel` frame on abort or timeout. A docked side-panel fallback handles overlay-blocked pages. ([#49](https://github.com/vymalo/opencode-oauth2/pull/49))
- **browser-extension:** A fake-chrome test harness plus background-worker unit tests, lifting the extension off "verified by hand only". ([#50](https://github.com/vymalo/opencode-oauth2/pull/50))

### Changed

- **docs:** The workspace README is rebranded as the **OpenCode Toolbelt** — a suite of five published plugins, not just the flagship auth plugin. Per-package npm badges, a "what's in the belt" table, and a suite-level diagram. ([#51](https://github.com/vymalo/opencode-oauth2/pull/51))

### Documentation

- **browser:** ADR-0001 records why the bridge uses the `ws` package rather than `Bun.serve` or socket.io, and a stale `Bun.serve` comment was fixed. ([#47](https://github.com/vymalo/opencode-oauth2/pull/47))
- **browser:** Documented where `bridge.json` lives on the host so the extension token is easy to find. ([#48](https://github.com/vymalo/opencode-oauth2/pull/48))

## [0.7.3] — 2026-06-14

### Fixed

- **browser:** Serve the bridge over `ws` so it runs under **Node** (the desktop OpenCode runtime), not only Bun. ([#46](https://github.com/vymalo/opencode-oauth2/pull/46))

## [0.7.2] — 2026-06-14

### Fixed

- **all plugins:** Stop flooding stdout — defer to OpenCode's logger instead of writing structured events directly to the console. ([#45](https://github.com/vymalo/opencode-oauth2/pull/45))

## [0.7.1] — 2026-06-14

A large development burst released as a patch: the MCP server, multi-client routing, and store automation all landed here.

### Added

- **oauth2:** `responseApi` toggle to route inference through `/v1/responses` (and inject the `output_index` / `content_index` fields some gateways drop on SSE). ([#37](https://github.com/vymalo/opencode-oauth2/pull/37))
- **models-info:** `meta.modelsInfoOverwrite` — opt specific fields out of the upstream-wins merge so a metadata endpoint can replace a value another plugin auto-stamped. ([#38](https://github.com/vymalo/opencode-oauth2/pull/38))
- **browser-mcp:** New published package — an MCP stdio server hosting the same bridge and exposing the same `browser_*` catalog over the Model Context Protocol, so any MCP client (Claude Code, Cursor, Cline, …) can drive the extension. Screenshots return as inline image content.
- **browser:** Multi-client routing via an auto-elect broker — multiple executors (extensions) and multiple agents (plugin / MCP / sessions) share one bridge, routed by named-group ownership, with host-or-guest election and failover. Plus 16 new actions, a shared tool catalog with group gating, true full-page capture on the content executor, and plugin-initiated + auto-on-shutdown release.
- **browser-extension:** daisyUI (nord / aqua) restyle with a "how it works" guide, and CI auto-submit to the Chrome Web Store and Firefox AMO (each store gated on its own secrets).

### Fixed

- **browser:** Persist the bridge token across sessions. ([#43](https://github.com/vymalo/opencode-oauth2/pull/43))
- **browser:** Broker release is scoped to owned executors only; an empty token is no longer treated as an explicit one; stale query refs are cleared.
- **browser-extension:** Pin `gecko.id` and declare `data_collection_permissions` for AMO.

## [0.7.0] — 2026-06-12

### Added

- **browser:** New published `@vymalo/opencode-browser` plugin — `browser_*` tools (open, navigate, click, type, scroll, screenshot, snapshot, …) registered via `Hooks.tool`, backed by a localhost WebSocket bridge — plus a private companion Chromium/Firefox extension under `apps/`. Because an extension can't host a server, the plugin is the server and the extension dials out. Tabs are organized into named groups; targeting is via snapshot refs, CSS selectors, or coordinates; screenshots are written to disk and surfaced as a path. ([f463429](https://github.com/vymalo/opencode-oauth2/commit/f463429))

---

Releases before `0.7.0` predate this changelog. For that history, see the [commit log](https://github.com/vymalo/opencode-oauth2/commits/main).
