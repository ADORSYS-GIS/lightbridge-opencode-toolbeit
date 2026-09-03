import { hostname } from "node:os";

import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";

import {
  buildResource,
  createJsonConsoleLogger,
  createProviders,
  DEFAULT_LOG_LEVEL,
  type DeferredAttribute,
  deferredAttribute,
  describeError,
  type EnvSource,
  type ExporterFactories,
  fromOpenCodeLogLevel,
  installTracePropagation,
  type LogFields,
  LOG_LEVEL_PRIORITY,
  type Logger,
  type LogLevel,
  type PropagationConfigInput,
  readVcsInfo,
  resolveOtelConfig,
  TelemetryRecorder,
  type TelemetryProviders,
  type VcsInfo
} from "@vymalo/opencode-core-otel";

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
  /** How long a deferred resource attribute waits for its event. */
  deferredTimeoutMs?: number;
}

/**
 * Pipe plugin logs through OpenCode's `client.app.log` so they show up in the
 * host's structured log stream, with the JSON console as a reliable fallback.
 * Mirrors the rest of the suite.
 *
 * Note this is the plugin's *own* diagnostic logging — entirely separate from
 * the OTLP logs signal it exports.
 *
 * Unlike the rest of the suite, this logger never mirrors `warn`/`error` to
 * the console: a telemetry exporter must never interrupt the work it
 * observes with terminal output. Every record still reaches `client.app.log`
 * at its true level, so the diagnostic (a failed export, an expired
 * `tokenCommand`, …) is always persisted to OpenCode's own log — just not on
 * the developer's screen. See ADR-0013. Set `VYMALO_PLUGIN_CONSOLE_LOG=1`
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

/**
 * Drain buffered telemetry on process exit. The plugin API has no dispose hook,
 * so without this a short CLI invocation loses everything still in a batch
 * processor. Handlers are registered once and never keep the loop alive.
 */
function registerExitHandlers(
  providers: TelemetryProviders,
  logger: Logger,
  deferred: DeferredAttribute[]
): void {
  let done = false;
  const drain = () => {
    if (done) {
      return;
    }
    done = true;
    // Settle any still-pending resource attribute first. Exporters await those
    // promises, and their timers are `unref`'d — so on `beforeExit` the timer
    // may never fire and the shutdown would hang, losing everything buffered.
    for (const attribute of deferred) {
      attribute.abandon();
    }
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

    // `service.version` and the git branch only ever reach a plugin as events
    // (`installation.updated` / `vcs.branch.updated`), which arrive after the
    // resource is built. Deferred attributes bridge that, with a bounded wait
    // so a host that never emits them cannot stall the first export.
    const version = deferredAttribute(factoryOptions.deferredTimeoutMs);
    const branch = deferredAttribute(factoryOptions.deferredTimeoutMs);
    if (factoryOptions.hostInfo?.version) {
      version.settle(factoryOptions.hostInfo.version);
    }

    // Read the checkout straight off disk. This is both richer and more
    // reliable than waiting for `vcs.branch.updated`: it arrives before the
    // first export instead of racing the deferral window, and it carries the
    // remote and revision, which no event reports at all. The event stays as a
    // fallback — `settle` keeps the first value, so whichever lands first wins.
    const vcs: VcsInfo = config.collectVcs
      ? await readVcsInfo(input.worktree ?? input.directory).catch(() => ({}))
      : {};
    if (vcs.ref) {
      branch.settle(vcs.ref);
    }

    const resource = buildResource(config, {
      version: version.value,
      hostname: factoryOptions.hostInfo?.hostname ?? safeHostname(),
      projectName: input.project?.id,
      directory: input.directory,
      worktree: input.worktree,
      branch: branch.value,
      vcs
    });

    const providers = createProviders(config, resource, logger, factoryOptions.exporters);
    const recorder = new TelemetryRecorder({
      providers,
      config,
      logger,
      now: factoryOptions.now,
      resourceSinks: {
        version: (value) => version.settle(value),
        branch: (value) => branch.settle(value)
      }
    });

    if (factoryOptions.registerProcessHandlers !== false) {
      registerExitHandlers(providers, logger, [version, branch]);
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
      },
      "chat.params": async (paramsInput, paramsOutput) => {
        recorder.onChatParams(paramsInput, paramsOutput);
      },
      "permission.ask": async (permissionInput, permissionOutput) => {
        recorder.onPermissionAsk(permissionInput, permissionOutput);
      },
      "experimental.text.complete": async (textInput, textOutput) => {
        recorder.onTextComplete(textInput, textOutput);
      },
      "experimental.compaction.autocontinue": async (compactionInput, compactionOutput) => {
        recorder.onCompactionAutocontinue(compactionInput, compactionOutput);
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

export const OpencodeOtelPlugin: Plugin = createOtelPlugin();

export default OpencodeOtelPlugin;
