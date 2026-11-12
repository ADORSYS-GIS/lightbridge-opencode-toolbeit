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

Tools: `wake_subscribe`, `wake_unsubscribe`, `wake_list`, `wake_next`.

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
- The cursor, per-URL ETags and a bounded `seen` ring are durable under the **state root**; the
  fetcher stops when the last subscriber leaves and its state ages out after 7 days.
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

> A live single-session wake is confirmed. Multi-session and loop-guard behaviour are still pending
> live verification; the exact steps are in the doc. Cross-process leader election is Phase 3.
