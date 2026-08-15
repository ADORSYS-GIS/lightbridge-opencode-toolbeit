import { randomBytes } from "node:crypto";
import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";

import type { AgentSocketFactory } from "./agent-client.js";
import { DEFAULT_GROUPS, TOOL_GROUPS } from "./catalog.js";
import { createEndpoint } from "./endpoint.js";
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
import { readBridgeFile, resolveSharedToken, writeBridgeFile } from "./token-file.js";
import { createNodeAgentSocket, createNodeTransport } from "./node-transport.js";
import { createBrowserTools, type SaveScreenshot } from "./tools.js";
import type { BridgeTransport } from "./transport.js";
import type { BrowserPluginOptions, ResolvedBrowserOptions } from "./types.js";

function resolveGroups(raw: unknown): ToolGroup[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_GROUPS];
  }
  const valid = raw.filter((g): g is ToolGroup => TOOL_GROUPS.includes(g as ToolGroup));
  return valid.length > 0 ? valid : [...DEFAULT_GROUPS];
}

const PLUGIN_SERVICE_NAME = "opencode-browser-plugin";

const DEFAULTS = {
  host: "127.0.0.1",
  port: 4517,
  executor: "auto",
  timeoutMs: 30_000,
  screenshotDir: ".opencode/browser"
} as const;

type OpenCodeConfig = Parameters<NonNullable<Hooks["config"]>>[0];

export interface BrowserPluginFactoryOptions {
  /** Inject a logger (defaults to the OpenCode-piped logger). */
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

/**
 * Pipe plugin logs through OpenCode's `client.app.log` so they show up in the
 * host's structured log stream, with the JSON console as a reliable fallback.
 * Mirrors the pattern used by `@vymalo/opencode-oauth2` / `-ratelimit`.
 */
function createOpenCodeLogger(client: PluginInput["client"], getMinLevel: () => LogLevel): Logger {
  const fallback = createJsonConsoleLogger("debug");
  // OpenCode already captures plugin logs via client.app.log (and filters them
  // by its own log level). Mirroring every event to stdout on top of that is
  // what floods the terminal (e.g. `opencode web` re-loads the plugin per
  // session). So only mirror warn/error to the JSON console by default; set
  // VYMALO_PLUGIN_CONSOLE_LOG=1 to restore full console output for debugging.
  const consoleAll = /^(1|true|yes|on)$/i.test(process.env.VYMALO_PLUGIN_CONSOLE_LOG ?? "");

  const write = (level: LogLevel, event: string, fields?: LogFields) => {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[getMinLevel()]) {
      return;
    }
    if (consoleAll || level === "warn" || level === "error") {
      fallback[level](event, fields);
    }
    // OpenCode's host log API has no `trace` tier — fold it into `debug` for the
    // host call (our own level filter above already gates trace by DEBUG).
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

function resolveOptions(
  raw: PluginOptions | undefined,
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

export function createBrowserPlugin(factoryOptions: BrowserPluginFactoryOptions = {}): Plugin {
  return async ({ client }, pluginOptions) => {
    let currentLogLevel: LogLevel = DEFAULT_LOG_LEVEL;
    const logger = factoryOptions.logger ?? createOpenCodeLogger(client, () => currentLogLevel);
    const generateToken = factoryOptions.generateToken ?? (() => randomBytes(24).toString("hex"));

    const options = resolveOptions(pluginOptions, generateToken);
    const rawOptions = pluginOptions as BrowserPluginOptions | undefined;
    // Empty string is NOT an explicit token (resolveOptions generates one for
    // it). Treating "" as provided would mark the shared token "explicit" and
    // skip the paste_into_extension log, leaving the extension unable to learn
    // the generated token.
    const tokenProvided = typeof rawOptions?.token === "string" && rawOptions.token.length > 0;
    // Only forward the executor preference when the operator set it explicitly;
    // otherwise the extension keeps its own dashboard choice.
    const executorProvided = typeof rawOptions?.executor === "string";

    if (!options.enabled) {
      logger.info("browser_plugin_disabled", {});
      return {
        config: async (config: OpenCodeConfig) => {
          currentLogLevel = fromOpenCodeLogLevel(config.logLevel) ?? DEFAULT_LOG_LEVEL;
        }
      };
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
        logger.info("browser_bridge_token", {
          paste_into_extension: token,
          source,
          mode: "host"
        });
      }
    };

    // Auto-elect: host the broker (win the bind) or join an existing one as a guest.
    const endpoint = await createEndpoint(
      {
        host: options.host,
        port: options.port,
        token,
        executor: executorProvided ? options.executor : undefined,
        timeoutMs: options.timeoutMs,
        label: "opencode-plugin",
        onHost: advertiseToken,
        // Lets a long-lived host pick up a rotated token from the shared file on
        // a failed handshake, instead of rejecting forever until it's restarted.
        // Disabled for an EXPLICIT token: the operator pinned it, so the file
        // must never override their configured secret.
        reloadToken: source === "explicit" ? undefined : () => readBridgeFile()?.token
      },
      {
        logger,
        createServerTransport: factoryOptions.createServerTransport ?? createNodeTransport,
        createAgentSocket: factoryOptions.createAgentSocket ?? createNodeAgentSocket
      }
    );

    // When OpenCode exits, hand the browser back automatically — the user
    // shouldn't have to click Disconnect.
    process.once("exit", () => {
      try {
        endpoint.shutdown();
      } catch {
        /* best-effort */
      }
    });

    const tools = createBrowserTools({
      send: endpoint.send,
      options,
      logger,
      saveScreenshot: factoryOptions.saveScreenshot
    });

    return {
      tool: tools,
      config: async (config: OpenCodeConfig) => {
        currentLogLevel = fromOpenCodeLogLevel(config.logLevel) ?? DEFAULT_LOG_LEVEL;
      }
    };
  };
}

export const OpencodeBrowserPlugin: Plugin = createBrowserPlugin();

export default OpencodeBrowserPlugin;
