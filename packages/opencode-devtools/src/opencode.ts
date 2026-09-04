import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";

import { DEFAULT_GROUPS, TOOL_GROUPS } from "./catalog.js";
import {
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  fromOpenCodeLogLevel,
  type LogFields,
  LOG_LEVEL_PRIORITY,
  type Logger,
  type LogLevel
} from "./logging.js";
import type { ToolGroup } from "./schema.js";
import { createDevtoolsTools, type ToolDeps } from "./tools.js";
import type { DevtoolsPluginOptions, ResolvedDevtoolsOptions } from "./types.js";

const PLUGIN_SERVICE_NAME = "opencode-devtools-plugin";

const DEFAULTS = {
  httpTimeoutMs: 30_000
} as const;

type OpenCodeConfig = Parameters<NonNullable<Hooks["config"]>>[0];

export interface DevtoolsPluginFactoryOptions {
  /** Inject a logger (defaults to the OpenCode-piped logger). */
  logger?: Logger;
  /** Inject the tool execution context (clock / randomness / fetch) for tests. */
  context?: ToolDeps["context"];
}

function resolveGroups(raw: unknown): ToolGroup[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_GROUPS];
  }
  const valid = raw.filter((g): g is ToolGroup => TOOL_GROUPS.includes(g as ToolGroup));
  // An explicit but empty/invalid list falls back to the defaults rather than
  // registering nothing — matches the browser plugin's behaviour.
  return valid.length > 0 ? Array.from(new Set(valid)) : [...DEFAULT_GROUPS];
}

export function resolveOptions(raw: PluginOptions | undefined): ResolvedDevtoolsOptions {
  const opts = (raw ?? {}) as DevtoolsPluginOptions;
  return {
    enabled: opts.enabled !== false,
    groups: resolveGroups(opts.groups),
    http: {
      allowPrivateNetwork: opts.http?.allowPrivateNetwork === true,
      timeoutMs:
        typeof opts.http?.timeoutMs === "number" && opts.http.timeoutMs > 0
          ? opts.http.timeoutMs
          : DEFAULTS.httpTimeoutMs
    }
  };
}

/**
 * Pipe plugin logs through OpenCode's `client.app.log` so they show up in the
 * host's structured log stream, with the JSON console as a reliable fallback.
 * Mirrors `@vymalo/opencode-browser`.
 *
 * No plugin in this suite may write to the user's TUI (ADR-0014, superseding
 * ADR-0013's narrower per-plugin scope) — even a warn/error about a failed
 * tool call stays off the terminal and goes only to the host log via
 * `client.app.log` at its true level. Set `VYMALO_PLUGIN_CONSOLE_LOG=1`
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
    const hostLevel = level === "trace" ? "debug" : level;
    void client.app
      .log({
        body: { service: PLUGIN_SERVICE_NAME, level: hostLevel, message: event, extra: fields }
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

export function createDevtoolsPlugin(factoryOptions: DevtoolsPluginFactoryOptions = {}): Plugin {
  return async ({ client }, pluginOptions) => {
    let currentLogLevel: LogLevel = DEFAULT_LOG_LEVEL;
    const logger = factoryOptions.logger ?? createOpenCodeLogger(client, () => currentLogLevel);

    const options = resolveOptions(pluginOptions);

    if (!options.enabled) {
      logger.info("devtools_plugin_disabled", {});
      return {
        config: async (config: OpenCodeConfig) => {
          currentLogLevel = fromOpenCodeLogLevel(config.logLevel) ?? DEFAULT_LOG_LEVEL;
        }
      };
    }

    logger.info("devtools_plugin_enabled", { groups: options.groups });

    const tools = createDevtoolsTools({
      options,
      logger,
      context: factoryOptions.context
    });

    return {
      tool: tools,
      config: async (config: OpenCodeConfig) => {
        currentLogLevel = fromOpenCodeLogLevel(config.logLevel) ?? DEFAULT_LOG_LEVEL;
      }
    };
  };
}

export const OpencodeDevtoolsPlugin: Plugin = createDevtoolsPlugin();

export default OpencodeDevtoolsPlugin;
