import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { Logger } from "./logging.js";
import type { CachedServerState } from "./types.js";

function resolveDefaultCacheRoot(): string {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches");
  }

  return process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
}

export function resolveCacheDir(namespace: string): string {
  return join(resolveDefaultCacheRoot(), "opencode-oauth2", namespace);
}

function statePath(baseDir: string, serverId: string): string {
  return join(baseDir, `${serverId}.json`);
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
  constructor(
    private readonly baseDir: string,
    private readonly logger?: Logger | undefined
  ) {}

  async ensureReady(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
  }

  async loadServerState(serverId: string): Promise<CachedServerState | undefined> {
    const filePath = statePath(this.baseDir, serverId);

    try {
      const content = await readFile(filePath, "utf8");
      const parsed = JSON.parse(content) as CachedServerState;

      if (!parsed || parsed.serverId !== serverId) {
        return undefined;
      }

      if (!Array.isArray(parsed.models) || !Array.isArray(parsed.rawModels)) {
        return undefined;
      }

      if (parsed.token && !hasValidTokenShape(parsed.token)) {
        this.logger?.trace("oauth2_cache_token_dropped_invalid_shape", { serverId });
        parsed.token = undefined;
      }

      this.logger?.trace("oauth2_cache_file_read", {
        serverId,
        modelCount: Array.isArray(parsed.models) ? parsed.models.length : 0,
        hasToken: Boolean(parsed.token)
      });
      return parsed;
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        (error as { code: string }).code === "ENOENT"
      ) {
        this.logger?.trace("oauth2_cache_file_missing", { serverId });
        return undefined;
      }
      throw error;
    }
  }

  async saveServerState(state: CachedServerState): Promise<void> {
    const filePath = statePath(this.baseDir, state.serverId);
    // Unique per-write temp name. A shared `${filePath}.tmp` collides when
    // several opencode instances boot at once (the desktop app restores every
    // project window in parallel) and all sync the same provider: one process'
    // rename consumes the temp file the other is about to rename, surfacing as
    // `sync_failed … ENOENT … rename '<serverId>.json.tmp' -> '<serverId>.json'`.
    // pid + uuid makes each writer's temp file private; rename stays atomic so
    // last-writer-wins on the final path. See docs/troubleshooting.md.
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });

    const serialized = JSON.stringify(state, null, 2);
    try {
      await writeFile(tempPath, serialized, {
        encoding: "utf8",
        mode: 0o600,
        flag: fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY
      });
      await rename(tempPath, filePath);
      this.logger?.trace("oauth2_cache_file_written", {
        serverId: state.serverId,
        modelCount: Array.isArray(state.models) ? state.models.length : 0,
        hasToken: Boolean(state.token)
      });
    } catch (error) {
      // Best-effort cleanup so a failed write never strands an orphan temp file.
      await unlink(tempPath).catch(() => {});
      throw error;
    }

    try {
      await chmod(filePath, 0o600);
    } catch {
      // Some filesystems may ignore chmod semantics; keep operation non-fatal.
    }
  }
}
