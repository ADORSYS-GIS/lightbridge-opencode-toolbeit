import { randomBytes } from "node:crypto";
import { Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";

import type { AgentSocketFactory } from "./agent-client.js";
import { DEFAULT_GROUPS, TOOL_GROUPS } from "./catalog.js";
import { createEndpoint } from "./endpoint.js";
import {
  captureHostContext,
  createEffectLogger,
  DEFAULT_LOG_LEVEL,
  type Logger,
  type LogLevel,
  resolveLogLevel
} from "./logging.js";
import { createNodeAgentSocket, createNodeTransport } from "./node-transport.js";
import type { ToolGroup } from "./schema.js";
import { readBridgeFile, resolveSharedToken, writeBridgeFile } from "./token-file.js";
import { createBrowserTools, type SaveScreenshot } from "./tools.js";
import type { BridgeTransport } from "./transport.js";
import type { BrowserPluginOptions, ResolvedBrowserOptions } from "./types.js";

/** Stable plugin id. v2 requires one and keys storage/registrations by it. */
export const PLUGIN_ID = "vymalo.browser";

function resolveGroups(raw: unknown): ToolGroup[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_GROUPS];
  }
  const valid = raw.filter((g): g is ToolGroup => TOOL_GROUPS.includes(g as ToolGroup));
  return valid.length > 0 ? valid : [...DEFAULT_GROUPS];
}

const DEFAULTS = {
  host: "127.0.0.1",
  port: 4517,
  executor: "auto",
  timeoutMs: 30_000,
  screenshotDir: ".opencode/browser"
} as const;

export interface BrowserPluginFactoryOptions {
  /** Inject a logger (defaults to the host's Effect logger). */
  logger?: Logger;
  /** Inject the server transport factory for host mode (defaults to the Node `ws` server). */
  createServerTransport?: () => BridgeTransport;
  /** Inject the agent-socket factory for guest mode (defaults to the Node `ws` client). */
  createAgentSocket?: AgentSocketFactory;
  /** Inject the screenshot disk-writer (tests). */
  saveScreenshot?: SaveScreenshot;
  /** Inject token generation (tests). */
  generateToken?: () => string;
}

function resolveOptions(
  raw: Readonly<Record<string, unknown>> | undefined,
  generateToken: () => string
): ResolvedBrowserOptions {
  const opts = (raw ?? {}) as BrowserPluginOptions;
  const token =
    typeof opts.token === "string" && opts.token.length > 0 ? opts.token : generateToken();
  return {
    enabled: opts.enabled !== false,
    host: opts.host ?? DEFAULTS.host,
    port: opts.port ?? DEFAULTS.port,
    token,
    executor: opts.executor ?? DEFAULTS.executor,
    groups: resolveGroups(opts.groups),
    timeoutMs: opts.timeoutMs ?? DEFAULTS.timeoutMs,
    screenshotDir: opts.screenshotDir ?? DEFAULTS.screenshotDir
  };
}

/**
 * Build the OpenCode v2 plugin.
 *
 * The plugin Effect does three things, in this order:
 *
 *  1. Captures the host's Effect context so diagnostics reach OpenCode's file
 *     logger instead of the terminal (ADR-0014 / ADR-0019) — this has to happen
 *     inside the plugin's own fiber.
 *  2. Elects host-or-guest and brings the bridge up, owned by the plugin's
 *     **scope**: when the scope closes the finalizer shuts the endpoint down,
 *     which stops the broker's `ws` listener (host) or closes the guest socket.
 *     A listener that outlived its plugin would make the next process elect as
 *     guest of a zombie instead of taking over the port.
 *  3. Registers the `browser_*` tools with `tool.transform`.
 */
