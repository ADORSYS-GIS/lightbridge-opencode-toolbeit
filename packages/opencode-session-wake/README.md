# @vymalo/opencode-session-wake

Watch a GitHub issue/PR and **wake the session that subscribed to it** when something changes — no
webhook, no relay, no GitHub writes.

```jsonc
{
  "plugins": [
    { "package": "@vymalo/opencode-session-wake", "options": { "intervalMs": 60000 } }
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

- A watch is owned by the session whose tool call created it; other sessions cannot see it.
- The cursor, per-URL ETags and a bounded `seen` ring are durable under the **state root**, deduped
  by a source-specific stable id, so restarts and overlapping polls deliver each event once.
- New events produce a short **untrusted** notice via `ctx.session.synthetic({ resume: true })`.
  Bodies and summaries are only readable through `wake_next`, never injected.
- Auth comes from `gh auth token` or a configured `tokenCommand`; the token is never written to disk.
- `401`/`403`/`404`/`429`/network/malformed and a timeline backlog deeper than `maxPages` fail
  closed: the cursor does not move and the next successful poll resumes without loss.

Full reference — source semantics, state layout, per-source cursor/ETag rules, delivery guarantees,
security model, scopes, limitations and the two-session manual test:
[`docs/session-wake.md`](../../docs/session-wake.md).

> A live single-session wake is confirmed. Multi-session live testing is still required; the exact
> steps are in the doc.
