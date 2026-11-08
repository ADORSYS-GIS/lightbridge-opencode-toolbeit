import { Plugin } from "@opencode/plugin/effect";
import type { AuthServerConfigInput } from "@vymalo/opencode-auth-core/lib";
import { Effect } from "effect";

import { hasOAuth2Conflict, parseRepoAuthSettings } from "./config.js";
import { resolveOriginRemote, resolveRepoRoot } from "./git.js";
import {
  captureHostContext,
  createEffectLogger,
  DEFAULT_LOG_LEVEL,
  type Logger,
  type LogLevel,
  resolveLogLevel
} from "./logging.js";
import { RepoAuthPlugin } from "./plugin.js";

/** Stable plugin id. v2 requires one and keys storage/registrations by it. */
export const PLUGIN_ID = "vymalo.repo-auth";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export interface ManagedProvider {
  projectId: string;
  auth: AuthServerConfigInput;
  /** Canonical IdP fingerprint — distinguishes IdPs for the single-IdP v1 guard. */
  authSignature: string;
}

interface RuntimeState {
  pluginByProvider: Map<string, RepoAuthPlugin>;
  signature?: string;
}

/** What the transform reads off each `ProviderRecord` — decoupled for tests. */
export interface ProviderView {
  id: string;
  settings?: Record<string, unknown>;
  integrationID?: string;
}

