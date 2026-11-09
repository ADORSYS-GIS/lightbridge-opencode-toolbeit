# ADR-0022 — credentials live in the durable state directory, not the OS cache directory

- **Status:** Accepted
- **Date:** 2026-11-09
- **Applies to:** `@vymalo/opencode-auth-core`, `@vymalo/opencode-provider-sync`,
  `@vymalo/opencode-oauth2`, `@vymalo/opencode-lightbridge`, `@vymalo/opencode-repo-auth`.
  **Amends [ADR-0017](0017-lightbridge-all-in-one.md)**: the shared root-token file keeps its
  relative path but moves to a different root, and ADR-0017's old-format migration is removed. It
  also touches [ADR-0005](0005-atomic-file-writes-per-writer-temp.md) and
  [ADR-0016](0016-provider-sync-extraction.md), whose invariants are all **kept**.

## Context

Every persisted OAuth token — a long-lived refresh token among them — was written under the
platform **cache** directory: `~/Library/Caches` on macOS, `XDG_CACHE_HOME` on Linux, `LOCALAPPDATA`
on Windows. The human/IdP root token sat at
`<cacheRoot>/opencode-oauth2/opencode-oauth2-model-sync/<auth.id>.json` (ADR-0017), fused into the
same JSON record as the discovered-model list.

macOS, Linux and cleanup tools treat a cache directory as disposable. On one user's Mac, observed
on 2026-11-09:

- the Data volume was 93% full;
- 18 `~/Library/Caches` subdirectories had been recreated that day, `opencode-oauth2` among them,
  which came back **empty** at 08:58;
