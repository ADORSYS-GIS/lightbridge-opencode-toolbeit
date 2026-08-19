import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";

import {
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  type AuthServerConfigInput,
  type LogFields,
  LOG_LEVEL_PRIORITY,
  type Logger,
  type LogLevel,
  type TokenSet
} from "@vymalo/opencode-auth-core/lib";

import { hasOAuth2Conflict, parseRepoAuthOptions } from "./config.js";
import { resolveOriginRemote, resolveRepoRoot } from "./git.js";
import { RepoAuthPlugin } from "./plugin.js";

type OpenCodeConfig = Parameters<NonNullable<Hooks["config"]>>[0];
type OpenCodeProviderMap = NonNullable<OpenCodeConfig["provider"]>;
type OpenCodeProviderConfig = OpenCodeProviderMap[string];

const PLUGIN_SERVICE_NAME = "opencode-repo-auth-plugin";

/**
 * Map OpenCode's host-level `config.logLevel` (uppercase `"DEBUG" | "INFO" |
 * "WARN" | "ERROR"`) to the plugin's internal `LogLevel`. Unknown / missing
 * values fall through to `undefined` so the caller applies its own default —
 * we never throw on an OpenCode-supplied value because the host owns
 * validation of its own field. Host `DEBUG` unlocks the `trace` tier (there is
 * no separate host `TRACE` level), surfacing the `repo_auth_*` trace events.
 */
function fromOpenCodeLogLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  switch (value.toUpperCase()) {
    case "DEBUG":
      return "trace";
    case "INFO":
      return "info";
    case "WARN":
      return "warn";
    case "ERROR":
      return "error";
    default:
      return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

interface ManagedProvider {
  projectId: string;
  auth: AuthServerConfigInput;
  /** Canonical IdP fingerprint — distinguishes IdPs for the single-IdP v1 guard. */
  authSignature: string;
}

interface RuntimeState {
  pluginByProvider: Map<string, RepoAuthPlugin>;
  signature?: string;
}

export interface OpenCodePluginFactoryOptions {
  logger?: Logger;
  fetchImpl?: typeof fetch;
  onAuthorizationUrl?: (url: string) => Promise<void> | void;
  cacheDir?: string;
  /** Repo root to resolve git identity from (defaults to `process.cwd()`). */
  cwd?: string;
}

function createOpenCodeLogger(client: PluginInput["client"], getMinLevel: () => LogLevel): Logger {
  const fallback = createJsonConsoleLogger("debug");
  const consoleAll = /^(1|true|yes|on)$/i.test(process.env.VYMALO_PLUGIN_CONSOLE_LOG ?? "");

  const write = (
    level: "trace" | "debug" | "info" | "warn" | "error",
    event: string,
    fields?: LogFields
  ) => {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[getMinLevel()]) {
      return;
    }

    if (consoleAll || level === "warn" || level === "error") {
      fallback[level](event, fields);
    }

    const hostLevel = level === "trace" ? "debug" : level;
    void client.app
      .log({
        body: {
          service: PLUGIN_SERVICE_NAME,
          level: hostLevel,
          message: event,
          extra: fields
        }
      })
      .catch(() => {
        // Best-effort forwarding; console logger is the reliable fallback.
      });
  };

  return {
    trace(event, fields) {
      write("trace", event, fields);
    },
    debug(event, fields) {
      write("debug", event, fields);
    },
    info(event, fields) {
      write("info", event, fields);
    },
    warn(event, fields) {
      write("warn", event, fields);
    },
    error(event, fields) {
      write("error", event, fields);
    }
  };
}

function authSignature(auth: AuthServerConfigInput): string {
  return JSON.stringify({
    issuer: auth.issuer,
    clientId: auth.clientId,
    clientSecret: auth.clientSecret,
    scopes: auth.scopes,
    authorizationEndpoint: auth.authorizationEndpoint,
    tokenEndpoint: auth.tokenEndpoint,
    deviceAuthorizationEndpoint: auth.deviceAuthorizationEndpoint,
    jwksUri: auth.jwksUri,
    redirectPort: auth.redirectPort,
    authFlow: auth.authFlow,
    pkce: auth.pkce,
    subjectTokenSource: auth.subjectTokenSource
  });
}

/**
 * Config-time stamp of the project bearer onto `provider.options.headers
 * .Authorization`, mirroring oauth2's `propagateCachedBearer`. This is the
 * config-object handshake that lets `@vymalo/opencode-models-info` (which runs
 * after repo-auth in `plugin`) fetch an OAuth2-protected `meta.modelsInfoUrl`.
 * A user-set `Authorization` always wins here; and a stale stamped value is
 * harmless because `chat.headers` overwrites it per request with a fresh
 * token. Never opens a browser / device-code prompt: on any failure (no cached
 * human token, exchange error) it logs and skips the stamp.
 */
