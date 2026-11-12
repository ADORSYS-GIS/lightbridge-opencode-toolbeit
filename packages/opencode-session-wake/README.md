# @vymalo/opencode-session-wake

Watch a GitHub issue/PR thread and **wake the session that subscribed to it** when a comment
arrives — no webhook, no relay, no GitHub writes.

```jsonc
{
  "plugins": [
    { "package": "@vymalo/opencode-session-wake", "options": { "intervalMs": 60000 } }
  ]
}
```

Tools: `wake_subscribe`, `wake_unsubscribe`, `wake_list`, `wake_next`.

- A watch is owned by the session whose tool call created it; other sessions cannot see it.
- The cursor (last seen comment + ETag) is durable under the **state root**, deduped by comment id,
  so restarts and overlapping polls deliver each comment once.
- New comments produce a short **untrusted** notice via `ctx.session.synthetic({ resume: true })`.
  Comment bodies are only readable through `wake_next`, never injected.
- Auth comes from `gh auth token` or a configured `tokenCommand`; the token is never written to disk.
- `401`/`403`/`429`/network/malformed responses fail closed: the cursor does not move and the next
  successful poll resumes without loss.

Full reference — configuration, state layout, delivery guarantees, security model, scopes and
limitations: [`docs/session-wake.md`](../../docs/session-wake.md).

> Status: implementation spike. The wake seam is exercised against a fake session API; see the
> "Host API limitation" section of the doc before relying on a live wake.
