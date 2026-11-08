# ADR-0019 — Cut over to the OpenCode v2 plugin API, on the Effect surface

- **Status**: Accepted
- **Date**: 2026-11-08
- **Applies to**: every runtime plugin in `packages/*`; amends the *mechanism* of [ADR-0014](0014-suite-wide-no-terminal-mirror.md)

## Context

OpenCode 2 shipped, and it is not a version bump. Three facts forced this decision:

1. **The package line we depend on is closed.** `@opencode-ai/plugin` tops out at `1.19.5`; this
   suite pins `1.15.10`. V2 ships under a renamed scope — `@opencode/plugin`, currently `2.2.6`,
   alongside `@opencode/client`, `@opencode/sdk` and `@opencode/cli`.
2. **V1 plugins do not run on V2.** OpenCode's own
   [migration guide](https://opencode.ai/docs/migrate-v1) states it plainly, and names plugins as
   one of three intentional breaking changes. Renaming the import is not sufficient.
3. **The hook model was replaced, not renamed.** V1 returned a `Hooks` object and mutated a single
   assembled config. V2 has **no mutable global config object**. A plugin is
   `Plugin.define({ id, setup | effect })` and registers changes with the *domain* that owns them
   (`ctx.provider`, `ctx.model`, `ctx.tool`, `ctx.session`, …).

That third point is the expensive one: **nine of our eleven plugin packages were built on the
`config` hook**, which has no v2 equivalent.

V2 offers a transition shape — one package exporting both a v2 `Plugin.define` and a v1 `server()`
hooks object. We are not taking it (see *Alternatives*).

### What v2 actually gives us

The hook-by-hook mapping, verified against `@opencode/plugin@2.2.6`'s type definitions rather than
the prose guide:

| v1 | v2 |
| --- | --- |
| `config` (provider registration) | `ctx.provider.transform(editor => …)` |
| `config` (model merge / enrichment) | `ctx.model.transform(editor => …)` |
| `chat.headers` | `ctx.session.hook("model.request")` |
| `chat.params` | `ctx.session.hook("context")` |
| `tool` map | `ctx.tool.transform(editor => editor.add(…))`, **JSON Schema** input |
| `tool.execute.before` / `.after` | `ctx.tool.hook("execute.before" / "execute.after")` |
| `event` | `ctx.event.subscribe({ signal })` |
| `permission.ask` | `ctx.permission.hook("evaluate")` |
| `auth` | `ctx.integration.transform(…)` + the integration APIs |
| `provider.options.fetch` injection | `ctx.session.hook("http.request" / "http.response")` |
| *(nothing — did not exist)* | `ctx.session.hook("retry")` |
| `dispose` | cleanup function returned from `setup` / the plugin's Effect scope |

Three of those rows are improvements rather than costs:

- **`http.request` / `http.response` are native seams.** `@vymalo/opencode-ratelimit` existed in its
  v1 shape because OpenCode had no post-response hook, so wrapping `provider.options.fetch` was —
  as [`docs/ratelimit.md`](../ratelimit.md) put it — "the sole interception point". V2 removes the
  need: `Provider.Info` has no `options` and no `fetch` field at all, and the HTTP exchange is
  hooked directly.
- **`retry` is a first-class backoff seam.** `SessionError.Error` carries `status` and
  `retryAfterMs`, and the hook returns `{ retry, delay }`. The host owns the retry loop, so a
  plugin no longer blocks a request on a 429 — it returns a delay and OpenCode sleeps, cancellably.
- **Tool registration takes raw JSON Schema**, which `browser/src/schema.ts` and
  `devtools/src/schema.ts` already emit for the two MCP servers. The 34 browser tools and the
  devtools groups port by reusing a path that already exists.

### Three casualties

- **There is no logging API.** V2's plugin `Context` has no `client`, and nothing in the type
  surface exposes a log sink. V1's `client.app.log` — which every package in this suite uses, and
  which [ADR-0014](0014-suite-wide-no-terminal-mirror.md) relies on to keep diagnostics off the
  user's TUI — is simply gone.
- **There is no `pluginConfig`.** Plugin configuration arrives as `ctx.options`, fed from the
  `plugins` array entry. This is a user-facing config break for every plugin we publish.
- **Per-provider `options.meta` is gone.** `Provider.Info` is
  `{ id, canonical?, integrationID?, name, activation, package, compatibility?, settings?, headers?, body? }`.
  Every `options.meta.<x>` opt-in in this suite has to move.

## Decision

**Cut over to v2 only. No dual-export, no compatibility shim.** The suite's next release targets
`@opencode/plugin` and drops `@opencode-ai/plugin` entirely, in one major version line.

**Author against the Effect surface (`@opencode/plugin/effect`), not the promise surface.**

This is the load-bearing part of the decision, and it is driven by logging. OpenCode installs its
own logger as an Effect `Logger.layer(...)` over a `Logger.toFile` sink
(`packages/util/src/observability/logging.ts` upstream) writing structured logfmt to the shared
`opencode-<channel>.log`. Effect carries loggers as **fiber-level references**, and
`@opencode/plugin`'s README states that plugin imports of `effect` resolve to the host's own module
instance precisely so that "fibers, loggers, and `Schema` parsers share one copy".

So the host's log sink is reachable — but only from inside the host's fiber. `Plugin.define({ effect })`
runs the plugin body as an `Effect` in that fiber; `Plugin.define({ setup })` does not. A bare
`Effect.runFork` from a detached callback would log to Effect's *default* logger, which writes to
the terminal — the exact outcome ADR-0014 forbids.

The suite therefore:

- Captures the host's `Context` once, inside the plugin's own Effect, via
  `Effect.withFiber(fiber => Effect.succeed(fiber.context))`.
- Logs through `Effect.logDebug` / `logInfo` / `logWarning` / `logError` with `Effect.annotateLogs`
  for structured fields, re-providing that captured context (`Effect.provideContext`) so records
  reach the host's logger from the synchronous callbacks our plain-TS core calls them from.
- Keeps the existing `Logger` interface (`trace`/`debug`/`info`/`warn`/`error` + `LogFields`)
  unchanged, so only each package's adapter learns about Effect. The business logic does not.
- Keeps `VYMALO_PLUGIN_CONSOLE_LOG=1` as the opt-in console mirror, off by default.

**ADR-0014 stands; only its mechanism changes.** Its guarantee — no plugin in this suite writes to
the user's terminal — is now delivered by the host's Effect file logger instead of
`client.app.log`. Event names stay `snake_case` and become the log message; `LogFields` become log
annotations, which OpenCode's formatter flattens to `key=value` — the same shape v1's `extra`
payload produced. `trace` folds onto Effect's `debug`, as it did onto the host's `debug` under
[ADR-0008](0008-trace-log-tier.md).

**`effect` is a `peerDependency` (`^4.0.0`) plus a `devDependency`, never a bundled runtime
dependency.** Two copies of `effect` do not share fiber, logger or `Schema` internals, and the host
supplies the real one. Bundling it would silently break logging.

**Per-provider opt-ins move to `settings.<key>`.** `Provider.Settings` is an open struct
(`StructWithRest` with a `Record<string, Any>` rest), so the per-provider opt-in model this suite
depends on survives — `options.meta.rateLimit` becomes `settings.rateLimit`, and so on for each
plugin's key.

**The decoupling holds, and is the reason this is affordable.** The v1 API only ever appeared in
thin adapter files — `opencode.ts`, `tools.ts`, `recorder.ts`, `opencode-helpers.ts`. `auth-core`,
`core-otel`, `provider-sync`, the tool catalogs and the browser broker never imported it. The
cutover rewrites adapters, not engines. `browser-mcp`, `devtools-mcp` and the browser extension do
not consume the plugin API and are unaffected.

## Consequences

- **A major version line.** Every published package breaks for anyone on OpenCode v1. There is no
  gradual path, by choice.
- **Users must rewrite config**, both ours and OpenCode's: `plugin` → `plugins` (with tuple entries
  becoming `{ package, options }`), `provider` → `providers`, each plugin's `pluginConfig.<key>`
  → that plugin's `options`, and each per-provider `options.meta.<key>` → `settings.<key>`. This
  needs migration notes per plugin, not just a changelog line.
