import type { Plugin, PluginInput } from "@opencode-ai/plugin";

import {
  createJsonConsoleLogger,
  type LogFields,
  LOG_LEVEL_PRIORITY,
  type Logger,
  type LogLevel
} from "@vymalo/opencode-auth-core/lib";
import {
  collectManagedProviders,
  mergeDiscoveredModels,
  propagateCachedBearer,
  runtimeSignature,
  type OpenCodeConfig
} from "@vymalo/opencode-provider-sync/lib";
import { DEFAULT_LOG_LEVEL, type OAuth2ModelSyncConfigInput } from "./config.js";
import { OAuth2ModelSyncPlugin } from "./plugin.js";
import { createResponsesRepairFetch } from "./responses-repair.js";

/**
 * Map OpenCode's host-level `config.logLevel` (uppercase `"DEBUG" | "INFO" |
 * "WARN" | "ERROR"`) to this plugin's internal `LogLevel`. Unknown / missing
 * values fall through to `undefined` so the caller can apply its own default —
 * we never throw on the OpenCode-supplied value because the host owns
 * validation of its own field.
 *
 * Note: host `DEBUG` unlocks this plugin's most-verbose `"trace"` tier (there
 * is no separate host `TRACE` level), so running OpenCode with
 * `--log-level DEBUG` surfaces the `oauth2_*` trace events emitted across the
 * runtime hot paths.
 */
export function fromOpenCodeLogLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  switch (value.toUpperCase()) {
    case "DEBUG":
      return "trace";
    case "INFO":
      return "info";
    case "WARN":
      return "warn";
    case "ERROR":
      return "error";
    default:
      return undefined;
  }
}

// oauth2's own config-key literals — where it looks for a provider's OAuth
// extension (`provider.options.<key>`) and its top-level server list
// (`pluginConfig.<key>.servers`). These are oauth2's public config surface and
// deliberately stay here rather than in the shared
// `@vymalo/opencode-provider-sync` engine (a future consumer, e.g.
// lightbridge, will pass its own).
const OAUTH_OPTIONS_KEYS = ["oauth2", "oauth2ModelSync"] as const;
const OAUTH_PLUGIN_CONFIG_KEY = "oauth2ModelSync";
const PLUGIN_SERVICE_NAME = "opencode-oauth2-plugin";

interface RuntimeState {
  runtime?: OAuth2ModelSyncPlugin;
  signature?: string;
  managedProviderIds: Set<string>;
}

export interface OpenCodePluginFactoryOptions {
  logger?: Logger;
  fetchImpl?: typeof fetch;
  onAuthorizationUrl?: (url: string) => Promise<void> | void;
  cacheDir?: string;
}

function createOpenCodeLogger(client: PluginInput["client"], getMinLevel: () => LogLevel): Logger {
  // Bypass createJsonConsoleLogger's own filter so the gate stays driven by
  // the current value of getMinLevel() — the level can change once the plugin
  // sees `pluginConfig.oauth2ModelSync.logLevel` during the `config` hook.
  const fallback = createJsonConsoleLogger("debug");
  // OpenCode already captures plugin logs via client.app.log (and filters them
  // by its own log level). No plugin in this suite may write to the user's
  // TUI (ADR-0014, superseding ADR-0013's narrower per-plugin scope) — even a
  // warn/error about the caller's own expired token or failed exchange stays
  // off the terminal and goes only to the host log, so only mirror to the
  // JSON console when explicitly requested; set VYMALO_PLUGIN_CONSOLE_LOG=1
  // to restore full console output for debugging.
  const consoleAll = /^(1|true|yes|on)$/i.test(process.env.VYMALO_PLUGIN_CONSOLE_LOG ?? "");

  const write = (
    level: "trace" | "debug" | "info" | "warn" | "error",
    event: string,
    fields?: LogFields
  ) => {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[getMinLevel()]) {
      return;
    }

    if (consoleAll) {
      fallback[level](event, fields);
    }

    // OpenCode's host log API has no dedicated `trace` level, so forward our
    // most-verbose tier as host `debug` (the trace gate above already ran, so
    // host-side filtering only sees records we intended to surface). The
    // original event name still carries the `oauth2_*` prefix, so the record
    // remains identifiable in the host log stream.
    const hostLevel = level === "trace" ? "debug" : level;

    void client.app
      .log({
        body: {
          service: PLUGIN_SERVICE_NAME,
          level: hostLevel,
          message: event,
          extra: fields
        }
      })
      .catch(() => {
        // Best-effort forwarding; console logger is the reliable fallback.
      });
  };

  return {
    trace(event, fields) {
      write("trace", event, fields);
    },
    debug(event, fields) {
      write("debug", event, fields);
    },
    info(event, fields) {
      write("info", event, fields);
    },
    warn(event, fields) {
      write("warn", event, fields);
    },
    error(event, fields) {
      write("error", event, fields);
    }
  };
}

