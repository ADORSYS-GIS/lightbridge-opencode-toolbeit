# Changelog

All notable changes to the **OpenCode Toolbelt** — the `@vymalo/*` plugin suite for [OpenCode](https://opencode.ai) — are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

All seventeen workspace packages move on **one version line** and are released together, so a single entry covers the whole suite. Each line is tagged with the package it touches (`oauth2`, `auth-core`, `models-info`, `ratelimit`, `session-wake`, `browser`, `browser-mcp`, `browser-extension`, `oauth2-bundle`, `devtools`, `devtools-mcp`, `otel`, `core-otel`, `provider-sync`, `repo-auth`, `lightbridge`). PR references link to the change.

## [Unreleased]

## [0.20.2] — 2026-11-12

> **session-wake gains workflow-run watches, restart adoption and cross-poller dedupe.** Three changes ship together so one reinstall fixes what the 0.20.1 watch loop could not do: it could not watch GitHub Actions, it lost every watch on an OpenCode restart, and two pollers over one state root woke a session for the same event more than once. No behaviour changes for the other packages.

### Added

- **session-wake:** Durable watches now survive a **restart with a new session**. Every new subscription records the **plugin instance's** project identity (`ctx.location.project.id`, absolute and, when exposed, canonical directory); `ctx.location` is the instance's location, not the calling session's, so this is instance-scoped and not a per-session isolation claim. Two explicit tools move ownership after a restart: `wake_adopt` (one `id` or `all: true`) and `wake_resume` (all same-identity orphans in one call). `wake_list` gains `includeOrphans: true`, which lists watches left behind by another session with the same instance identity and marks `owner=… orphan=true`, the unread count and the adoption scope. Adoption changes the owner field (and stamps a legacy record's missing identity): `pending`, the subscriber `seen` ring, `lastError`, the loop guard, the shared cursor/ETags/`seen` and the refcount are preserved, so the new session can `wake_next` the old unread events and receives future wakes with no adoption-induced duplicate and no lost event within one poller. (The multi-poller duplicate-delivery gap is fixed by the per-watch lease in the entry below; the remaining tool-snapshot limitation is documented.) A different instance identity answers "not found for this session"; legacy records without a project identity remain readable and are adoptable only within the same state root (shown as `project=unknown (legacy)`), and adoption stamps the adopting instance's identity so they are project-scoped afterwards. Adoption moves ownership — the old session loses the watch — and there is no automatic startup adoption: startup has no calling session, so `autoResume` is deliberately not offered. ([#158](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/issues/158))
- **session-wake:** New `github.actions` source watches a repository's GitHub Actions **workflow runs**: a new run, every status transition (`queued` → `in_progress` → `completed`), every conclusion (`success`, `failure`, `cancelled`, `skipped`, …) and reruns. `wake_subscribe` accepts `owner`/`repo` plus optional `workflow` (file name or id) and `branch`; `number` is now optional at the schema level and is **rejected** for this source, while the three thread sources still require it and reject `workflow`/`branch`. Events are keyed by `(run id, status, conclusion, updated_at)` — `run:<id>:<status>:<conclusion>:<updated_at>` — so each transition is delivered once and a replay dedupes. The first poll records a baseline without waking, like `github.checks`. Run-level only; jobs are out of scope. Needs `Actions: read` and fails closed as `auth`/`forbidden` without it. Because GitHub exposes no `since`/`updated` filter for runs, the source keeps a window anchored at `cursor.runFloor` and fails closed as `backlog` when new runs push it past `maxPages`. ([#162](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/162))

### Fixed

- **session-wake:** End-to-end dedupe across poller instances over one state root, fixing the three live anomalies on 0.20.1: duplicate synthetic notices for one drained event, `wake_next` answering "No unread comments" while `pending=1`, and a notice `count` larger than the events `wake_next` could return. A **per-watch lease** (`owner` + expiry, atomic exclusive create, renewed each poll and again after the fetch, released by a graceful `stop()`, TTL = two negotiated intervals plus margin clamped to 60 s–2 h) makes one live poller the fetcher and deliverer; a second poller skips the whole poll, with no HTTP request, no pending append and no notice. Taking over an **expired** lease is not yet an atomic compare-and-swap: it revalidates after the fetch instead, so two survivors that observe the expiry within the same few milliseconds can both proceed until that revalidation lands. A follow-up replaces it with a compare-and-swap and adds a concurrent-takeover test. The poller reloads the subscription and watch stores from disk at the start of every poll, so it serves sessions created by another process and sees the cursor/`seen` it has not written. A poll now writes each subscriber's delivery state **once** (`updateState` appends the fresh events, merges the `seen` ring and loop state, and never resurrects an event a concurrent `wake_next` drained); the shared watch is persisted before the notice, and the notice `count` is read back from the persisted queue. `wake_next` re-reads the queue from disk, so a stale in-memory snapshot cannot answer "No unread comments" over a non-empty queue, and marks drained ids in the shared `seen` ring, keeping them past the `seenLimit` trim rather than evicting them before the next poll. If `updateState` returns `undefined` (record removed mid-poll), no notice is sent. The lease is a single-writer guard on a local state root, not a global exactly-once claim on a filesystem that does not honour atomic exclusive create/rename. ([#158](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/issues/158), [live anomalies](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/issues/158#issuecomment-6826581654))

### Documentation

- **docs:** [`docs/session-wake.md`](docs/session-wake.md) and the package README document the cross-process lease, its TTL and failover, the append-merge delivery write, the `wake_next` seen marking, the count invariant, the new `leases/` state directory, and the narrowed residual limits (filesystem atomicity, non-`wake_next` tool snapshots).
- **docs:** [`docs/session-wake.md`](docs/session-wake.md) and the package README document the `github.actions` source, its per-source cursor/dedupe and ETag rules, the `Actions: read` scope, the run-window limitation and the manual verification steps.
- **docs:** [`docs/session-wake.md`](docs/session-wake.md) documents restart adoption: the stored project identity, `wake_list` orphans, `wake_adopt` / `wake_resume`, exactly what is preserved, the multiple-session ownership trade-off, the deliberate absence of `autoResume`, the legacy-record limitation, the cross-identity refusal and a manual restart test.

## [0.20.1] — 2026-11-12

> **session-wake ships on the pipeline, and 0.20.0 is retired.** `@vymalo/opencode-session-wake@0.20.0` reached npm by hand, without SLSA provenance, so the publish guard correctly classifies it as foreign and refuses to skip it; npm cannot republish a version. `0.20.1` is the first version of the package this pipeline can publish — with provenance — and the whole suite moves with it. No behaviour changes for the other packages.

### Changed

