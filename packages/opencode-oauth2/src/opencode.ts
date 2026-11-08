import { Plugin } from "@opencode/plugin/effect";
import {
  collectManagedProviders,
  mergeDiscoveredModels,
  type ProviderServerConfigInput,
  type ProviderEditor,
  propagateCachedBearer,
  resolveCachedBearer,
  runtimeSignature
} from "@vymalo/opencode-provider-sync/lib";
import { Effect } from "effect";

import type { OAuth2ModelSyncConfigInput } from "./config.js";
import {
  captureHostContext,
  createEffectLogger,
  DEFAULT_LOG_LEVEL,
  type Logger,
  type LogLevel,
  resolveLogLevel,
  runInHost
} from "./logging.js";
import { OAuth2ModelSyncPlugin } from "./plugin.js";
import { repairResponsesResponse } from "./responses-repair.js";

/** Stable plugin id. v2 requires one and keys storage/registrations by it. */
export const PLUGIN_ID = "vymalo.oauth2";

// oauth2's own config-key literals: where it looks for a provider's OAuth
// extension (`provider.settings.<key>`). The server list is the plugin's own
// `ctx.options.servers` — v2 has no `pluginConfig`, and a plugin's options are
// already its own scope. These deliberately stay here rather than in the shared
// `@vymalo/opencode-provider-sync` engine (lightbridge passes its own).
const OAUTH_SETTINGS_KEYS = ["oauth2", "oauth2ModelSync"] as const;
// Part of the on-disk cache path (`<root>/opencode-oauth2/<namespace>`): changing
// it forces every user to log in again, and breaks the cache shared with
// lightbridge (ADR-0017).
const CACHE_NAMESPACE = "opencode-oauth2-model-sync";

/** Test/embedder handle onto the runtime the plugin builds in the background. */
export interface OAuth2RuntimeHandle {
  /** Resolves once every queued runtime build + warmup (and its reload) has finished. */
  settled(): Promise<void>;
  /** The current engine, or `undefined` before the first build / with no managed provider. */
  runtime(): OAuth2ModelSyncPlugin | undefined;
}