export function createBrowserPlugin(
  factoryOptions: BrowserPluginFactoryOptions = {}
): Plugin.Plugin {
  return Plugin.define({
    id: PLUGIN_ID,
    effect: Effect.fn(function* (ctx) {
      // v2 has no `config` object, so v1's `config.logLevel` channel is gone:
      // this plugin's own `logLevel` option first, then the host's env var.
      const logLevel: LogLevel =
        resolveLogLevel(ctx.options.logLevel) ??
        resolveLogLevel(process.env.OPENCODE_LOG_LEVEL) ??
        DEFAULT_LOG_LEVEL;

      let logger = factoryOptions.logger;
      if (!logger) {
        const hostContext = yield* captureHostContext;
        logger = createEffectLogger(hostContext, () => logLevel);
      }
      const log = logger;

      const generateToken = factoryOptions.generateToken ?? (() => randomBytes(24).toString("hex"));
      const options = resolveOptions(ctx.options, generateToken);
      const rawOptions = ctx.options as BrowserPluginOptions;
      // Empty string is NOT an explicit token (resolveOptions generates one for
      // it). Treating "" as provided would mark the shared token "explicit" and
      // skip the paste_into_extension log, leaving the extension unable to learn
      // the generated token.
      const tokenProvided = typeof rawOptions.token === "string" && rawOptions.token.length > 0;
      // Only forward the executor preference when the operator set it explicitly;
      // otherwise the extension keeps its own dashboard choice.
      const executorProvided = typeof rawOptions.executor === "string";

      if (!options.enabled) {
        log.info("browser_plugin_disabled", {});
        return;
      }

      // Share the token across adapters via the per-user state file (explicit wins).
      const { token, source } = resolveSharedToken(
        options.port,
        tokenProvided ? options.token : undefined,
        generateToken
      );

      // Persist + advertise the token, **host-only** (fired via onHost so a host
      // reached by failover re-election does it too). Writing only on the host —
      // not unconditionally at load like before — means a guest that resolved a
      // fresh token on a transient read miss can never clobber the live host's
      // token in the shared file. We write whenever the file doesn't already match
      // OUR (port, token): that keeps a port change in sync and lets an explicit
      // token overwrite a stale generated one — but a no-op when the file already
      // agrees, so a concurrent host doesn't thrash it. The `paste_into_extension`
      // field name dodges the logger's redaction filter so the value stays copyable.
      const advertiseToken = () => {
        const existing = readBridgeFile();
        if (!existing || existing.port !== options.port || existing.token !== token) {
          writeBridgeFile(options.port, token);
        }
        if (source !== "explicit") {
          log.info("browser_bridge_token", {
            paste_into_extension: token,
            source,
            mode: "host"
          });
        }
      };

      // Auto-elect: host the broker (win the bind) or join an existing one as a
      // guest. Acquired into the plugin scope — the release is the teardown.
      const endpoint = yield* Effect.acquireRelease(
        Effect.promise(() =>
          createEndpoint(
            {
              host: options.host,
              port: options.port,
              token,
              executor: executorProvided ? options.executor : undefined,
              timeoutMs: options.timeoutMs,
              label: "opencode-plugin",
              onHost: advertiseToken,
              // Lets a long-lived host pick up a rotated token from the shared
              // file on a failed handshake, instead of rejecting forever until
              // it's restarted. Disabled for an EXPLICIT token: the operator
              // pinned it, so the file must never override their configured secret.
              reloadToken: source === "explicit" ? undefined : () => readBridgeFile()?.token
            },
            {
              logger: log,
              createServerTransport: factoryOptions.createServerTransport ?? createNodeTransport,
              createAgentSocket: factoryOptions.createAgentSocket ?? createNodeAgentSocket
            }
          )
        ),
        (ep) =>
          Effect.sync(() => {
            try {
              ep.shutdown();
            } catch {
              /* best-effort */
            }
          })
      );

      // Safety net for a host that exits without closing the plugin scope: hand
      // the browser back automatically — the user shouldn't have to click
      // Disconnect. Removed again on a clean scope close so it can't leak.
      const onExit = () => {
        try {
          endpoint.shutdown();
        } catch {
          /* best-effort */
        }
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.once("exit", onExit);
        }),
        () =>
          Effect.sync(() => {
            process.off("exit", onExit);
          })
      );

      const tools = createBrowserTools({
        send: endpoint.send,
        options,
        logger: log,
        worktree: ctx.location.project.directory,
        saveScreenshot: factoryOptions.saveScreenshot
      });

      yield* ctx.tool.transform((editor) => {
        for (const info of Object.values(tools)) {
          editor.add(info);
        }
      });
    })
  });
}

export const OpencodeBrowserPlugin: Plugin.Plugin = createBrowserPlugin();

export default OpencodeBrowserPlugin;