- **`.well-known/opencode` survives but is reshaped.** The v2 manifest is
  `{ auth?, config?, remote_config? }`, `auth` is command-based (`{ command: string[], env: string }`)
  rather than an OAuth block, and a well-known origin becomes an **Integration**. Since well-known
  is this suite's primary distribution channel, oauth2's five auth flows move to
  `ctx.integration`, and the new `remote_config` field is worth adopting — it fetches config from a
  URL with substituted headers, which is exactly what a gateway-served suite wants. Treat that as
  its own ADR when the oauth2 port lands.
- **Logging is now an Effect concern in every adapter.** A package whose adapter forgets to capture
  the host context will log to the terminal and violate ADR-0014 without failing a type check. Each
  port must carry the ADR-0014 regression test.
- **Log levels are now gated twice.** A record passes the plugin's own `logLevel` gate and then
  Effect's `MinimumLogLevel` on the host fiber, whose default is `Info`. A plugin configured with
  `logLevel: "debug"` therefore emits nothing at `debug` unless the host also permits it
  (`OPENCODE_LOG_LEVEL=DEBUG`). Under v1 the plugin's gate was the only one that mattered, because
  `client.app.log` took whatever we handed it. Document this per plugin; it is the likeliest
  "why are my trace events missing" support question.
- **LSP config is accepted but inert in v2** (no language servers, no LSP tools, no diagnostics).
  Nothing in this suite depends on it today, and nothing here should grow to depend on it. (This bullet originally named the experimental `code-index` plugin, which was dropped at the cutover.)
- **`$` (the Bun shell helper) is gone**, as is the direct `client` object. Nothing in this suite
  used `$`.

## Alternatives considered

**Dual v1/v2 export during a transition.** V2 supports one package exporting both a v2 plugin and a
v1 `server()` hooks object, and nothing translates between them. Rejected: it means maintaining two
implementations of nine plugins against two incompatible config surfaces, for a v1 line that is
already closed at `1.19.5` and no longer self-updates. The suite's standing delivery rule is a hard
cutover — rip out the old path rather than ship a parallel one — and this is the case that rule
exists for.

**The promise surface (`@opencode/plugin`) with console logging.** Simpler code, and it is the
surface the migration guide leads with. Rejected because it cannot reach the host's log sink: the
only sink available from a detached promise callback is the terminal, which would silently
supersede ADR-0014. Writing our own file logger instead was also considered and rejected — it would
split this suite's diagnostics out of the host log stream that operators actually read, to solve a
problem the Effect surface does not have.
