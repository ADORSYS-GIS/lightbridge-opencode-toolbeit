# Plan — migrate the suite to the OpenCode v2 plugin API

**Status**: in progress. `@vymalo/opencode-ratelimit` is ported as the reference implementation;
the other ten packages follow the pattern it establishes.

Decision record: [ADR-0018](../docs/adr/0018-opencode-v2-cutover.md). Read it first — it holds the
*why* (v2-only, no dual export; the Effect surface; `effect` as a peer dep; ADR-0014's mechanism
change). This document holds the *how* and the order.

## The pattern, as established by ratelimit

Every port is the same five moves. Nothing below is specific to ratelimit except the hook choice.

### 1. Manifest

```jsonc
{
  "dependencies": { "@opencode/plugin": "2.2.6" },
  "peerDependencies": { "effect": "^4.0.0" },
  "devDependencies": { "effect": "4.1.0", … }
}
```

`@opencode-ai/plugin` comes out. `effect` is **peer + dev, never a runtime dependency** — the host
supplies the instance, and a second copy silently breaks logging (ADR-0018).

### 2. The adapter becomes `Plugin.define({ id, effect })`

Author against `@opencode/plugin/effect`, not the promise surface. Every plugin needs a stable id;
the suite uses `vymalo.<plugin>` (ratelimit: `vymalo.ratelimit`).

```ts
import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"

export function createOpencodeXxxPlugin(factoryOptions: … = {}): Plugin.Plugin {
  return Plugin.define({
    id: "vymalo.xxx",
    effect: Effect.fn(function* (ctx) {
      /* registrations */
    })
  })
}
```

Keep the `createOpencodeXxxPlugin(factoryOptions)` factory. It is the test seam for injecting a
logger, a clock and a sleep, and every package in this suite already has one.

### 3. Logging

```ts
const hostContext = yield* captureHostContext            // Effect.withFiber(f => succeed(f.context))
const logger = createEffectLogger(hostContext, () => logLevel)
```

Copy `captureHostContext` / `createEffectLogger` from
[`packages/opencode-ratelimit/src/logging.ts`](../packages/opencode-ratelimit/src/logging.ts). The
`Logger` interface itself does not change, so the package's engine code is untouched.

Two things to get right, because neither fails a type check:

- **Capture the context inside the plugin's Effect.** A bare `Effect.runFork` logs to Effect's
  default logger, which is the terminal — an ADR-0014 violation.
- **Resolve the level from `ctx.options.logLevel`, then `OPENCODE_LOG_LEVEL`.** V2 gives plugins no
  `config` object, so v1's `fromOpenCodeLogLevel(config.logLevel)` has no input. It becomes
  `resolveLogLevel`.

Every port carries the ADR-0014 regression test: a `warn` record reaches the Effect logger at its
true severity and does **not** reach the console unless `VYMALO_PLUGIN_CONSOLE_LOG=1`.

### 4. Registrations, per the ADR-0018 mapping table

Transform callbacks must stay **synchronous and cheap** — load effectful data before registering,
and call the domain's `reload()` when it changes. Later plugins' transforms see earlier changes.

### 5. Config surface

- `pluginConfig.<key>` → `ctx.options`
- per-provider `options.meta.<key>` → `settings.<key>` (`Provider.Settings` is an open struct)
- document both in the package's `docs/` page, with a before/after block

## Per-package work

Ordered by dependency. The two shared engines go first because the plugin packages consume their
types.

