# @vymalo/opencode-github-notify

OpenCode plugin that bridges **GitHub issue / pull-request thread comments into running OpenCode
sessions**. Subscribing to a thread on GitHub only notifies *you*; it does nothing for an agent that
is already working. This plugin polls the threads you configure (no webhook), records every new,
edited or deleted comment once in a durable local log, and lets each session read what it has not
seen yet — through a tool, with an optional notice pushed into the session.

**Read-only.** It sends GET requests to GitHub and nothing else: no comments, reactions, reviews,
merges, labels or "mark as read". Comment bodies are returned as **untrusted** data and are never
acted on by the plugin.

> **Requires OpenCode v2** (`@opencode/plugin` 2.x). Mechanism, security model and state layout:
> [`docs/github-notify.md`](../../docs/github-notify.md). Design record:
> [ADR-0024](../../docs/adr/0024-github-thread-bridge.md).

## Installation

```sh
npm install @vymalo/opencode-github-notify
```

The default auth uses the GitHub CLI, so `gh auth login` once on the machine (or see
[Auth](#auth)).

## Configuration

```jsonc
// opencode.json
{
  "plugins": [
    {
      "package": "@vymalo/opencode-github-notify",
      "options": {
        "watches": ["skyengpro/a24-context#334"],
        "pollIntervalSeconds": 60,
        "notify": "queue"
      }
    }
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `watches` | `[]` | Threads as `owner/repo#number`. Issues and PRs share one number space. |
| `repo` + `threads` | — | Alternative spelling: `"repo": "owner/repo", "threads": [334, 335]`. Combined with `watches` and deduplicated. |
| `pollIntervalSeconds` | `60` | Minimum `15` (smaller values are raised). Shared across every OpenCode process on the machine. |
| `maxBackoffSeconds` | `900` | Cap for exponential backoff after errors (rate limits use GitHub's own reset time, up to 1 h). |
| `notify` | `"queue"` | `"queue"`: a fixed-text notice is queued into sessions that use the tools and read on their next turn. `"wake"`: also resumes an idle session (costs tokens per batch). `"off"` / `false`: tool only. |
| `filter.mentions` | `[]` | Deliver only comments that mention one of these handles (`"agent-bot"` or `"@agent-bot"`, case-insensitive, whole handle). |
| `filter.markers` | `[]` | …or that contain one of these literal strings (e.g. `"[decision]"`). Both empty = every comment. |
| `auth` | `{ "command": ["gh", "auth", "token"] }` | `{ "command": [...] }` runs a command whose stdout is the token; `{ "env": "GITHUB_TOKEN" }` reads an env var. |
| `apiBaseUrl` | `https://api.github.com` | GitHub Enterprise: `https://<host>/api/v3`. Must be `https` (plain `http` only for loopback). |
| `maxLogEvents` | `500` | Events retained per thread. A session that falls further behind is told how many it missed. |
| `maxPages` | `30` | Pages (100 comments each) listed per poll. Beyond it, new comments are still seen on the listed pages but deletions are not reported. |
| `batchSize` | `20` | Default number of events one `github_messages_next` call returns (the tool accepts `limit`, max 100). |
| `enabled` | `true` | `false` disables the plugin without removing it. |
| `logLevel` | `OPENCODE_LOG_LEVEL` | Plugin log level (`DEBUG`/`INFO`/`WARN`/`ERROR`). |

## Tools

| Tool | Effect |
| --- | --- |
| `github_messages_next` | Returns this session's unread events (created / edited / deleted), oldest first, and marks them read **for this session only**. Each comment comes wrapped in `<untrusted-github-comment …>` with author, timestamp, URL and comment id. |
| `github_messages_recent` | Re-reads the latest retained events without changing any cursor (`limit`, optional `watch`). The recovery path if a turn is lost. |
| `github_messages_status` | Per thread: unread count for this session, last poll result (auth / rate limit / network errors are spelled out), next poll time. Calling it also subscribes the session to notices. |

Tell your agent to call `github_messages_status` at the start of a session; after that, notices
arrive on their own.

## Auth

The token is resolved in memory on first use and re-resolved after a `401`. It is **never written**
to the plugin's files and **never logged** (only the command's name is). A missing or rejected token
is reported by `github_messages_status` and in the log — the plugin keeps polling with backoff and
never claims thread state it could not read.

Scopes: a fine-grained token with **Issues: Read-only** (and **Pull requests: Read-only** for PR
threads) on the watched repositories is enough. `gh auth token` hands over whatever `gh` holds,
which is usually broader — use `auth.command` / `auth.env` with a narrower token if that matters.

## Log events

| Event | Level | When |
| --- | --- | --- |
| `github_notify_started` | info | Poll loop started (watches, interval, notify mode, auth source name). |
| `github_notify_baselined` | info | First complete listing recorded (existing comments are not delivered). |
| `github_notify_events_recorded` | info | New events appended to a thread's log. |
| `github_notify_poll_failed` | warn | GitHub error; `kind` is one of `no_token`, `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `server`, `network`, `malformed`. |
| `github_notify_listing_truncated` | warn | The thread has more pages than `maxPages`. |
| `github_notify_notice_sent` / `_failed` | info / warn | A notice was queued into a session / refused (that session stops receiving notices; its cursor is kept). |
| `github_notify_delivered` | info | `github_messages_next` handed events to a session. |
| `github_notify_state_reset` | error | A state file was unreadable; it was moved aside and the thread re-baselined. |
| `github_notify_config_invalid` / `_inactive` | error / info | The plugin is inert (bad options, disabled, or no watches). |

## Disabling

Set `"enabled": false`, or remove the plugin entry. To forget all cursors and logs, delete
`<state root>/opencode-github-notify/` (see [`docs/github-notify.md`](../../docs/github-notify.md#local-state)).
