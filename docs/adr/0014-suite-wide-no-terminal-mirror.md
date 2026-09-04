# ADR-0014 — No plugin in the suite writes to the terminal (device-code login excepted)

- **Status:** Accepted (2026-09). Supersedes [ADR-0013](0013-otel-no-terminal-mirror.md).
- **Scope:** every `createOpenCodeLogger` host bridge in the suite —
  `opencode-lightbridge`, `opencode-oauth2`, `opencode-repo-auth`, `opencode-browser`,
  `opencode-code-index`, `opencode-devtools`, `opencode-models-info`, `opencode-ratelimit`
  (`opencode-otel` already had this shape since ADR-0013). Also covers the two hardcoded
  `process.stderr.write` calls in `@vymalo/opencode-auth-core` (`oauth/device-code.ts`,
  `oauth/client.ts`) — those writes stay, but the maintainer plugin's name they used to print
  is now a parameter instead of a literal.

## Context

[ADR-0008](0008-trace-log-tier.md) established the suite-wide logging convention: a clean run is
silent at `info`, lifecycle events sit at `debug`, and only failures surface at `warn`/`error` — by
having `createOpenCodeLogger` mirror `warn`/`error` records to the console
(`consoleAll || level === "warn" || level === "error"`) on top of forwarding every record to
`client.app.log`. [ADR-0013](0013-otel-no-terminal-mirror.md) carved `opencode-otel` out of that rule
on the grounds that it is the suite's only *pure observer* — it mutates nothing, so its own
`warn`/`error` records describe telemetry going missing, not the developer's own work — and argued
explicitly that the console mirror was *correct* for everyone else:

> That convention is right for oauth2, models-info, ratelimit, browser and repo-auth: those plugins
> mutate the session … so a warn/error printed to the terminal is telling the developer about *their
> own* request that just failed or degraded — actionable, and worth the interruption.

The maintainer has since overridden that reasoning directly: **in all cases, the TUI should never
see an error.** The "pure observer vs. session-mutating plugin" distinction ADR-0013 drew is no
longer load-bearing — it is not that action-taking plugins deserve terminal interruptions and
observers don't; it is that *no* plugin gets to interrupt the terminal on its own initiative,
regardless of what it does. A user mid-agentic-run does not want `opencode-ratelimit` or
`opencode-oauth2` printing over the model's output any more than they want `opencode-otel` doing it —
the "it's actionable" argument assumed the interruption was welcome; in practice it is just noise at
the exact moment the developer is least able to act on it.

## Decision

Every plugin's `createOpenCodeLogger` drops the `level === "warn" || level === "error"` branch of its
console-mirror check, leaving only the existing escape hatch:

```ts
if (consoleAll) {
  fallback[level](event, fields);
}
```

This is the same one-line shape ADR-0013 already gave `opencode-otel`, now applied to the remaining
eight packages (`opencode-lightbridge`, `opencode-oauth2`, `opencode-repo-auth`, `opencode-browser`,
`opencode-code-index`, `opencode-devtools`, `opencode-models-info`, `opencode-ratelimit`). As before:

- **Severity is preserved.** A record keeps its true level all the way to `client.app.log`; only the
  *console* branch changes. The min-level gate and the `trace`→`debug` wire fold (ADR-0008) are
  untouched.
- **`client.app.log` is the only sink for a diagnostic by default.** Every `logger.warn`/`logger.error`
  call site keeps working unmodified — the record just stops printing to stdout/stderr on its own.
- **`VYMALO_PLUGIN_CONSOLE_LOG=1` remains the one opt-in escape hatch**, suite-wide, for every plugin
  and every level — no new env var, no per-plugin knob.

**The one deliberate carve-out: the device-code login prompt.** `@vymalo/opencode-auth-core`'s
`acquireTokenViaDeviceCode` (`oauth/device-code.ts`) and `OAuthClient`'s browser-open fallback
(`oauth/client.ts`) both write a login URL/code straight to `process.stderr`, bypassing the logger
entirely. Both writes **stay** — this is not a diagnostic, it is the only way the flow can hand a
first-time (or re-)login prompt to a human sitting at the terminal; suppressing it would make a
normal login look like a hang, with no path forward for the user. What changes is the hardcoded
`[opencode-oauth2]` prefix both call sites carried: `auth-core` is shared by `opencode-lightbridge`,
`opencode-oauth2` and `opencode-repo-auth` (ADR-0012), so a user of the other two plugins was being
shown a prompt naming the wrong plugin. The prefix is now a `serviceLabel` parameter, threaded
`OAuthClient` → `TokenRuntime` → each plugin's own `TokenRuntime` construction site, defaulting to
the neutral `"opencode"` when a caller doesn't set one:

```ts
// device-code.ts / client.ts
const serviceLabel = options.serviceLabel ?? "opencode";
process.stderr.write(`\n[${serviceLabel}] ...`);
```

