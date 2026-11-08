# Plan — migrate the suite to the OpenCode v2 plugin API

**Status**: **done.** Every runtime plugin package is on the v2 API; `@vymalo/opencode-code-index`
was dropped instead of ported. `@vymalo/opencode-ratelimit` was ported first and established the
pattern the other ports copied. This document is kept as the record of the pattern, the per-package
mapping and the order the work landed in; the release PR (step 8) is the only item still open.

Decision record: [ADR-0019](../docs/adr/0019-opencode-v2-cutover.md). Read it first — it holds the
*why* (v2-only, no dual export; the Effect surface; `effect` as a peer dep; ADR-0014's mechanism
change). This document holds the *how* and the order.

## The pattern, as established by ratelimit (the first port)

Every port is the same five moves. Nothing below is specific to ratelimit except the hook choice.

### 1. Manifest

```jsonc
{
  "dependencies": { "@opencode/plugin": "2.2.6" },
  "peerDependencies": { "effect": "^4.0.0" },
  "devDependencies": { "effect": "4.1.0", … }
}
```

`@opencode-ai/plugin` came out. `effect` is **peer + dev, never a runtime dependency** — the host
supplies the instance, and a second copy silently breaks logging (ADR-0019).

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

### 4. Registrations, per the ADR-0019 mapping table

Transform callbacks must stay **synchronous and cheap** — load effectful data before registering,
and call the domain's `reload()` when it changes. Later plugins' transforms see earlier changes.

### 5. Config surface

- `pluginConfig.<key>` → `ctx.options`
- per-provider `options.meta.<key>` → `settings.<key>` (`Provider.Settings` is an open struct)
- document both in the package's `docs/` page, with a before/after block

## Per-package work

Ordered by dependency. The two shared engines go first because the plugin packages consume their
types.