export interface OpenCodePluginFactoryOptions {
  /** Override the logger (tests). Defaults to the host's Effect logger. */
  logger?: Logger;
  fetchImpl?: typeof fetch;
  onAuthorizationUrl?: (url: string) => Promise<void> | void;
  cacheDir?: string;
  /** Observe the background runtime (tests). */
  onRuntime?: (handle: OAuth2RuntimeHandle) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Make a managed provider self-describing. Other plugins (repo-auth's
 * double-management guard) can only see the provider record — never this
 * plugin's private `ctx.options` — so every provider we manage must carry a
 * `settings.oauth2` / `settings.oauth2ModelSync` block. A provider declared with
 * its own block already does and is left untouched; one materialised purely from
 * `options.servers` gets a marker. The marker has no issuer/clientId/scopes, so
 * `parseOAuthExtension` ignores it on the next pass.
 */
function markManaged(editor: ProviderEditor, providerId: string): void {
  const settings = editor.get(providerId)?.provider.settings as Record<string, unknown> | undefined;
  const has = (key: string) => {
    const value = settings?.[key];
    return typeof value === "object" && value !== null && !Array.isArray(value);
  };
  if (OAUTH_SETTINGS_KEYS.some(has)) {
    return;
  }
  editor.update(providerId, (provider) => {
    provider.settings = {
      ...(provider.settings ?? {}),
      oauth2: { managed: true, source: "options.servers" }
    } as typeof provider.settings;
  });
}

/**
 * Build the OpenCode v2 plugin.
 *
 * Three registrations, one per lifecycle seam:
 *
 *  - `provider.transform` registers the managed providers (from `options.servers`
 *    and `settings.oauth2` opt-ins), merges the discovered models and stamps the
 *    cached bearer on `Provider.Info.headers` for config-time consumers. It is
 *    synchronous and cheap by contract: token and sync work happens in a queued
 *    background build, which calls `provider.reload()` when it has something new.
 *  - `session.hook("model.request")` injects a freshly ensured bearer per request.
 *  - `session.hook("http.response")` runs the Responses-API SSE repair for
 *    providers that opted into `responseApi`.
 *
 * All five auth flows stay on the plugin-owned `TokenRuntime` inside the sync
 * engine — see ADR-0020 for why none of them is an `ctx.integration` method.
 */
export function createOpencodeOauth2Plugin(
  factoryOptions: OpenCodePluginFactoryOptions = {}
): Plugin.Plugin {
  return Plugin.define({
    id: PLUGIN_ID,
    effect: Effect.fn(function* (ctx) {
      // v2 gives plugins no `config` object, so the v1 `config.logLevel` channel
      // is gone: take this plugin's own `logLevel` option first, then the host's
      // `OPENCODE_LOG_LEVEL`.
      const logLevel: LogLevel =
        resolveLogLevel(ctx.options.logLevel) ??
        resolveLogLevel(process.env.OPENCODE_LOG_LEVEL) ??
        DEFAULT_LOG_LEVEL;

      // Captured INSIDE the plugin's own Effect so records reach the host's file
      // logger and not the terminal (ADR-0014 / ADR-0019).
      const hostContext = yield* captureHostContext;
      const logger: Logger =
        factoryOptions.logger ?? createEffectLogger(hostContext, () => logLevel);

      let runtime: OAuth2ModelSyncPlugin | undefined;
      let runtimeSig: string | undefined;
      let requestedSig: string | undefined;
      let managedIds = new Set<string>();
      let responseApiIds = new Set<string>();
      // providerId -> "Bearer …", refreshed out of band and applied by the
      // (synchronous) provider transform.
      const bearers = new Map<string, string>();
      const stamped = new Map<string, string>();
      // Serialises runtime builds so a burst of transform passes cannot race.
      let chain: Promise<void> = Promise.resolve();

      const reloadProviders = (): Promise<void> => runInHost(hostContext, ctx.provider.reload());

      const safeModels = (providerId: string): Array<{ id: string; displayName: string }> => {
        try {
          return runtime?.getServerModels(providerId) ?? [];
        } catch {
          // The runtime was built for a different server set; the next build
          // will catch up.
          return [];
        }
      };

      async function applyServers(servers: ProviderServerConfigInput[]): Promise<void> {
        if (servers.length === 0) {
          logger.trace("oauth2_no_managed_providers", {});
          runtime?.stop();
          runtime = undefined;
          runtimeSig = undefined;
          return;
        }

        const pluginConfig: OAuth2ModelSyncConfigInput = {
          servers,
          cacheNamespace: CACHE_NAMESPACE,
          logLevel
        };
        const signature = runtimeSignature(pluginConfig);
        if (runtime && runtimeSig === signature) {
          logger.trace("oauth2_runtime_reused", { serverCount: servers.length });
          return;
        }

        logger.trace("oauth2_runtime_rebuild", {
          reason: runtime ? "signature_changed" : "first_build",
          serverCount: servers.length
        });
        runtime?.stop();
        runtime = undefined;
        runtimeSig = undefined;

        const next = new OAuth2ModelSyncPlugin(pluginConfig, {
          logger,
          fetchImpl: factoryOptions.fetchImpl,
          onAuthorizationUrl: factoryOptions.onAuthorizationUrl,
          cacheDir: factoryOptions.cacheDir
        });
        await next.initialize();
        runtime = next;
        runtimeSig = signature;
        await next.start({ warmup: true });

        // Each provider is independent and resolving a bearer can mean a token
        // refresh round trip, so fan out. resolveCachedBearer swallows its own
        // errors, so this never rejects.
        await Promise.all(
          servers.map(async (server) => {
            const authorization = await resolveCachedBearer(server.id, next, logger);
            if (authorization) {
              bearers.set(server.id, authorization);
            } else {
              bearers.delete(server.id);
            }
          })
        );

        // Models and bearers are now known: ask the host to re-run transforms.
        await reloadProviders();
      }

      function scheduleApply(servers: ProviderServerConfigInput[]): void {
        const signature = runtimeSignature({ servers });
        if (signature === requestedSig) {
          return;
        }
        requestedSig = signature;
        chain = chain
          .then(() => applyServers(servers))
          .catch((error) => {
            // A failed build must not wedge the queue, and must be retried by the
            // next distinct server set.
            runtimeSig = undefined;
            logger.error("oauth2_runtime_build_failed", { error: errorMessage(error) });
          });
      }

      factoryOptions.onRuntime?.({
        async settled() {
          let current: Promise<void>;
          do {
            current = chain;
            await current;
          } while (current !== chain);
        },
        runtime: () => runtime
      });

      yield* ctx.provider.transform((editor) => {
        logger.trace("oauth2_provider_transform_start", {});
        let servers: ProviderServerConfigInput[];
        try {
          servers = collectManagedProviders(editor, ctx.options, logger, {
            settingsKeys: OAUTH_SETTINGS_KEYS
          }).servers;
        } catch (error) {
          // Invalid user config (e.g. a bad redirectPort). v1 threw out of the
          // `config` hook; here a throw would take down the whole provider
          // pipeline for every plugin, so report it and manage nothing instead.
          logger.error("oauth2_config_invalid", { error: errorMessage(error) });
          servers = [];
        }

        managedIds = new Set(servers.map((server) => server.id));
        responseApiIds = new Set(
          servers.filter((server) => server.responseApi).map((server) => server.id)
        );
        logger.trace("oauth2_provider_transform_collected", {
          managedCount: servers.length,
          providerIds: [...managedIds]
        });

        for (const server of servers) {
          markManaged(editor, server.id);
          const models = safeModels(server.id);
          if (models.length > 0) {
            mergeDiscoveredModels(editor, server.id, models);
          }
          // Stamp the cached bearer onto `Provider.Info.headers.Authorization`
          // so a later consumer (models-info fetching a metadata endpoint) can
          // inherit it. `model.request` re-injects a fresh token per request, so
          // a stale value here can only ever affect that consumer — never the
          // inference call. A user-set Authorization header is never clobbered.
          propagateCachedBearer(editor, server.id, bearers.get(server.id), logger, stamped);
        }

        scheduleApply(servers);
      });

      yield* ctx.session.hook("model.request", (event) =>
        Effect.tryPromise({
          try: async () => {
            // Wait for any in-flight build/warmup: a request racing startup must
            // not leave the managed provider without a bearer.
            await chain;
            const providerId = event.model.providerID;
            if (!runtime || !managedIds.has(providerId)) {
              logger.trace("oauth2_model_request_skipped", {
                providerId,
                managed: managedIds.has(providerId)
              });
              return;
            }

            logger.trace("oauth2_model_request_ensure_token", { providerId });
            const token = await runtime.ensureAccessToken(providerId);
            // Header names are case-insensitive: drop any variant already set
            // (e.g. the placeholder key's `Authorization`, or a lowercase copy).
            for (const key of Object.keys(event.headers)) {
              if (key.toLowerCase() === "authorization") {
                delete event.headers[key];
              }
            }
            event.headers.Authorization = `${token.tokenType || "Bearer"} ${token.accessToken}`;
            logger.trace("oauth2_model_request_bearer_injected", {
              providerId,
              present: Boolean(token.accessToken),
              tokenType: token.tokenType || "Bearer"
            });

            if (runtime.getServerModels(providerId).length === 0) {
              logger.trace("oauth2_model_request_lazy_sync", { providerId });
              const active = runtime;
              void active.syncServer(providerId).then(async () => {
                if (active.getServerModels(providerId).length > 0) {
                  await reloadProviders();
                }
              });
            }
          },
          catch: (error) => error
        }).pipe(
          // Fail closed: with no usable token the request must not go out under
          // a placeholder or stale credential. The cause is logged first.
          Effect.tapError((error) =>
            Effect.sync(() =>
              logger.error("oauth2_model_request_token_failed", {
                providerId: event.model.providerID,
                error: errorMessage(error)
              })
            )
          ),
          Effect.orDie
        )
      );

      yield* ctx.session.hook("http.response", (event) =>
        Effect.sync(() => {
          if (!responseApiIds.has(event.model.providerID)) {
            return;
          }
          event.response = repairResponsesResponse(event.request, event.response);
        })
      );

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtime?.stop();
        })
      );
    })
  });
}

export const OpencodeOauth2Plugin: Plugin.Plugin = createOpencodeOauth2Plugin();

export default OpencodeOauth2Plugin;
