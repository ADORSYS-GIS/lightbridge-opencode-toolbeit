import { hostname } from "node:os";

import { defaultTextMapSetter } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { Plugin } from "@opencode/plugin/effect";
import { Effect, Stream } from "effect";

import {
  buildResource,
  createProviders,
  deferredAttribute,
  type EnvSource,
  type ExporterFactories,
  type Logger,
  type LogLevel,
  readVcsInfo,
  registerExitHandlers,
  resolveOtelConfig,
  TelemetryRecorder,
  type VcsInfo
} from "@vymalo/opencode-core-otel";

import { createEventBridge, EVENT_TYPES } from "./events.js";
import {
  captureHostContext,
  createEffectLogger,
  DEFAULT_LOG_LEVEL,
  resolveLogLevel
} from "./logging.js";

/** Stable plugin id. v2 requires one and keys storage/registrations by it. */
export const PLUGIN_ID = "vymalo.otel";

const propagator = new W3CTraceContextPropagator();

export interface OtelPluginFactoryOptions {
  logger?: Logger;
  /** Injected environment; defaults to `process.env`. */
  env?: EnvSource;
  /** Substitute exporters (tests use in-memory ones). */
  exporters?: ExporterFactories;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /** Skip the `beforeExit`/`SIGINT`/`SIGTERM` exit handlers (tests). See ADR-0018. */
  registerProcessHandlers?: boolean;
  /** Override the resolved host metadata (hostname, version) for tests. */
  hostInfo?: { hostname?: string; version?: string };
  /** How long a deferred resource attribute waits for its event. */
  deferredTimeoutMs?: number;
  /** Observe the recorder the plugin built (tests). */
  onRecorder?: (recorder: TelemetryRecorder) => void;
}

/**
 * Build the OpenCode v2 plugin.
 *
 * An observer: no tools, no server, no mutation except the `traceparent` header
 * on primary model requests. Registrations:
 *
 *  - `event.subscribe` — a `Stream` forked into the plugin scope; closing the
 *    scope interrupts it. Translated to the engine by {@link createEventBridge}.
 *  - `session.hook("prompt" | "context")` — user prompts and generation params.
 *  - `session.hook("model.request")` — W3C trace-context propagation. v1 wrapped
 *    `provider.options.fetch`; v2's `Provider.Info` has no such field.
 *  - `tool.hook("execute.before" | "execute.after")` — tool spans and results.
 *  - `permission.hook("evaluate")` — permission decisions config resolved on its own.
 */
