import { hostname } from "node:os";

import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";

import { type EnvSource, resolveOtelConfig } from "./config.js";
import {
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  fromOpenCodeLogLevel,
  type LogFields,
  LOG_LEVEL_PRIORITY,
  type Logger,
  type LogLevel
} from "./logging.js";
import { installTracePropagation, type PropagationConfigInput } from "./propagation.js";
import {
  buildResource,
  createProviders,
  describeError,
  type ExporterFactories,
  type TelemetryProviders
} from "./providers.js";
import { TelemetryRecorder } from "./recorder.js";

const PLUGIN_SERVICE_NAME = "opencode-otel-plugin";

type OpenCodeConfig = Parameters<NonNullable<Hooks["config"]>>[0];

export interface OtelPluginFactoryOptions {
  logger?: Logger;
  /** Injected environment; defaults to `process.env`. */
  env?: EnvSource;
  /** Substitute exporters (tests use in-memory ones). */
  exporters?: ExporterFactories;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /** Skip `beforeExit`/`SIGINT`/`SIGTERM` registration (tests). */
  registerProcessHandlers?: boolean;
  /** Override the resolved host metadata (hostname, version) for tests. */
  hostInfo?: { hostname?: string; version?: string };
}

/**
 * Pipe plugin logs through OpenCode's `client.app.log` so they show up in the
 * host's structured log stream, with the JSON console as a reliable fallback.
 * Mirrors the rest of the suite.
 *
 * Note this is the plugin's *own* diagnostic logging — entirely separate from
 * the OTLP logs signal it exports.
 */
function createOpenCodeLogger(client: PluginInput["client"], getMinLevel: () => LogLevel): Logger {
  const fallback = createJsonConsoleLogger("debug");
  const consoleAll = /^(1|true|yes|on)$/i.test(process.env.VYMALO_PLUGIN_CONSOLE_LOG ?? "");

  const write = (level: LogLevel, event: string, fields?: LogFields) => {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[getMinLevel()]) {
      return;
    }
    if (consoleAll || level === "warn" || level === "error") {
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

/**
 * Drain buffered telemetry on process exit. The plugin API has no dispose hook,
 * so without this a short CLI invocation loses everything still in a batch
 * processor. Handlers are registered once and never keep the loop alive.
 */
function registerExitHandlers(providers: TelemetryProviders, logger: Logger): void {
  let done = false;
  const drain = () => {
    if (done) {
      return;
    }
    done = true;
    void providers.shutdown().catch((error) => {
      logger.warn("otel_shutdown_failed", { error: describeError(error) });
    });
  };
  process.once("beforeExit", drain);
  process.once("SIGINT", drain);
  process.once("SIGTERM", drain);
}

export function createOtelPlugin(factoryOptions: OtelPluginFactoryOptions = {}): Plugin {
  return async (input: PluginInput, pluginOptions?: PluginOptions) => {
    let currentLogLevel: LogLevel = DEFAULT_LOG_LEVEL;
    const logger =
      factoryOptions.logger ?? createOpenCodeLogger(input.client, () => currentLogLevel);

    const config = resolveOtelConfig(pluginOptions, factoryOptions.env ?? process.env);

    if (!config.active) {
      // No endpoint and no explicit exporter means the plugin was installed but
      // never configured — cost nothing rather than half-initializing.
      logger.info("otel_plugin_inactive", {
        enabled: config.enabled,
        reason: config.enabled ? "no_exporter_configured" : "disabled"
      });
      return {
        config: async (hostConfig: OpenCodeConfig) => {
          currentLogLevel = fromOpenCodeLogLevel(hostConfig.logLevel) ?? DEFAULT_LOG_LEVEL;
        }
      };
    }

    const resource = buildResource(config, {
      version: factoryOptions.hostInfo?.version,
      hostname: factoryOptions.hostInfo?.hostname ?? safeHostname(),
      projectName: input.project?.id,
      directory: input.directory,
      worktree: input.worktree
    });

    const providers = createProviders(config, resource, logger, factoryOptions.exporters);
    const recorder = new TelemetryRecorder({
      providers,
      config,
      logger,
      now: factoryOptions.now
    });

    if (factoryOptions.registerProcessHandlers !== false) {
      registerExitHandlers(providers, logger);
    }

    logger.info("otel_plugin_enabled", {
      serviceName: config.serviceName,
      exporters: config.exporters,
      endpoint: config.endpoint,
      includeSessionId: config.includeSessionId,
      filteredTools: [...config.filteredTools]
    });

    return {
      config: async (hostConfig: OpenCodeConfig) => {
        currentLogLevel = fromOpenCodeLogLevel(hostConfig.logLevel) ?? DEFAULT_LOG_LEVEL;
        if (config.propagateTraceContext) {
          const wrapped = installTracePropagation(hostConfig as PropagationConfigInput, {
            getContext: () => recorder.currentChatContext(),
            logger
          });
          logger.debug("otel_trace_propagation_ready", { providerCount: wrapped });
        }
      },
      event: async ({ event }) => {
        recorder.onEvent(event);
      },
      "chat.message": async (chatInput, chatOutput) => {
        recorder.onChatMessage(chatInput, chatOutput);
      },
      "tool.execute.before": async (toolInput) => {
        recorder.onToolBefore(toolInput);
      },
      "tool.execute.after": async (toolInput, toolOutput) => {
        recorder.onToolAfter(toolInput, toolOutput);
      }
    };
  };
}

function safeHostname(): string | undefined {
  try {
    return hostname() || undefined;
  } catch {
    return undefined;
  }
}

export const OpencodeOtelPlugin = createOtelPlugin();

export default OpencodeOtelPlugin;
