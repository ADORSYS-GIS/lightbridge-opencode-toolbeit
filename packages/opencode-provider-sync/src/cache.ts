import { join } from "node:path";

import {
  FileCacheStore as AuthFileStore,
  resolveCacheRoot,
  resolveStateRoot,
  type Logger,
  type TokenSet
} from "@vymalo/opencode-auth-core/lib";
import type { CachedServerState } from "./types.js";

/**
 * A provider-sync consumer persists its per-server state as TWO records, split
 * by what the OS may do to them (ADR-0022):
 *
 * - the **credential** record (`ServerCredentialStore`) — the OAuth token
 *   (`access` / `refresh` material) — lives under the durable STATE root, next
 *   to the refresh lock that guards it, because macOS/Linux/cleanup tools purge
 *   cache dirs and a purged refresh token silently logs the user out;
 * - the **model** record (`ModelCacheStore`) — discovered `models` /
 *   `rawModels` — lives under the CACHE root. It is rebuilt by the next sync,
 *   so losing it costs one network round trip.
 *
 * Before ADR-0022 both were one fused `CachedServerState` file in the cache
 * root. The in-memory shape (`CachedServerState`) is unchanged; only the
 * persistence is split. Both stores write through auth-core's generic, atomic
 * (per-writer temp + rename, ADR-0005), `0o600`/`0o700` `FileCacheStore`, so
 * there is no second copy of the atomic-write logic.
 *
 * The relative location is `<root>/<segment>/<namespace>` — `segment`
 * identifies the *consuming plugin* (e.g. `"opencode-oauth2"`), not this
 * package — and is identical under both roots, so oauth2 and lightbridge, which
 * pin the same segment/namespace, resolve the very same credential file.
 */
export function resolveCacheDir(segment: string, namespace: string): string {
  return join(resolveCacheRoot(), segment, namespace);
}

/** Credential counterpart of `resolveCacheDir`: same relative path, under the STATE root. */
export function resolveStateDir(segment: string, namespace: string): string {
  return join(resolveStateRoot(), segment, namespace);
}

/** What the credential file holds: only the token and the stamp used for cross-process adoption. */
export interface StoredCredential {
  serverId: string;
  updatedAt: number;
  token: TokenSet;
}

/** What the model-cache file holds: everything in `CachedServerState` except the token. */
export type StoredModels = Pick<
  CachedServerState,
  "serverId" | "updatedAt" | "lastSyncAt" | "models" | "rawModels"
>;

/**
 * Model-cache filenames carry a `.models` suffix so that, on Windows (where the
 * state root and the cache root are the same directory), a model record can
 * never overwrite — or be mistaken for — the credential record `<serverId>.json`.
 */
const MODELS_KEY_SUFFIX = ".models";

function hasValidTokenShape(token: unknown): token is TokenSet {
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

/**
 * Persists a server's OAuth token under the durable state dir. The directory it
 * is given must be the same one handed to the server's `TokenRuntime` as
 * `stateDir`, so the refresh lock (`<dir>/locks/<id>.lock`) sits beside the
 * token it guards.
 */
export class ServerCredentialStore {
  private readonly store: AuthFileStore;

  constructor(baseDir: string, logger?: Logger | undefined) {
    this.store = new AuthFileStore(baseDir, logger);
  }

  get directory(): string {
    return this.store.directory;
  }

  async ensureReady(): Promise<void> {
    await this.store.ensureReady();
  }

  /** The record, or `undefined` when missing, unreadable, mismatched, or holding a malformed token. */
  async load(serverId: string): Promise<StoredCredential | undefined> {
    const parsed = await this.store.load<StoredCredential>(serverId);
    if (!parsed || parsed.serverId !== serverId || !hasValidTokenShape(parsed.token)) {
      return undefined;
    }
    if (typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt)) {
      return undefined;
    }
    return parsed;
  }

  async save(serverId: string, token: TokenSet, updatedAt: number): Promise<void> {
    const record: StoredCredential = { serverId, updatedAt, token };
    await this.store.save(serverId, record);
  }

  /** Forget the credential (logout). Missing file is not an error. */
  async remove(serverId: string): Promise<void> {
    await this.store.remove(serverId);
  }
}

/** Persists a server's discovered-model list under the (disposable) cache dir. */
export class ModelCacheStore {
  private readonly store: AuthFileStore;

  constructor(baseDir: string, logger?: Logger | undefined) {
    this.store = new AuthFileStore(baseDir, logger);
  }

  get directory(): string {
    return this.store.directory;
  }

  async ensureReady(): Promise<void> {
    await this.store.ensureReady();
  }

  async load(serverId: string): Promise<StoredModels | undefined> {
    const parsed = await this.store.load<StoredModels>(`${serverId}${MODELS_KEY_SUFFIX}`);
    if (!parsed || parsed.serverId !== serverId) {
      return undefined;
    }
    if (!Array.isArray(parsed.models) || !Array.isArray(parsed.rawModels)) {
      return undefined;
    }
    return parsed;
  }

  async save(state: CachedServerState): Promise<void> {
    // Explicitly omit the token: a model record must never carry credentials.
    const record: StoredModels = {
      serverId: state.serverId,
      updatedAt: state.updatedAt,
      lastSyncAt: state.lastSyncAt,
      models: state.models,
      rawModels: state.rawModels
    };
    await this.store.save(`${state.serverId}${MODELS_KEY_SUFFIX}`, record);
  }
}

/**
 * Both records for one server, merged into the in-memory `CachedServerState`.
 * The credential survives a purged model cache (and vice versa): either record
 * alone yields a usable state; `undefined` only when neither exists.
 */
export class ServerStateStore {
  readonly credentials: ServerCredentialStore;
  readonly models: ModelCacheStore;

  constructor(cacheDir: string, stateDir: string, logger?: Logger | undefined) {
    this.models = new ModelCacheStore(cacheDir, logger);
    this.credentials = new ServerCredentialStore(stateDir, logger);
  }

  async ensureReady(): Promise<void> {
    await this.credentials.ensureReady();
    await this.models.ensureReady();
  }

  async loadServerState(serverId: string): Promise<CachedServerState | undefined> {
    const credential = await this.credentials.load(serverId);
    const models = await this.models.load(serverId);
    if (!credential && !models) {
      return undefined;
    }

    return {
      serverId,
      updatedAt: Math.max(credential?.updatedAt ?? 0, models?.updatedAt ?? 0),
      lastSyncAt: models?.lastSyncAt,
      models: models?.models ?? [],
      rawModels: models?.rawModels ?? [],
      token: credential?.token
    };
  }

  /** Writes the credential FIRST: a rotated refresh token is the record that must not be lost. */
  async saveServerState(state: CachedServerState): Promise<void> {
    if (state.token) {
      await this.credentials.save(state.serverId, state.token, state.updatedAt);
    } else {
      await this.credentials.remove(state.serverId);
    }
    await this.models.save(state);
  }
}