| # | Package | v1 surface | v2 target | Notes |
| --- | --- | --- | --- | --- |
| 1 | `opencode-core-otel` | `Hooks` type in `recorder.ts` | own event/tool/permission types | Engine, not a plugin. Stop importing `Hooks`; declare the event shapes it records against so `otel` and `lightbridge` can both feed it. |
| 2 | `opencode-provider-sync` | `Hooks` + `config` in `opencode-helpers.ts` | `ProviderEditor` / `ModelEditor` helpers | `collectManagedProviders` / `mergeDiscoveredModels` / `propagateCachedBearer` all take an `OpenCodeConfig` today; they become editor-shaped. **The cross-plugin `options.headers.Authorization` handoff to models-info has to be re-established on `Provider.Info.headers`** — see the composition contract in `CLAUDE.md`. |
| 3 | `opencode-models-info` | `config` | `ctx.model.transform` | The upstream-wins merge, `modelsInfoOverwrite` and `modelsInfoHideTextOnly` all map onto `ModelEditor.update` / `.remove`. Opt-in moves to `settings.modelsInfoUrl`. Mapping (`mapping.ts`) is pure — untouched. **Check whether v2's `Model.Info` still shapes `limit`/`cost` the same way**; `capabilities.tools` / `capabilities.input` / `capabilities.output` replaced v1's `tool_call` / `modalities`, so `mapping.ts`'s output fields need re-checking against the v2 schema even though its logic is sound. |
| 4 | `opencode-devtools` | `config` + `tool` map | `ctx.tool.transform` | Cheapest of the tool packages. `catalog.ts` + `schema.ts`'s `toJsonSchema()` already emit what `editor.add({ input })` wants. Groups gating moves to `ctx.options.groups`. |
| 5 | `opencode-browser` | `config` + `tool` map + `event` | `ctx.tool.transform` + `ctx.event.subscribe` | Same tool story as devtools, ×34 tools. The bridge/broker/transport layer never touched the plugin API and does not move. `dispose` → the Effect scope's cleanup; make sure the WS host closes on scope exit. |
| 6 | `opencode-oauth2` | `chat.headers` (+ `config` via provider-sync) | `ctx.session.hook("model.request")` + `ctx.integration` | **The hard one.** Five auth flows move to the integration domain (`IntegrationOAuthMethodRegistration` has `authorize` / `refresh` / `label`), and well-known origins are Integrations in v2. Needs its own ADR for the integration model + the reshaped `.well-known/opencode` manifest (`{ auth, config, remote_config }`, command-based `auth`). |
| 7 | `opencode-repo-auth` | `config` + `chat.headers` | `ctx.provider.transform` + `ctx.session.hook("model.request")` | Opt-in `options.meta.repoAuth` → `settings.repoAuth`. The oauth2-collision guard needs re-deriving from the provider editor rather than the config object. `git.ts` is off-disk and untouched. |
| 8 | `opencode-otel` | `config`, `chat.message`, `chat.params`, `permission.ask`, `tool.execute.*`, `event` | `ctx.session.hook("context")`, `ctx.permission.hook("evaluate")`, `ctx.tool.hook(…)`, `ctx.event.subscribe` | Widest hook surface in the suite, but it is an observer — no transforms except the `model.request` header injection for W3C trace-context (replacing the `provider.options.fetch` wrapper). Check whether v2's `experimental.openTelemetry` config field (accepted-but-ignored per the migration guide) changes anything for us. |
| 9 | `opencode-lightbridge` | all of the above | all of the above | Last, because it composes `provider-sync` + `core-otel` and must not regress ADR-0017's shared root-token cache or the scheduler-ownership guard. |
| 10 | `opencode-code-index` | `config` + `tool` map | `ctx.tool.transform` | Private + experimental. Port last, or drop it — ADR-0018 is a good moment to decide whether it stays. |

Unaffected: `opencode-auth-core` (never imported the plugin API), `opencode-browser-mcp`,
`opencode-devtools-mcp` (MCP servers — they consume catalogs, not hooks), and
`apps/browser-extension`.

`packages/plugin-bundle` rolls up oauth2 and must keep `effect` **external** — bundling it breaks
the host-instance sharing that logging depends on.

## PR sequence

One PR per concern, per `CLAUDE.md`. Implementation and docs land together.

1. ✅ **ratelimit + ADR-0018 + this plan** — the reference port.
2. **core-otel + provider-sync** — the two engines, together: both are `Hooks`-type-only changes and
   nothing else can port until they land.
3. **models-info**, **devtools**, **browser** — independent, parallelisable.
4. **oauth2 + its integration/well-known ADR**.
5. **repo-auth**, **otel** — parallelisable, both depend on step 2.
6. **lightbridge**.
7. **code-index** or its removal.
8. **Release PR**: one version line across all seventeen packages, the consolidated
   `CHANGELOG.md` entry, and a top-level migration guide for users (config renames, per-plugin
   `options`, `settings.<key>` opt-ins).

Steps 3 and 5 are the ones worth fanning out to concurrent sub-agents; the rest are sequential by
dependency.

## Open questions

- **Does `.well-known/opencode`'s v2 `remote_config` replace what this suite does with a served
  `config` block?** It fetches config from a URL with `{env:VAR}`-substituted headers, which is
  close to what the gateway already wants to do. Decide during step 4.
- **Does v2's integration model subsume `repo-auth`'s project-scoped exchange?** Integrations own
  credentials and have a `refresh` seam. If so, ADR-0011's "model b" renewal may get simpler.
- **`code-index`: port or delete?** It is private, experimental, and has never been published.
