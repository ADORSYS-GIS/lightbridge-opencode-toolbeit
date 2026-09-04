import { join } from "node:path";

import {
  FileCacheStore as AuthCacheStore,
  resolveCacheRoot,
  type Logger
} from "@vymalo/opencode-auth-core/lib";
import type { CachedServerState } from "./types.js";

/**
 * A provider-sync consumer keeps its own per-server model-sync state (a fused
 * `CachedServerState` of models + token), written through auth-core's generic,
 * atomic, identity-keyed `FileCacheStore`. The state *shape* and validation are
 * provider-sync's; the disk IO (per-writer temp + rename, `0o600`) is the
 * shared implementation, so there is no second copy of the atomic-write logic.
 *
 * The on-disk location is `<root>/<segment>/<namespace>` — `segment` identifies
 * the *consuming plugin* (e.g. `"opencode-oauth2"`), not this package, so an
 * existing install's cache path is entirely up to its caller and never moves
 * just because the engine that reads/writes it does.
 */
export function resolveCacheDir(segment: string, namespace: string): string {
  return join(resolveCacheRoot(), segment, namespace);
}

function hasValidTokenShape(token: unknown): boolean {
  if (!token || typeof token !== "object" || Array.isArray(token)) {
    return false;
  }

  const candidate = token as Record<string, unknown>;
  if (
    typeof candidate.accessToken !== "string" ||
    candidate.accessToken.length === 0 ||
    typeof candidate.tokenType !== "string" ||
    candidate.tokenType.length === 0
  ) {
    return false;
  }

  // refreshToken is optional: client_credentials grant never returns one.
  // When present, it must be a non-empty string.
  if (candidate.refreshToken !== undefined) {
    return typeof candidate.refreshToken === "string" && candidate.refreshToken.length > 0;
  }
  return true;
}

export class FileCacheStore {
  private readonly store: AuthCacheStore;

  constructor(baseDir: string, logger?: Logger | undefined) {
    this.store = new AuthCacheStore(baseDir, logger);
  }

  async ensureReady(): Promise<void> {
    await this.store.ensureReady();
  }

  async loadServerState(serverId: string): Promise<CachedServerState | undefined> {
    const parsed = await this.store.load<CachedServerState>(serverId);
    if (!parsed) {
      return undefined;
    }

    if (!parsed || parsed.serverId !== serverId) {
      return undefined;
    }

    if (!Array.isArray(parsed.models) || !Array.isArray(parsed.rawModels)) {
      return undefined;
    }

    if (parsed.token && !hasValidTokenShape(parsed.token)) {
      parsed.token = undefined;
    }

    return parsed;
  }

  async saveServerState(state: CachedServerState): Promise<void> {
    await this.store.save(state.serverId, state);
  }
}
