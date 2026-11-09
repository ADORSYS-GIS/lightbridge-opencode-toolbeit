# ADR-0021 — a needed sign-in is reported with `connection.status`; credential custody stays with the plugin

- **Status:** Accepted
- **Date:** 2026-11-09
- **Applies to:** `@vymalo/opencode-oauth2`, the `gateway`/`register` modules of
  `@vymalo/opencode-lightbridge`, and `@vymalo/opencode-provider-sync`'s
  `ProviderModelSyncEngine`. **Amends [ADR-0020](0020-oauth2-integration-domain.md)**: it replaces
  the *"No host-visible sign-in"* consequence and leaves ADR-0020's Decision intact.

## Context

ADR-0020 accepted, as a stated cost, that a user whose cached token is missing or expired sees
nothing: warmup refuses non-interactively, and the device-code prompt appears only on the first
request, on stderr. [#149](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit/pull/149)
measured that cost on a real install — 405 non-interactive refusals across 0.17.0 and 0.18.0 with an
empty token cache, the documented fallback working but discoverable only in the host log, and the
user code expiring 600s after it is issued. The ADR's own words: *"the main thing a host-integrated
design would improve, and it is accepted for now."*

Re-reading the v2 type surface shows ADR-0020 answered two separable questions with one answer:

1. **who holds the credential**, and
2. **how the user is told a sign-in is needed.**

Both were answered "the plugin", because the only route to (2) that ADR-0020 examined was an
`external` method — its third alternative — which also moves (1). There is a route to (2) that does
not touch (1).

### The notice surface

`IntegrationDomain.connection.status` (`@opencode/plugin@2.2.6`, `dist/effect/integration.d.ts:88-93`):

```ts
/** Reports a problem with a connection, such as a required sign-in; `undefined` clears it. */
readonly status: (input: {
  readonly integrationID: string
  readonly connection: ConnectionInfo
  readonly status: Connection.Status | undefined
}) => Effect.Effect<void>
```

`Connection.Status` (`@opencode/schema@2.2.6`, `dist/connection.d.ts:3-13`) is
`{ status: "needs_auth", message: string, url?: string }`, documented as *"asks the user to sign in
again: at `url` when set (the credential itself stays valid), otherwise by reconnecting the
integration."*

Four properties make it the right channel:

- It is an **annotation on an existing connection**, not a credential. Nothing about it transfers a
  token, a refresh chain or custody of either.
- It is **sticky**: it rides on `Connection.Info.status`, so it persists until cleared — unlike a
  transient notification, which would scroll past while a 600s code expires.
- `message` + `url` carry a device-code prompt (verification URI and user code) without the host
  running the flow.
- *"the credential itself stays valid"* describes our case exactly. The host-side connection — a
  command/env placeholder, per [`docs/well-known.md`](../well-known.md) — is fine. What is missing is
  the plugin's own cached token.

### What it does not reach

`connection.status` needs a `ConnectionInfo`, which comes from `connection.active(integrationID)`
(`integration.d.ts:86`). **A plugin cannot create an integration**: `IntegrationEditor` (`:71-81`)
has `list` / `get` / `update` / `remove` and `method.update`, and no `add`. Integrations come from
the well-known document (`experimental.integration.wellknown.add`, `@opencode/client@2.2.6`,
`dist/effect/api/api.d.ts:2084-2088`).

For this suite's primary distribution channel that is satisfied — a well-known origin becomes an
Integration (ADR-0020). A provider configured by hand in `opencode.json`, with no well-known origin,
has no integration and therefore no connection to annotate.

### Re-examining ADR-0020's rejection of the OAuth method

Its Decision stands. Two of its four reasons are restated here precisely, because together they are
the gate on ever revisiting it:

- **Dual custody remains disqualifying, and is the load-bearing reason.** An
  `IntegrationOAuthMethodRegistration` hands the host a `Credential.OAuth` that the host stores,
  including `refresh`. The chain is single-use; an IdP with reuse detection (RFC 6819 §5.2.2.3)
  revokes it when an already-rotated token is replayed. Two holders of one chain — the host's store
  and the shared cache file (ADR-0016, ADR-0017) — is the precise failure the cache design exists to
  prevent, and `lightbridge` cannot see the host's store at all.
- **`auth-core` is still monolithic, and the seam is one layer deeper than it looks.**
  `requestDeviceAuthorization` does compute `user_code`, `verification_uri` and
  `verification_uri_complete`, but `DeviceAuthorizationResponse` is not exported and
  `acquireTokenViaDeviceCode` offers no callback: `AcquireTokenViaDeviceCodeOptions`
  (`packages/opencode-auth-core/src/oauth/device-code.ts:21-53`) ends at `serviceLabel`, and the
  values reach only `logger.info("oauth_device_code_issued")` and `process.stderr` (`:192-212`). The
  function returns once polling completes, whereas `IntegrationOAuthAuthorization` must be returned
  *before* the flow finishes. ADR-0020's *"worth revisiting if `auth-core` grows a split
  `begin`/`complete` API"* is the exact, still-unmet condition.

One correction to the record: `IntegrationOAuthAuthorization` (`integration.d.ts:40-50`) fits
device-code better than ADR-0020 implies — `mode: "auto"` with `callback` is the poll loop,
`expiresAt` is `expires_in`, and `instructions` carries the user code. The obstacle is custody and
the `auth-core` seam, not the type.

## Decision

**A needed sign-in is reported to the host with
`ctx.integration.connection.status({ status: "needs_auth", message, url })`, and cleared with
`undefined` once a token is cached. Credential custody does not move: ADR-0020's Decision — all five
flows on the plugin-owned `TokenRuntime`, no `ctx.integration` method registered — stands unchanged.**

- The engine already separates this one cause structurally rather than by message text:
  `isInteractiveAuthRequiredError` from `@vymalo/opencode-auth-core/lib` (#149). Where it logs
  `sync_skipped_needs_login` at `warn` today, it additionally reports `needs_auth`.
- `message` names the server and the action. `url` carries the device-code `verificationUri` while a
  flow is in flight; with no flow in flight it is omitted, and the documented meaning —
  *"otherwise by reconnecting the integration"* — is the correct instruction.
- The status is cleared on the next successful `ensureAccessToken` for that server.
- The ADR-0014 stderr carve-out **stays**. It is the only channel for a provider with no integration,
  and the only one that shows the user code itself.
- **No integration means no notice**, logged once at `debug`. It is not an error, and it is not a
  reason to fabricate an integration.

## Consequences

- **The ADR-0020 cost is removed for the primary channel.** For well-known-distributed providers an
  expired token becomes visible in the TUI and the GUI without reading a log file.
- **The log remains the contract; the notice is best-effort.** Every decision stays logged
  (`sync_skipped_needs_login`, `oauth_device_code_issued`). A failed or unreachable
  `connection.status` call never fails a request and never replaces a log line, so no diagnostic
  depends on a host surface we cannot test.
- **Clearing is part of the change, not a follow-up.** A stale `needs_auth` left behind after a
  successful login is worse than no notice at all: it would tell a working install to sign in.
- **`lightbridge` inherits it** wherever it shares the root-token cache with oauth2 (ADR-0017), since
  the refusal and the clear both originate in the shared engine.
- **Hand-configured providers are unchanged** — stderr and the log, exactly as ADR-0020 describes.
- **No new dependency.** `ctx.integration` is already part of the v2 plugin context; this adds calls,
  not a surface.

## Verified since

Resolved by implementing this ADR against the `@opencode/plugin@2.2.6` / `@opencode/schema@2.2.6` /
`@opencode/client@2.2.6` type definitions. **These are type-level facts**, not observations of a running host;
what a running host does is still listed under *Unverified* below.

- **Which `integrationID` a provider belongs to.** `Provider.Info` carries an optional `integrationID`
  (`@opencode/schema` `dist/provider.d.ts:388`, branded `Integration.ID`), visible to a plugin in
  `ctx.provider.transform` as `record.provider.integrationID`. The plugin records it per provider id and
  looks the managed provider up there; it never derives an integration id from a well-known URL or origin,
  because no type exposes that mapping. The fallback is `ctx.integration.transform`'s
  `IntegrationEditor.list()` (`{ id, name }[]`), used only for an integration whose id equals the
  provider id. `IntegrationEditor` has no way to find an integration by origin. Lightbridge's runtime id
  (`auth.id`) may differ from its gateway providers' ids, so it also borrows the `integrationID` of any
  provider listed in `gateway.providers`.
- **What `connection.active` returns.** `Effect<ConnectionInfo | undefined>`, where `ConnectionInfo` is
  `{ type: "credential"; id; label; method: "key" | "oauth" | "external"; status? } | { type: "env";
  name; status? }` (`@opencode/client` `dist/promise/generated/types.d.ts:1054-1065`). The type allows
  a connection for a command-/env-backed well-known integration; whether the host *returns* one is the gate
  below.
- **`connection.status` accepts a status without a credential change.** Its input is
  `{ integrationID, connection, status: Connection.Status | undefined }`, and
  `Connection.Status.url` is optional, so the *message-only* form this ADR specifies is a valid value.
- **The seam exists in plain TypeScript.** `auth-core` now exports a `SignInReporter` interface, a
  `SignInNotifier` (when to raise and clear), and `createConnectionSignInReporter`; the engine and
  `auth-core` import nothing from the plugin API (enforced by
  `packages/opencode-provider-sync/test/layering.test.ts`). Only the plugin adapters touch
  `ctx.integration`, inside the captured host context. The device-code values were exposed by adding
  optional `onDeviceCode` / `onDeviceCodeExpired` callbacks to `acquireTokenViaDeviceCode` and an
  `onTokenObtained` callback to `TokenRuntime`; `DeviceAuthorizationResponse` is still unexported.
- **A stale notice is cleared.** `TokenRuntime.onTokenObtained` fires after every successful
  `ensure` / `refresh` (cached hit, refresh or login) and never on failure; the notifier clears only a
  notice it raised itself.
- **stderr no longer produces an unhandled error under a closed pipe.** Both ADR-0014 prompts now go
  through `writeTerminalPrompt`, which attaches a short-lived `'error'` listener (it must outlive the
  write callback, because Node emits the event on a later tick), swallows `EPIPE`, and logs once at
  `debug`. The prompt still reaches a live stderr.

## Still unverified without a running v2 host

- **Whether `connection.active(integrationID)` returns a `ConnectionInfo` for a well-known
  integration whose `auth` is command- or env-based.** This is the gate: if it returns `undefined`,
  nothing in this ADR is reachable and it must be superseded rather than quietly no-op.
- Whether the TUI and GUI render `needs_auth` on a non-OAuth connection, how prominently, and what
  they do with `url` (link, copy, or text).
- Whether the host actually **stamps `Provider.Info.integrationID`** on a provider that comes from a
  well-known document, and what id it uses. The implementation reads that field and falls back to an
  integration whose id equals the provider id; it logs the known integration ids once at `debug`
  (`sign_in_notice_skipped`, `reason: no_integration`) so a mismatch is diagnosable from the host log.
- Whether `connection.status` may be called from inside a `session.hook`, or only within a transform
  or the plugin's own scope. The calls are made from detached promise continuations via `runInHost`
  (the captured host context), never from the hook's own fiber, but nothing here proves the host accepts
  that.
- Whether the host itself ever sets, clears or overwrites a plugin-set status.
- Whether a status set by a plugin survives a host restart. The notifier only clears a notice it raised
  in the same process, so a status persisted by the host across a restart would outlive the login that
  fixed it.
- Whether a `url` that is a device-code verification page, with a user code only in `message`, is
  rendered usably (the code is in the message precisely so it does not depend on `url` handling).

## Alternatives considered

**Keep the log as the only channel (ADR-0020 as written).** Rejected now that the cost is measured
rather than predicted: a user on 0.18.0 could not tell why no models appeared, and the remedy was
only in a file. ADR-0020 accepted this "for now" explicitly; this is that revisit.

**Throw from `ctx.session.hook("model.request")`.** The one genuinely bolt-on option — it needs no
integration and no connection. Rejected because it surfaces as a request failure rather than a
prompt, it only fires when the user sends a message (so a session with no models still explains
nothing), and ADR-0020's fail-closed path already dies there; adding prose to that defect changes
how it reads, not whether the user is told in advance.

**`session.synthetic`.** Rejected, and recorded because it looks correct: `SessionModelRequest`
carries `sessionID` (`dist/effect/session.d.ts:62-69`) and `SessionDomain` exposes `synthetic`
(`@opencode/client`, `dist/effect/api/api.d.ts:269-281`), so a plugin can place text in the
transcript. But a synthetic message is **input to the agent** — the `experimental.idle` docstring
states that input admitted by a hook *"runs in the same execution instead of the Session going
idle"* — so it would instruct the model to sign in, not the user. It would appear to work, which is
what makes it worth writing down.

**A device-code login CLI (a `bin` in oauth2).** Deferred, not rejected. It is the only option that
also helps hand-configured providers, and it makes the user code visible without the host. It
duplicates what the host can already show for well-known providers, so it is worth building only if
the gate above fails or hand-configured providers turn out to be the common case.

**Register the OAuth method and let the host drive the login.** Still rejected, on dual custody and
the `auth-core` seam set out above.