export function createOtelPlugin(factoryOptions: OtelPluginFactoryOptions = {}): Plugin.Plugin {
  return Plugin.define({
    id: PLUGIN_ID,
    effect: Effect.fn(function* (ctx) {
      const env = factoryOptions.env ?? process.env;
      // v2 gives plugins no `config` object, so the v1 `config.logLevel`
      // channel is gone: take this plugin's own `logLevel` option first, then
      // the host's `OPENCODE_LOG_LEVEL`.
      const logLevel: LogLevel =
        resolveLogLevel(ctx.options.logLevel) ??
        resolveLogLevel(env.OPENCODE_LOG_LEVEL) ??
        DEFAULT_LOG_LEVEL;

      let logger = factoryOptions.logger;
      if (!logger) {
        // Must run inside the plugin's own fiber: a bare `Effect.runFork` would
        // log to the terminal and violate ADR-0014.
        const hostContext = yield* captureHostContext;
        logger = createEffectLogger(hostContext, () => logLevel);
      }
      const log = logger;

      const config = resolveOtelConfig(ctx.options, env);

      if (!config.active) {
        // No endpoint and no explicit exporter means the plugin was installed but
        // never configured — cost nothing rather than half-initializing.
        log.info("otel_plugin_inactive", {
          enabled: config.enabled,
          reason: config.enabled ? "no_exporter_configured" : "disabled"
        });
        return;
      }

      // The git branch only ever reaches a plugin as an event
      // (`vcs.branch.updated`), after the resource is built. A deferred
      // attribute bridges that, with a bounded wait so a host that never emits
      // it cannot stall the first export. The host version is known up front
      // (`ctx.app.version`), so `service.version` no longer needs an event.
      const version = deferredAttribute(factoryOptions.deferredTimeoutMs);
      const branch = deferredAttribute(factoryOptions.deferredTimeoutMs);
      const hostVersion = factoryOptions.hostInfo?.version ?? ctx.app.version;
      if (hostVersion) {
        version.settle(hostVersion);
      }

      // Read the checkout straight off disk. This is both richer and more
      // reliable than waiting for `vcs.branch.updated`, and it carries the
      // remote and revision, which no event reports at all. The event stays as a
      // fallback — `settle` keeps the first value, so whichever lands first wins.
      const vcs: VcsInfo = config.collectVcs
        ? yield* Effect.promise(() =>
            readVcsInfo(ctx.location.project.directory || ctx.location.directory).catch(
              (): VcsInfo => ({})
            )
          )
        : {};
      if (vcs.ref) {
        branch.settle(vcs.ref);
      }

      const resource = buildResource(config, {
        version: version.value,
        hostname: factoryOptions.hostInfo?.hostname ?? safeHostname(),
        projectName: ctx.location.project.id,
        directory: ctx.location.directory,
        worktree: ctx.location.project.directory,
        branch: branch.value,
        vcs
      });

      const providers = createProviders(config, resource, log, factoryOptions.exporters);
      const recorder = new TelemetryRecorder({
        providers,
        config,
        logger: log,
        now: factoryOptions.now,
        resourceSinks: { branch: (value) => branch.settle(value) }
      });
      factoryOptions.onRecorder?.(recorder);

      if (factoryOptions.registerProcessHandlers !== false) {
        // Flush on exit, and hand the default signal action back (ADR-0018). The scope
        // finalizer is deliberately not used to shut down: these handlers, the
        // `location.shutdown` event and `session.idle` already cover the exit paths.
        registerExitHandlers(providers, log, [version, branch], { eventPrefix: "otel" });
      }

      log.info("otel_plugin_enabled", {
        serviceName: config.serviceName,
        exporters: config.exporters,
        endpoint: config.endpoint,
        includeSessionId: config.includeSessionId,
        filteredTools: [...config.filteredTools]
      });

      const bridge = createEventBridge({
        recorder,
        logger: log,
        onBranch: (value) => branch.settle(value)
      });

      // Telemetry must never break the host: a throwing observer is logged and dropped.
      const guard = (hook: string, run: () => void): Effect.Effect<void> =>
        Effect.sync(() => {
          try {
            run();
          } catch (error) {
            log.warn("otel_hook_failed", {
              hook,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        });

      // The event stream is a `Stream`, not an async iterator with a signal.
      // Forking it into the plugin scope is what ties its lifetime to the
      // plugin: closing the scope interrupts the fiber, which closes the
      // subscription.
      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: EVENT_TYPES }).pipe(
          Stream.runForEach((event) => Effect.sync(() => bridge.handle(event))),
          Effect.catchCause(() => Effect.sync(() => log.warn("otel_event_stream_failed", {})))
        )
      );

      yield* ctx.session.hook("prompt", (event) =>
        guard("prompt", () => {
          const known = bridge.defaults(event.sessionID);
          // Shape only: part types and text length. The text itself is never kept.
          const parts: Array<{ type: string; text?: string }> = [
            { type: "text", text: event.prompt.text },
            ...(event.prompt.files ?? []).map(() => ({ type: "file" }))
          ];
          recorder.onChatMessage(
            { sessionID: event.sessionID, agent: known?.agent, model: known?.model },
            { parts }
          );
        })
      );

      yield* ctx.session.hook("context", (event) =>
        guard("context", () => {
          bridge.noteContext(event.sessionID, event.agent, event.model);
          recorder.onChatParams(
            { sessionID: event.sessionID, agent: event.agent, model: event.model },
            {
              temperature: event.options.temperature,
              topP: event.options.topP,
              topK: event.options.topK,
              maxTokens: event.options.maxTokens
            }
          );
        })
      );

      if (config.propagateTraceContext) {
        yield* ctx.session.hook("model.request", (event) =>
          guard("model.request", () => {
            // Auxiliary requests (title, compaction, generate) can run beside the
            // primary one, where "the single in-flight chat" would be ambiguous.
            if (event.kind !== "primary") {
              return;
            }
            const context = recorder.currentChatContext();
            if (!context) {
              return;
            }
            const carrier: Record<string, string> = {};
            propagator.inject(context, carrier, defaultTextMapSetter);
            const present = new Set(Object.keys(event.headers).map((key) => key.toLowerCase()));
            for (const [key, value] of Object.entries(carrier)) {
              // Never clobber an upstream traceparent — whatever set it knows more than we do.
              if (!present.has(key.toLowerCase())) {
                event.headers[key] = value;
              }
            }
          })
        );
        log.debug("otel_trace_propagation_ready", {});
      }

      yield* ctx.tool.hook("execute.before", (event) =>
        guard("execute.before", () => {
          recorder.onToolBefore({ tool: event.tool, sessionID: event.sessionID, id: event.id });
        })
      );

      yield* ctx.tool.hook("execute.after", (event) =>
        guard("execute.after", () => {
          recorder.onToolAfter(
            { tool: event.tool, sessionID: event.sessionID, id: event.id, status: event.status },
            event.status === "completed" ? { content: event.result.content } : undefined
          );
        })
      );

      yield* ctx.permission.hook("evaluate", (event) =>
        guard("evaluate", () => {
          recorder.onPermissionAsk(
            { sessionID: event.sessionID, type: event.action },
            { status: event.effect }
          );
        })
      );
    })
  });
}

function safeHostname(): string | undefined {
  try {
    return hostname() || undefined;
  } catch {
    return undefined;
  }
}

export const OpencodeOtelPlugin: Plugin.Plugin = createOtelPlugin();

export default OpencodeOtelPlugin;
