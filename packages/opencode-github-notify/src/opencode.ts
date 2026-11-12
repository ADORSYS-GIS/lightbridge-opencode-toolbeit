import { Plugin } from "@opencode/plugin/effect";
import { type Context as EffectContext, Effect } from "effect";

import { ConfigError, resolveOptions } from "./config.js";
import {
  captureHostContext,
  createEffectLogger,
  DEFAULT_LOG_LEVEL,
  type Logger,
  type LogLevel,
  resolveLogLevel
} from "./logging.js";
import { createNotifier, type Notifier, type NotifierDeps } from "./plugin.js";
import { registerTools } from "./tools.js";

/** Stable plugin id. v2 requires one and keys storage/registrations by it. */
export const PLUGIN_ID = "vymalo.github-notify";

export interface OpenCodePluginFactoryOptions {
  /** Override the logger (tests). Defaults to the host's Effect logger. */
  logger?: Logger;
  /** Engine overrides (tests): fake GitHub client, clock, timers, state dir. */
  notifier?: Partial<Omit<NotifierDeps, "options" | "logger" | "sendNotice" | "sessionStartedAt">>;
  /** Observe the engine the plugin built (tests). */
  onNotifier?: (notifier: Notifier) => void;
}

/** `Session.Info.time.created` decodes to an Effect `DateTime`; accept the shapes it may take. */
export function toEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "object" && value !== null && "epochMilliseconds" in value) {
    const ms = (value as { epochMilliseconds: unknown }).epochMilliseconds;
    return typeof ms === "number" ? ms : undefined;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/**
 * Build the OpenCode v2 plugin.
 *
 * - `tool.transform` registers `github_messages_{next,recent,status}` — the delivery path.
 * - A background timer (owned by the plugin scope, stopped by its finalizer) polls the
 *   watched threads and, per `notify`, queues a fixed-text notice into sessions that use
 *   the tools via `ctx.session.synthetic`. The notice never carries comment text, so a
 *   malicious comment cannot become a session instruction on its own.
 *
 * Nothing here writes to GitHub.
 */
export function createOpencodeGithubNotifyPlugin(
  factoryOptions: OpenCodePluginFactoryOptions = {}
): Plugin.Plugin {
  return Plugin.define({
    id: PLUGIN_ID,
    effect: Effect.fn(function* (ctx) {
      const logLevel: LogLevel =
        resolveLogLevel(ctx.options.logLevel) ??
        resolveLogLevel(process.env.OPENCODE_LOG_LEVEL) ??
        DEFAULT_LOG_LEVEL;

      const hostContext: EffectContext.Context<never> = yield* captureHostContext;
      const logger = factoryOptions.logger ?? createEffectLogger(hostContext, () => logLevel);

      let options: ReturnType<typeof resolveOptions>;
      try {
        options = resolveOptions(ctx.options);
      } catch (error) {
        if (error instanceof ConfigError) {
          logger.error("github_notify_config_invalid", { error: error.message });
          return;
        }
        throw error;
      }
      if (!options.enabled || options.watches.length === 0) {
        logger.info("github_notify_inactive", {
          reason: options.enabled ? "no watches configured" : "disabled"
        });
        return;
      }

      // Host calls from detached callbacks run on the captured host context (ADR-0019).
      const runHost = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
        Effect.runPromise(Effect.provideContext(effect, hostContext));
      type SyntheticInput = Parameters<typeof ctx.session.synthetic>[0];
      type GetInput = Parameters<typeof ctx.session.get>[0];

      const notifier = createNotifier({
        ...factoryOptions.notifier,
        options,
        logger,
        sendNotice: async (sessionID, text, resume) => {
          await runHost(
            ctx.session.synthetic({
              sessionID: sessionID as SyntheticInput["sessionID"],
              text,
              description: "GitHub thread activity",
              metadata: { source: PLUGIN_ID },
              delivery: "queue",
              resume
            })
          );
        },
        sessionStartedAt: async (sessionID) => {
          const info = await runHost(
            ctx.session.get({ sessionID: sessionID as GetInput["sessionID"] })
          );
          return toEpochMs((info as { time?: { created?: unknown } }).time?.created);
        }
      });
      factoryOptions.onNotifier?.(notifier);

      yield* ctx.tool.transform((editor) => {
        registerTools(editor, { notifier, logger, batchSize: options.batchSize });
      });

      notifier.start();
      yield* Effect.addFinalizer(() => Effect.sync(() => notifier.stop()));
    })
  });
}

export const OpencodeGithubNotifyPlugin: Plugin.Plugin = createOpencodeGithubNotifyPlugin();

export default OpencodeGithubNotifyPlugin;
