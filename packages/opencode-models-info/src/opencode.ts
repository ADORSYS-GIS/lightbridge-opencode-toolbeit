import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";

import { type CacheStore, FileCacheStore } from "./cache.js";
import {
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  fromOpenCodeLogLevel,
  type LogFields,
  LOG_LEVEL_PRIORITY,
  type Logger,
  type LogLevel
} from "./logging.js";
import { type EnrichConfigInput, enrichConfig, startCacheRefreshSchedulers } from "./plugin.js";
import type { SchedulerHandle } from "./scheduler.js";

const PLUGIN_SERVICE_NAME = "opencode-models-info-plugin";

type OpenCodeConfig = Parameters<NonNullable<Hooks["config"]>>[0];

export interface OpenCodePluginFactoryOptions {
  logger?: Logger;
  fetchImpl?: typeof fetch;
  cache?: CacheStore;
  cacheDir?: string;
}

/**
 * Pipe plugin logs through OpenCode's `client.app.log` so they show up in the
 * host's structured log stream, with the JSON console as a reliable fallback.
 * Mirrors the pattern used by `@vymalo/opencode-oauth2`.
 */
function createOpenCodeLogger(client: PluginInput["client"], getMinLevel: () => LogLevel): Logger {
  const fallback = createJsonConsoleLogger("debug");
  // OpenCode already captures plugin logs via client.app.log (and filters them
  // by its own log level). Mirroring every event to stdout on top of that just
  // floods the terminal, so only mirror warn/error to the JSON console by
  // default; set VYMALO_PLUGIN_CONSOLE_LOG=1 to restore full console output.
  const consoleAll = /^(1|true|yes|on)$/i.test(process.env.VYMALO_PLUGIN_CONSOLE_LOG ?? "");

  const write = (level: LogLevel, event: string, fields?: LogFields) => {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[getMinLevel()]) {
      return;
    }
    if (consoleAll || level === "warn" || level === "error") {
      fallback[level](event, fields);
    }
    // OpenCode's log API has no `trace` tier — fold it into the host's most
    // verbose level (`debug`) for the wire payload; our own `getMinLevel()`
    // gate above is what actually unlocks trace events.
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
        /* best-effort */
      });
  };

  return {
    trace: (event, fields) => write("trace", event, fields),
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields)
  };
}

export function createOpencodeModelsInfoPlugin(
  factoryOptions: OpenCodePluginFactoryOptions = {}
): Plugin {
  return async ({ client }) => {
    let currentLogLevel: LogLevel = DEFAULT_LOG_LEVEL;
    const logger = factoryOptions.logger ?? createOpenCodeLogger(client, () => currentLogLevel);
    const cache = factoryOptions.cache ?? new FileCacheStore(factoryOptions.cacheDir);
    let schedulers: SchedulerHandle[] = [];

    const stopSchedulers = (): void => {
      for (const handle of schedulers) {
        handle.stop();
      }
      schedulers = [];
    };

    return {
      config: async (config: OpenCodeConfig) => {
        currentLogLevel = fromOpenCodeLogLevel(config.logLevel) ?? DEFAULT_LOG_LEVEL;
        const deps = { cache, logger, fetchImpl: factoryOptions.fetchImpl };
        await enrichConfig(config as EnrichConfigInput, deps);

        // OpenCode re-runs `config` on certain config edits — stop the
        // schedulers from any prior run before starting fresh ones so a
        // rebuilt config never leaks a duplicate background timer per
        // provider.
        stopSchedulers();
        schedulers = startCacheRefreshSchedulers(config as EnrichConfigInput, deps);
      },
      dispose: async () => {
        stopSchedulers();
      }
    };
  };
}

export const OpencodeModelsInfoPlugin = createOpencodeModelsInfoPlugin();

export default OpencodeModelsInfoPlugin;