export function createOpencodeOauth2Plugin(
  factoryOptions: OpenCodePluginFactoryOptions = {}
): Plugin {
  return async ({ client }) => {
    // The plugin defers to OpenCode's own `config.logLevel` for filter
    // decisions. Until the first `config` hook fires we don't know what the
    // host picked, so we start at the package default (`"info"`) and update
    // the holder once we see the real value.
    let currentLogLevel: LogLevel = DEFAULT_LOG_LEVEL;
    const logger = factoryOptions.logger ?? createOpenCodeLogger(client, () => currentLogLevel);

    const state: RuntimeState = {
      runtime: undefined,
      signature: undefined,
      managedProviderIds: new Set<string>()
    };

    return {
      config: async (config: OpenCodeConfig) => {
        // Apply the host's logLevel BEFORE walking the config: parsing emits
        // `plugin_config_server_invalid` / `plugin_config_server_missing_fields`
        // warnings via `logger`, and those need to be filtered against the
        // user's chosen threshold — not the bootstrap default.
        currentLogLevel = fromOpenCodeLogLevel(config.logLevel) ?? DEFAULT_LOG_LEVEL;
        logger.trace("oauth2_config_hook_start", {
          logLevel: currentLogLevel,
          hostLogLevel: typeof config.logLevel === "string" ? config.logLevel : undefined
        });
        const managed = collectManagedProviders(config, logger, {
          pluginConfigKey: OAUTH_PLUGIN_CONFIG_KEY,
          optionKeys: OAUTH_OPTIONS_KEYS,
          createResponsesRepairFetch
        });
        logger.trace("oauth2_config_hook_collected_providers", {
          managedCount: managed.servers.length,
          providerIds: managed.servers.map((server) => server.id)
        });

        if (managed.servers.length === 0) {
          logger.trace("oauth2_config_hook_no_managed_providers", {});
          state.runtime?.stop();
          state.runtime = undefined;
          state.signature = undefined;
          state.managedProviderIds = new Set<string>();
          return;
        }

        const pluginConfig: OAuth2ModelSyncConfigInput = {
          servers: managed.servers,
          cacheNamespace: "opencode-oauth2-model-sync",
          logLevel: currentLogLevel
        };

        const signature = runtimeSignature(pluginConfig);
        if (!state.runtime || state.signature !== signature) {
          logger.trace("oauth2_runtime_rebuild", {
            reason: state.runtime ? "signature_changed" : "first_build",
            serverCount: pluginConfig.servers.length
          });
          state.runtime?.stop();

          state.runtime = new OAuth2ModelSyncPlugin(pluginConfig, {
            logger,
            fetchImpl: factoryOptions.fetchImpl,
            onAuthorizationUrl: factoryOptions.onAuthorizationUrl,
            cacheDir: factoryOptions.cacheDir
          });

          await state.runtime.initialize();
          await state.runtime.start({ warmup: true });
          state.signature = signature;
        } else {
          logger.trace("oauth2_runtime_reused", { serverCount: pluginConfig.servers.length });
        }

        state.managedProviderIds = new Set<string>(managed.servers.map((server) => server.id));

        const providers = (config.provider ??= {});
        const runtime = state.runtime;
        // Each provider is independent (distinct config object, distinct
        // runtime state), and propagation can do a token-refresh round trip
        // (up to httpTimeoutMs). Fan out so one slow IdP doesn't serialize
        // startup behind the others. propagateCachedBearer swallows its own
        // errors, so this never rejects.
        await Promise.all(
          [...state.managedProviderIds].map((providerId) => {
            const providerConfig = providers[providerId];
            if (!providerConfig) {
              return undefined;
            }

            const models = runtime.getServerModels(providerId);
            logger.trace("oauth2_config_hook_provider_models", {
              providerId,
              modelCount: models.length
            });
            if (models.length > 0) {
              mergeDiscoveredModels(providerConfig, models);
            }

            // Stamp the cached bearer onto `options.headers.Authorization` so
            // subsequent `config` hooks (e.g. @vymalo/opencode-models-info
            // fetching a metadata endpoint) can inherit it without depending
            // on this plugin. `chat.headers` still overwrites per-request with
            // a freshly-ensured token, so a stale value here can only ever
            // affect other config-time consumers — never the actual inference
            // call. We never clobber a user-set Authorization header.
            return propagateCachedBearer(providerConfig, providerId, runtime, logger);
          })
        );
        logger.trace("oauth2_config_hook_finished", {
          managedCount: state.managedProviderIds.size
        });
      },
      "chat.headers": async (input, output) => {
        const providerId = input.model?.providerID ?? input.provider?.info?.id;
        if (!providerId || !state.runtime || !state.managedProviderIds.has(providerId)) {
          logger.trace("oauth2_chat_headers_skipped", {
            providerId,
            managed: providerId ? state.managedProviderIds.has(providerId) : false
          });
          return;
        }

        logger.trace("oauth2_chat_headers_ensure_token", { providerId });
        const token = await state.runtime.ensureAccessToken(providerId);
        output.headers.Authorization = `${token.tokenType || "Bearer"} ${token.accessToken}`;
        logger.trace("oauth2_chat_headers_bearer_injected", {
          providerId,
          present: Boolean(token.accessToken),
          tokenType: token.tokenType || "Bearer"
        });

        if (state.runtime.getServerModels(providerId).length === 0) {
          logger.trace("oauth2_chat_headers_lazy_sync", { providerId });
          void state.runtime.syncServer(providerId);
        }
      }
    };
  };
}

export const OpencodeOauth2Plugin: Plugin = createOpencodeOauth2Plugin();

export default OpencodeOauth2Plugin;