- **release:** `@vymalo/opencode-session-wake@0.20.0` was hand-published (bootstrap first publish) and therefore has no provenance attestation naming this repo's `.github/workflows/publish.yml`. Run [`43222813224`](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/actions/runs/43222813224) failed its preflight on exactly that: the other thirteen packages classified as `pipeline` and would have been skipped, session-wake classified as `foreign` and the run stopped with nothing published. That is the guard working as designed — a version this workflow has not proven it can publish is never reported as "already released". npm cannot republish an existing version, so the fix is a new version line: every package moves to `0.20.1`, and `0.20.1` is the first session-wake release with pipeline provenance. (The next preflight still has to prove the package's Trusted Publisher exchange; see `CLAUDE.md` → Releasing → "Adding a new published package".) ([#161](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/161))

### Added

- **session-wake:** New published package `@vymalo/opencode-session-wake`, the first in the suite that *pushes* into a running session instead of waiting to be called. `wake_subscribe` / `wake_unsubscribe` / `wake_list` / `wake_next` are scoped to the calling session, so a watch is owned by the session that created it.
  - **Sources:** `github.thread` (comments only, the default and unchanged from its first landing), `github.timeline` (comments, reviews, review comments, review requests, opened/closed/reopened/merged, labels, assignees, milestones, commits, force-pushes) and `github.checks` (the PR head commit and its check runs, keyed by `(run id, status, conclusion)` so each transition is a distinct event). Read-only GitHub calls; there is no write verb anywhere in the package.
  - **One fetcher, many subscribers:** a watch is keyed by `(apiBase, source, owner, repo, number)`, so every session watching the same target shares one poller, one cursor, one ETag map and one `seen` ring. Delivery state (`pending`, per-subscriber `seen`, loop guard) stays per session, and `wake_next` never crosses sessions. The shared interval is the shortest any subscriber asked for, clamped to `[minIntervalMs, maxIntervalMs]`; at zero subscribers the poller stops, and the watch file is kept for 7 days so a rejoin resumes from its cursor.
  - **Per-session wake:** new events produce a short `ctx.session.synthetic({ resume: true })` notice that carries a count and a pointer only — never a comment body or summary. Content is readable solely through `wake_next`, labelled untrusted.
  - **Loop guard:** `ignoreAuthors` drops configured logins at fan-out, `markOriginated(id)` is the seam a future write path uses to suppress its own events, and a per-`(session, watch)` wake budget (`maxWakes` / `windowMs`) coalesces the notice once exhausted, holds a `cooldownMs` quiet period, and surfaces `loop_suspected` in `wake_list`. Events stay readable throughout.
  - **Durability and failure:** the cursor, per-URL ETags and a bounded `seen` ring live under the **state root** ([ADR-0022](docs/adr/0022-credentials-in-state-dir.md)), written atomically with mode `0o600`; no token is ever stored. Auth is `gh auth token` or a configured `tokenCommand`, held in memory only. `401`/`403`/`429`/network/malformed fail closed — the cursor never advances and the poll backs off, with the server's `retry-after` winning.

### Documentation

- **docs:** [`docs/session-wake.md`](docs/session-wake.md) (sources, shared fetcher and interval negotiation, state layout, per-source cursor/dedupe and ETag rules, delivery guarantees, loop guard, configuration) and the package README; the root README table and [`docs/README.md`](docs/README.md) index list the new package. The doc records the host-API limitation honestly: the `synthetic` wake is verified against a fake session API, not a live host.
- **docs:** `CONTRIBUTING.md` now states the real package counts — seventeen workspace packages, fourteen published (session-wake included) and three private — and the root `CLAUDE.md` / `AGENTS.md` version line reads `0.20.1`.

## [0.20.0] — 2026-11-10

> **Sign-in moved into the host's Connect dialog.** lightbridge no longer prints a device code to the terminal; sign in from Settings → Providers → Show more providers → search the provider name → Sign in. Existing signed-in users keep working. Shipped in [#155](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/155).

### Changed

- **lightbridge (breaking):** Sign-in is now an `oauth` Integration method registered on an integration named after `auth.id`, shown in the host's native *Connect* dialog (Settings → Providers → Show more providers → search the provider name in the Integrations dialog → Sign in) with the confirmation code and the verification URL the host opens. It is the **only** thing that starts an interactive login: `LightbridgeRuntime.getProjectToken` lost its `interactive` option and is always refresh-only; the gateway hook, the OTEL token source, the register sync (warmup and scheduled) and the new startup check never start a device flow. With no usable token the plugin logs one `lightbridge_sign_in_required` warning naming that path. The host credential is a marker/projection: `refresh` is always `""` and the refresh token never leaves lightbridge's state file. `authFlow: "authorization_code"` no longer has a sign-in surface (`lightbridge_sign_in_unsupported_flow`); use `device_code`. ([ADR-0023](docs/adr/0023-sign-in-via-integration-oauth-method.md))
- **provider-sync:** New `ProviderModelSyncEngineOptions.neverInteractive` forces warmup, the scheduler, `syncServer` and `ensureAccessToken` to be refresh-only. Default off, so oauth2 is unchanged.

- **lightbridge:** Disconnecting the integration in the host now signs lightbridge out (transition-based: a connection seen present, then gone — never a host that simply has no credential at startup). The sign-in URL is validated (`https:`, loopback `http:` only), the device code's `expires_in` is clamped to 30 minutes, the host's `refresh` forces a real refresh inside its 5-minute window, the follow-up sync/reload runs after the projection is returned, and the sign-in notice re-arms after a sign-in or disconnect and fires only for the interactive-auth-required class.

### Added

- **auth-core:** `TokenRuntime.beginDeviceSignIn(signal?)` returns the device code for display and a `complete(signal)` that polls and stores through the single `setCached` writer under the refresh lock; abort or expiry stores nothing. Underneath, `beginDeviceCodeFlow` / `DeviceCodeFlow` / `DeviceCodeAbortedError` split the RFC 8628 request from the poll, and `device-code` polling honours an `AbortSignal`.

### Fixed

- **auth-core:** The device-code stderr prompt can no longer raise an unhandled `EPIPE` under a host whose stderr is a closed pipe (`writeTerminalPrompt`, logged once at `debug`). Salvaged from the withdrawn `needs-auth-notice` work.

### Documentation

- **docs (ADR):** [ADR-0023](docs/adr/0023-sign-in-via-integration-oauth-method.md) supersedes [ADR-0020](docs/adr/0020-oauth2-integration-domain.md) and [ADR-0021](docs/adr/0021-needs-auth-via-connection-status.md). `lightbridge.md`, `troubleshooting.md` and `architecture.md` updated.

## [0.19.0] — 2026-11-09

> **⚠️ One-time re-login required after upgrading.** OAuth credentials moved from the OS **cache** directory to the durable **state** directory, and there is **no migration and no fallback read** of the old location ([ADR-0022](docs/adr/0022-credentials-in-state-dir.md)). Every user of `oauth2`, `lightbridge` and `repo-auth` signs in **once** after the upgrade. The old files left under `~/Library/Caches/opencode-oauth2` (and `opencode-lightbridge`, `opencode-repo-auth`, `opencode-auth-core`) are inert and can be deleted.

### Changed

- **auth-core, provider-sync, oauth2, lightbridge, repo-auth:** Every persisted OAuth token (the human/IdP root token shared by oauth2 and lightbridge, lightbridge's exchanged project token, repo-auth's human and project tokens, and `TokenRuntime`'s default store) is now stored under the **state root** instead of the cache root: `~/Library/Application Support` on macOS, `$XDG_STATE_HOME` (else `~/.local/state`; a relative value is ignored per the XDG spec) on Linux, `%LOCALAPPDATA%` on Windows (unchanged there). The relative path under the root is unchanged, so oauth2 and lightbridge still resolve the same file for the same `auth.id` and one login still serves both. Cause: on a real Mac the OS had purged `~/Library/Caches/opencode-oauth2`, the refresh token vanished, and every sync since refused with "interactive authentication required".
- **provider-sync:** The fused per-server record is **split**. The token is a credential file in the state root (`<id>.json`); the discovered-model list stays in the cache root (`<id>.models.json`, the suffix keeps the two apart on Windows where the roots coincide). A token rotation no longer rewrites the model list, and a purged model cache no longer costs the login. `FileCacheStore` is replaced by `ServerStateStore` / `ServerCredentialStore` / `ModelCacheStore`; `resolveStateDir` is added.
- **auth-core, provider-sync, lightbridge:** The cross-process refresh lock now lives in `locks/` **inside the credential directory**, beside the token it guards (it previously fell back to a shared directory in the cache root). `TokenRuntimeOptions.cacheDir` / `cacheNamespace` are renamed `stateDir` / `stateNamespace` (the old names are removed from the type, so TypeScript callers get a compile error, and the constructor **throws** if a JS caller still passes them rather than silently ignoring them); `resolveCacheDir` is replaced by `resolveStateDir`, and `resolveStateRoot` is added. repo-auth's `cacheDir` option and `repoAuthCacheDir` become `stateDir` / `repoAuthStateDir`; lightbridge's `lightbridgeCacheDir` becomes `lightbridgeStateDir` (new `rootStateDir`) and its `DEFAULT_CACHE_NAMESPACE` export becomes `EXCHANGE_STATE_NAMESPACE`; oauth2's `./lib` re-export `FileCacheStore` becomes `ServerStateStore` (provider-sync's `FileCacheStore` export is gone, and `ServerStateStore` has no combined write), and its `cacheDir` factory option now means only the disposable register model list, with `stateDir` for credentials. models-info keeps its cache (it holds no credential). Unchanged: atomic per-writer temp + rename ([ADR-0005](docs/adr/0005-atomic-file-writes-per-writer-temp.md)), `0o600` files / `0o700` directories, the advisory refresh lock ([ADR-0016](docs/adr/0016-provider-sync-extraction.md)).
- **auth-core, provider-sync, oauth2, lightbridge, repo-auth (tests):** The five packages' vitest configs run under a throwaway `HOME` (`scripts/vitest-isolated-home.mjs`) so no test can write to a developer's real login state.

### Fixed

- **provider-sync (credential race, critical):** `syncServer` held the token it got *before* its slow `/models` fetch and wrote it back to the shared credential file with a newer stamp. If another process (oauth2 and lightbridge share the file, ADR-0017) rotated the refresh token R1 → R2 in between, the file ended up holding R1 with the newest stamp, every process adopted it, and the next refresh replayed R1 — RFC 6819 reuse detection then revoked the whole chain (the "two processes 10 seconds apart, then nine `refresh token exchange failed (400)`" pattern in a real log). Credentials are now written **only** by `TokenRuntime` (`setCached`, under the refresh lock); the sync path persists the model record only, never deletes a credential, and keeps the in-memory stamp equal to the credential's so memory cannot run ahead of the file. The combined `saveServerState` write was removed.
- **auth-core, provider-sync, lightbridge:** A refresh token the IdP definitively rejected (HTTP 400) was stripped only from memory and replayed from the file on every call (3 POSTs measured). `TokenRuntime` now clears the stored credential under the refresh lock, as a compare-and-clear (only if the file still holds the rejected token, so a legitimate rotation by another process survives). Network errors, 5xx and 401 never clear. New `TokenRuntimeOptions.clearCached` for callers that own persistence; provider-sync and lightbridge wire it.
- **auth-core:** `LOCALAPPDATA`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` are honoured only when absolute; an empty or relative value previously produced a cwd-relative credential or cache path (Windows) or leaked into the cache root (`XDG_CACHE_HOME`). `resolveCacheRoot` / `resolveStateRoot` take an optional injectable environment.

### Removed

- **lightbridge:** ADR-0017's one-time migration of a pre-0.17 root token (`<cacheRoot>/opencode-lightbridge/lightbridge.json`) and its `migrateRootTokenIfNeeded` export. It read a credential from the cache directory, which this release declares unfit for credentials; the install it served is two layouts old.

### Documentation

- **docs (ADR):** [ADR-0022](docs/adr/0022-credentials-in-state-dir.md) records the decision, the evidence, and the alternatives rejected (marking files non-purgeable, the OS keychain, a fallback read). It amends [ADR-0017](docs/adr/0017-lightbridge-all-in-one.md).
- **docs:** Every stated credential path updated (`architecture.md` cache layout, `lightbridge.md`, `repo-auth.md`, `provider-sync.md`, `security.md`, `troubleshooting.md`, `local-development.md`, `well-known.md`, the package READMEs, and the Cache-layout and lightbridge rows in `CLAUDE.md` / `AGENTS.md`).

## [0.18.1] — 2026-11-09

### Added

- **all packages:** A manually-dispatched `.github/workflows/dist-tag.yml` (`tag` default `opencode-v1`, `version` default `0.17.0`, `dry_run` default `true`) points one npm dist-tag at one existing version on all thirteen published packages over npm Trusted Publishing (OIDC), via `scripts/release/dist-tag.mjs`: a plan phase (inputs, version exists, OIDC exchange for every package; writes nothing) and an apply phase that reports every failing package at once. It is idempotent, refuses `latest`, never publishes or changes a version, and needs npm >= 11.21 (installed as `npm@^11`). **Prerequisite, once per package on npmjs.com:** a Trusted Publisher config for `dist-tag.yml` with "Allow npm dist-tag" enabled (off by default). The tag is `opencode-v1`, not `v1`: npm rejects any dist-tag that is a valid SemVer range. ([#148](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/148))

### Fixed

- **provider-sync, auth-core:** The expected "needs an interactive login" refusal from non-interactive warmup (the OpenCode server runs `--stdio`, so there is never a TTY) was logged as `ERROR sync_failed` on every cold start and scheduler tick — 405 lines in one user's log across 0.17.0/0.18.0 — though the design is that models stay empty until a login. It now logs `sync_skipped_needs_login` at `warn`, with a pointer to `docs/troubleshooting.md` in the message; every other sync failure still logs `sync_failed` at `error`. The cause is identified structurally via a new `InteractiveAuthRequiredError` / `isInteractiveAuthRequiredError` exported from `@vymalo/opencode-auth-core/lib` (tagged `code`, robust across duplicate package copies), not by matching the message. ([#149](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/149))
- **release (publish workflow):** The publish skip path could not tell "this pipeline already published this version" from "someone published it some other way", so a hand-published version was reported as released and the package was silently skipped on every later run. `@vymalo/opencode-provider-sync` was hand-published at 0.17.0 on 2026-09-04 after run `33864587568` failed with `E404` (no Trusted Publisher existed for the new name); run `33865395921` then took the `npm view` skip, went green on the publish job, and every release until 0.18.0 skipped it again — it surfaced only when run `42573812315` first needed a genuinely new `provider-sync` version. A skip is now allowed only when the registry holds a provenance attestation built by this repo's `.github/workflows/publish.yml`; a version on npm without it fails the run. ([#147](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/147))
- **release (publish workflow):** A **preflight** now runs before anything is installed or pushed — in `dry_run` too — classifying all thirteen packages and running the npm Trusted Publishing OIDC token exchange (the call made before the `PUT`, without the `PUT`) for each one still to publish, so a missing Trusted Publisher fails the release up front with nothing published instead of partway (run `42573812315` left two of thirteen at the new version). ([#147](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/147))

### Changed

- **release (publish workflow):** The thirteen near-identical pack and publish steps (and the tarball-verify list) are now one ordered loop over a single `PUBLISH_ORDER` in `scripts/release/publish-guard.mjs`, covered by Vitest (including a drift test against the workspace's non-private packages and their dependency order). The audit gate, tarball-content verification and `--provenance` are unchanged. ([#147](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/147))

### Documentation

- **all packages:** "Staying on v1" in `docs/migration-v2.md` (and one line in the root README and the seven per-package "Migrating from v1" sections): `0.17.0` is the last v1-compatible release and stays on npm; install it by version or the `opencode-v1` tag; v1 is frozen, with no backported fixes. ([#148](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/148))
- **release:** `CLAUDE.md` / `AGENTS.md` "Releasing" now documents the new-package bootstrap (manual first publish to reserve the name → attach a Trusted Publisher on npmjs.com → release) and the preflight / skip rules.
- **release:** The `0.17.1` entry now notes that it never reached npm. ([#147](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/147))
- **docs (ADR):** [ADR-0021](docs/adr/0021-needs-auth-via-connection-status.md) records that a needed sign-in will be reported to the host with the v2 integration domain's `connection.status` (`needs_auth`, carrying a message and an optional URL) instead of only reaching the host log. It **amends** [ADR-0020](docs/adr/0020-oauth2-integration-domain.md) rather than superseding it, because that notice is an annotation on an existing connection and transfers no credential, so ADR-0020's decision to keep all five auth flows on the plugin-owned `TokenRuntime` stands. A decision record only: no implementation in this release. ([#150](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/150))

## [0.18.0] — 2026-11-09

The release that moves the whole suite onto the **OpenCode v2 plugin API** (`@opencode/plugin`, [ADR-0019](docs/adr/0019-opencode-v2-cutover.md)). In the order it landed:

1. **A dependency refresh** cleared the decks first: Batch A minors, the AI SDK pair at v7, and the dev toolchain at vitest 5 / TypeScript 7 / `@types/node` 22 (#117, #118, #119).
2. **Two lifecycle fixes** shipped alongside it, both independent of v2: the OTel exit handlers now re-raise the signal (#123, ADR-0018), and the browser `AgentClient` handshake is bounded (#126). The browser extension also stopped awaiting `chrome.*` on Firefox (#124, #129, #130).
3. **`ratelimit` was ported first** (#128) and is the reference implementation: it fixed the porting pattern (`Plugin.define` on the Effect surface, domain transforms, host-routed logging, `effect` as a peer dependency) that the other seven runtime plugins then followed (#133, #135-#139), with `core-otel` untangled from the plugin API on the way (#134).
4. **`code-index` was dropped** rather than ported (#132), and the root docs, the bundle and the audit gate were brought into line (#140-#145), ending with the upgrade guide.

> ### ⚠️ BREAKING: this release requires OpenCode v2. There is no v1 compatibility path.
>
> `0.18.0` targets `@opencode/plugin` and **does not run on OpenCode v1**. It is a hard cutover with no dual export, no compatibility mode and no flag ([ADR-0019](docs/adr/0019-opencode-v2-cutover.md)). Upgrade OpenCode and the plugins together, and rewrite your config once.
>
> **Read [`docs/migration-v2.md`](docs/migration-v2.md) before upgrading.** It is the upgrade path: the config renames (`plugin` to `plugins`, `provider` to `providers`, `options.meta.<key>` to `settings.<key>`, `pluginConfig` to the plugin's own `options`), the per-plugin opt-in keys, the required plugin order (`oauth2` first), the `effect` peer dependency, and the list of telemetry signals that stop being produced (dashboards built on them go quiet without erroring). Each package README also has a "Migrating from v1" table.
>
> Things that will bite on upgrade, in one place:
>
> - Config written for v1 is **silently ignored**, not rejected: a left-behind `options.meta.rateLimit`, `modelsInfoUrl` or `repoAuth` does nothing.
> - `effect` (`^4.0.0`) is a **peer dependency** of every runtime plugin and of `provider-sync`; it must stay external (never bundled), or plugin logs miss OpenCode's log file.
> - `oauth2` must be listed **before** `models-info`, `lightbridge` and `repo-auth` in `plugins`.
> - Log level is gated twice: the plugin's `options.logLevel` (else `OPENCODE_LOG_LEVEL`) and the host's own minimum, which defaults to `Info`.
> - `lightbridge`'s gateway now **fails the request** locally when it cannot resolve a bearer; v1 sent it without one.
> - Six OTel signals are no longer emitted (see **Removed**).
> - `core-otel`'s `./lib` surface changed; direct consumers must adapt.

### Added

- **provider-sync, oauth2, lightbridge:** [ADR-0020](docs/adr/0020-oauth2-integration-domain.md) records that none of oauth2's five auth flows becomes a `ctx.integration` method: they stay on the plugin-owned `TokenRuntime`, so the token cache layout and the ADR-0017 migration are untouched. Managed providers stay self-describing through a `settings.oauth2` marker, which is what lets `repo-auth` and `lightbridge` detect a collision without reading another plugin's options. ([#139](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/139))

- **lightbridge:** New events `lightbridge_register_build_failed` (a failed background engine build, `error`), `lightbridge_gateway_model_request_skipped` (`trace`) and `lightbridge_otel_event_stream_failed` (`warn`). `lightbridge_gateway_chat_headers_skipped` is replaced by `lightbridge_gateway_model_request_skipped`. ([#139](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/139))

- **browser:** `AgentClient.connect()` is now bounded by a handshake timeout (`connectTimeoutMs`, default 5000 ms, also accepted by `createEndpoint`). Previously, when the broker port was held by a peer that accepted the WebSocket upgrade and never sent `ready`, `connect()` stayed pending forever and `elect()` never reached `scheduleReelect()`, so the plugin never recovered. It now rejects with `connect_failed`, closes the socket and logs at `debug`; a timed-out attempt is marked closed so its late `close` event cannot null a later successful election, and the timer is `unref()`'d so a pending handshake cannot hold the process. ([#126](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/126))

- **core-otel:** `./lib` now exports the engine's own recorder input types (`recorder-input.ts`), so a consumer no longer needs the OpenCode plugin API to feed the recorder. ([#134](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/134))

- **core-otel, otel, lightbridge:** A shared `registerExitHandlers` in `@vymalo/opencode-core-otel` (exported via `./lib`) replaces the two private copies in `otel` and `lightbridge`. See **Fixed**. ([#123](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/123))

### Changed

- **ratelimit (BREAKING):** Ported to the OpenCode v2 plugin API ([ADR-0019](docs/adr/0019-opencode-v2-cutover.md)), and the **reference implementation** for the other runtime plugins. `Plugin.define` over `@opencode/plugin/effect`, with four registrations: `provider.transform` reads the per-provider opt-in, `session.hook("http.request")` is the pre-request gate, `http.response` reads the `x-ratelimit-*` headers, and `retry` returns a delay on a `429` that the **host** sleeps (cancellably), so the plugin no longer owns the retry loop. The v1 `provider.options.fetch` wrapper is deleted (v2's `Provider.Info` has no `options` or `fetch` field), and with it the request-body model parsing: v2 hands over `event.model`. The per-provider opt-in moves from `options.meta.rateLimit` to `settings.rateLimit`; plugin config moves from `pluginConfig` to the plugin's `plugins` entry. `config.ts`, `headers.ts`, the tier/gate semantics and every `ratelimit_*` event name are unchanged. ADR-0014 (no plugin writes to the terminal) stands; only its mechanism moves, to `Effect.log` with annotations over a captured host context. (The commit message says ADR-0018; the ADR was renumbered to 0019 after merge.) ([#128](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/128))

- **devtools (BREAKING):** Ported to the v2 plugin API. Tools register through `ctx.tool.transform` with the catalog's JSON Schema, one namespace per group; group gating and log level come from `ctx.options`; logging goes through `captureHostContext` + `createEffectLogger`. `effect` is a peer dependency. `./lib` no longer re-exports anything that imports `effect`, so `devtools-mcp` is untouched. ([#133](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/133))

- **core-otel (BREAKING for direct `./lib` consumers), otel, lightbridge:** The engine owns its recorder input types and imports no OpenCode plugin API (the dependency is dropped from its `package.json`). `TelemetryRecorder.onEvent` takes the engine's own `RecorderEvent`, text length is re-sourced from the v2 `session.text.ended` event, and `otel` and `lightbridge` carry the adapters that translate v2 events into it. The `compaction.autocontinue` path is removed (no v2 equivalent). Also fixes a flaky `otel` test whose 5 ms `deferredTimeoutMs` could expire before `vcs.branch.updated` was dispatched under CI load. ([#134](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/134))

- **browser (BREAKING):** Ported to the v2 plugin API. Tools register through `ctx.tool.transform` with the catalog's JSON Schema, the bridge endpoint is owned by the plugin scope and shut down when it closes (replacing `dispose` / `process.on("exit")`), and logging goes through the host Effect logger. `screenshotDir` now resolves against the plugin's `location.project.directory` instead of `ctx.worktree`. Every option, every `browser_*` tool name and argument, the wire protocol and the extension are unchanged. ([#135](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/135))

- **repo-auth (BREAKING):** Ported to the v2 plugin API. The per-provider opt-in moves from `options.meta.repoAuth` to `settings.repoAuth`, read in `provider.transform`; the project bearer is injected from the `model.request` session hook, **fail-closed** (an exchange failure injects nothing, and a stamp this plugin wrote is stripped). The config-time bearer stamp survives as an async resolve followed by a synchronous stamp onto `Provider.Info.headers.Authorization` and a `provider.reload()`; it is never stamped if the exchange fails. The `repoAuth` block's fields, the exchange wire contract, the cache location (an existing login survives) and the surviving `repo_auth_*` events are unchanged. ([#136](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/136))

- **otel (BREAKING):** Ported to the v2 plugin API. The interim v1 adapters give way to real v2 wiring: an event `Stream` subscription interrupted with the plugin scope, session/tool/permission hooks, W3C trace-context propagation through `session.hook("model.request")` (replacing the wrapped `options.fetch`), and Effect-host logging (ADR-0014). Signals with no v2 source are dropped (see **Removed**). ([#137](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/137))

- **models-info (BREAKING):** Ported to the v2 plugin API. Enrichment moves from the `config` hook to `ctx.model.transform`, with a read-only `ctx.provider.transform` observing provider headers. The catalog fetch stays async, so the transform never awaits: a catalog that lands or changes calls `ctx.model.reload()`, which means the first model list a session sees can be un-enriched. Opt-ins move from `options.meta.modelsInfo*` to flat `settings.modelsInfo*`; plugin config comes from `ctx.options`; the plugin id is `vymalo.models-info`. `mapping.ts` is re-derived against `Model.Info` (`capabilities.tools/input/output`, cost tiers with `cache.read/write`); `reasoning` and `attachment` have no v2 field and are no longer set. Upstream-wins is now placeholder-aware (provider-sync's unknown-sentinels count as absent), and the `Authorization` handoff reads `Provider.Info.headers`, with a provider-domain fallback. ([#138](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/138))

- **provider-sync (BREAKING), oauth2 (BREAKING), lightbridge (BREAKING):** The provider engine and its two consumers are ported to the v2 plugin API ([ADR-0019](docs/adr/0019-opencode-v2-cutover.md), [ADR-0020](docs/adr/0020-oauth2-integration-domain.md)). `provider-sync`'s `opencode-helpers` move onto v2's `ProviderEditor`, and discovered models now carry unknown-sentinels rather than `Model.Info.default` values (which models-info's placeholder-aware merge relies on). `oauth2` moves `chat.headers` to `session.hook("model.request")`, provider registration and model merge to `provider.transform`, servers to `ctx.options.servers` (with `cacheNamespace`, `httpTimeoutMs` and `tokenExpirySkewMs` also read from `ctx.options`), the per-provider opt-in to `settings.oauth2`, and the Responses SSE repair to `session.hook("http.response")`. `lightbridge` ports all three modules: `register` (`provider.transform` plus a queued `ProviderModelSyncEngine` build and reload, standing down when the provider already carries oauth2's marker), `gateway` (`model.request`, fail-closed by dying the request) and `otel` (event subscription and hooks through a pure v2 to core-otel adapter). The shared root-token cache, the ADR-0017 migration and the exchanged-token store are unchanged, so an existing login survives. oauth2's `./lib` surface changed too (`fromOpenCodeLogLevel` is now `resolveLogLevel`; the internal `createResponsesRepairFetch` is replaced by the exported `repairResponsesResponse`). **Behaviour changes:** invalid oauth2 config no longer rejects plugin load, the plugin logs `oauth2_config_invalid` and manages no providers (a typo shows up as a missing provider); startup no longer blocks on warmup, so providers first appear without models and are filled in by a `provider.reload()`; lightbridge's collision detection with oauth2 is order-sensitive (list oauth2 first); lightbridge's gateway now fails the request locally and logs `lightbridge_gateway_no_bearer` at `warn`; a malformed lightbridge config logs `lightbridge_config_invalid` and registers nothing. ([#139](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/139))

- **all packages:** Dev toolchain majors: `vitest` ^4.1.7 to ^5.0.1, `typescript` ^6.0.3 to ^7.0.2 (no `stableTypeOrdering` needed), `@types/node` ^25.9.1 to ^22.20.4 (matches `engines >=22`). In `devtools` crypto this also drops a `...pem` spread to fix a `generateKeyPairSync` overload regression under the older types. ([#119](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/119))

- **oauth2:** AI SDK pair bumped to v7 (`ai` ^7.0.112, `@ai-sdk/openai` ^4.0.73). The only call site is the Responses-repair e2e test; `pnpm-workspace.yaml` gains explained `minimumReleaseExclude` entries for the pair. ([#118](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/118))

- **all packages:** Routine minors across the workspace: `biome` 2.5.14 (fixes one pre-existing `noUnsafeOptionalChaining` lint error), `@opencode-ai/plugin` 1.18.32 (since removed by the v2 ports), `vite` 8.3.0, `rolldown` 1.2.9, `oxc-transform` 0.151.0, OTel 2.11.0 / 0.222.0 in lockstep, the React 19.3.0 family, `wxt` 0.21.4, plus assorted minors. `tree-sitter` was deliberately not bumped. ([#117](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/117))

- **provider-sync, lightbridge:** `upsertManagedProvider` (add the provider as `activation: "enabled"` if absent, otherwise update `package`/`name`/`settings` in place) is now exported from `@vymalo/opencode-provider-sync/lib` and is the single implementation; lightbridge's `register` module calls it instead of carrying its own copy. No behaviour change, and the shared root-token cache path is untouched. ([#141](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/141))

### Fixed

- **browser-extension:** Every awaited or promise-chained extension API call now goes through `browser` from `wxt/browser` instead of `chrome.*`. Firefox's `chrome.*` namespace is callback-only, so awaiting it resolves to `undefined`: the call fires but the result is lost and the follow-up access throws (e.g. `await chrome.tabs.create(...)` then `.id` of `undefined`), which left the extension inert on Firefox (issue #63). `chrome.*` remains only for event registration, synchronous calls, feature detection, `cdp.ts`'s callback-style debugger calls and the functions injected into pages. A new `promise-namespace-guard` test scans `src/` and fails on any awaited or promise-chained `chrome.*` call, and a Firefox-shaped simulation suite (callback-only `chrome.*` plus promise `browser.*`) covers the call sites; the rule is documented in `docs/browser.md`. ([#124](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/124))

- **browser-extension:** The Firefox simulation suite now covers every promise-namespace call site that was previously protected only by the regex guard: `GroupRegistry.activate` (`tabs.update` + `windows.update`), `CommandRouter.cookies` (`cookies.get/set/remove`), `startFeedback` (`action.setBadgeBackgroundColor/setBadgeText`) and `openSidePanelFallback` (`sidebarAction.setPanel`). Reverting any of them to `chrome.*` fails the suite, as it did for issue #63. Tests only. ([#130](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/130))

- **browser-extension:** `waitForComplete` is annotated with WXT's `Browser.tabs.Tab` instead of `chrome.tabs.Tab`. #124 (which made `browser.tabs.get()` return `Browser.tabs.Tab`) and #117 (`@types/chrome` 0.1.43 to 0.3.0, where `chrome.tabs.Tab.lastAccessed` became required) each passed their own gate but together failed `typecheck` on `main` with TS2322. Type-only; no runtime change. ([#129](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/129))

- **core-otel, otel, lightbridge:** A SIGINT/SIGTERM listener replaces the runtime's default "terminate" action, and both OTel plugins registered one whose drain only started `providers.shutdown()` and returned. With the `lightbridge` otel module active, `opencode serve` (opencode 1.18.33) therefore ignored both signals and needed SIGKILL in every measured run, while `--pure` exits in 0.06 s. Both private copies are replaced by one shared `registerExitHandlers`, which decides by who owns the signal: if nobody else listens it does a bounded shutdown (2 s), removes its listeners and re-raises the same signal, so the process ends with the normal signal status (143 / 130); if the host listens it only does a bounded `forceFlush` and leaves the listener and the process alone; a second signal mid-drain re-raises at once; sibling registrations (several plugin instances in one process, or `otel` and `lightbridge` side by side) are tagged with a shared symbol so they do not read each other as the host, and the last to finish re-raises. Measured on a real `opencode serve`: SIGTERM and SIGINT now exit in 0.06 s with rc 143 / 130, including with two instances. The TUI worker path and the host-owned branch are covered by unit tests only. Decision: [ADR-0018](docs/adr/0018-exit-handlers-reraise-the-signal.md). ([#123](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/123))

- **browser-mcp, devtools-mcp, all packages:** The release `pnpm audit --audit-level=high --prod` gate failed with 8 high + 1 critical after the v2 cutover. `@modelcontextprotocol/sdk` is now `^1.32.2` in both MCP servers (four advisories, fixed at 1.30.1 / 1.31.0 / 1.32.0 / 1.32.0, so 1.32.0 is the binding floor), and a bare `zod: ^4.6.6` override lifts the SDK's `zod` (fixed in 4.6.6). Overrides, scoped to the vulnerable range, lift the SDK's express transitives `proxy-addr` (critical, `>=2.0.8`) and `body-parser` (`>=2.4.0`), and `vite` (`>=8.3.3`) and `source-map-js` (`>=1.2.2`), which are dev-only (vite is a workspace devDependency and an optional peer of `@opencode/plugin`, not a production dependency) but which `pnpm audit --prod` reports anyway, so the release gate needs them lifted. The inert `toml` override is untouched. ([#144](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/144))

- **oauth2-bundle:** The bundled oauth2 artifact (`dist/index.mjs`) was shipping its own copy of `effect` (plus `@opencode/plugin` and `@opencode/schema`). The Rolldown externals list still named the v1 package `@opencode-ai/plugin`, so none of the v2 dependencies were external; the artifact was 807 KB instead of 125 KB, and a second `effect` copy cannot reach the host's log sink (ADR-0019, ADR-0014). `@opencode/plugin` (including `/effect`) and `effect` are now external, and `build` fails if either is ever inlined again. Docs and `pnpm-workspace.yaml` comments no longer cite `@opencode-ai/plugin`. The `toml: ^4.2.0` override is kept but is now inert: the v2 cutover removed the path it guarded (`@opencode-ai/plugin` → `effect@4.0.0-beta.83` → `toml`), so the 0.17.1 note that the advisory "cannot be designed away" no longer applies. ([#143](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/143))

### Removed

- **all packages:** `@vymalo/opencode-code-index` (the private, experimental DuckDB + tree-sitter code-indexing plugin, never published to npm) is deleted rather than ported to the v2 plugin API, together with `docs/code-index.md`, `plans/code-index.md` and its workspace entry. ADR-0002, ADR-0003 and ADR-0004 are kept and marked Withdrawn. It was never on npm, so no registry user is affected; there is no replacement and no `code_*` tools. ([#132](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/132))

- **otel, lightbridge:** The v2 event stream has no source for several signals, so the ports stop producing them: `opencode.lines_of_code.count` and `opencode.command.executed.count` (metrics), and the `opencode.file_edited`, `opencode.todo_updated`, `opencode.command_executed` and `opencode.compaction_autocontinue` logs, plus per-error `opencode.error.retryable` on terminal failures. A dashboard or alert built on one of them goes quiet **without erroring**; there is no replacement, so remove or re-point the panel. The plain `opencode.compaction` signal is still emitted. See [`docs/migration-v2.md`](docs/migration-v2.md#52-vymaloopencode-core-otel-lib-and-the-signals-it-fed). ([#137](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/137), [#134](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/134), [#139](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/139))

- **lightbridge:** `oauth2ManagedProviderIds`, `OpenCodeConfigLike` and the config-shaped `hasOAuth2Conflict` signature are removed from `./lib`; `hasOAuth2Conflict(editor, id)` replaces it. ([#139](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/139))

- **core-otel, otel:** Deleted the now-unreachable `session.diff`, `todo.updated` and `command.executed` paths from `@vymalo/opencode-core-otel`. The v2 port of `otel` already stopped feeding them; the engine still carried the recorder handlers, the `opencode.lines_of_code.count` and `opencode.command.executed.count` instruments, and the `opencode.file_edited`, `opencode.todo_updated` and `opencode.command_executed` log emitters. All gone, along with their `RecorderEvent` variants, the `FileDiff` and `TodoInfo` types, the `detectLanguage` helper (its only caller was the diff recorder) and the `diffs` key of `TelemetryRecorder.pendingStateSize()`. **Breaking for direct `./lib` consumers** of those exports; the `otel` and `lightbridge` plugins are unaffected, since neither emitted them after the v2 port. ([#140](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/140))

### Documentation

- **all packages:** `docs/migration-v2.md` is the upgrade guide for this release: the host and per-provider config renames, the per-plugin opt-in keys read out of each package's `src/`, `effect` as a peer dependency, the required plugin order and what each wrong order costs, the removals, and a symptom-keyed "if it breaks, check this first" table. The root `README.md`, `docs/README.md` and `docs/local-development.md` link to it. ([#145](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/145))

- **all packages:** The "currently `0.17.1`" version references in `CLAUDE.md`, `AGENTS.md` (kept in sync) and `packages/plugin-bundle/README.md` now say `0.18.0`, so the docs do not contradict the release they ship in. ([#146](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/146))

- **core-otel, otel:** `docs/otel.md` no longer says the engine still implements the dropped signals. ([#140](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/140))

- **all packages:** Brought the root documentation in line with the completed OpenCode v2 cutover ([ADR-0019](docs/adr/0019-opencode-v2-cutover.md), source of truth [#128](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/128)). `CLAUDE.md` / `AGENTS.md` drop the mid-migration banner, correct the package count to sixteen (three private), remove every `code-index` reference, describe each plugin by the v2 domain transforms and hooks it really registers, re-derive the models-info `Authorization` handoff on `Provider.Info.headers`, document that `oauth2` must be listed before `models-info` and `lightbridge`, and record the `effect` peer-dependency invariant and the Effect-logger convention. The remaining v1-shaped guides and config examples (`README.md`, `GETTING_STARTED.md`, `docs/architecture.md`, `docs/troubleshooting.md`, `docs/local-development.md`, `docs/github-actions.md`, `docs/kubernetes.md`, `docs/security.md`, `docs/well-known.md`, `docs/lightbridge.md`, `docs/repo-auth.md`) move to the v2 config shape (`plugins`, `providers`, `settings`). `plans/opencode-v2.md` is marked done, and `docs/adr/0019-opencode-v2-cutover.md` no longer points at the removed `code-index` package. The preamble above now says sixteen packages and drops the `code-index` tag. ([#142](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/142))

## [0.17.1] — 2026-09-18

> **Never published to npm.** No `publish.yml` run was made for 0.17.1 — every `@vymalo/*` package went from 0.17.0 straight to 0.18.0 (`npm view` lists no 0.17.1 for any of them), so its dependency pin reached consumers with 0.18.0. The entry below is kept as the record of what the version contained.

A dependency-only patch. No package's code changes in this release — it exists to carry a
transitive-dependency pin that the 0.17.0 publish gate rejected, so the suite has a version on npm
whose `pnpm audit --audit-level=high --prod` is clean.

### Fixed

- **all packages:** Pinned the `toml` override to `^4.2.0`, clearing two high-severity advisories reached through `@opencode-ai/plugin` → `effect` → `toml` across 11 paths: prototype pollution ([GHSA-v5mp-jgw5-2x6j](https://github.com/advisories/GHSA-v5mp-jgw5-2x6j), fixed in 4.1.2) and uncontrolled recursion ([GHSA-82x6-q7mm-w9cf](https://github.com/advisories/GHSA-82x6-q7mm-w9cf), fixed in 4.2.0). The tree resolved `toml` 4.1.1, below both. **The floor is the higher of the two** — `^4.1.2` would clear the first advisory, still resolve below the second, and fail the identical gate on the very next release, which is precisely how the earlier `fast-uri` `^3.1.4` pin failed. The lockfile now resolves `toml` 4.3.0. Unlike `fast-uri`'s `ajv` path, this one **cannot be designed away**: `@opencode-ai/plugin` is the plugin API every package in the suite is built on, so a future recurrence has to be chased rather than dropped — the override block says so in a comment, so the next reader inherits the reasoning instead of rediscovering it. These are newly-published advisories against a version already in the tree, unrelated to any code shipped in 0.17.0. ([#115](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/115))

## [0.17.0] — 2026-09-04

The release that makes `@vymalo/opencode-lightbridge` the all-in-one plugin, with `oauth2` and
`otel` remaining as the decoupled standalone versions. Four changes, in the order they landed:

1. **No plugin writes to the terminal any more** (ADR-0014). The ADR-0013 fix that covered
   `opencode-otel` alone now covers all nine, with one deliberate exception — the device-code login
   prompt, which is UX rather than diagnostics.
2. **OTel fails closed on the credential, not just the header** (ADR-0015). A logged-out session
   used to fire a real, unauthenticated OTLP request on every batch flush; now no network call is
   made at all while the credential is unusable.
3. **The model-sync engine is a shared package** (ADR-0016), `@vymalo/opencode-provider-sync`,
   extracted from `opencode-oauth2` with no behaviour change — **new on npm with this release**.
4. **lightbridge registers providers, discovers models, and shares one login with oauth2**
   (ADR-0017), and its RFC 8693 token exchange becomes opt-in. See the BREAKING note below.

⚠️ **Breaking**, and the reason to read before upgrading: `gateway.exchange` now defaults to
`false`, so a lightbridge gateway receives the IdP token directly instead of an exchanged
project-scoped one — set `exchange: true` to keep the old behaviour. The token cache also moves to
oauth2's location; an existing cache is migrated in place on first use, so no re-login is expected.

### Added

- **provider-sync:** A new published package, `@vymalo/opencode-provider-sync` — the provider-
  registration + OAuth-backed model-sync engine extracted verbatim (step 1 of 2) from
  `@vymalo/opencode-oauth2`: `ProviderModelSyncEngine` (renamed from `OAuth2ModelSyncPlugin`) with
  its cross-process-safe `ensureAccessToken`/`syncServer`/`getServerModels` surface built on
  `@vymalo/opencode-auth-core`'s `TokenRuntime`, `model-discovery.ts`/`model-normalization.ts`/
  `scheduler.ts` moved unchanged, a generalized `cache.ts` (`resolveCacheDir(segment, namespace)`
  now takes the on-disk segment as a parameter instead of hardcoding `"opencode-oauth2"`), and
  `opencode-helpers.ts` — the `Hooks.config` wiring (`collectManagedProviders`,
  `parsePluginConfigServers`, `parseOAuthExtension`, `mergeDiscoveredModels`,
  `propagateCachedBearer`, `resolveProviderNpm`, `applyResponsesApiOptions`, `runtimeSignature`),
  previously private to oauth2's `opencode.ts`, now public so a second consumer can compose it with
  its own config-key literals and (optional) Responses-API repair hook instead of forking it. This
  mirrors the `auth-core`/`core-otel` precedent (0.15.0): oauth2's own config-key literals
  (`"oauth2"`/`"oauth2ModelSync"`), auth-subset validation (`config.ts`'s `validateConfig`, layered
  on auth-core's `validateAuthConfig`), and the Envoy-AI-Gateway-specific Responses SSE repair
  (`createResponsesRepairFetch`) stay behind in `opencode-oauth2`, injected into the shared engine
  rather than folded into it. `opencode-oauth2` is **behaviourally unchanged** — `OAuth2ModelSyncPlugin`
  is now a thin subclass of `ProviderModelSyncEngine`, and every symbol its `lib.ts` exported before
  this extraction still exports the same name from the same subpath. See
  [ADR-0016](docs/adr/0016-provider-sync-extraction.md) and
  [`docs/provider-sync.md`](docs/provider-sync.md).
- **lightbridge:** A new `register` option block (ADR-0017) — `@vymalo/opencode-lightbridge` is now
  the all-in-one plugin: `register.baseURL` registers `auth`'s IdP as an OpenCode provider and keeps
  its models in sync via the SAME `@vymalo/opencode-provider-sync` `ProviderModelSyncEngine`
  `@vymalo/opencode-oauth2` uses — everything oauth2 does, from lightbridge. Independent of
  `gateway`/`otel`; `gateway.providers`'s existing simple header-injection behaviour is completely
  unchanged. Skips registering/owning a provider id already managed by oauth2 in the same host
  config (config-detectable, logged once at `debug`, `lightbridge_register_skipped_oauth2_conflict`).
  See [ADR-0017](docs/adr/0017-lightbridge-all-in-one.md) and
  [`docs/lightbridge.md`](docs/lightbridge.md#register--provider-registration--model-discovery-adr-0017).
- **lightbridge:** The human/IdP root token now lives in the SAME on-disk file
  `@vymalo/opencode-oauth2` writes for a server of that id
  (`<cacheRoot>/opencode-oauth2/opencode-oauth2-model-sync/<auth.id>.json`) instead of lightbridge's
  own bespoke store — configure the same `id`/`issuer`/`clientId` in both plugins and log in through
  **either one**; the other reuses the same token. A pre-upgrade install's old-format root token
  (`<cacheRoot>/opencode-lightbridge/lightbridge.json`) is adopted into the new location
  automatically, non-destructively, the first time it's needed — **no forced re-login**. The
  exchanged project-scoped token (only relevant with `gateway.exchange: true`, see below) has no
  oauth2 equivalent and is unaffected — same shape, same location as before. See
  [ADR-0017](docs/adr/0017-lightbridge-all-in-one.md).
- **provider-sync:** `ProviderModelSyncEngine.start()` now claims a process-wide, in-memory
  scheduler-ownership slot per `<cacheDir, serverId>` before running its warmup sync + starting its
  polling scheduler for a server. A second engine instance in the SAME process targeting the same
  cache file (e.g. oauth2's engine and lightbridge's `register` engine, or two of lightbridge's own
  across a config hot-reload) skips its own warmup + scheduler entirely rather than double-polling
  the upstream `/models` endpoint and racing writes to one file — logged once at `debug`
  (`sync_scheduler_ownership_skipped`), never throws, and still serves cached reads +
  on-demand `ensureAccessToken`/`syncServer` calls normally. `stop()` releases the claim. This
  protects any future third consumer of the engine, not just this pairing. See
  [ADR-0017](docs/adr/0017-lightbridge-all-in-one.md).

### Fixed

- **lightbridge, core-otel:** `opencode-lightbridge`'s OTEL export no longer ships unauthenticated OTLP requests when the shared login/exchange fails — `createRuntimeTokenSource`'s `headers()` previously caught the failure and returned `{}`, which stripped the `Authorization` header but still let the export fire, so a logged-out session hammered the collector with a rejected request on every batch flush. `TokenSource.headers()` now returns `undefined` on "no credential available," and a new fail-closed gate in `withFailureLogging` resolves the credential *before* delegating to the real exporter, skipping the network call entirely when it is absent (logged at `debug` as `otel_export_skipped_no_credential`, not `warn`). The standalone `@vymalo/opencode-otel` plugin's unauthenticated-by-design configuration (no `tokenCommand`, nothing injected) is untouched — the gate only engages when a credential source is actually configured. The check is lazy (re-run on every export attempt), so a later successful login resumes exporting on the next flush with no restart. `opencode-lightbridge`'s `otel.tokenCommand`/`tokenHeader`/`tokenPrefix` — always silently overridden by the shared runtime — now log `lightbridge_otel_token_command_ignored` once at `debug` instead of no-opping quietly. See [ADR-0015](docs/adr/0015-otel-fail-closed-credential-gate.md).

### Changed

- **lightbridge — BREAKING (ADR-0017, amends ADR-0012):** the RFC 8693 token exchange lightbridge's
  `gateway`/`otel` modules used to perform UNCONDITIONALLY is now opt-in via
  `gateway.exchange`, **defaulting to `false`**. Before: the human token was always exchanged for a
  project-scoped one before being used as the gateway bearer / OTEL export credential. Now: by
  default, the IdP access token from `auth` is used **directly** as the bearer — no exchange, no
  extra grant required. **If you relied on the exchange, set `gateway.exchange: true` explicitly on
  upgrade** to keep the exact previous behaviour (including `gateway.projectId`/top-level
  `projectId`, unchanged). Chosen as the new default because it matches our own fleet (whose IdP
  already issues a fully project-scoped token, and whose `opencode-cli` client has no
  `token-exchange` grant — the unconditional exchange failed outright with `unauthorized_client`)
  and because most IdP setups don't need a second network round trip to a token that's already
  correctly scoped. See [ADR-0017](docs/adr/0017-lightbridge-all-in-one.md).
- **lightbridge, oauth2, repo-auth, browser, code-index, devtools, models-info, ratelimit:** Each plugin's own diagnostic logging no longer mirrors `warn`/`error` records to the console — matching the fix `opencode-otel` got in 0.16.1. Every record still reaches OpenCode's own `client.app.log` stream at its true, unchanged level, so nothing is lost, it just isn't printed to the screen. Set `VYMALO_PLUGIN_CONSOLE_LOG=1` to restore the console mirror for every level, exactly as before. See [ADR-0014](docs/adr/0014-suite-wide-no-terminal-mirror.md), which supersedes [ADR-0013](docs/adr/0013-otel-no-terminal-mirror.md).
- **auth-core:** The device-code login prompt and the browser-open-failure fallback (both `process.stderr` writes — the one deliberate carve-out from the no-terminal-mirror rule, since the login URL/code is required UX, not a diagnostic) no longer hardcode a `[opencode-oauth2]` prefix. `auth-core` is shared by `lightbridge`, `oauth2` and `repo-auth`, so the prefix was misattributing the prompt whenever a different plugin drove the flow. It is now a `serviceLabel` passed through `TokenRuntime`, defaulting to the neutral `[opencode]` when unset.

## [0.16.1] — 2026-09-03

A single-purpose release: `@vymalo/opencode-otel` stops printing its own diagnostics to the terminal. The suite's only pure observer no longer interrupts a session over telemetry it cannot ask the developer to fix mid-turn.

### Changed

- **otel:** The plugin's own diagnostic logging (`otel_traces_init_failed`, `otel_export_failed`, `otel_token_command_failed`, …) no longer mirrors `warn`/`error` records to the console — a telemetry exporter must never interrupt the session it is observing with terminal output. Every record still reaches OpenCode's own log stream at its true, unchanged level, so nothing is lost, it just isn't printed to the screen. Set `VYMALO_PLUGIN_CONSOLE_LOG=1` to restore the console mirror. See [ADR-0013](docs/adr/0013-otel-no-terminal-mirror.md). ([#107](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/107))

## [0.16.0] — 2026-09-02

A single-purpose release: a rotating, single-use refresh token is now presented by at most one OpenCode process at a time. Against an IdP with RFC 6819 §5.2.2.3 reuse detection (lightbridge `authz-idp`), two OpenCode windows sharing one cache file used to log each other out.

### Fixed

- **auth-core / oauth2:** Two OpenCode processes sharing one token cache each refreshed from their own in-memory copy of the refresh token; the second one replayed an already-rotated token minutes later, the IdP's reuse detection revoked the whole chain, and **both** processes were logged out and forced through a new device-code login. `TokenRuntime.ensure()` now single-flights in-process, takes a cross-process advisory file lock (`<cacheDir>/locks/<key>.lock`, `O_EXCL`, stale-broken after `lockStaleMs`, bounded wait, degrades to unlocked with a `token_lock_unavailable` warning rather than blocking auth), re-reads the persisted token inside the lock and adopts it when still valid, and on a 4xx from the token endpoint re-reads once more and retries a single time with a newer refresh token before falling through to interactive login. The `oauth2` plugin's `getCached` re-reads its per-server state file on every call and adopts the persisted snapshot wholesale when it is at least as new as memory. Sixteen new tests, each shown failing against the previous code. ([#104](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/issues/104), [#105](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/105))
- **auth-core:** A stale lock file that exists but cannot be unlinked no longer busy-spins past the `maxWaitMs` bound; the stale-break path checks the deadline and backs off a poll interval. Found by the in-house reviewer on #105. ([#105](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/105))

### Added

- **auth-core:** `TokenRuntimeOptions.lockStaleMs` (default `30_000`), the typed `RefreshTokenError { status }` thrown by `OAuthClient.refreshToken`, and the lock surface (`acquireFileLock`, `FileLock`, `FileLockOptions`, `DEFAULT_LOCK_STALE_MS`) exported from `./lib`. `OAuthClient.isTokenValid`, `usesRefreshToken` and `refreshToken` are now public so an embedder applies the same expiry-skew rule the runtime does. New structured events: `token_refresh_joined_in_flight`, `token_refresh_adopted_persisted`, `token_refresh_retry_with_newer`, `token_refresh_retry_failed`, `token_lock_wait`, `token_lock_stale_broken`, `token_lock_unavailable`; in oauth2, `oauth2_token_adopted_from_cache`, `oauth2_cache_reread_stale`, `oauth2_cache_reread_no_persisted_token`, `oauth2_cache_reread_failed`. ([#105](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/105))

### Documentation

- **oauth2 / auth-core:** [`docs/architecture.md`](docs/architecture.md) — the token lifecycle and cache-layout sections now describe the state file as shared across processes and re-read before any refresh, with the new events in the table; both package READMEs gained a refresh-coordination section. ([#105](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/105))

## [0.15.0] — 2026-08-23

The local-development counterpart to CI's repo-as-principal attribution: a developer logs in once as themselves and every gateway request from an enrolled repo carries a short-lived, **project-scoped** bearer. This release lands two new published plugins (`repo-auth`, `lightbridge`), the two shared-core libraries they compose (`auth-core`, `core-otel`, extracted from the existing `oauth2`/`otel` plugins with no behaviour change), and the ADR that ties the credential model together.

### Added

- **auth-core:** A new published package, `@vymalo/opencode-auth-core` — the OAuth2/OIDC primitive extracted verbatim from `@vymalo/opencode-oauth2`: the five token flows, the RFC 8693 `token-exchange` `exchangeTo`, the `FileCacheStore` (per-OS cache dir, atomic-rename, `0o600`), the structured logger with secret redaction, and `validateAuthConfig`. It exists so `repo-auth` and `lightbridge` reuse the *same* token machinery as `oauth2` rather than forking it — one implementation of refresh, caching and exchange behind one `TokenRuntime` seam. ([#97](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/97))
- **repo-auth:** A new published plugin, `@vymalo/opencode-repo-auth` — repo-as-project attribution for local development. The developer authenticates once with `offline_access` (a `device_code` or PKCE `authorization_code` flow against `issuer`), and a `chat.headers` hook stamps `Authorization: Bearer <project-token>` on the opted-in providers, where the project token comes from a single RFC 8693 exchange presenting `project_id` (no `audience`, no separate mint step — the IdP resolves membership server-side and seals `{account_id, project_id}` into the JWT). **`projectId` is declared in config, never derived from the git remote** — a repo may belong to many projects; the git `origin` is resolved for logging only. **Fail-closed**: a failed exchange injects no header, so a request never runs under the wrong identity. Opts in per provider via `options.meta.repoAuth`; guards against being stacked with `oauth2` on the same provider. See [`docs/repo-auth.md`](docs/repo-auth.md) and [ADR-0011](docs/adr/0011-repo-auth-project-id-token-exchange.md). ([#98](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/98))
- **core-otel:** A new published package, `@vymalo/opencode-core-otel` — the OpenTelemetry engine (exporters, recorder, resource assembly) extracted from `@vymalo/opencode-otel`, plus a new **injected `TokenSource` seam** so an embedder can drive the collector credential from its own runtime instead of the plugin's `tokenCommand`. This is what lets `lightbridge` present the *same* project token to the collector that the gateway sees. `@vymalo/opencode-otel` now composes it and is behaviourally unchanged. ([#98](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/98))
- **lightbridge:** A new published plugin, `@vymalo/opencode-lightbridge` — the umbrella for [ADR-0012](docs/adr/0012-single-auth-across-gateway-and-otel.md): **one shared `TokenRuntime` drives both the LLM gateway bearer and the OTEL export credential**, because both validate the same `lightbridge-authz` issuer and `aud=lightbridge-api-key`. A developer logs in once and every egress that needs a project-scoped credential rides the exact same token — no second login, no second cache namespace. A thin composition layer over `auth-core` and `core-otel` (no forked engine logic); `gateway` and `otel` are each optional (omitting both is a valid, inert config). **MCP is deliberately out of scope** — OpenCode mints its own per-server MCP OAuth and `McpRemoteConfig.headers` has no per-request hook. See [`docs/lightbridge.md`](docs/lightbridge.md). ([#99](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/99))

### Changed

- **oauth2:** Auth-subset validation now delegates to `auth-core`'s `validateAuthConfig` rather than carrying its own copy — the plugin keeps its public surface and behaviour, but the validation logic has a single home shared across the suite. ([#97](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/97))
- **lightbridge:** `projectId` is **fully optional**. When it is omitted, the token exchange sends **no `project_id` form parameter**, so the backend mints a token for the caller's **default project** instead of failing — the common single-project case needs no configuration at all. An explicit top-level `projectId` still wins over `gateway.projectId` when both are set. ([#99](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/99))

### Documentation

- **lightbridge:** [ADR-0012](docs/adr/0012-single-auth-across-gateway-and-otel.md) — why a single `TokenRuntime` is shared across the gateway and OTEL egresses, where OpenCode writes each credential, why MCP is excluded (it would need a stdio credential-proxy sidecar), and the alternatives considered. ([#98](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/98), [#99](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/99))
- **all packages:** Every README refreshed for the current suite — corrected package counts, added badges/sections/workspace-table rows for `repo-auth`, `lightbridge`, `auth-core` and `core-otel`, a first-ever README for the freshly-published `@vymalo/opencode-repo-auth` (its npm page was blank), and fixed the stale `github.com/vymalo/opencode-oauth2` origin to `github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit`. ([#100](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/100))

## [0.14.1] — 2026-08-17

A single-purpose release: it exists to carry the extension's permission fix to the Chrome Web Store, which will not accept a resubmission at an already-published version number. The eight npm packages are functionally unchanged from 0.14.0.

### Fixed

- **browser-extension:** Dropped `storage` and `activeTab` from the manifest. The Chrome Web Store rejected the 0.14.0 submission under its use-of-permissions policy for requesting `storage` without using it — correctly: every byte the extension persists (settings, history, screenshots, the group registry) goes through Dexie/IndexedDB, which needs no permission, and nothing in `src/` ever touched `chrome.storage`. `activeTab` went with it in the same audit: it grants temporary host access to the active tab on a user gesture, which is strictly narrower than the `<all_urls>` host access the agent genuinely needs to drive arbitrary sites, so it was never doing anything. Nothing else in the list was speculative — `tabs`, `scripting`, `cookies`, `debugger`, `tabGroups` and `sidePanel` each have a call site, now named in a new `test/manifest.test.ts` that pins both the Chromium and Firefox permission sets so a re-addition has to be deliberate. ([#95](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/95))

## [0.14.0] — 2026-08-15

### Added

- **otel:** Repository metadata on the resource — `vcs.repository.url.full`, `vcs.repository.name`, `vcs.owner.name`, `vcs.provider.name`, `vcs.ref.head.name`, `vcs.ref.head.type` and `vcs.ref.head.revision`. Read **straight off disk** (`.git/config`, `HEAD`, `refs`, `packed-refs`) rather than by invoking `git`: the plugin runs in the host process at every session start, a subprocess costs more there than the data is worth, and the files are readable whether or not `git` is on `PATH`. A linked worktree — where `.git` is a *file* containing `gitdir:` — is handled, which is how this project is itself developed. **Credentials in the remote are always stripped**: the whole userinfo component goes, along with any query or fragment, because `https://user:ghp_xxx@host/org/repo.git` is an ordinary CI remote and that token would otherwise ride on every span, metric and log. scp-like SSH remotes become `ssh://host/org/repo` rather than being rewritten to `https://`, since the transport is a fact about the checkout. Disable with `collectVcs: false` / `OPENCODE_OTEL_COLLECT_VCS=0`. See [`docs/otel.md`](docs/otel.md#repository-metadata).
- **otel:** OTLP export failures now reach the host log stream as `otel_export_failed` — with the signal, the HTTP status where the backend supplies one, the error message and a `consecutiveFailures` count — and recovery is reported once as `otel_export_recovered`. Previously a rejected export (an expired credential, a wrong audience, an unreachable collector) was reported only through the OTel SDK's own `diag` channel, which nothing subscribed to: telemetry stopped silently while the session looked healthy. Implemented by decorating this plugin's own exporters rather than calling `diag.setLogger`, which is process-global and would hijack the channel for the host and every other plugin.
- **otel:** A new `tokenCommand` option (env `OPENCODE_OTEL_TOKEN_COMMAND`) for collectors behind a short-lived credential — an executable that prints a fresh access token on stdout, re-run before the current one expires. Needed because a static `Authorization` header is read once at plugin load and never refreshed, so a five-minute OIDC token goes stale and every subsequent export fails. Expiry comes from the token's own `exp` claim where it is a JWT (base64-decoded, deliberately **not** signature-verified — the plugin is not authenticating anything, it only needs to know when to ask again), minus a 30-second margin; `tokenRefreshMs` applies otherwise. Concurrent exports share one helper invocation. The token is never logged, and a failure logs the *length* of the helper's stderr rather than its contents. See [`docs/otel.md`](docs/otel.md#short-lived-credentials).
- **otel:** Failure handling for the credential helper is deliberately asymmetric: a helper that fails while the cached token is still valid changes nothing, since that token is current rather than stale, but one that fails with no valid token left produces **no auth header at all** — so the export fails closed at the collector instead of retrying forever with a dead credential. A rejected export also drops the cached token, so the next attempt re-runs the helper rather than replaying something already refused.

### Changed

- **otel:** The branch now reaches the resource as `vcs.ref.head.name`, the current OpenTelemetry semantic convention; `vcs.repository.ref.name` was deprecated in semconv 1.43. Both are emitted for now — the deprecated name is what `opencode-otel-plugin` sends and what existing dashboards key on, so dropping it outright would split the two plugins' data. It is due for removal once those dashboards move. The branch is also now read from `HEAD` at startup rather than waiting for the `vcs.branch.updated` event, so it is present on the very first export instead of racing the deferred-attribute window; the event remains as a fallback.
- **all plugins:** `build` now emits with [oxc](https://oxc.rs) instead of `tsc`, cutting the workspace build from ~2.4s to ~0.95s and a single package from ~0.90s to ~0.30s. The saving is not from a faster transpiler — it is from **not type-checking during the build at all**. `tsc -p tsconfig.json` type-checked *and* emitted, while `typecheck` (`tsc --noEmit`) already ran the identical check separately, so every build paid for the same pass twice. `isolatedDeclarations: true` is what makes this sound: it forces every export to carry a type readable from a single file, so oxc can emit `.d.ts` without a checker, and `tsc --noEmit` rejects anything that would break that. Enabling it across ~16,000 lines needed **8 annotations**, seven of them the same `export const XxxPlugin: Plugin = …`. Published artefacts are unchanged — the same 303 files, same nesting, source maps with the same fields and the same relative `sources`. A `swc + tsc --emitDeclarationOnly` prototype was measured *slower* than plain `tsc` (2.77s vs 2.43s) and rejected; it is parked at `chore/build-with-swc`. **`pnpm build` no longer reports type errors** — run `pnpm typecheck`. See [ADR-0010](docs/adr/0010-oxc-build-isolated-declarations.md).

### Fixed

- **all plugins:** Raised the `pnpm-workspace.yaml` audit overrides to clear four high-severity advisories that were failing `publish.yml`'s `pnpm audit --audit-level=high` gate and blocking the 0.13.0 release. `fast-uri` was already pinned to `^3.1.4` for two earlier host-confusion advisories, but a third ([GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7), backslash authority introducer) has a floor of 3.1.5 — the old pin satisfied the advisories it was written for and silently resolved below the new one. Also pinned `ip-address` ≥10.3.1 ([GHSA-mwp4-54f8-5fhr](https://github.com/advisories/GHSA-mwp4-54f8-5fhr), SSRF via leading-zero octets; transitive through `@modelcontextprotocol/sdk` → `express-rate-limit`), and `postcss` ≥8.5.18 / `nanoid` ≥3.3.18 from the vite + WXT toolchain — devDependencies only, but the gate does not distinguish. Each override now carries its advisory ids so a future reader can tell whether the entry is still earning its place. `vite` moved 8.0.14 → 8.2.1 within its existing `^8` range.

### Documentation

- **otel:** An integration test that drives a **real** `OTLPTraceExporter` against a local HTTP server, proving the async `headers` factory the credential helper depends on is actually awaited and its `Authorization` header reaches the wire — including that the factory is re-invoked per export rather than cached, which is what makes refresh work at all. The rest of the suite substitutes the exporter, so the SDK's own header consumption was previously unverified: the whole feature rode on a contract nothing exercised.
- **otel:** A backend recipe for an OIDC-protected collector (the OpenTelemetry Collector's `oidc` extension), covering the static-header and credential-helper cases and how to verify auth with `curl` before wiring the plugin in. Notes that such collectors commonly expose HTTP only, which matches this plugin's transport — worth checking before assuming a gRPC endpoint exists, particularly behind an ingress that would need explicit h2c configuration to carry gRPC.

## [0.13.0] — 2026-08-14

### Added

- **otel:** A new published plugin, `@vymalo/opencode-otel` — OpenTelemetry export of developer interactions as OTLP **traces, metrics and logs**, the OpenCode counterpart to [Claude Code's monitoring](https://code.claude.com/docs/en/monitoring-usage) and [Codex's `[otel]` block](https://learn.chatgpt.com/docs/config-file/config-advanced). Exports **real USD cost** straight from the host's `AssistantMessage.cost` (no price table to maintain), **all five token types** including `cache_read` / `cache_write` / `reasoning` (on a cached agentic session cache-read is routinely the majority of tokens, so an input+output-only dashboard measures a different quantity), tool results with durations and outcomes, permission decisions, API errors with status codes and retry attempts, lines of code by language, active time, and compactions. Configurable from **`opencode.json` or standard `OTEL_*` environment variables** — environment overrides options, so a `.well-known/opencode` document can ship an org-wide default that a developer can still redirect at a local collector. Completely inert until an endpoint or explicit exporter is configured. See [`docs/otel.md`](docs/otel.md) and [`plans/otel.md`](plans/otel.md).
- **otel:** Full coverage of the host's observation surface — **9 of 19 plugin hooks** and **16 of 32 SDK event types**, up from 5 and 11. New hooks: `chat.params` (sampling parameters, and a `chat` span that now opens *before* the provider request, which is what makes trace-context propagation work for the first request of a turn), `permission.ask`, `experimental.text.complete` (assistant response size), `experimental.compaction.autocontinue` (whether context overflow forced the compaction). New events: `installation.updated`, `vcs.branch.updated`, `todo.updated`, `session.deleted`, `server.instance.disposed` (a host-driven drain, more reliable than waiting for a process signal). Everything still excluded is listed with its reason in [`docs/otel.md`](docs/otel.md#what-is-deliberately-not-collected) — including `lsp.client.diagnostics`, whose payload carries no severity or counts to aggregate.
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

- **otel:** The branch now reaches the resource as `vcs.ref.head.name`, the current OpenTelemetry semantic convention; `vcs.repository.ref.name` was deprecated in semconv 1.43. Both are emitted for now — the deprecated name is what `opencode-otel-plugin` sends and what existing dashboards key on, so dropping it outright would split the two plugins' data. It is due for removal once those dashboards move. The branch is also now read from `HEAD` at startup rather than waiting for the `vcs.branch.updated` event, so it is present on the very first export instead of racing the deferred-attribute window; the event remains as a fallback.


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