- the log showed the refresh token had vanished and every sync since had refused with
  "interactive authentication required" (the expected non-interactive refusal of
  [#149](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/149)); the last
  successful login was 2026-09-02.

Every login the user completes is lost at the next purge. The cache is a correct home for the
model list — it is rebuilt by the next sync — and a wrong home for the one thing that cannot be
rebuilt without the user at a keyboard.

### The two records were one file

`CachedServerState` (provider-sync) carried `models`, `rawModels`, `lastSyncAt` **and** `token` in
one JSON file, written whole by oauth2's engine, by lightbridge's `register` engine and by
lightbridge's read/refresh-only root runtime. Moving that file to the state directory would put a
disposable, possibly large model list in a durable place; leaving it would keep the credential in
the purgeable one. It had to be split.

### Where the refresh lock lived

`TokenRuntime` takes its advisory refresh lock at `<cacheStore.directory>/locks/<identity>.lock`
(ADR-0016). The provider-sync engine and lightbridge's root runtime both supplied
`getCached`/`setCached` overrides and **no** directory, so the lock fell back to
`<cacheRoot>/opencode-auth-core/tokens/locks/` — in the cache root, shared across unrelated
servers, and not beside the token it guards. A purge would have removed the lock too, but the lock
being far from the credential also meant that two plugins sharing a credential file did not
necessarily share the lock directory their own configuration implied.

## Decision

### 1. A state root, next to the cache root

`@vymalo/opencode-auth-core` gains `resolveStateRoot()`:

| Platform | State root |
| --- | --- |
| macOS | `~/Library/Application Support` |
| Linux | `$XDG_STATE_HOME`, else `~/.local/state` — a **relative** `XDG_STATE_HOME` is ignored (the XDG Base Directory spec makes only absolute paths valid), as is an empty one |
| Windows | `%LOCALAPPDATA%` — the same directory as the cache root, which Windows does not auto-purge, so the effective location is unchanged |

`resolveCacheRoot()` keeps serving data that may be lost. For both roots, an env override (`XDG_STATE_HOME`, `XDG_CACHE_HOME`, `LOCALAPPDATA`) counts only when it is an absolute path on the target platform; an empty or relative value would resolve against the cwd and scatter per-directory credentials, so it falls back to the home-based default. (This also newly applies to `XDG_CACHE_HOME` and `LOCALAPPDATA` in the cache root; models-info keeps its own, unchanged cache resolver.)

### 2. Credentials move; caches stay

"Credential" means every persisted `access` / `refresh` token. All of them move to the state root,
at the same relative path they had under the cache root:

| Store | Before (cache root) | After (state root) |
| --- | --- | --- |
| Shared root token — oauth2 and lightbridge | `opencode-oauth2/opencode-oauth2-model-sync/<id>.json` | same relative path |
| Lightbridge exchanged project token | `opencode-lightbridge/lightbridge-<hash>.json` | same relative path |
| repo-auth human root + project tokens | `opencode-repo-auth/human*.json` | same relative path |
| `TokenRuntime` default store (exchanged tokens when no directory is given) | `opencode-auth-core/tokens/` | same relative path |
| Refresh lock files | `opencode-auth-core/tokens/locks/` (shared, in the cache root) | `locks/` **inside each credential directory** |

Not moved, because they are disposable: the discovered-model list, and the models-info catalog
cache (`opencode-models-info`, which stores no credential).

### 3. The fused record is split

provider-sync persists a server's state as two records, merged back into the unchanged in-memory
`CachedServerState`:

- **credential** — `{ serverId, updatedAt, token }` in the state root, as `<id>.json`
  (`ServerCredentialStore`);
- **models** — `{ serverId, updatedAt, lastSyncAt, models, rawModels }` in the cache root, as
  `<id>.models.json` (`ModelCacheStore`). The `.models` suffix is deliberate: on Windows the two
  roots are the same directory, and the model record must never overwrite or be read as the
  credential.

Consequences of the split inside the engine: a token rotation writes **only** the credential (it no
longer rewrites the model list); a sync writes **only** the model record (see "One writer per record" below); a purged model cache costs one
network round trip and leaves the login intact; and lightbridge's root runtime — which also
persisted `models: []` on a token write, a latent way to clobber oauth2's discovered models — now
touches only the credential file. Cross-process adoption (ADR-0016) compares the credential's
`updatedAt` and, when it adopts, re-reads the model record so the in-memory snapshot still moves as
one.

### 3a. One writer per record

The credential is written **only** by `TokenRuntime` (`setCached`, under the refresh lock); the
model record is written only by the sync path. There is no combined write — `saveServerState` was
removed. Writing the credential from the sync path was a bug found in review of #152: `syncServer`
held the token from before a slow `/models` fetch, so if another process (oauth2 and lightbridge
share the file) rotated R1 → R2 meanwhile, the sync wrote R1 back with a *newer* stamp, every
process adopted it, and the next refresh replayed R1 — RFC 6819 reuse detection then revokes the
whole chain. (An earlier draft of this ADR called "credential written first" a safety property; it
was the bug.) Two corollaries: the in-memory `updatedAt` is the *credential's* stamp and a model sync
does not advance it, so memory is never left ahead of a token another process rotated; and a
model-path call can never delete a credential.

### 3b. A rejected refresh token is cleared

When the IdP answers a refresh with a definitive 400 (`invalid_grant`), `TokenRuntime` removes the
stored credential — under the refresh lock, and as a **compare-and-clear**: only if the store still
holds the rejected refresh token (another process may have rotated it legitimately; a blind delete
would log that process out). Network errors, 5xx and 401 never clear. Before, the dead token was
stripped only from memory and replayed from the file on every call.

### 4. The lock sits beside the credential

The engine and lightbridge's root runtime pass the credential directory to `TokenRuntime` as
`stateDir`, so the lock is `<credentialDir>/locks/<id>.lock`. oauth2 and lightbridge resolve the
same credential directory for the same `auth.id`, so they take the same lock.
`TokenRuntimeOptions.cacheDir` / `cacheNamespace` are renamed `stateDir` / `stateNamespace`, and
the factory options of repo-auth (`cacheDir` → `stateDir`), oauth2 and lightbridge (new `stateDir`)
say which root they mean.

### 5. Invariants kept exactly

Atomic per-writer temp file + rename (ADR-0005), files `0o600`, directories `0o700`, the advisory
cross-process refresh lock and its stale-break rule (ADR-0016), single-use refresh-token adoption,
and the shared-file contract between oauth2 and lightbridge (ADR-0017: same relative path, now under
the state root, so one login still serves both).

### 6. Hard cutover

There is **no migration and no fallback read** of the old cache location. Each user logs in **once**
after upgrading; the abandoned files in the cache directory are inert and can be deleted. A fallback
would keep a credential reading path alive in the one location we have just declared unfit for
credentials, and would have to be maintained until every install had moved.

The one pre-existing migration — ADR-0017's adoption of lightbridge's pre-0.17 root token from
`<cacheRoot>/opencode-lightbridge/lightbridge.json` — read from exactly that location. It is
**deleted** (`migration.ts`, its export `migrateRootTokenIfNeeded`, and its test), not repointed: its
source file format predates two releases of the cache layout and is, by construction, a cache-dir
credential.

## Consequences

- **One forced re-login on upgrade**, for every user of oauth2, lightbridge and repo-auth. Stated
  prominently in the CHANGELOG. A user whose cache was already purged loses nothing further.
- A refresh token now survives a cache purge, a "free up space" sweep and a reboot. It is also now
  backed up by tools that back up `~/Library/Application Support` (Time Machine) or
  `~/.local/state` — within the same trust boundary as the `0o600` file, but a change worth knowing.
- On Windows nothing moves; the old fused `<id>.json` there is read as a credential record (its
  `token` field is the same shape) and is rewritten without models on the next token write.
- `ServerStateStore`, `ServerCredentialStore`, `ModelCacheStore`, `resolveStateDir` and
  `resolveStateRoot` replace provider-sync's and oauth2's exported `FileCacheStore` / auth-core's
  `resolveCacheDir`. The packages publish on one version line, so a mixed install is not supported.
- A model list is no longer adopted wholesale from another process on every token re-read; it is
  re-read only when a newer or rotated credential is adopted.
- All five credential-bearing packages' vitest configs run under a throwaway `HOME`
  (`scripts/vitest-isolated-home.mjs`), so a test that forgets to inject a directory cannot write to
  a developer's real login state — the failure mode this ADR would otherwise have introduced.

## Alternatives considered

- **Keep the cache root, mark the files "do not purge".** macOS gives a cache directory no such
  contract (`com.apple.metadata:com_apple_backup_excludeItem` marks backups, not purges), and
  cleanup tools do not read per-file flags. Rejected.
- **`~/Library/Preferences`, or the data directory OpenCode itself uses.** The first is for
  `NSUserDefaults` plists. The second is the host's, and ADR-0020 settled that the plugin — not the
  host — owns credential custody; sharing its directory would blur that.
- **The OS keychain.** The right long-term home for a refresh token, but a different dependency
  (a native module or shelling out per platform), no headless-Linux story, and a larger change than
  the bug warrants. Not rejected on merit — this ADR does not preclude it.
- **A migration or fallback read of the old cache path.** Would spare one login. Rejected: the repo's
  standing rule is hard cutovers, and a fallback keeps a credential reader on the location this ADR
  declares unfit.
- **Leave the fused record and move the whole file.** Puts the disposable model list in the durable
  directory and keeps three writers racing on one file for two purposes. Rejected in favour of the
  split.
- **Split by directory only, same filename in both roots.** Collides on Windows, where the roots are
  one directory; the `.models` suffix is the cheaper fix than a per-platform special case.
- **Honour a relative `XDG_STATE_HOME` against the cwd.** Spec-invalid and scatters per-directory
  credentials; browser's bridge-token resolver already ignores it for the same reason.
