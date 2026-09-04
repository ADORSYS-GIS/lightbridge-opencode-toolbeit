import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";

import { resolveOptions } from "./config.js";
import {
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  fromOpenCodeLogLevel,
  type LogFields,
  LOG_LEVEL_PRIORITY,
  type Logger,
  type LogLevel
} from "./logging.js";
import { createCodeIndexTools, type MakeRepo, type OpenStore } from "./tools.js";
import type { CodeIndexPluginOptions } from "./types.js";

const PLUGIN_SERVICE_NAME = "opencode-code-index-plugin";

type OpenCodeConfig = Parameters<NonNullable<Hooks["config"]>>[0];

export interface CodeIndexFactoryOptions {
  /** Inject a logger (defaults to the OpenCode-piped logger). */
  logger?: Logger;
  /** Inject the store opener (tests use in-memory DuckDB). */
  openStore?: OpenStore;
  /** Inject the GitRepo factory (tests). */
  makeRepo?: MakeRepo;
}

/**
 * Pipe plugin logs through OpenCode's `client.app.log` with a JSON console
 * fallback — mirrors the pattern used across the @vymalo suite.
 *
 * No plugin in this suite may write to the user's TUI (ADR-0014, superseding
 * ADR-0013's narrower per-plugin scope) — even a warn/error about the
 * indexer's own failure stays off the terminal and goes only to the host log
 * via `client.app.log` at its true level. Set `VYMALO_PLUGIN_CONSOLE_LOG=1`
 * (`consoleAll` below) to opt back into the console mirror for every level.
 */
function createOpenCodeLogger(client: PluginInput["client"], getMinLevel: () => LogLevel): Logger {
  const fallback = createJsonConsoleLogger("debug");
  const consoleAll = /^(1|true|yes|on)$/i.test(process.env.VYMALO_PLUGIN_CONSOLE_LOG ?? "");

  const write = (level: LogLevel, event: string, fields?: LogFields) => {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[getMinLevel()]) {
      return;
    }
    if (consoleAll) {
      fallback[level](event, fields);
    }
    void client.app
      .log({ body: { service: PLUGIN_SERVICE_NAME, level, message: event, extra: fields } })
      .catch(() => {
        /* best-effort */
      });
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields)
  };
}

export function createCodeIndexPlugin(factoryOptions: CodeIndexFactoryOptions = {}): Plugin {
  return async ({ client }, pluginOptions) => {
    let currentLogLevel: LogLevel = DEFAULT_LOG_LEVEL;
    const logger = factoryOptions.logger ?? createOpenCodeLogger(client, () => currentLogLevel);
    const options = resolveOptions(pluginOptions as CodeIndexPluginOptions | undefined);

    const syncLogLevel = async (config: OpenCodeConfig) => {
      currentLogLevel = fromOpenCodeLogLevel(config.logLevel) ?? DEFAULT_LOG_LEVEL;
    };

    if (!options.enabled) {
      logger.info("code_index_disabled", {});
      return { config: syncLogLevel };
    }

    const tools = createCodeIndexTools({
      options,
      logger,
      openStore: factoryOptions.openStore,
      makeRepo: factoryOptions.makeRepo
    });

    return {
      tool: tools,
      config: syncLogLevel
    };
  };
}

export const OpencodeCodeIndexPlugin: Plugin = createCodeIndexPlugin();

export default OpencodeCodeIndexPlugin;
