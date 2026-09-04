import { hostname } from "node:os";

import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";

import {
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  LOG_LEVEL_PRIORITY,
  type AuthServerConfig,
  type LogFields,
  type Logger,
  type LogLevel
} from "@vymalo/opencode-auth-core/lib";

import {
  buildResource,
  createProviders,
  deferredAttribute,
  describeError,
  fromOpenCodeLogLevel,
  installTracePropagation,
  readVcsInfo,
  resolveOtelConfig,
  TelemetryRecorder,
  type DeferredAttribute,
  type EnvSource,
  type ExporterFactories,
  type OtelPluginOptions,
  type PropagationConfigInput,
  type ResolvedOtelConfig,
  type TelemetryProviders,
  type TokenSource,
  type VcsInfo
} from "@vymalo/opencode-core-otel";

import {
  needsProjectToken,
  parseLightbridgeOptions,
  type ParsedLightbridgeOptions
} from "./config.js";
import {
  LightbridgeRuntime,
  type LightbridgeRuntimeFactory,
  type LightbridgeRuntimeLike,
  type LightbridgeRuntimeOptions
} from "./plugin.js";

const PLUGIN_SERVICE_NAME = "opencode-lightbridge-plugin";

type OpenCodeConfig = Parameters<NonNullable<Hooks["config"]>>[0];

export interface LightbridgePluginFactoryOptions {
  logger?: Logger;
  /** Shared-runtime HTTP client (auth-core `TokenRuntime`). Tests only. */
  fetchImpl?: typeof fetch;
  onAuthorizationUrl?: (url: string) => Promise<void> | void;
  /** Override the shared-runtime cache root (defaults to the OS cache dir). */
  cacheDir?: string;
  tokenExpirySkewMs?: number;
  /**
   * Build the shared `LightbridgeRuntimeLike` for `(auth, projectId)`.
   * Defaults to a real `LightbridgeRuntime`; tests substitute a spy/fake so
   * neither module ever touches the network.
   */
  runtimeFactory?: LightbridgeRuntimeFactory;

  // --- OTEL test seams (mirror `@vymalo/opencode-otel`'s factory options) ---
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
 * Pipe plugin logs through OpenCode's `client.app.log`, JSON console as
 * fallback. Mirrors every other plugin in the suite.
 *
 * This plugin mutates the session (gateway bearer injection, OTEL export), so
 * it might seem like a warn/error printed to the terminal would be actionable
 * developer feedback. It is not: no plugin in this suite may write to the
 * user's TUI (ADR-0014, superseding ADR-0013's narrower per-plugin scope).
 * Every record still reaches `client.app.log` at its true level, so the
 * diagnostic is always persisted to OpenCode's own log — just not on the
 * developer's screen. Set `VYMALO_PLUGIN_CONSOLE_LOG=1` (`consoleAll` below)
 * to opt back into the console mirror for every level.
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
        // best-effort forwarding; console logger is the reliable fallback.
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

function safeHostname(): string | undefined {
  try {
    return hostname() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Drain buffered telemetry on process exit — same rationale as
 * `@vymalo/opencode-otel`'s `registerExitHandlers`: the plugin API has no
 * dispose hook, so without this a short CLI invocation loses everything still
 * in a batch processor.
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
    for (const attribute of deferred) {
      attribute.abandon();
    }
    void providers.shutdown().catch((error) => {
      logger.warn("lightbridge_otel_shutdown_failed", { error: describeError(error) });
    });
  };
  process.once("beforeExit", drain);
  process.once("SIGINT", drain);
  process.once("SIGTERM", drain);
}

/**
 * Build the umbrella's `TokenSource` for `createProviders`'s 5th argument: an
 * async factory over the SHARED runtime, superseding otel's standalone
 * `tokenCommand` path entirely (ADR-0012 — one credential, not two seams).
 * Never throws — the OTLP exporters require that of every `headers()` call —
 * so an exchange failure resolves `headers()` to `undefined` rather than `{}`.
 * That distinction is load-bearing (ADR-0015): `{}` would still let the export
 * fire with no `Authorization` header, which the collector then rejects at the
 * network — the exact bug this fixes. `undefined` tells the shared gate in
 * `@vymalo/opencode-core-otel` (`withFailureLogging`) to skip the export
 * before any request goes out, so a logged-out session goes quiet instead of
 * hammering the collector with 401s. Because `headers()` is called fresh on
 * every export attempt, a later successful login resumes exporting on the
 * next flush with nothing to restart.
 */
