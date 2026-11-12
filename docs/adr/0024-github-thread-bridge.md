# ADR-0024 — GitHub thread bridge: a shared event log, a cursor per session, tool-first delivery

- **Status:** Proposed
- **Date:** 2026-11-11
- **Applies to:** `@vymalo/opencode-github-notify` (new). Follows the storage rules of
  [ADR-0022](0022-credentials-in-state-dir.md) and the atomic-write rule of
  [ADR-0005](0005-atomic-file-writes-per-writer-temp.md); logs per
  [ADR-0019](0019-opencode-v2-cutover.md).
- **Source:** [#158](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/issues/158)

## Context

Several agents share one GitHub account and subscribe to one working-plan issue. GitHub sends the
*human* a notification; nothing reaches an agent that is already running. In the reported session
four minutes of decisions were missed until the agent was told to re-read the thread. The fix must
be read-only, need no public webhook, survive restarts without losing or repeating comments, and
must not let a comment become an instruction.

Four questions closed off real alternatives.

### 1. Who consumes an event — the process, or the session?

The obvious design is one queue per watch, consumed by whoever calls the tool. That re-creates
the bug it is meant to fix: with several agents on one account and one host, the first agent to
call the tool takes the comment away from every other. So **events are not consumed; positions
are.** Each watch has one append-only event log; each session has its own cursor into it. Every
session sees every event once.

A session meeting a watch for the first time starts after the events observed *before the session
began* (`ctx.session.get` → `time.created`; "now" if unknown) — so comments that arrive between
session start and its first tool call are delivered, and old history is not dumped into a new
session.

### 2. How is "changed since last poll" detected?

- `?since=` on the comments endpoint returns new and edited comments but **cannot express a
  deletion**, and its result depends on a clock the plugin does not own.
- The REST notifications API reports *threads*, not comments, and marking them read would mutate
  the human's inbox, which the ticket keeps as the source of record.
- **Chosen:** list the thread's comments in full, every page conditionally (`If-None-Match` with
  the stored per-page ETag), and diff against a stored snapshot (`id → updatedAt`). A 304 does not
  count against the primary rate limit, so an idle thread costs `pages` free requests per poll. The
  diff yields created / edited / deleted precisely. Deletions are reported only from a *complete*
  listing; a listing truncated by `maxPages` never claims one.

The first successful listing is a **baseline**: existing comments are recorded, not delivered.

### 3. What makes delivery exactly-once?

- **Recording.** One poll = read state → fetch → diff → write events + snapshot + seq in **one
  atomic rename**, under a strict cross-process lock. A crash before the rename leaves the old
  snapshot, so the next poll re-detects the same change; a crash after it has recorded it. Event
  ids are `(comment, kind, updatedAt)` and are deduped against the retained log as a second guard.
  On any GitHub failure (401/403/404/429/5xx/network/malformed) the snapshot and log are untouched;
  only the failure status and backoff deadline are written.
- **The lock is strict, unlike auth-core's advisory lock.** If it cannot be taken, the poll is
  skipped (another process is doing it) and the tool asks the model to retry. Skipping loses
  nothing; proceeding unlocked could deliver twice.
- **Delivery.** `next` advances the session cursor under that session's lock and commits **before**
  returning. A turn lost after that commit is recovered with the read-only `recent` tool, not by
  re-delivering — the alternative (ack after the model "has" it) has no host seam to hang the ack on.
- **Retention.** The log keeps `maxLogEvents`; a cursor behind an eviction is reported as an
  explicit gap ("N events were evicted before this session read them"), never skipped silently.

### 4. How does a running session find out?

The spike the ticket asked for: v2 exposes `ctx.session.synthetic({ sessionID, text, delivery,
resume })`, which admits a message into a session's inbox (`queue` = read on the next turn;
`resume: true` also wakes an idle session). That is the push seam.

**Comment text never travels through it.** The notice is fixed text plus counts ("2 new, 1 edited on
owner/repo#7; call `github_messages_next`"). Comment bodies reach the model only as a tool result,
fenced in `<untrusted-github-comment>` with any attempt to close or forge the fence escaped, under a
preamble that labels them as data. A malicious comment therefore cannot become a session message
by itself; at worst the model reads it in a tool result labelled as untrusted.

Notices go only to sessions that have called one of the tools in this process — not to every
session the host creates (that would wake unrelated sessions and subagents). `notify` is
`queue` by default; `wake` is opt-in because resuming an idle session spends tokens on every
comment; `off` leaves only the tool.

The `experimental.idle` session hook was considered and not used: it only fires as a session is
about to go idle, so it cannot reach a session that is already idle — which is the reported case.

## Decision

Ship `@vymalo/opencode-github-notify` with the design above: per-watch event log + per-session
cursors under `<stateRoot>/opencode-github-notify/` (never the cache root), conditional full-listing
diff, strict locks, tool-first delivery (`github_messages_{next,recent,status}`), and fixed-text
`synthetic` notices. Read-only: the package issues GET requests only. The token comes from
`gh auth token` (default), a user command, or an env var, is held in memory, and is never logged
or written.

## Consequences

- One GitHub listing per watch per interval, shared by every process on the host (the lock + the
  persisted `nextPollAt`), not per agent.
- Issue *comments* only — which includes a pull request's conversation tab. PR review comments and
  review summaries are a follow-up (another listing source feeding the same log).
- `synthetic` and `experimental.*` are young v2 surfaces; the plugin degrades to tool-only if a
  notice is refused (the session is dropped from the notice set, its cursor untouched).
- A deleted comment carries no body (the plugin keeps no copy of bodies outside the log).
- Cursor files are per session and are not garbage-collected yet.
