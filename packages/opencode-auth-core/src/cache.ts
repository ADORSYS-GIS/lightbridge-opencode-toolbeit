import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { Logger } from "./logging.js";

function resolveDefaultCacheRoot(): string {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches");
  }

  return process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
}

/**
 * The platform's default cache root (never created here, just resolved). Exposed
 * so consumers can build their own cache paths sharing the same root while
 * keeping their own on-disk location stable (e.g. oauth2 preserves its existing
 * `<root>/opencode-oauth2/<ns>` path rather than moving under a new folder).
 */
export function resolveCacheRoot(): string {
  return resolveDefaultCacheRoot();
}

/**
 * Deterministic, path-safe digest of an arbitrary cache key. `FileCacheStore`
 * uses keys verbatim as filenames (see `statePath`), so a raw caller-supplied
 * key (an `audience` URL, a `project_id`, …) could carry path-hostile
 * characters — a URL-shaped key breaks on Windows (`:` is illegal in NTFS
 * filenames) and creates nested directories on POSIX (`/`). Truncated sha256
 * keeps the key short, opaque and stable for the same input.
 */
export function hashCacheKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function resolveCacheDir(namespace: string): string {
  return join(resolveDefaultCacheRoot(), "opencode-auth-core", namespace);
}

function statePath(baseDir: string, key: string): string {
  return join(baseDir, `${key}.json`);
}

/**
 * Identity-keyed file cache. Each entry is addressed by an arbitrary `key`
 * string (e.g. a provider server id, a repo Source id, …) so a shared library
 * can persist *whatever* state a plugin needs without the cache knowing about
 * any one plugin's shape. The caller is responsible for validating the shape
 * it reads back.
 *
 * Writes are atomic (per-writer temp file + rename, ADR-0005) with `0o600`
 * permissions so concurrent processes never collide on a shared temp and the
 * cached credentials never leave the owning user's control.
 */
export class FileCacheStore {
  constructor(
    private readonly baseDir: string,
    private readonly logger?: Logger | undefined
  ) {}

  /**
   * The directory this store writes into. Exposed so a caller can place
   * sibling coordination state (e.g. `TokenRuntime`'s refresh lock files)
   * next to the cached entries without duplicating the path resolution.
   */
  get directory(): string {
    return this.baseDir;
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
  }

  async load<T>(key: string): Promise<T | undefined> {
    const filePath = statePath(this.baseDir, key);

    try {
      const content = await readFile(filePath, "utf8");
      const parsed = JSON.parse(content) as T;
      this.logger?.trace("auth_cache_file_read", { key });
      return parsed;
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        (error as { code: string }).code === "ENOENT"
      ) {
        this.logger?.trace("auth_cache_file_missing", { key });
        return undefined;
      }
      // A corrupted/partial file (e.g. a hard crash mid-write) must not poison
      // the runtime — treat it as a cache miss rather than throwing.
      this.logger?.warn("auth_cache_file_unreadable", {
        key,
        error: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }

  async save(key: string, value: unknown): Promise<void> {
    const filePath = statePath(this.baseDir, key);
    // Unique per-write temp name. A shared `${filePath}.tmp` collides when
    // several processes (or several opencode instances) write the same entry
    // in parallel. pid + uuid makes each writer's temp file private; rename
    // stays atomic so last-writer-wins on the final path. See ADR-0005.
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });

    const serialized = JSON.stringify(value, null, 2);
    try {
      await writeFile(tempPath, serialized, {
        encoding: "utf8",
        mode: 0o600,
        flag: fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY
      });
      await rename(tempPath, filePath);
      this.logger?.trace("auth_cache_file_written", { key });
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

  async remove(key: string): Promise<void> {
    const filePath = statePath(this.baseDir, key);
    await unlink(filePath).catch(() => {});
  }

  /**
   * Keys of the entries currently persisted in this store, optionally filtered
   * to a key prefix. Used by callers that must rewrite or remove every entry
   * under a namespace (e.g. `TokenRuntime.reset` clearing all `identity-*`
   * exchanged tokens). Missing/empty dirs return `[]` — never throws on a
   * store that has not been written to yet.
   */
  async listKeys(prefix = ""): Promise<string[]> {
    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      return entries
        .filter(
          (entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".json")
        )
        .map((entry) => entry.name.slice(0, -".json".length));
    } catch {
      return [];
    }
  }
}