| # | Package | v1 surface | v2 target | Outcome |
| --- | --- | --- | --- | --- |
| 1 | `opencode-core-otel` | `Hooks` type in `recorder.ts` | own event/tool/permission types | **Done (#134).** Engine, not a plugin: it no longer imports the plugin API and declares the event shapes it records against, so `otel` and `lightbridge` both feed it. |
| 2 | `opencode-provider-sync` | `Hooks` + `config` in `opencode-helpers.ts` | `ProviderEditor` / `ModelEditor` helpers | `collectManagedProviders` / `mergeDiscoveredModels` / `propagateCachedBearer` all take an `OpenCodeConfig` today; they become editor-shaped. **The cross-plugin `options.headers.Authorization` handoff to models-info was re-established on `Provider.Info.headers`** — see the composition contract in `CLAUDE.md`. **Done (#139).** |
| 3 | `opencode-models-info` | `config` | `ctx.model.transform` | The upstream-wins merge, `modelsInfoOverwrite` and `modelsInfoHideTextOnly` all map onto `ModelEditor.update` / `.remove`. Opt-in moves to `settings.modelsInfoUrl`. Mapping (`mapping.ts`) is pure — untouched. **Check whether v2's `Model.Info` still shapes `limit`/`cost` the same way**; `capabilities.tools` / `capabilities.input` / `capabilities.output` replaced v1's `tool_call` / `modalities`, so `mapping.ts`'s output fields need re-checking against the v2 schema even though its logic is sound. **Done (#138).** |
| 4 | `opencode-devtools` | `config` + `tool` map | `ctx.tool.transform` | Cheapest of the tool packages. `catalog.ts` + `schema.ts`'s `toJsonSchema()` already emit what `editor.add({ input })` wants. Groups gating moves to `ctx.options.groups`. **Done (#133).** |
| 5 | `opencode-browser` | `config` + `tool` map + `event` | `ctx.tool.transform` + `ctx.event.subscribe` | Same tool story as devtools, ×34 tools. The bridge/broker/transport layer never touched the plugin API and does not move. `dispose` → the Effect scope's cleanup; make sure the WS host closes on scope exit. **Done (#135).** |
| 6 | `opencode-oauth2` | `chat.headers` (+ `config` via provider-sync) | `ctx.session.hook("model.request")` + `ctx.integration` | **The hard one.** The plan expected the five auth flows to move to the integration domain (they did not; see the note below the table) (`IntegrationOAuthMethodRegistration` has `authorize` / `refresh` / `label`), and well-known origins are Integrations in v2. Needs its own ADR for the integration model + the reshaped `.well-known/opencode` manifest (`{ auth, config, remote_config }`, command-based `auth`). **Done (#139).** |
| 7 | `opencode-repo-auth` | `config` + `chat.headers` | `ctx.provider.transform` + `ctx.session.hook("model.request")` | Opt-in `options.meta.repoAuth` → `settings.repoAuth`. The oauth2-collision guard needs re-deriving from the provider editor rather than the config object. `git.ts` is off-disk and untouched. **Done (#136).** |
| 8 | `opencode-otel` | `config`, `chat.message`, `chat.params`, `permission.ask`, `tool.execute.*`, `event` | `ctx.session.hook("context")`, `ctx.permission.hook("evaluate")`, `ctx.tool.hook(…)`, `ctx.event.subscribe` | Widest hook surface in the suite, but it is an observer — no transforms except the `model.request` header injection for W3C trace-context (replacing the `provider.options.fetch` wrapper). Check whether v2's `experimental.openTelemetry` config field (accepted-but-ignored per the migration guide) changes anything for us. **Done (#137).** |
| 9 | `opencode-lightbridge` | all of the above | all of the above | Last, because it composes `provider-sync` + `core-otel` and must not regress ADR-0017's shared root-token cache or the scheduler-ownership guard. **Done (#139).** |
| 10 | `opencode-code-index` | `config` + `tool` map | `ctx.tool.transform` | **Dropped, not ported (#132).** Private, experimental and never published; removed at the cutover together with its `docs/` and `plans/` pages, and ADR-0002 to ADR-0004 were withdrawn. |

Note on the oauth2 row: the plan expected the five auth flows to move to `ctx.integration`. They did
not — see [ADR-0020](../docs/adr/0020-oauth2-integration-domain.md): v1 oauth2 never had an `auth` hook, and
the host's OAuth method model (host-owned credential, host-driven flow) collides with the plugin-owned
token cache and single-use refresh tokens.

Unaffected: `opencode-auth-core` (never imported the plugin API), `opencode-browser-mcp`,
`opencode-devtools-mcp` (MCP servers — they consume catalogs, not hooks), and
`apps/browser-extension`.

`packages/plugin-bundle` rolls up oauth2 and must keep `effect` **external** — bundling it breaks
the host-instance sharing that logging depends on.

## PR sequence

One PR per concern, per `CLAUDE.md`. Implementation and docs landed together. Steps 1 to 7 are merged
(PR numbers from `git log` on `main`); step 8 is open.

1. ✅ **ratelimit + ADR-0019 + this plan** — the reference port. #128 (the commit message cites the
   ADR as 0018; it was renumbered to 0019 on merge).
2. ✅ **core-otel + provider-sync** — the two engines. core-otel: #134 (it owns its recorder input
   types, no plugin API dependency). provider-sync: ported with oauth2 and lightbridge in #139,
   because its helpers (`collectManagedProviders`, `mergeDiscoveredModels`, `propagateCachedBearer`)
   are only meaningful against the consumers.
3. ✅ **models-info** (#138), **devtools** (#133), **browser** (#135).
4. ✅ **oauth2 + its integration/well-known ADR** — #139, with
   [ADR-0020](../docs/adr/0020-oauth2-integration-domain.md).
5. ✅ **repo-auth** (#136), **otel** (#137).
6. ✅ **lightbridge** — #139, together with oauth2 and provider-sync.
7. ✅ **code-index removal** — #132. Dropped rather than ported.
8. ⏳ **Release PR**: one version line across all sixteen packages (the next line is `0.18.0`; `0.17.1`
   was the last v1 release), the consolidated `CHANGELOG.md` entry, and a top-level migration guide
   for users (config renames, per-plugin `options`, `settings.<key>` opt-ins). Per-package READMEs
   already carry a "Migrating from v1" table.

## Open questions — resolved

- **Does `.well-known/opencode`'s v2 `remote_config` replace what this suite does with a served
  `config` block?** No, not as the default. It is a host feature with nothing for a plugin to
  implement, and it does not fit the headline OAuth2-managed gateway: the config is fetched before
  plugins load, so the plugin's bearer does not exist yet. The served `config` block stays, renamed
  (`plugins`, `providers`, `settings`); `remote_config` suits gateways that authenticate with a static
  key through `auth.env`. Decided in [ADR-0020](../docs/adr/0020-oauth2-integration-domain.md).
- **Does v2's integration model subsume `repo-auth`'s project-scoped exchange?** No. repo-auth was
  ported with the exchange kept on `@vymalo/opencode-auth-core`'s `TokenRuntime` and the "model b"
  renewal unchanged ([ADR-0011](../docs/adr/0011-repo-auth-project-id-token-exchange.md)); it uses
  `integrationID` only as an ownership marker in its oauth2-conflict guard
  (`packages/opencode-repo-auth/src/config.ts`). ADR-0020 gives the reasons for oauth2 (a host-owned
  credential versus a plugin-owned cache and single-use refresh tokens) and applies them to the
  `gateway` / `register` modules of lightbridge; it does not name repo-auth, so the repo-auth answer
  is evidenced by the port rather than stated in an ADR.
- **`code-index`: port or delete?** Deleted (#132). It was private, experimental and never published;
  ADR-0002 to ADR-0004 are withdrawn.
