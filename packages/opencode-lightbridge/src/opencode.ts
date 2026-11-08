import { hostname } from "node:os";
import { join } from "node:path";

import { Plugin, Provider } from "@opencode/plugin/effect";
import { defaultTextMapSetter } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type { AuthServerConfig } from "@vymalo/opencode-auth-core/lib";
import {
  buildResource,
  createProviders,
  deferredAttribute,
  describeError,
  readVcsInfo,
  registerExitHandlers,
  resolveOtelConfig,
  TelemetryRecorder,
  type EnvSource,
  type ExporterFactories,
  type OtelPluginOptions,
  type ResolvedOtelConfig,
  type TokenSource,
  type VcsInfo
} from "@vymalo/opencode-core-otel";
import {
  applyResponsesApiSettings,
  mergeDiscoveredModels,
  propagateCachedBearer,
  ProviderModelSyncEngine,
  resolveCachedBearer,
  resolveProviderPackage,
  type ProviderEditor,
  type ProviderServerConfig
} from "@vymalo/opencode-provider-sync/lib";
import { Effect, Stream } from "effect";

import {
  hasOAuth2Conflict,
  needsProjectToken,
  parseLightbridgeOptions,
  type LightbridgeRegisterOptions,
  type ParsedLightbridgeOptions
} from "./config.js";
import {
  captureHostContext,
  createEffectLogger,
  DEFAULT_LOG_LEVEL,
  type Logger,
  type LogLevel,
  resolveLogLevel,
  runInHost
} from "./logging.js";
import {
  adaptContext,
  adaptPermission,
  adaptPrompt,
  adaptToolAfter,
  adaptToolBefore,
  type HostEvent,
  OtelEventAdapter
} from "./otel-adapter.js";
import {
  LightbridgeRuntime,
  ROOT_CACHE_NAMESPACE,
  ROOT_CACHE_SEGMENT,
  type LightbridgeRuntimeFactory,
  type LightbridgeRuntimeLike,
  type LightbridgeRuntimeOptions
} from "./plugin.js";

/** Stable plugin id. v2 requires one and keys storage/registrations by it. */
export const PLUGIN_ID = "vymalo.lightbridge";

/** Test/embedder handle onto the `register` module's background engine. */
export interface LightbridgeRegisterHandle {
  /** Resolves once every queued engine build + warmup (and its reload) has finished. */
  settled(): Promise<void>;
  /** The current engine, or `undefined` before it is ready / after a collision stand-down. */
  engine(): ProviderModelSyncEngine | undefined;
}

export interface LightbridgePluginFactoryOptions {
  /** Override the logger (tests). Defaults to the host's Effect logger. */
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
  /** Observe the `register` module's background engine (tests). */
  onRegister?: (handle: LightbridgeRegisterHandle) => void;

