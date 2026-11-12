import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";

export const NAMESPACE = "opencode-github-notify";

/** Must exceed the longest poll a holder can run (pages × request timeout). */
export const DEFAULT_LOCK_STALE_MS = 120_000;
const LOCK_POLL_INTERVAL_MS = 50;

export interface StateRootEnvironment {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
}

function absoluteOrUndefined(value: string | undefined, platform: NodeJS.Platform) {
  if (!value) {
    return undefined;
  }
  return (platform === "win32" ? win32 : posix).isAbsolute(value) ? value : undefined;
}

/**
 * The platform's durable STATE root — the same resolution as auth-core's
 * `resolveStateRoot` (ADR-0022), kept local so this plugin stays import-decoupled from the
 * auth packages. Cursors live here, never under the cache root: the OS purges cache dirs,
 * and a purged cursor would replay or lose comments.
 */
export function resolveStateRoot(environment: StateRootEnvironment = {}): string {
  const platform = environment.platform ?? process.platform;
  const env = environment.env ?? process.env;
  const home = environment.home ?? homedir();

  if (platform === "win32") {
    return absoluteOrUndefined(env.LOCALAPPDATA, platform) ?? join(home, "AppData", "Local");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support");
  }
  return absoluteOrUndefined(env.XDG_STATE_HOME, platform) ?? join(home, ".local", "state");
}

export function resolveStateDir(environment: StateRootEnvironment = {}): string {
  return join(resolveStateRoot(environment), NAMESPACE);
}

/** A storage key safe as a filename on every platform (`owner/repo#1` → `owner__repo__1`). */
export function fileKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "__");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export type ReadResult<T> =
  | { readonly status: "missing" }
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "corrupt"; readonly error: string };

/**
 * Read a JSON file. A corrupt file is reported, never silently treated as missing: for a
 * cursor, "missing" means "start fresh", which would re-deliver or skip comments.
 */
export async function readJson<T>(path: string): Promise<ReadResult<T>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { status: "missing" };
    }
    throw error;
  }
  try {
    return { status: "ok", value: JSON.parse(raw) as T };
  } catch (error) {
    return { status: "corrupt", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Atomic write: private temp file + rename (ADR-0005), `0o600` file in a `0o700` dir. A
 * crash leaves either the old file or the new one, never a torn one — which is what makes
 * "append events + advance cursor" a single commit.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  await chmod(path, 0o600).catch(() => {});
}

export interface Lock {
  release(): Promise<void>;
}

export interface LockOptions {
  /** How long to wait for a busy lock. `0` = try once. */
  readonly waitMs?: number;
  readonly staleMs?: number;
}

/** Is a process with this pid running on this machine? `undefined` when it cannot be told. */
export function isProcessAlive(pid: number): boolean | undefined {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: it exists but belongs to another user.
    const code = errorCode(error);
    return code === "ESRCH" ? false : code === "EPERM" ? true : undefined;
  }
}

interface Holder {
  readonly ageMs: number;
  readonly pid?: number;
}

/** Who holds a lock and for how long; `undefined` when the lock vanished meanwhile. */
async function lockHolder(path: string): Promise<Holder | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      acquiredAt?: unknown;
      pid?: unknown;
    };
    if (typeof parsed.acquiredAt === "number") {
      return {
        ageMs: Date.now() - parsed.acquiredAt,
        ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {})
      };
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
  }
  try {
    return { ageMs: Date.now() - (await stat(path)).mtimeMs };
  } catch (error) {
    return errorCode(error) === "ENOENT" ? undefined : { ageMs: Number.POSITIVE_INFINITY };
  }
}

/**
 * Cross-process lock on `open(path, "wx")` (O_CREAT|O_EXCL). Unlike auth-core's advisory
 * lock this one is STRICT: when it cannot be taken it returns `undefined` and the caller
 * must not touch the guarded state. That is safe here because skipping a poll or asking
 * the model to retry loses nothing, whereas proceeding unlocked could deliver a comment
 * twice.
 *
 * A dead holder's lock is broken at once: every holder runs on this machine and records
 * its pid, and a process that exits mid-poll (OpenCode closed, `opencode run` finished)
 * would otherwise block polling for every other session until `staleMs`. Seen on a real
 * v2.2.7 host. Age remains the fallback when liveness cannot be determined.
 */
export async function tryLock(path: string, options: LockOptions = {}): Promise<Lock | undefined> {
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const deadline = Date.now() + (options.waitMs ?? 0);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
      } finally {
        await handle.close();
      }
      return { release: () => unlink(path).catch(() => {}) };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }

    const holder = await lockHolder(path);
    if (holder === undefined) {
      continue;
    }
    const dead =
      holder.pid !== undefined &&
      holder.pid !== process.pid &&
      isProcessAlive(holder.pid) === false;
    if (dead || holder.ageMs > staleMs) {
      await unlink(path).catch(() => {});
      continue;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
  }
}

/**
 * In-process serialisation keyed by string. The file lock alone is enough for correctness,
 * but two fibers of one process would otherwise spin against their own lock file.
 */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.catch(() => {});
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    });
    return next;
  }
}
