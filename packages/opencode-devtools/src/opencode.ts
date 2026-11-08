import { Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";

import {
  captureHostContext,
  createEffectLogger,
  DEFAULT_LOG_LEVEL,
  type Logger,
  type LogLevel,
  resolveLogLevel
} from "./logging.js";
import { resolveOptions } from "./options.js";
import { registerDevtoolsTools, type ToolDeps } from "./tools.js";

/** Stable plugin id. v2 requires one and keys storage/registrations by it. */
export const PLUGIN_ID = "vymalo.devtools";

export interface DevtoolsPluginFactoryOptions {
  /** Override the logger (tests). Defaults to the host's Effect logger. */
  logger?: Logger;
  /** Inject the tool execution context (clock / randomness / fetch) for tests. */
  context?: ToolDeps["context"];
}

/**
 * Build the OpenCode v2 plugin.
 *
 * One registration: `tool.transform` adds the catalog tools for the enabled
 * `groups` (each group a tool namespace). v1's `config` hook only tracked the
 * host log level; v2 gives plugins no `config` object, so the level comes from
 * this plugin's own `logLevel` option, then `OPENCODE_LOG_LEVEL`.
 */
export function createDevtoolsPlugin(
  factoryOptions: DevtoolsPluginFactoryOptions = {}
): Plugin.Plugin {
  return Plugin.define({
    id: PLUGIN_ID,
    effect: Effect.fn(function* (ctx) {
      const logLevel: LogLevel =
        resolveLogLevel(ctx.options.logLevel) ??
        resolveLogLevel(process.env.OPENCODE_LOG_LEVEL) ??
        DEFAULT_LOG_LEVEL;

      // Capture the host Effect context *inside* the plugin's fiber so records
      // reach the host logger, not Effect's default one (the terminal —
      // ADR-0014).
      let logger = factoryOptions.logger;
      if (!logger) {
        const hostContext = yield* captureHostContext;
        logger = createEffectLogger(hostContext, () => logLevel);
      }

      const options = resolveOptions(ctx.options);

      if (!options.enabled) {
        logger.info("devtools_plugin_disabled", {});
        return;
      }

      logger.info("devtools_plugin_enabled", { groups: options.groups });

      const deps: ToolDeps = { options, logger, context: factoryOptions.context };
      yield* ctx.tool.transform((editor) => {
        registerDevtoolsTools(editor, deps);
      });
    })
  });
}

export const OpencodeDevtoolsPlugin: Plugin.Plugin = createDevtoolsPlugin();

export default OpencodeDevtoolsPlugin;