function createRuntimeTokenSource(runtime: LightbridgeRuntimeLike): TokenSource {
  return {
    headers: async (): Promise<Record<string, string> | undefined> => {
      try {
        const token = await runtime.getProjectToken({ interactive: false });
        return { Authorization: `${token.tokenType || "Bearer"} ${token.accessToken}` };
      } catch {
        return undefined;
      }
    },
    // v1: no-op. The project token is short-lived and `getProjectToken`
    // re-exchanges on its own expiry check every call — there is no stale
    // in-memory copy for `invalidate` to drop, unlike the credential-helper
    // `TokenSource` this replaces. See ADR-0012.
    invalidate: () => {}
  };
}

/**
 * Build the gateway's `chat.headers` hook: inject the shared project bearer
 * on `gateway.providers` only, fail closed on any exchange error (mirrors
 * `@vymalo/opencode-repo-auth`'s `chat.headers`).
 */
function createGatewayChatHeaders(
  providers: ReadonlySet<string>,
  runtime: LightbridgeRuntimeLike,
  logger: Logger
): NonNullable<Hooks["chat.headers"]> {
  return async (input, output) => {
    const providerId = input.model?.providerID ?? input.provider?.info?.id;
    if (!providerId || !providers.has(providerId)) {
      logger.trace("lightbridge_gateway_chat_headers_skipped", { providerId });
      return;
    }
    try {
      const token = await runtime.getProjectToken({ interactive: true });
      output.headers.Authorization = `${token.tokenType || "Bearer"} ${token.accessToken}`;
      logger.trace("lightbridge_gateway_bearer_injected", { providerId });
    } catch {
      logger.trace("lightbridge_gateway_no_bearer", { providerId });
    }
  };
}

interface OtelModule {
  config: ResolvedOtelConfig;
  recorder: TelemetryRecorder;
}

/**
 * `otel.tokenCommand`/`tokenHeader`/`tokenPrefix` are accepted by
 * `parseLightbridgeOptions` (they are just `OtelPluginOptions` fields) but
 * never take effect here: `buildOtelModule` always injects the shared
 * runtime-backed `TokenSource` whenever a runtime exists, and that injected
 * source unconditionally wins over `config.tokenCommand` in
 * `createProviders` (see `providers.ts`). Silently accepting and ignoring a
 * credential-helper config is exactly the kind of no-op ADR-0015 calls out, so
 * this logs once at `debug` rather than staying quiet — `debug` because it's
 * an informational no-op, not a warning-worthy misconfiguration, and no
 * plugin in this suite prints to the terminal by default anyway (ADR-0014).
 */
function warnIfTokenCommandConfigIgnored(
  otel: OtelPluginOptions,
  env: EnvSource,
  logger: Logger
): void {
  const explicit =
    otel.tokenCommand !== undefined ||
    otel.tokenHeader !== undefined ||
    otel.tokenPrefix !== undefined ||
    Boolean(env.OPENCODE_OTEL_TOKEN_COMMAND) ||
    Boolean(env.OPENCODE_OTEL_TOKEN_HEADER) ||
    Boolean(env.OPENCODE_OTEL_TOKEN_PREFIX);
  if (explicit) {
    logger.debug("lightbridge_otel_token_command_ignored", {
      reason:
        "otel.tokenCommand/tokenHeader/tokenPrefix are ignored — the shared lightbridge auth token always supersedes them"
    });
  }
}

/**
 * Build the OTEL module: resource, providers (with the runtime-backed
 * `TokenSource` when a shared runtime is available), recorder and exit
 * handlers. Mirrors `@vymalo/opencode-otel`'s `createOtelPlugin` orchestration
 * verbatim, minus the standalone `tokenCommand` seam.
 */
