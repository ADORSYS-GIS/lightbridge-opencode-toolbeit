import type { ProviderEditor } from "@opencode/plugin/effect/provider";

import type { Logger } from "./logging.js";
import type { RepoAuthPlugin } from "./plugin.js";

/**
 * The config-time bearer handoff for `@vymalo/opencode-models-info`, split in
 * two because a `provider.transform` callback must be synchronous (the same
 * shape `@vymalo/opencode-provider-sync` uses):
 *
 *  - {@link resolveCachedBearer} is ASYNC and runs OUTSIDE the transform;
 *  - {@link propagateCachedBearer} is SYNC and only writes a value it was
 *    handed. With no value it writes nothing — that is what keeps a failed
 *    exchange from ever producing a stamped header.
 */

/**
 * Resolve the `Authorization` value for a managed provider, or `undefined`.
 * Strictly non-interactive: a first-ever login must not block startup on a
 * browser/device-code prompt, so a missing or expired human root just yields
 * `undefined` (the first `model.request` does the login).
 */
export async function resolveCachedBearer(
  providerId: string,
  plugin: RepoAuthPlugin,
  logger: Logger
): Promise<string | undefined> {
  try {
    const token = await plugin.resolveProjectToken({ interactive: false });
    if (!token.accessToken) {
      logger.debug("repo_auth_bearer_propagation_skipped_empty_token", { providerId });
      return undefined;
    }
    return `${token.tokenType || "Bearer"} ${token.accessToken}`;
  } catch (error) {
    logger.debug("repo_auth_bearer_propagation_skipped_no_token", {
      providerId,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

/**
 * Stamp `authorization` onto `Provider.Info.headers.Authorization`. Must be
 * called inside a `provider.transform` callback. A user-set `Authorization`
 * (case-insensitive) always wins; `stamped` records what we last wrote per
 * provider so a value of ours can be refreshed while a user's is left alone.
 * `undefined` is a no-op: absence means "no credential".
 */
export function propagateCachedBearer(
  editor: ProviderEditor,
  providerId: string,
  authorization: string | undefined,
  logger: Logger,
  stamped?: Map<string, string>
): void {
  if (!authorization) {
    return;
  }
  const record = editor.get(providerId);
  if (!record) {
    return;
  }

  const headers = record.provider.headers ?? {};
  const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === "authorization");
  if (existingKey !== undefined && headers[existingKey] !== stamped?.get(providerId)) {
    logger.debug("repo_auth_bearer_propagation_skipped_user_set", { providerId });
    return;
  }

  editor.update(providerId, (provider) => {
    provider.headers = {
      ...(provider.headers ?? {}),
      [existingKey ?? "Authorization"]: authorization
    };
  });
  stamped?.set(providerId, authorization);
  logger.debug("repo_auth_bearer_propagated_to_provider_headers", { providerId });
}

/**
 * Fail-closed backstop for the stamp: when the per-request exchange fails, a
 * previously stamped (possibly expired) bearer must not ride out on the
 * request. Removes the `Authorization` header only if its value is exactly the
 * one this plugin stamped; a user-set header is never touched.
 */
export function dropStampedAuthorization(
  headers: Record<string, string>,
  stampedValue: string | undefined
): boolean {
  if (!stampedValue) {
    return false;
  }
  let dropped = false;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "authorization" && headers[key] === stampedValue) {
      delete headers[key];
      dropped = true;
    }
  }
  return dropped;
}
