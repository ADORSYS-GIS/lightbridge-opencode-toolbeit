# @vymalo/opencode-session-wake

Watch a GitHub issue/PR **or a repository's Actions workflow runs** and wake the session that
subscribed to it when something changes — no webhook, no relay, no GitHub writes.

```jsonc
{
  "plugins": [
    {
      "package": "@vymalo/opencode-session-wake",
      "options": {
        "intervalMs": 60000,
        "ignoreAuthors": ["github-actions[bot]"],
        "loop": { "maxWakes": 5, "windowMs": 60000, "cooldownMs": 300000 }
      }
    }
  ]
}
```

Tools: `wake_subscribe`, `wake_unsubscribe`, `wake_list`, `wake_adopt`, `wake_resume`,
`wake_next`.

Sources (`wake_subscribe.source`):

| Source | Watches |
| --- | --- |
| `github.thread` (default) | Issue/PR comments only |
| `github.timeline` | The whole timeline: comments, reviews, review comments, review requests, opened/closed/merged, labels, assignees, commits, force-pushes |
| `github.checks` | The PR's head commit and check runs (status, conclusion, URL) |
| `github.actions` | Workflow runs: new run, status/conclusion transitions and reruns (run-level only; jobs are out of scope). Takes `owner`/`repo` plus optional `workflow` and `branch`, no `number` |

- **One fetcher, many subscribers.** A watch is keyed by `(apiBase, source, owner, repo, number)` for
  the thread sources, and by `(apiBase, "github.actions", owner, repo, workflow?, branch?)` for
  workflow runs; every session watching that target shares one poller, one cursor and one ETag map.
  Delivery state (`pending`, `seen`, loop guard) stays per session, and `wake_next` never crosses
  sessions.
- **One poller per watch, even across processes.** A lease file per watch key (`owner` + expiry)
  is claimed with an atomic exclusive create and renewed on every poll; only the holder fetches or
  wakes. A second process over the same state root skips the whole poll and makes no HTTP request.
  The lease is released by a graceful `stop()` and expires after a bounded TTL (two negotiated
  intervals plus margin, clamped to 60 s–2 h) so a crashed owner cannot wedge the watch.
- **Dedupe is durable and counted honestly.** A poll appends its fresh events to `pending` in one
  `updateState` write (merged with the on-disk queue, so a concurrent drain is not resurrected) and
  persists the shared `seen` ring before the notice. `wake_next` marks drained ids in that ring, and
  a drained id is kept past the `seenLimit` trim rather than evicted before the next poll. The
  notice `count` is read back from the persisted queue, so it matches what `wake_next` can return.
- The cursor, per-URL ETags and a bounded `seen` ring are durable under the **state root**; the
  fetcher stops when the last subscriber leaves and its state ages out after 7 days.
- **Restart-safe ownership.** Every new subscription records the **plugin instance's** project
  identity (`ctx.location`, not the calling session's). After a restart,
  `wake_list {"includeOrphans":true}` shows watches left behind by another session with the same
  instance identity, and `wake_adopt` (one id or `all: true`) / `wake_resume` (all) moves ownership
  to the calling session. Unread events, cursor, ETags, `seen`, loop state and the shared fetcher are
  preserved; a different instance identity answers "not found for this session". Adoption moves ownership —
  the old session loses the watch — and there is no automatic startup adoption (`autoResume`),
  because startup has no calling session. This is instance-scoped, not per-session isolation.
- New events produce a short **untrusted** notice via `ctx.session.synthetic({ resume: true })`.
  Bodies and summaries are only readable through `wake_next`, never injected.
- **Loop prevention:** `ignoreAuthors` drops configured logins at fan-out, `markOriginated(id)` is the
  seam a future write path uses to suppress its own events, and a per-`(session, watch)` wake-rate
  guard coalesces the notice (events stay readable) and surfaces `loop_suspected` in `wake_list`.
- Auth comes from `gh auth token` or a configured `tokenCommand`; the token is never written to disk.
- `401`/`403`/`404`/`429`/network/malformed, a timeline backlog deeper than `maxPages`, or an actions
  run window pushed deeper than `maxPages` fail closed: the cursor does not move and the next
  successful poll resumes without loss.

Full reference — registry semantics, interval negotiation, state layout, per-source cursor/ETag
rules, delivery guarantees, loop prevention, security model, scopes, limitations and the two-session
manual test: [`docs/session-wake.md`](../../docs/session-wake.md).

> A live single-session wake is confirmed. Multi-session, cross-poller dedupe and loop-guard
> behaviour are covered by tests but still pending live verification; the exact steps are in the doc.
> The lease is a single-writer guard on a local state root, **not** global exactly-once on a
> filesystem that does not honour atomic exclusive create/rename.