async function propagateCachedBearer(
  providerConfig: OpenCodeProviderConfig,
  providerId: string,
  plugin: RepoAuthPlugin,
  logger: Logger
): Promise<void> {
  const options = (providerConfig.options ??= {} as NonNullable<OpenCodeProviderConfig["options"]>);
  const headers = ((options as { headers?: Record<string, string> }).headers ??= {});
  const hasUserAuth = Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
  if (hasUserAuth) {
    logger.debug("repo_auth_bearer_propagation_skipped_user_set", { providerId });
    return;
  }

  let token: TokenSet;
  try {
    // Config-time warmup is strictly non-interactive: a first-ever login must
    // not block boot on a browser/device-code prompt. The project token is
    // renewed later by the first `chat.headers` request (interactive) or the
    // user's explicit `auth login`. A missing/expired human token throws here
    // and is caught below — `repo_auth_bearer_propagation_skipped_no_token`.
    token = await plugin.resolveProjectToken({ interactive: false });
  } catch (error) {
    logger.debug("repo_auth_bearer_propagation_skipped_no_token", {
      providerId,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  if (!token.accessToken) {
    logger.debug("repo_auth_bearer_propagation_skipped_empty_token", { providerId });
    return;
  }

  headers.Authorization = `${token.tokenType || "Bearer"} ${token.accessToken}`;
  logger.debug("repo_auth_bearer_propagated_to_provider_headers", { providerId });
}

/**
 * Resolve the repo's git identity once per config hook — worktree-aware, read
 * off disk, normalized (userinfo stripped). Log-only in v1: nothing is derived
 * from the remote; the module exists to make the plugin worktree-correct and
 * to leave a repo-auditable trace in the log stream.
 */
async function logGitIdentity(logger: Logger, cwd: string): Promise<void> {
  const repoRoot = await resolveRepoRoot(cwd);
  if (!repoRoot) {
    logger.trace("repo_auth_remote_missing", {});
    return;
  }
  const remote = await resolveOriginRemote(repoRoot);
  if (!remote) {
    logger.trace("repo_auth_remote_missing", { repoRoot });
    return;
  }
  logger.debug("repo_auth_remote_resolved", { repoRoot, remote });
}

/**
 * Walk the provider map, collect every `options.meta.repoAuth` opt-in, and
 * enforce the plugin's guards. Returns the managed providers map (providerId →
 * parsed config), logging `repo_auth_*` events as it goes.
 */
function collectManagedProviders(
  config: OpenCodeConfig,
  logger: Logger
): Map<string, ManagedProvider> {
  const managed = new Map<string, ManagedProvider>();
  const providers = config.provider ?? {};

  const optedIn: Array<{ providerId: string; config: ManagedProvider }> = [];
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    const options = asRecord(providerConfig.options);
    // A malformed opt-in on one provider must not take down the whole plugin:
    // warn and skip, mirroring the no-op matrix. (oauth2 throws for its own
    // config keys; here a stray/typo'd `meta.repoAuth` on any provider would
    // otherwise reject the entire config hook for every provider.)
    let parsed: ReturnType<typeof parseRepoAuthOptions>;
    try {
      parsed = parseRepoAuthOptions(options);
    } catch (error) {
      logger.warn("repo_auth_skipped_malformed", {
        providerId,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    if (parsed.kind === "not_opted_in") {
      logger.trace("repo_auth_provider_skipped", { providerId });
      continue;
    }
    if (parsed.kind === "missing_project_id") {
      logger.warn("repo_auth_skipped_no_project_id", { providerId });
      continue;
    }
    if (hasOAuth2Conflict(config, options, providerId)) {
      logger.warn("repo_auth_skipped_oauth2_provider", { providerId });
      continue;
    }

    const entry: ManagedProvider = {
      projectId: parsed.config.projectId,
      auth: parsed.config.auth,
      authSignature: authSignature(parsed.config.auth)
    };
    optedIn.push({ providerId, config: entry });
  }

  // v1 is single-IdP: one identity key (the human) per cache namespace. The
  // human root file is shared across every managed provider, so two opted-in
  // providers MUST resolve to the same IdP or the second would clobber the
  // first's human token. Guard: keep the first IdP group, warn + skip the rest.
  const first = optedIn[0];
  if (first) {
    const selected = new Set<string>([first.config.authSignature]);
    for (const { providerId, config } of optedIn) {
      if (!selected.has(config.authSignature)) {
        logger.warn("repo_auth_multiple_idps_unsupported", { providerId });
        continue;
      }
      logger.trace("repo_auth_provider_opted_in", { providerId, projectId: config.projectId });
      managed.set(providerId, config);
    }
  }

  return managed;
}

function runtimeSignature(managed: Map<string, ManagedProvider>): string {
  const sorted = [...managed.entries()].sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(
    sorted.map(([providerId, entry]) => ({
      providerId,
      projectId: entry.projectId,
      authSignature: entry.authSignature
    }))
  );
}

export function createOpencodeRepoAuthPlugin(
  factoryOptions: OpenCodePluginFactoryOptions = {}
): Plugin {
  return async ({ client }) => {
    let currentLogLevel: LogLevel = DEFAULT_LOG_LEVEL;
    const logger = factoryOptions.logger ?? createOpenCodeLogger(client, () => currentLogLevel);

    const state: RuntimeState = {
      pluginByProvider: new Map<string, RepoAuthPlugin>(),
      signature: undefined
    };

    return {
      config: async (config) => {
        currentLogLevel = fromOpenCodeLogLevel(config.logLevel) ?? DEFAULT_LOG_LEVEL;
        logger.trace("repo_auth_config_hook_start", {
          logLevel: currentLogLevel,
          hostLogLevel: typeof config.logLevel === "string" ? config.logLevel : undefined
        });

        await logGitIdentity(logger, factoryOptions.cwd ?? process.cwd());

        const managed = collectManagedProviders(config, logger);
        logger.trace("repo_auth_config_hook_collected_providers", {
          managedCount: managed.size,
          providerIds: [...managed.keys()]
        });
        if (managed.size === 0) {
          logger.trace("repo_auth_config_hook_no_managed_providers", {});
          state.pluginByProvider.clear();
          state.signature = undefined;
          logger.trace("repo_auth_config_hook_finished", { managedCount: 0 });
          return;
        }

        const signature = runtimeSignature(managed);
        if (state.signature !== signature || state.pluginByProvider.size === 0) {
          logger.trace("repo_auth_runtime_rebuild", {
            reason: state.pluginByProvider.size > 0 ? "signature_changed" : "first_build",
            providerCount: managed.size
          });
          const rebuilt = new Map<string, RepoAuthPlugin>();
          for (const [providerId, entry] of managed.entries()) {
            try {
              const plugin = new RepoAuthPlugin(
                { projectId: entry.projectId, auth: entry.auth },
                {
                  logger,
                  fetchImpl: factoryOptions.fetchImpl,
                  onAuthorizationUrl: factoryOptions.onAuthorizationUrl,
                  cacheDir: factoryOptions.cacheDir
                }
              );
              rebuilt.set(providerId, plugin);
            } catch (error) {
              // validateAuthConfig inside the constructor can still reject
              // (e.g. client_credentials without clientSecret). Fail that one
              // provider, keep the rest — never abort the whole config hook.
              logger.warn("repo_auth_skipped_invalid_auth", {
                providerId,
                error: error instanceof Error ? error.message : String(error)
              });
            }
          }
          state.pluginByProvider = rebuilt;
          state.signature = signature;
        } else {
          logger.trace("repo_auth_runtime_reused", { providerCount: managed.size });
        }

        const providers = (config.provider ??= {});
        await Promise.all(
          [...state.pluginByProvider.entries()].map(([providerId, plugin]) => {
            const providerConfig = providers[providerId];
            if (!providerConfig) {
              return undefined;
            }
            return propagateCachedBearer(providerConfig, providerId, plugin, logger);
          })
        );
        logger.trace("repo_auth_config_hook_finished", {
          managedCount: state.pluginByProvider.size
        });
      },
      "chat.headers": async (input, output) => {
        const providerId = input.model?.providerID ?? input.provider?.info?.id;
        const plugin = providerId ? state.pluginByProvider.get(providerId) : undefined;
        if (!providerId || !plugin) {
          logger.trace("repo_auth_chat_headers_skipped", {
            providerId,
            managed: providerId ? state.pluginByProvider.has(providerId) : false
          });
          return;
        }

        // Fail closed: on any exchange failure we inject NO header — the
        // gateway 401s, matching the SPI's fail-closed semantics. Errors are
        // already logged as `repo_auth_exchange_failed`.
        const token = await plugin.resolveProjectToken({ interactive: true });
        output.headers.Authorization = `${token.tokenType || "Bearer"} ${token.accessToken}`;
        logger.trace("repo_auth_chat_headers_bearer_injected", {
          providerId,
          present: Boolean(token.accessToken),
          tokenType: token.tokenType || "Bearer"
        });
      }
    };
  };
}

export const OpencodeRepoAuthPlugin: Plugin = createOpencodeRepoAuthPlugin();

export default OpencodeRepoAuthPlugin;