async function buildOtelModule(
  input: PluginInput,
  otelConfig: ResolvedOtelConfig,
  logger: Logger,
  factoryOptions: LightbridgePluginFactoryOptions,
  runtime: LightbridgeRuntimeLike | undefined
): Promise<OtelModule> {
  const version = deferredAttribute(factoryOptions.deferredTimeoutMs);
  const branch = deferredAttribute(factoryOptions.deferredTimeoutMs);
  if (factoryOptions.hostInfo?.version) {
    version.settle(factoryOptions.hostInfo.version);
  }

  const vcs: VcsInfo = otelConfig.collectVcs
    ? await readVcsInfo(input.worktree ?? input.directory).catch(() => ({}))
    : {};
  if (vcs.ref) {
    branch.settle(vcs.ref);
  }

  const resource = buildResource(otelConfig, {
    version: version.value,
    hostname: factoryOptions.hostInfo?.hostname ?? safeHostname(),
    projectName: input.project?.id,
    directory: input.directory,
    worktree: input.worktree,
    branch: branch.value,
    vcs
  });

  const tokenSource = runtime ? createRuntimeTokenSource(runtime) : undefined;
  const providers = createProviders(
    otelConfig,
    resource,
    logger,
    factoryOptions.exporters,
    tokenSource
  );
  const recorder = new TelemetryRecorder({
    providers,
    config: otelConfig,
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

  logger.info("lightbridge_otel_enabled", {
    serviceName: otelConfig.serviceName,
    exporters: otelConfig.exporters,
    endpoint: otelConfig.endpoint,
    runtimeBackedTokenSource: Boolean(tokenSource)
  });

  return { config: otelConfig, recorder };
}

function registerOtelHooks(hooks: Hooks, otel: OtelModule): void {
  const { recorder } = otel;
  hooks.event = async ({ event }) => {
    recorder.onEvent(event);
  };
  hooks["chat.message"] = async (chatInput, chatOutput) => {
    recorder.onChatMessage(chatInput, chatOutput);
  };
  hooks["tool.execute.before"] = async (toolInput) => {
    recorder.onToolBefore(toolInput);
  };
  hooks["tool.execute.after"] = async (toolInput, toolOutput) => {
    recorder.onToolAfter(toolInput, toolOutput);
  };
  hooks["chat.params"] = async (paramsInput, paramsOutput) => {
    recorder.onChatParams(paramsInput, paramsOutput);
  };
  hooks["permission.ask"] = async (permissionInput, permissionOutput) => {
    recorder.onPermissionAsk(permissionInput, permissionOutput);
  };
  hooks["experimental.text.complete"] = async (textInput, textOutput) => {
    recorder.onTextComplete(textInput, textOutput);
  };
  hooks["experimental.compaction.autocontinue"] = async (compactionInput, compactionOutput) => {
    recorder.onCompactionAutocontinue(compactionInput, compactionOutput);
  };
}

/**
 * Create the `@vymalo/opencode-lightbridge` umbrella plugin (ADR-0012): ONE
 * shared `TokenRuntime`, built once from `auth`, drives both the gateway
 * bearer (`gateway`) and the OTEL export credential (`otel`) — each module
 * activates independently, and an `auth`-only config is a valid, inert
 * plugin. `config` runs both modules' config-time logic (host log level +
 * OTEL trace propagation); `chat.headers` is the gateway injector;
 * `event`/`chat.message`/`tool.execute.*`/`chat.params`/`permission.ask`/
 * `experimental.*` are the OTEL observers.
 */
export function createLightbridgePlugin(
  factoryOptions: LightbridgePluginFactoryOptions = {}
): Plugin {
  return async (input: PluginInput, pluginOptions?: PluginOptions) => {
    let currentLogLevel: LogLevel = DEFAULT_LOG_LEVEL;
    const logger =
      factoryOptions.logger ?? createOpenCodeLogger(input.client, () => currentLogLevel);

    let parsed: ParsedLightbridgeOptions;
    try {
      parsed = parseLightbridgeOptions(pluginOptions);
    } catch (error) {
      // A malformed config must not take down every other plugin's load —
      // log and return inert hooks rather than throwing out of the factory.
      logger.error("lightbridge_config_invalid", { error: describeError(error) });
      return {
        config: async (hostConfig: OpenCodeConfig) => {
          currentLogLevel = fromOpenCodeLogLevel(hostConfig.logLevel) ?? DEFAULT_LOG_LEVEL;
        }
      };
    }

    const wantsProjectToken = needsProjectToken(parsed);
    if (wantsProjectToken && !parsed.projectId) {
      // `projectId` is fully optional — the exchange omits `project_id` and the
      // backend mints a token for the caller's default project (ADR-0012).
      logger.info("lightbridge_default_project", {
        gateway: Boolean(parsed.gateway),
        otel: Boolean(parsed.otel)
      });
    }

    // The ONE shared runtime (ADR-0012) — constructed exactly once whenever a
    // module (gateway/otel) needs a token, reused by both the gateway injector
    // and the OTEL token source below. `projectId` is optional (undefined →
    // default project). `undefined` runtime only for an auth-only config.
    const buildRuntime: LightbridgeRuntimeFactory =
      factoryOptions.runtimeFactory ??
      ((auth: AuthServerConfig, pid: string | undefined, options: LightbridgeRuntimeOptions) =>
        new LightbridgeRuntime(auth, pid, options));
    const sharedRuntime: LightbridgeRuntimeLike | undefined = wantsProjectToken
      ? buildRuntime(parsed.auth, parsed.projectId, {
          logger,
          fetchImpl: factoryOptions.fetchImpl,
          onAuthorizationUrl: factoryOptions.onAuthorizationUrl,
          cacheDir: factoryOptions.cacheDir,
          tokenExpirySkewMs: factoryOptions.tokenExpirySkewMs
        })
      : undefined;

    const hooks: Hooks = {};

    // ---- gateway module ----
    // `sharedRuntime` is always defined here: it is built whenever `gateway`
    // or `otel` is configured (`wantsProjectToken`).
    if (parsed.gateway && sharedRuntime) {
      hooks["chat.headers"] = createGatewayChatHeaders(
        new Set(parsed.gateway.providers),
        sharedRuntime,
        logger
      );
    }

    // ---- otel module ----
    let otel: OtelModule | undefined;
    if (parsed.otel) {
      const otelConfig = resolveOtelConfig(parsed.otel, factoryOptions.env ?? process.env);
      if (otelConfig.active) {
        warnIfTokenCommandConfigIgnored(parsed.otel, factoryOptions.env ?? process.env, logger);
        otel = await buildOtelModule(input, otelConfig, logger, factoryOptions, sharedRuntime);
        registerOtelHooks(hooks, otel);
      } else {
        logger.info("lightbridge_otel_inactive", {
          enabled: otelConfig.enabled,
          reason: otelConfig.enabled ? "no_exporter_configured" : "disabled"
        });
      }
    }

    hooks.config = async (hostConfig: OpenCodeConfig) => {
      currentLogLevel = fromOpenCodeLogLevel(hostConfig.logLevel) ?? DEFAULT_LOG_LEVEL;
      if (otel?.config.propagateTraceContext) {
        const activeOtel = otel;
        const wrapped = installTracePropagation(hostConfig as PropagationConfigInput, {
          getContext: () => activeOtel.recorder.currentChatContext(),
          logger
        });
        logger.debug("lightbridge_otel_trace_propagation_ready", { providerCount: wrapped });
      }
    };

    logger.info("lightbridge_plugin_ready", {
      gateway: Boolean(hooks["chat.headers"]),
      otel: Boolean(otel),
      projectId: parsed.projectId ?? (wantsProjectToken ? "(default)" : undefined)
    });

    return hooks;
  };
}

export const LightbridgePlugin: Plugin = createLightbridgePlugin();

export default LightbridgePlugin;

export type { OpenCodeConfig };
