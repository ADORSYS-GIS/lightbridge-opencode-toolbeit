import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";

import {
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  fromOpenCodeLogLevel,
  type LogFields,
  LOG_LEVEL_PRIORITY,
  type Logger,
  type LogLevel
} from "./logging.js";
import { type InstallConfigInput, installRateLimiter } from "./plugin.js";

const PLUGIN_SERVICE_NAME = "opencode-ratelimit-plugin";

type OpenCodeConfig = Parameters<NonNullable<Hooks["config"]>>[0];

export interface OpenCodePluginFactoryOptions {
  logger?: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Pipe plugin logs through OpenCode's `client.app.log` so they show up in the
 * host's structured log stream, with the JSON console as a reliable fallback.
 * Mirrors the pattern used by `@vymalo/opencode-oauth2` and `-models-info`.
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
    // The host's log API has no `trace` level — fold it onto `debug` so the most
    // verbose tier still reaches the structured stream (it's already gated above
    // by `getMinLevel`, which DEBUG maps to `trace`).
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

export function createOpencodeRatelimitPlugin(
  factoryOptions: OpenCodePluginFactoryOptions = {}
): Plugin {
  return async ({ client }) => {
    let currentLogLevel: LogLevel = DEFAULT_LOG_LEVEL;
    const logger = factoryOptions.logger ?? createOpenCodeLogger(client, () => currentLogLevel);

    return {
      config: async (config: OpenCodeConfig) => {
        currentLogLevel = fromOpenCodeLogLevel(config.logLevel) ?? DEFAULT_LOG_LEVEL;
        installRateLimiter(config as InstallConfigInput, {
          logger,
          fetchImpl: factoryOptions.fetchImpl,
          now: factoryOptions.now,
          sleep: factoryOptions.sleep
        });
      }
    };
  };
}

export const OpencodeRatelimitPlugin: Plugin = createOpencodeRatelimitPlugin();

export default OpencodeRatelimitPlugin;
