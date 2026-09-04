import { join } from "node:path";

import {
  FileCacheStore as LegacyFileCacheStore,
  type Logger,
  type TokenSet
} from "@vymalo/opencode-auth-core/lib";
import {
  FileCacheStore as SharedFileCacheStore,
  type CachedServerState
} from "@vymalo/opencode-provider-sync/lib";

/**
 * The pre-ADR-0017 on-disk location of lightbridge's human root token:
 * `<cacheRoot>/opencode-lightbridge/lightbridge.json`, a bare `TokenSet`
 * (see the OLD `LIGHTBRIDGE_IDENTITY`/`DEFAULT_CACHE_NAMESPACE` in `plugin.ts`,
 * which are still used verbatim for the exchanged project-token store — only
 * the ROOT token relocated).
 */
const OLD_ROOT_CACHE_NAMESPACE = "opencode-lightbridge";
const OLD_ROOT_KEY = "lightbridge";

function hasUsableTokenShape(value: unknown): value is TokenSet {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.accessToken === "string" &&
    candidate.accessToken.length > 0 &&
    typeof candidate.tokenType === "string" &&
    candidate.tokenType.length > 0
  );
}

/**
 * One-time migration read-path (ADR-0017, mandatory — not optional polish).
 *
 * v0.17 moves lightbridge's human root token from its own bespoke file
 * (`<cacheRoot>/opencode-lightbridge/lightbridge.json`, a bare `TokenSet`) to
 * the SAME fused `CachedServerState` file `@vymalo/opencode-oauth2` uses
 * (`<cacheRoot>/<sharedSegment>/<sharedNamespace>/<serverId>.json`) so the two
 * plugins can share one login (ADR-0017 §"one login, shared cache"). An
 * install that already has a valid old-format token must NOT be forced
 * through a fresh device-code/browser login just because the file moved.
 *
 * Behaviour:
 * - If the NEW location already has a persisted state (with or without a
 *   token), this is a no-op — never clobbers a fresher state (e.g. one
 *   oauth2 has already been writing to, with real discovered models).
 * - Else, read the OLD location. If it holds a structurally usable token
 *   (`accessToken` + `tokenType` present — possibly expired; an expired
 *   token with a refresh token is still worth adopting, since `TokenRuntime`
 *   will refresh it transparently), write it into the NEW location as a
 *   fresh `CachedServerState` (empty `models`/`rawModels` — nothing to carry
 *   over, since the old shape never tracked models).
 * - Else (no old file, or it's empty/malformed) this is a no-op; the caller
 *   proceeds to a normal login.
 *
 * The old file is left in place (non-destructive) — this function only ever
 * ADDS the new file, never deletes/mutates the old one. Safe to call more
 * than once: the "new location already has a state" check makes every call
 * after the first a cheap no-op.
 */
export async function migrateRootTokenIfNeeded(
  cacheRoot: string,
  sharedSegment: string,
  sharedNamespace: string,
  serverId: string,
  logger: Logger
): Promise<void> {
  const sharedStore = new SharedFileCacheStore(
    join(cacheRoot, sharedSegment, sharedNamespace),
    logger
  );

  let alreadyMigrated: CachedServerState | undefined;
  try {
    alreadyMigrated = await sharedStore.loadServerState(serverId);
  } catch (error) {
    logger.debug("lightbridge_root_migration_check_failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
  if (alreadyMigrated) {
    // New location already has SOME state (with or without a token) — either
    // a previous migration ran, or oauth2/register already populated it.
    // Never overwrite it from the old file.
    return;
  }

  const legacyStore = new LegacyFileCacheStore(join(cacheRoot, OLD_ROOT_CACHE_NAMESPACE), logger);
  let legacyToken: unknown;
  try {
    legacyToken = await legacyStore.load<TokenSet>(OLD_ROOT_KEY);
  } catch (error) {
    logger.debug("lightbridge_root_migration_legacy_read_failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  if (!hasUsableTokenShape(legacyToken)) {
    logger.trace("lightbridge_root_migration_nothing_to_adopt", { serverId });
    return;
  }

  const migrated: CachedServerState = {
    serverId,
    updatedAt: Date.now(),
    models: [],
    rawModels: [],
    token: legacyToken
  };

  await sharedStore.ensureReady();
  await sharedStore.saveServerState(migrated);
  logger.info("lightbridge_root_migration_adopted", {
    serverId,
    hadRefreshToken: Boolean(legacyToken.refreshToken)
  });
}