```ts
// opencode-lightbridge/src/plugin.ts
new TokenRuntime(LIGHTBRIDGE_IDENTITY, auth, { ..., serviceLabel: "opencode-lightbridge" });
// opencode-oauth2/src/plugin.ts
new TokenRuntime(server.id, authConfig, { ..., serviceLabel: "opencode-oauth2" });
// opencode-repo-auth/src/plugin.ts
new TokenRuntime(HUMAN_IDENTITY, validateAuthConfig(config.auth), { ..., serviceLabel: "opencode-repo-auth" });
```

## Consequences

**Positive**

- **No plugin can interrupt the terminal on its own initiative, full stop.** The narrower ADR-0013
  exception — "only the pure observer is silenced" — is gone; the rule is now suite-wide and has no
  per-plugin carve-out to keep track of.
- **Nothing is lost from the log.** Every `warn`/`error` from every plugin still reaches
  `client.app.log` at its true level; the diagnostic is always there, just not on the developer's
  screen.
- **The device-code login prompt now names the right plugin.** A `opencode-repo-auth` or
  `opencode-lightbridge` user doing a device-code login sees `[opencode-repo-auth]` /
  `[opencode-lightbridge]`, not a hardcoded `[opencode-oauth2]` that used to misattribute the prompt
  to a plugin they may not even have configured.
- **One escape hatch, one mental model.** `VYMALO_PLUGIN_CONSOLE_LOG=1` still restores full console
  mirroring, identically, across all nine plugins — a developer debugging any of them reaches for the
  same one env var.

**Negative / cost — named concretely, not glossed over**

This is the real trade the maintainer is accepting, and it is a bigger one than ADR-0013's: those
five plugins really were mutating the session, and their failures really were often the developer's
own problem to fix *right then*. Under this ADR:

- **A user whose `opencode-oauth2` (or `opencode-repo-auth`) token has expired and failed to refresh
  sees nothing in the terminal.** The request that needed the bearer degrades or 401s downstream —
  possibly surfacing as a confusing provider-side error several layers removed from "your token
  expired" — and the actual diagnostic (`oauth2_refresh_failed`, `repo_auth_exchange_failed`, …) is
  only in OpenCode's own log, not printed where the failure happened.
- **A user being throttled by `opencode-ratelimit` gets no visible warning.** A request that is
  slowed or rejected under budget produces no terminal signal that a rate limit is the cause; the
  developer has to notice degraded behavior and go looking in the log to find out why.
- **A user whose `opencode-browser` bridge has gone down (host process died, port stale, handshake
  rejected) sees no error when a browser tool call fails.** The tool call itself will presumably fail
  or hang from the model's perspective, but the plugin's own diagnosis of *why* — mirrored to console
  under the old behavior — no longer appears.
- **Discoverability now depends on knowing to check OpenCode's own log**, for every plugin in the
  suite, not just `opencode-otel`. `VYMALO_PLUGIN_CONSOLE_LOG=1` is the way back to the old behavior,
  but a developer has to already suspect a plugin failure to reach for it.

The maintainer's instruction is explicit that this cost is accepted: **"In all case, TUI should never
see an error."** This ADR does not relitigate that call — it records it and its consequences.

## Alternatives considered

### Keep ADR-0013's per-plugin distinction (pure observer vs. session-mutating) — rejected

This is the status quo this ADR overturns. It was a reasonable distinction on its own terms — an
action-taking plugin's failure genuinely is more often "your request, right now" than an observer's
— but the maintainer's standing instruction removes the premise that such an interruption is welcome
at all. Keeping the distinction would also mean five different plugins each re-deriving "is my
failure actionable enough to interrupt the terminal," a judgment call that the maintainer has now
made once, suite-wide, instead of nine times.

### Also silence the device-code/browser-open stderr prompts — rejected

These are not diagnostics; they are the only mechanism by which an interactive login flow can hand a
human the URL/code they need to complete it. Neither goes through `createOpenCodeLogger` — they write
directly to `process.stderr` before any token exists, so there is no `client.app.log` yet those
writes could redirect to. Silencing them would not swap the failure mode for "check the log instead"
(ADR-0013's trade for otel's failures) — it would leave the user with **no way to complete login at
all**, which is a strictly different and worse outcome than "a diagnostic isn't on screen."

### Leave the hardcoded `[opencode-oauth2]` label alone — rejected

Fixing the suite-wide console-mirror rule without also fixing the label would leave a real, unrelated
bug in place: `auth-core` is deliberately shared across three plugins (ADR-0011, ADR-0012), and a
`opencode-lightbridge` or `opencode-repo-auth` user doing a device-code or browser-fallback login
would keep seeing a prompt naming a plugin they may not have configured at all — confusing at exactly
the moment a first-time user most needs the prompt to be trustworthy.

### A dedicated env var per plugin, or a global `NO_TUI_OUTPUT` toggle — rejected

Same reasoning as ADR-0013's equivalent alternative: `VYMALO_PLUGIN_CONSOLE_LOG` already exists as the
suite's one console-mirror escape hatch, is already documented, and already does exactly what a new
toggle would do. Adding a second knob — global or per-plugin — would only fragment the contract
without buying any control an operator doesn't already have.
