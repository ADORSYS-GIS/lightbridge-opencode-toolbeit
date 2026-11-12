# GitHub thread notifications

How `@vymalo/opencode-github-notify` gets comments from a GitHub issue or pull request into an
OpenCode session that is already running, and what it guarantees. Option reference:
[`packages/opencode-github-notify/README.md`](../packages/opencode-github-notify/README.md).
Why it is built this way: [ADR-0024](adr/0024-github-thread-bridge.md).

## The problem

Several agents share one GitHub account and subscribe to a working-plan issue. GitHub reports the
subscription as active (`viewerSubscription: SUBSCRIBED`), but a subscription only sends the human a
notification. An agent mid-task never hears about the comment, and acting on a decision made four
minutes ago is the failure mode
([source](https://github.com/skyengpro/a24-context/issues/334#issuecomment-6800736608)).

## How it works

```
GitHub ──GET (If-None-Match)──▶ poller ──atomic write──▶ watches/<thread>.json  (event log + snapshot)
                                  │                              │
                                  │                     sessions/<id>.json (cursor per session)
                                  ▼                              │
                  session.synthetic(notice)              github_messages_next ──▶ model
                  "2 new on o/r#7; call the tool"        (comments, fenced as untrusted)
```

1. **Poll.** Every `pollIntervalSeconds` (minimum 15) the plugin lists each thread's comments,
   page by page, sending the stored ETag. Unchanged pages answer `304`, which does not count against
   GitHub's rate limit. One process on the machine polls a given thread at a time (a lock file); the
   others skip and read the result.
2. **Diff.** The listing is compared with the stored snapshot (`comment id → updated_at`): a new id
   is `created`, a changed timestamp is `edited`, a missing id is `deleted` (only from a complete
   listing). The first listing is a baseline — comments that existed before the plugin started are
   not delivered.
3. **Record.** New events get the next sequence number and are written together with the new
   snapshot in one atomic file rename. If the process dies before the rename, nothing was recorded
   and the next poll finds the same change; after it, the change is recorded exactly once.
4. **Notify** (unless `notify: "off"`). For each session in this process that has used one of the
   tools and has unread events it was not yet told about, the plugin queues a fixed-text notice with
   `ctx.session.synthetic`: *"New activity on watched GitHub threads: o/r#7 (2 new). Call the
   github_messages_next tool…"*. With `notify: "wake"` the notice also resumes an idle session.
5. **Deliver.** `github_messages_next` returns the events past *this session's* cursor and moves the
   cursor. Another session on the same account has its own cursor and gets its own copy.

A new session's cursor starts after the events recorded before the session was created, so a
comment posted between "session started" and "first tool call" is still delivered.

## Guarantees

| Situation | Behaviour |
| --- | --- |
| Polling with no new comments | No event, no notice. |
| One new comment | One event; each session receives it once. |
| Restart after delivery | Not delivered again (cursor is on disk, committed before the tool returns). |
| Two OpenCode processes polling, or two tool calls at once | The thread lock and the session lock serialise them; the loser skips or is asked to retry. Nothing is delivered twice. |
| 401, 403, 404, 429, 5xx, network error, malformed JSON | The log and snapshot do not move. The failure is logged and shown by `github_messages_status`; polling backs off (rate limits use GitHub's reset time). The next successful poll picks up everything missed. |
| Private repo the token cannot see | GitHub answers 404; status says "not found, or private and not visible to this token", and no thread state is recorded. |
| Comment edited / deleted | An `edited` event with the new body / a `deleted` event without a body. Other comments are not re-delivered. |
| A session falls more than `maxLogEvents` behind | It is told how many events were evicted and to re-read the thread. Never silently skipped. |
| A turn is lost after `next` returned | `github_messages_recent` shows the latest events again without moving the cursor. |

## Security model

- **Read-only.** The client issues GET requests only. There is no code path that posts, reacts,
  reviews, merges, labels or marks notifications read.
- **Comments are untrusted input.** Bodies, authors and URLs come from third parties. They reach
  the model only inside a tool result, wrapped in `<untrusted-github-comment …>…</untrusted-github-comment>`
  under a preamble that says to treat them as data. A body that tries to close the fence or open a
  fake one has the tag neutralised (`&lt;/untrusted-github-comment`); attribute values are stripped
  of quotes and angle brackets.
- **Notices carry no third-party text.** The pushed notice is a fixed sentence plus counts and
  thread names you configured. A comment saying "ignore previous instructions" cannot become a
  session message by itself; the plugin itself never calls a tool or acts on comment content.
- **Pagination links stay on the API origin.** A `Link: rel="next"` pointing anywhere else is
  refused, so the token is never sent off-host.
- **Token handling.** From `gh auth token` (default), a command you configure, or an env var. Held
  in memory, re-resolved after a 401, never logged (only the command name is), never written to the
  plugin's files. `apiBaseUrl` must be `https` except on loopback.

### Token scopes

Minimum: a fine-grained personal access token with **Issues: Read-only** (plus **Pull requests:
Read-only** for PR threads), restricted to the watched repositories. `gh auth token` returns the
token `gh` is logged in with, which is usually a broad OAuth token (`repo` scope); point `auth` at
a narrower token if the blast radius matters:

```jsonc
"auth": { "env": "GITHUB_NOTIFY_TOKEN" }
// or
"auth": { "command": ["pass", "show", "github/notify-readonly"] }
```

## Local state

Everything lives under the durable **state** root (never the purgeable cache root —
[ADR-0022](adr/0022-credentials-in-state-dir.md)), namespace `opencode-github-notify`:

| Platform | Directory |
| --- | --- |
| Linux | `$XDG_STATE_HOME/opencode-github-notify` (absolute only), else `~/.local/state/opencode-github-notify` |
| macOS | `~/Library/Application Support/opencode-github-notify` |
| Windows | `%LOCALAPPDATA%\opencode-github-notify` |

```
opencode-github-notify/
├── watches/<owner>__<repo>__<n>.json   # snapshot, page ETags, event log, poll status
├── sessions/<sessionID>.json           # this session's cursor + last-notified seq per thread
└── locks/                              # short-lived lock files
```

Files are `0600` in `0700` directories, written by atomic rename. They contain comment bodies
(retained events) but **no token**. An unreadable thread file is moved aside as
`*.corrupt-<timestamp>` and the thread re-baselines (logged as `github_notify_state_reset`, shown by
status); an unreadable session file is reported as a tool error rather than reset, because a reset
would replay or skip comments — delete it to restart that session from now.

## Disabling

- `"enabled": false` in the plugin's options — the plugin registers nothing and does not poll.
- `"notify": "off"` — keep the tools, stop pushing notices.
- Remove the plugin entry, and delete the state directory above to drop all logs and cursors.

## Limits and follow-ups

- Issue **comments** only — this includes a PR's conversation tab, but not inline review comments
  or review summaries yet.
- Notices go to sessions that used the tools **in the current process**; after a restart a session
  is re-subscribed when it next calls a tool (its cursor, and so its unread events, survive).
- Session cursor files are not garbage-collected.
- The tests use an in-process GitHub fake with real ETag/304/`Link` semantics; there is no WireMock
  integration suite for this package yet.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Status says `no_token` | `gh auth status`; or the env var / command in `auth`. |
| `not_found` on a thread you can open in the browser | The token cannot see that (private) repo — `gh` may be logged into another account. |
| `rate_limited` | Raise `pollIntervalSeconds` or reduce watches; the plugin waits until GitHub's reset. |
| No notices, but `next` returns events | The session has not called a tool in this process yet, `notify` is `off`, or the host refused the notice (`github_notify_notice_failed` in the log). |
| Debug logs missing | Set both `logLevel: "DEBUG"` and `OPENCODE_LOG_LEVEL=DEBUG` ([ADR-0019](adr/0019-opencode-v2-cutover.md)). |
