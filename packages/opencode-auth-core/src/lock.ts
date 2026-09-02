import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import type { Logger } from "./logging.js";

/**
 * How long a lock file may sit untouched before another holder treats it as
 * abandoned. Must comfortably exceed the HTTP timeout of the operation the
 * lock guards (a token refresh, 15s by default) so a slow-but-alive holder is
 * never robbed of its lock.
 */
export const DEFAULT_LOCK_STALE_MS = 30_000;

/** Poll interval while waiting for a contended lock. */
export const DEFAULT_LOCK_POLL_INTERVAL_MS = 75;

/**
 * Extra wait allowed on top of `staleMs` before giving up. A holder that is
 * still alive re-appears as "not stale" forever; the bound is what keeps a
 * wedged lock from hanging a chat request indefinitely.
 */
export const LOCK_WAIT_MARGIN_MS = 5_000;

export type FileLockUnavailableReason = "unwritable" | "timeout";

export interface FileLockOptions {
  staleMs?: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  logger?: Logger;
  /** Structured fields merged into every event this helper logs. */
  logFields?: Record<string, unknown>;
}

export interface FileLock {
  /**
   * `false` when the lock could not be taken. The caller is expected to
   * proceed anyway — this is an advisory lock, and a filesystem that cannot
   * host it must never become a permanent authentication outage.
   */
  readonly acquired: boolean;
  readonly reason?: FileLockUnavailableReason;
  release(): Promise<void>;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return undefined;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function unavailable(reason: FileLockUnavailableReason): FileLock {
  return {
    acquired: false,
    reason,
    release: async () => {}
  };
}

/**
 * Age of an existing lock file in milliseconds, or `undefined` when it has
 * vanished (the holder released it between our failed create and this read).
 * A lock whose payload cannot be parsed falls back to the file's mtime, and a
 * file that yields neither is reported as infinitely old so a corrupt lock can
 * always be broken rather than wedging every process forever.
 */
async function lockAgeMs(lockPath: string): Promise<number | undefined> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { acquiredAt?: unknown };
    if (typeof parsed.acquiredAt === "number" && Number.isFinite(parsed.acquiredAt)) {
      return Date.now() - parsed.acquiredAt;
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
  }

  try {
    const stats = await stat(lockPath);
    return Date.now() - stats.mtimeMs;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Cross-process advisory lock built on `open(path, "wx")` (O_CREAT|O_EXCL),
 * which is atomic on every filesystem this runs on. The payload records the
 * owning pid and acquisition time so a crashed holder's lock can be recognised
 * as abandoned and broken instead of blocking every other process forever.
 *
 * The lock is deliberately best-effort: when the directory cannot be created
 * or the file cannot be written (EACCES, EROFS, ENOTDIR, a read-only container
 * layer, …) this returns `acquired: false` rather than throwing, and the
 * caller proceeds unlocked.
 */
export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions = {}
): Promise<FileLock> {
  const staleMs = positiveOr(options.staleMs, DEFAULT_LOCK_STALE_MS);
  const pollIntervalMs = positiveOr(options.pollIntervalMs, DEFAULT_LOCK_POLL_INTERVAL_MS);
  const maxWaitMs = positiveOr(options.maxWaitMs, staleMs + LOCK_WAIT_MARGIN_MS);
  const deadline = Date.now() + maxWaitMs;
  const logFields = options.logFields ?? {};
  let waitLogged = false;

  try {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  } catch {
    return unavailable("unwritable");
  }

  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), {
          encoding: "utf8"
        });
      } finally {
        await handle.close();
      }

      return {
        acquired: true,
        release: async () => {
          await unlink(lockPath).catch(() => {});
        }
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        return unavailable("unwritable");
      }
    }

    const age = await lockAgeMs(lockPath);
    if (age === undefined) {
      // Released while we looked; retry the create immediately.
      if (Date.now() >= deadline) {
        return unavailable("timeout");
      }
      continue;
    }

    if (age > staleMs) {
      options.logger?.warn("token_lock_stale_broken", { ...logFields, ageMs: Math.round(age) });
      const removed = await unlink(lockPath).then(
        () => true,
        () => false
      );
      if (Date.now() >= deadline) {
        return unavailable("timeout");
      }
      if (!removed) {
        await sleep(pollIntervalMs);
      }
      continue;
    }

    if (Date.now() >= deadline) {
      return unavailable("timeout");
    }

    if (!waitLogged) {
      waitLogged = true;
      options.logger?.debug("token_lock_wait", { ...logFields, ageMs: Math.round(age) });
    }

    await sleep(pollIntervalMs);
  }
}