export interface OpenCodePluginFactoryOptions {
  /** Override the logger (tests). Defaults to the host's Effect logger. */
  logger?: Logger;
  fetchImpl?: typeof fetch;
  onAuthorizationUrl?: (url: string) => Promise<void> | void;
  cacheDir?: string;
  /** Repo root to resolve git identity from (defaults to the plugin's location directory). */
  cwd?: string;
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
 * Resolve the repo's git identity once per plugin load — worktree-aware, read
 * off disk, normalized (userinfo stripped). Log-only: nothing is derived from
 * the remote; the module exists to make the plugin worktree-correct and to
 * leave a repo-auditable trace in the log stream. Never rejects.
 */
async function logGitIdentity(logger: Logger, cwd: string): Promise<void> {
  try {
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
  } catch (error) {
    logger.trace("repo_auth_remote_missing", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Walk the provider list, collect every `settings.repoAuth` opt-in, and
 * enforce the plugin's guards. Returns the managed providers map (providerId →
 * parsed config), logging `repo_auth_*` events as it goes. Pure and
 * synchronous — it runs inside `provider.transform`.
 */
export function collectManagedProviders(
  providers: readonly ProviderView[],
  logger: Logger
): Map<string, ManagedProvider> {
  const managed = new Map<string, ManagedProvider>();

  const optedIn: Array<{ providerId: string; config: ManagedProvider }> = [];
  for (const provider of providers) {
    const providerId = provider.id;
    const settings = asRecord(provider.settings);
    // A malformed opt-in on one provider must not take down the whole plugin:
    // warn and skip, mirroring the no-op matrix.
    let parsed: ReturnType<typeof parseRepoAuthSettings>;
    try {
      parsed = parseRepoAuthSettings(settings);
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
    if (hasOAuth2Conflict({ settings, integrationID: provider.integrationID })) {
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

/**
 * Build the OpenCode v2 plugin.
 *
 * Two registrations:
 *
 *  - `provider.transform` reads each provider's `settings.repoAuth` opt-in and
 *    rebuilds the per-provider {@link RepoAuthPlugin} runtimes when the managed
 *    set changes. It replaces v1's `config` hook. It does no I/O and mints no
 *    token: transform callbacks must stay synchronous and cheap.
 *  - `session.hook("model.request")` replaces v1's `chat.headers`: it resolves
 *    the project token and writes `Authorization` onto the mutable
 *    `event.headers`. **Fails closed** — on any exchange error no header is set.
 *
 * v1 also stamped the bearer onto `provider.options.headers` at config time so
 * `models-info` could fetch an OAuth2-protected endpoint. That is dropped: a
 * transform cannot await a token, and a stamped header would survive a failed
 * exchange as a stale bearer, which contradicts fail-closed.
 */
export function createOpencodeRepoAuthPlugin(
  factoryOptions: OpenCodePluginFactoryOptions = {}
): Plugin.Plugin {
  return Plugin.define({
    id: PLUGIN_ID,
    effect: Effect.fn(function* (ctx) {
      // v2 gives plugins no `config` object: take this plugin's own `logLevel`
      // option first, then the host's `OPENCODE_LOG_LEVEL`.
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

      const state: RuntimeState = {
        pluginByProvider: new Map<string, RepoAuthPlugin>(),
        signature: undefined
      };

      log.trace("repo_auth_plugin_start", { logLevel });

      const cwd = factoryOptions.cwd ?? ctx.location?.directory ?? process.cwd();
      yield* Effect.promise(() => logGitIdentity(log, cwd));

      yield* ctx.provider.transform((editor) => {
        const managed = collectManagedProviders(
          editor.list().map((record) => ({
            id: record.provider.id,
            settings: record.provider.settings as Record<string, unknown> | undefined,
            integrationID: record.provider.integrationID
          })),
          log
        );

        if (managed.size === 0) {
          state.pluginByProvider.clear();
          state.signature = undefined;
          log.trace("repo_auth_transform_finished", { managedCount: 0 });
          return;
        }

        const signature = runtimeSignature(managed);
        if (state.signature !== signature || state.pluginByProvider.size === 0) {
          log.trace("repo_auth_runtime_rebuild", {
            reason: state.pluginByProvider.size > 0 ? "signature_changed" : "first_build",
            providerCount: managed.size
          });
          const rebuilt = new Map<string, RepoAuthPlugin>();
          for (const [providerId, entry] of managed.entries()) {
            try {
              rebuilt.set(
                providerId,
                new RepoAuthPlugin(
                  { projectId: entry.projectId, auth: entry.auth },
                  {
                    logger: log,
                    fetchImpl: factoryOptions.fetchImpl,
                    onAuthorizationUrl: factoryOptions.onAuthorizationUrl,
                    cacheDir: factoryOptions.cacheDir
                  }
                )
              );
            } catch (error) {
              // validateAuthConfig inside the constructor can still reject
              // (e.g. client_credentials without clientSecret). Fail that one
              // provider, keep the rest — never abort the whole transform.
              log.warn("repo_auth_skipped_invalid_auth", {
                providerId,
                error: error instanceof Error ? error.message : String(error)
              });
            }
          }
          state.pluginByProvider = rebuilt;
          state.signature = signature;
        } else {
          log.trace("repo_auth_runtime_reused", { providerCount: managed.size });
        }
        log.trace("repo_auth_transform_finished", { managedCount: state.pluginByProvider.size });
      });

      yield* ctx.session.hook("model.request", (event) =>
        Effect.promise(async () => {
          const providerId = event.model.providerID;
          const plugin = state.pluginByProvider.get(providerId);
          if (!plugin) {
            log.trace("repo_auth_model_request_skipped", {
              providerId,
              managed: state.pluginByProvider.has(providerId)
            });
            return;
          }

          // Fail closed: on any exchange failure we inject NO header — the
          // request goes out without a bearer and the gateway 401s, matching
          // the SPI's fail-closed semantics. The failure itself is logged at
          // error level by `resolveProjectToken` (`repo_auth_exchange_failed`);
          // it must not escape the hook, or the whole model request would error
          // instead of degrading to the gateway's 401.
          try {
            const token = await plugin.resolveProjectToken({ interactive: true });
            event.headers.Authorization = `${token.tokenType || "Bearer"} ${token.accessToken}`;
            log.trace("repo_auth_model_request_bearer_injected", {
              providerId,
              present: Boolean(token.accessToken),
              tokenType: token.tokenType || "Bearer"
            });
          } catch {
            log.trace("repo_auth_model_request_no_bearer", { providerId });
          }
        })
      );
    })
  });
}

export const OpencodeRepoAuthPlugin: Plugin.Plugin = createOpencodeRepoAuthPlugin();

export default OpencodeRepoAuthPlugin;