  // --- OTEL test seams (mirror `@vymalo/opencode-otel`'s factory options) ---
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
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeHostname(): string | undefined {
  try {
    return hostname() || undefined;
  } catch {
    return undefined;
  }
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
 * Translate `auth` (already-validated `AuthServerConfig`) + `register` into
 * the ONE `ProviderServerConfig` the shared `ProviderModelSyncEngine` needs
 * (ADR-0017 requirement 1 — "everything oauth2 does"). `auth.id` is the
 * provider id AND the shared cache identity (see `plugin.ts`'s
 * `ROOT_CACHE_SEGMENT`/`ROOT_CACHE_NAMESPACE`).
 */
function buildRegisterServerConfig(
  auth: AuthServerConfig,
  register: LightbridgeRegisterOptions
): ProviderServerConfig {
  return {
    id: auth.id,
    name: register.name ?? auth.id,
    issuer: auth.issuer,
    baseURL: register.baseURL,
    clientId: auth.clientId,
    clientSecret: auth.clientSecret,
    scopes: auth.scopes,
    syncIntervalMinutes: register.syncIntervalMinutes ?? 60,
    nameOverrides: register.nameOverrides ?? {},
    authorizationEndpoint: auth.authorizationEndpoint,
    tokenEndpoint: auth.tokenEndpoint,
    deviceAuthorizationEndpoint: auth.deviceAuthorizationEndpoint,
    jwksUri: auth.jwksUri,
    redirectPort: auth.redirectPort,
    authFlow: auth.authFlow,
    pkce: auth.pkce,
    subjectTokenSource: auth.subjectTokenSource,
    tokenExchangeAudience: auth.tokenExchangeAudience
  };
}

function asSettings(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Create or update the one registered provider on the editor. A provider that
 * does not exist yet is added with `activation: "enabled"` (the gateway bearer
 * is injected per request, not held as a host connection, so `"auto"` could
 * leave it inactive); an existing one keeps its activation, id and other
 * fields.
 */
function upsertRegisteredProvider(
  editor: ProviderEditor,
  providerId: string,
  register: LightbridgeRegisterOptions,
  logger: Logger
): void {
  const existing = editor.get(providerId)?.provider;
  // `Provider.Info.name` is required, so a provider declared without a name
  // reads back as its own id — treat that as "unset" and let `register.name` win.
  const existingName = existing && existing.name !== providerId ? existing.name : undefined;
  const name = existingName ?? register.name ?? providerId;
  const settings = applyResponsesApiSettings(
    { ...asSettings(existing?.settings), baseURL: register.baseURL },
    register.responseApi,
    providerId,
    logger
  );
  const pkg = resolveProviderPackage(register.responseApi);

  if (!existing) {
    editor.add({
      info: {
        id: Provider.ID.make(providerId),
        name,
        activation: "enabled",
        package: pkg,
        settings
      },
      models: []
    });
    return;
  }

  editor.update(providerId, (provider) => {
    provider.package = pkg;
    provider.name = name;
    provider.settings = settings as typeof provider.settings;
  });
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

interface HostLocation {
  directory: string;
  projectId?: string;
}

/**
 * Build the OTEL module: resource, providers (with the runtime-backed
 * `TokenSource` when a shared runtime is available), recorder and exit
 * handlers. Mirrors `@vymalo/opencode-otel`'s orchestration verbatim, minus
 * the standalone `tokenCommand` seam.
 */
async function buildOtelModule(
  location: HostLocation,
  otelConfig: ResolvedOtelConfig,
  logger: Logger,
  factoryOptions: LightbridgePluginFactoryOptions,
  runtime: LightbridgeRuntimeLike | undefined
): Promise<OtelModule & { version: ReturnType<typeof deferredAttribute> }> {
  const version = deferredAttribute(factoryOptions.deferredTimeoutMs);
  const branch = deferredAttribute(factoryOptions.deferredTimeoutMs);
  if (factoryOptions.hostInfo?.version) {
    version.settle(factoryOptions.hostInfo.version);
  }

  const vcs: VcsInfo = otelConfig.collectVcs
    ? await readVcsInfo(location.directory).catch(() => ({}))
    : {};
  if (vcs.ref) {
    branch.settle(vcs.ref);
  }

  const resource = buildResource(otelConfig, {
    version: version.value,
    hostname: factoryOptions.hostInfo?.hostname ?? safeHostname(),
    projectName: location.projectId,
    directory: location.directory,
    worktree: location.directory,
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
    // Flush on exit, and hand the default signal action back (ADR-0018).
    registerExitHandlers(providers, logger, [version, branch], {
      eventPrefix: "lightbridge_otel"
    });
  }

  logger.info("lightbridge_otel_enabled", {
    serviceName: otelConfig.serviceName,
    exporters: otelConfig.exporters,
    endpoint: otelConfig.endpoint,
    runtimeBackedTokenSource: Boolean(tokenSource)
  });

  return { config: otelConfig, recorder, version };
}

const propagator = new W3CTraceContextPropagator();

/**
 * Subscribe to the host event stream and drive the recorder. Only the event
 * types the adapter understands are requested.
 */
const OTEL_EVENT_TYPES = [
  "session.created",
  "session.deleted",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.text.ended",
  "session.retry.scheduled",
  "session.compaction.ended",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "permission.asked",
  "permission.replied",
  "vcs.branch.updated",
  "installation.updated"
] as const;

/**
 * Create the `@vymalo/opencode-lightbridge` umbrella plugin (ADR-0012,
 * ADR-0017) for the OpenCode v2 plugin API (ADR-0019): ONE shared
 * `TokenRuntime`, built once from `auth`, drives both the gateway bearer
 * (`gateway`) and the OTEL export credential (`otel`) — each module activates
 * independently, and an `auth`-only config is a valid, inert plugin.
 *
 *  - `register`: `provider.transform` registers the provider and merges the
 *    discovered models and cached bearer; a queued background build runs the
 *    `ProviderModelSyncEngine` and calls `provider.reload()` (the transform is
 *    synchronous and cheap by contract — same shape as oauth2).
 *  - `gateway`: `session.hook("model.request")` injects the shared bearer and
 *    fails closed by dying the request when no bearer can be produced.
 *  - `otel`: `event.subscribe` + `prompt`/`context`/`tool`/`permission` hooks
 *    feed the recorder through `otel-adapter.ts`; `http.request` carries W3C
 *    trace context.
 */
export function createLightbridgePlugin(
  factoryOptions: LightbridgePluginFactoryOptions = {}
): Plugin.Plugin {
  return Plugin.define({
    id: PLUGIN_ID,
    effect: Effect.fn(function* (ctx) {
      // v2 gives plugins no `config` object: this plugin's own `logLevel`
      // option, then the host's `OPENCODE_LOG_LEVEL`.
      const logLevel: LogLevel =
        resolveLogLevel(ctx.options.logLevel) ??
        resolveLogLevel(process.env.OPENCODE_LOG_LEVEL) ??
        DEFAULT_LOG_LEVEL;

      // Captured INSIDE the plugin's own Effect so records reach the host's file
      // logger and not the terminal (ADR-0014 / ADR-0019).
      const hostContext = yield* captureHostContext;
      const logger: Logger =
        factoryOptions.logger ?? createEffectLogger(hostContext, () => logLevel);

      let parsed: ParsedLightbridgeOptions;
      try {
        parsed = parseLightbridgeOptions(ctx.options);
      } catch (error) {
        // A malformed config must not take down every other plugin's load —
        // log and register nothing rather than throwing out of the plugin.
        logger.error("lightbridge_config_invalid", { error: describeError(error) });
        return;
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
      // and the OTEL token source below. `undefined` only for a register/auth-only
      // config.
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
            tokenExpirySkewMs: factoryOptions.tokenExpirySkewMs,
            exchange: parsed.gateway?.exchange ?? false
          })
        : undefined;

      const reloadProviders = (): Promise<void> => runInHost(hostContext, ctx.provider.reload());

      // ---- register module (ADR-0017 requirement 1) ----
      let engine: ProviderModelSyncEngine | undefined;
      let registerChain: Promise<void> = Promise.resolve();
      // A build has been queued for the current non-collision stretch.
      let registerQueued = false;
      // oauth2 owns the provider id: register must neither build nor run an engine.
      let registerSuppressed = false;
      let skipLogged = false;
      let registerBearer: string | undefined;
      const stamped = new Map<string, string>();

      const stopEngine = (): void => {
        engine?.stop();
        engine = undefined;
        registerBearer = undefined;
      };

      const buildRegisterEngine = async (register: LightbridgeRegisterOptions): Promise<void> => {
        // The collision may have been detected after this build was queued.
        if (registerSuppressed) {
          return;
        }
        const next = new ProviderModelSyncEngine(
          {
            servers: [buildRegisterServerConfig(parsed.auth, register)],
            cacheNamespace: ROOT_CACHE_NAMESPACE
          },
          {
            logger,
            fetchImpl: factoryOptions.fetchImpl,
            onAuthorizationUrl: factoryOptions.onAuthorizationUrl,
            cacheDir: factoryOptions.cacheDir
              ? join(factoryOptions.cacheDir, ROOT_CACHE_SEGMENT, ROOT_CACHE_NAMESPACE)
              : undefined,
            cacheNamespaceSegment: ROOT_CACHE_SEGMENT,
            serviceLabel: "opencode-lightbridge"
          }
        );
        await next.initialize();
        if (registerSuppressed) {
          return;
        }
        await next.start({ warmup: true });
        if (registerSuppressed) {
          // oauth2 claimed the id while we warmed up: release our scheduler slot.
          next.stop();
          return;
        }
        engine = next;
        registerBearer = await resolveCachedBearer(parsed.auth.id, next, logger);
        // Models and bearer are now known: ask the host to re-run transforms.
        await reloadProviders();
      };

      if (parsed.register) {
        const register = parsed.register;
        const providerId = parsed.auth.id;

        factoryOptions.onRegister?.({
          async settled() {
            let current: Promise<void>;
            do {
              current = registerChain;
              await current;
            } while (current !== registerChain);
          },
          engine: () => engine
        });

        yield* ctx.provider.transform((editor) => {
          if (hasOAuth2Conflict(editor, providerId)) {
            registerSuppressed = true;
            registerQueued = false;
            stopEngine();
            if (!skipLogged) {
              skipLogged = true;
              logger.debug("lightbridge_register_skipped_oauth2_conflict", { providerId });
            }
            return;
          }
          registerSuppressed = false;

          upsertRegisteredProvider(editor, providerId, register, logger);
          let modelCount = 0;
          if (engine) {
            try {
              const models = engine.getServerModels(providerId);
              modelCount = models.length;
              if (models.length > 0) {
                mergeDiscoveredModels(editor, providerId, models);
              }
            } catch {
              // The engine is mid-rebuild; the next pass catches up.
            }
          }
          propagateCachedBearer(editor, providerId, registerBearer, logger, stamped);
          logger.trace("lightbridge_register_config_applied", { providerId, modelCount });

          if (!registerQueued) {
            registerQueued = true;
            registerChain = registerChain
              .then(() => buildRegisterEngine(register))
              .catch((error) => {
                // A failed build must not wedge the queue; a later distinct pass retries.
                registerQueued = false;
                logger.error("lightbridge_register_build_failed", { error: errorMessage(error) });
              });
          }
        });
      }

      // ---- gateway module ----
      // `sharedRuntime` is always defined here: it is built whenever `gateway`
      // or `otel` is configured (`wantsProjectToken`).
      if (parsed.gateway && sharedRuntime) {
        const providers = new Set(parsed.gateway.providers);
        const runtime = sharedRuntime;
        // `gateway` never stamps a bearer onto the provider record, so a stale
        // value cannot ride out of the record. It can still coexist with a
        // `register` stamp (the raw IdP token) or an oauth2 stamp for the same
        // provider; to keep that from leaking through when this module's own
        // token (notably the RFC 8693 exchange, a remote call) cannot be
        // produced, a failure here kills the request rather than leaving the
        // stamped header in place — the same fail-closed mechanism oauth2 uses.
        yield* ctx.session.hook("model.request", (event) => {
          const providerId = event.model.providerID;
          if (!providers.has(providerId)) {
            logger.trace("lightbridge_gateway_model_request_skipped", { providerId });
            return Effect.void;
          }
          return Effect.tryPromise({
            try: async () => {
              const token = await runtime.getProjectToken({ interactive: true });
              // Header names are case-insensitive: drop any variant already set
              // (a stamped record header, the placeholder key's, a lowercase copy).
              for (const key of Object.keys(event.headers)) {
                if (key.toLowerCase() === "authorization") {
                  delete event.headers[key];
                }
              }
              event.headers.Authorization = `${token.tokenType || "Bearer"} ${token.accessToken}`;
              logger.trace("lightbridge_gateway_bearer_injected", { providerId });
            },
            catch: (error) => error
          }).pipe(
            Effect.tapError((error) =>
              Effect.sync(() =>
                logger.warn("lightbridge_gateway_no_bearer", {
                  providerId,
                  error: errorMessage(error)
                })
              )
            ),
            Effect.orDie
          );
        });
      }

      // ---- otel module ----
      let otel: OtelModule | undefined;
      if (parsed.otel) {
        const env = factoryOptions.env ?? process.env;
        const otelConfig = resolveOtelConfig(parsed.otel, env);
        if (otelConfig.active) {
          warnIfTokenCommandConfigIgnored(parsed.otel, env, logger);
          const built = yield* Effect.promise(() =>
            buildOtelModule(
              { directory: ctx.location.directory, projectId: ctx.location.project?.id },
              otelConfig,
              logger,
              factoryOptions,
              sharedRuntime
            )
          );
          otel = built;
          const { recorder } = built;
          const adapter = new OtelEventAdapter(recorder, factoryOptions.now);

          yield* Effect.forkScoped(
            Stream.runForEach(ctx.event.subscribe({ types: OTEL_EVENT_TYPES }), (event) =>
              Effect.sync(() => adapter.handle(event as unknown as HostEvent))
            ).pipe(
              Effect.tapError((error) =>
                Effect.sync(() =>
                  logger.warn("lightbridge_otel_event_stream_failed", {
                    error: errorMessage(error)
                  })
                )
              ),
              Effect.ignore
            )
          );

          yield* ctx.session.hook("prompt", (event) =>
            Effect.sync(() => {
              const [input, output] = adaptPrompt(event);
              recorder.onChatMessage(input, output);
            })
          );
          yield* ctx.session.hook("context", (event) =>
            Effect.sync(() => {
              const [input, output] = adaptContext(event);
              recorder.onChatParams(input, output);
            })
          );
          yield* ctx.tool.hook("execute.before", (event) =>
            Effect.sync(() => recorder.onToolBefore(adaptToolBefore(event)))
          );
          yield* ctx.tool.hook("execute.after", (event) =>
            Effect.sync(() => {
              const [input, output] = adaptToolAfter({
                tool: event.tool,
                sessionID: event.sessionID,
                id: event.id,
                status: event.status,
                result: event.status === "completed" ? event.result : undefined
              });
              recorder.onToolAfter(input, output);
            })
          );
          yield* ctx.permission.hook("evaluate", (event) =>
            Effect.sync(() => {
              const [input, output] = adaptPermission(event);
              recorder.onPermissionAsk(input, output);
            })
          );

          if (otelConfig.propagateTraceContext) {
            // v1 wrapped `provider.options.fetch`; `Provider.Info` has no `fetch`,
            // so the trace context rides the outgoing request instead.
            yield* ctx.session.hook("http.request", (event) =>
              Effect.sync(() => {
                const context = recorder.currentChatContext();
                if (!context) {
                  return;
                }
                const carrier: Record<string, string> = {};
                propagator.inject(context, carrier, defaultTextMapSetter);
                for (const [key, value] of Object.entries(carrier)) {
                  // Never clobber an upstream traceparent.
                  if (!event.request.headers.has(key)) {
                    event.request.headers.set(key, value);
                  }
                }
              })
            );
            logger.debug("lightbridge_otel_trace_propagation_ready", {});
          }
        } else {
          logger.info("lightbridge_otel_inactive", {
            enabled: otelConfig.enabled,
            reason: otelConfig.enabled ? "no_exporter_configured" : "disabled"
          });
        }
      }

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stopEngine();
          // A real shutdown signal from the host: drain the exporters.
          otel?.recorder.onEvent({ type: "server.instance.disposed" });
        })
      );

      logger.info("lightbridge_plugin_ready", {
        gateway: Boolean(parsed.gateway && sharedRuntime),
        exchange: parsed.gateway?.exchange ?? false,
        otel: Boolean(otel),
        register: Boolean(parsed.register),
        projectId: parsed.projectId ?? (wantsProjectToken ? "(default)" : undefined)
      });
    })
  });
}

export const LightbridgePlugin: Plugin.Plugin = createLightbridgePlugin();

export default LightbridgePlugin;
