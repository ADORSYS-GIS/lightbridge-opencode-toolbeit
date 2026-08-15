# Security model

This workspace ships plugins that touch credentials, network gateways, and — in the case of the
browser plugin — a real browser profile. This page consolidates the security posture of each so
you can reason about the blast radius before enabling one.

> TL;DR: tokens are cached `0o600` and never logged; the rate-limit plugin observes responses but
> never touches auth; the otel plugin exports shape only — never prompt, response or tool-argument
> content — and strips credentials out of any git remote URL before publishing it; the browser
> bridge is loopback-only + token-gated and grants control of a real browser profile — **use a
> throwaway profile**.

## `@vymalo/opencode-oauth2` — tokens & cache

- **No long-lived secrets baked into config.** The plugin runs the OAuth dance for the configured
  flow and caches the resulting tokens; for federated flows (`jwt_bearer`, `token_exchange`) the
  platform's short-lived OIDC token is re-fetched on every expiry, so nothing long-lived is
  stored.
- **Cache on disk** lives under the per-OS cache dir (`~/Library/Caches/opencode-oauth2/` on
  macOS, `XDG_CACHE_HOME` on Linux, `LOCALAPPDATA` on Windows). Writes are **atomic-rename +
  `0o600`** (owner read/write only).
- **Refresh-token policy.** User flows that issue refresh tokens are cached only if fully
  renewable; entries missing a refresh token are evicted on load (machine flows excepted, since
  they re-acquire). See [token policy in the root README](../README.md#token-policy).
- **Logging redacts secrets.** Token-like fields are redacted in the structured log stream.
- **Bearer injection is per-request** via the `chat.headers` hook, so a stale config-time header
  can never reach inference.

## `@vymalo/opencode-models-info` — metadata fetch

- **Auth-agnostic.** It only reads/merges already-resolved config and fetches a metadata URL.
- When paired with oauth2, it **inherits** the bearer oauth2 stamped onto the provider headers —
  it never acquires or stores credentials itself.
- The metadata fetch honors `options.headers` + `meta.modelsInfoHeaders`. Only
  `meta.modelsInfoHeaders` is part of the cache key — so if you switch tenants via
  `meta.modelsInfoHeaders` the cache busts, but switching via the provider's `options.headers`
  alone does **not** bust it (those are sent on the fetch but not keyed). Put any tenant/auth
  selector that must isolate cached metadata in `meta.modelsInfoHeaders`.

## `@vymalo/opencode-ratelimit` — response observation

- **Never reads or sets `Authorization`.** It wraps `provider.options.fetch` purely to observe
  response **status** and `x-ratelimit-*` **headers**, then throttles / backs off.
- **In-memory state only** — no disk cache, nothing persisted (a reset window is seconds; stale
  state would be worse than none).
- Composes with any auth scheme because it's auth-independent.

## `@vymalo/opencode-otel` — telemetry export

Unlike every other plugin here, otel's blast radius runs in the opposite direction: the risk isn't
that it grants access to something, it's that it might leak something on the way out to a
third-party backend. The posture is deliberately conservative because a telemetry pipe is exactly
the kind of thing nobody re-audits once it's wired up.

- **No content capture, anywhere in the pipeline.** Never prompt text, never assistant response
  text, never tool arguments, never raw API request/response bodies. Every log record carries
  *shape* only — lengths, counts, durations, sizes, outcomes and error classes — so there is no
  redaction engine to get wrong because there is nothing to redact in the first place. See
  [otel.md → Privacy](otel.md#privacy).
- **Git remote credentials are stripped unconditionally.** A checkout's remote is commonly
  `https://user:token@host/org/repo.git` in CI. Before `vcs.repository.url.full` is published as a
  resource attribute on every span, metric and log, `sanitizeRemoteUrl` (in
  [`src/vcs.ts`](../packages/opencode-otel/src/vcs.ts)) drops the whole userinfo component —
  including a bare username, which identifies nothing about the repository — along with any query
  string or fragment. This happens whether or not `collectVcs` scoping narrows anything else; it is
  not a configurable behavior.
- **The `tokenCommand` credential helper's stdout is treated as a secret.** Its output is the access
  token used to authenticate to the OTLP collector, so it is never logged. A failed helper invocation
  logs the command name, exit code, whether stdout came back empty, and the *length* of stderr — not
  stderr's contents, because a credential helper's stderr can echo back the request it failed on. See
  [`src/token-source.ts`](../packages/opencode-otel/src/token-source.ts) and
  [otel.md → Short-lived credentials](otel.md#short-lived-credentials).
- **Identifies the machine and the project, never the developer.** Resource attributes cover
  `service.name`, `host.name`, `opencode.project.name`, `opencode.directory`/`opencode.worktree` and
  VCS branch/revision — deliberately no git author email. Per-person attribution is available but is
  an explicit opt-in via `OTEL_RESOURCE_ATTRIBUTES` (e.g. `enduser.id=dev@example.com`), which keeps
  the choice visible in config instead of baked into the binary.
- **Cardinality and egress are both switchable.** Session id (`gen_ai.conversation.id`) reaches
  metrics only when `includeSessionId` is turned on — logs and spans always carry it, but metric
  backends bill per series, so the default keeps unbounded-cardinality session ids out of the metric
  path. Repository identity leaves the machine by default whenever `collectVcs` is on (the default);
  set `collectVcs: false` to publish no repository identity at all.
- **Inert until configured.** With no endpoint and no explicit exporter, the plugin initializes no
  providers, opens no sockets, and installs no `fetch` wrapper — installing it costs nothing until an
  `OTEL_EXPORTER_OTLP_ENDPOINT` or equivalent is actually set.

## `@vymalo/opencode-browser` & `-mcp` — the bridge

This is the highest-blast-radius component: it grants an agent control of a **real browser
profile**.

- **Loopback bind.** The bridge binds `127.0.0.1` only (`host` is configurable but should stay
  loopback). It is not reachable from the network.
- **Token handshake.** Every client must present the shared token on connect; mismatches are
  closed immediately. If you don't set one, a token is generated and logged once
  (`browser_bridge_token_generated`) / printed to stderr (MCP).
- **Use a dedicated or throwaway browser profile.** The agent can navigate, click, type, read
  page content, and (with `debug` tools) read cookies and run arbitrary JS. Don't point it at a
  profile logged into your bank, email, or production consoles.
- **The "being debugged" banner is intentional.** On Chromium the CDP executor attaches
  `chrome.debugger`, which shows a persistent banner — a deliberate, continuous signal that
  automation is active. Don't suppress it.
- **`debug` tools are off by default.** `browser_eval`, `browser_cookies`, `browser_console`,
  `browser_network`, `browser_handle_dialog`, `browser_set_viewport` are only registered when you
  add `debug` to `groups` / `OCB_GROUPS`. Enable them deliberately.
- **Password masking.** `<input type="password">` values are masked (`••••••`) in
  `browser_snapshot` / `browser_query` / `browser_get_attribute` output so they don't reach the
  model or host logs.
- **Group isolation.** Tab-targeted actions validate that an explicit `tabId` belongs to the
  named group, so a command can't reach unrelated user tabs. With multiple agents on one bridge,
  groups are owner-exclusive.
- **Screenshots.** Written to disk under the worktree (OpenCode) or returned inline (MCP). Treat
  them like any other artifact — they can contain whatever was on screen.

### Reducing blast radius

- Scope tools per agent: `{ "groups": ["page"] }` for a read-only research agent.
- Keep `debug` off unless you need it.
- Run the browser under a separate OS user or container if you want stronger isolation.

## Reporting a vulnerability

Please open a security advisory or a private issue rather than a public PR for anything
exploitable. For non-sensitive hardening ideas, a normal issue/PR is welcome.
