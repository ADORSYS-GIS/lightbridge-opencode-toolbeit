import { createHash, randomBytes } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle
} from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "./logging.js";

/**
 * A per-watch **delivery lease**: one live poller at a time may fetch and wake
 * for a watch key. It lives beside the watch state (its own `leases/` directory)
 * so two plugin instances over one STATE root see the same owner.
 *
 * The lease is deliberately short-lived state, not a source of truth: if it is
 * lost, the worst case is a skipped poll, never a lost event (the cursor and
 * `seen` ring are separate). It is renewed on every poll and released by a
 * graceful `stop()`.
 */
export interface LeaseRecord {
  /** The watch key this lease protects. */
  readonly key: string;
  /** A poller instance id. Stable for the lifetime of one plugin instance. */
  readonly owner: string;
  /** Epoch ms after which another owner may take the lease. */
  readonly expiresAt: number;
}

export interface LeaseStoreOptions {
  readonly dir: string;
  readonly logger: Logger;
  /** Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Floor for a lease TTL. A very short poll interval (tests, or a caller that
 * asked for the minimum) must not make the lease expire between two polls.
 */
export const LEASE_TTL_FLOOR_MS: number = 60_000;
/**
 * Ceiling for a lease TTL. Even at the slowest allowed interval a crashed
 * owner must eventually be replaced; two missed polls is the widest bound.
 */
export const LEASE_TTL_CEILING_FACTOR = 2;
/** Extra slack on top of two negotiated intervals, for a slow fetch + delivery. */
export const LEASE_TTL_MARGIN_MS: number = 30_000;

/** The widest a lease may ever be: two maximum intervals, never below the floor. */
export function leaseTtlCeilingMs(maxIntervalMs: number): number {
  return Math.max(LEASE_TTL_FLOOR_MS, maxIntervalMs * LEASE_TTL_CEILING_FACTOR);
}

/**
 * How long a lease stays valid. It must outlive the gap between two polls of a
 * live owner (otherwise two pollers would alternate), so it is based on the
 * **negotiated interval** of the subscribers, not a fixed constant:
 *
 *   ttl = clamp(2 × interval + 30 s, 60 s, 2 × maxIntervalMs)
 *
 * - two intervals tolerate one missed/delayed poll;
 * - +30 s covers a fetch and a delivery that run past the scheduled time;
 * - the 60 s floor keeps a 1 s test interval from expiring mid-poll;
 * - the ceiling (2 h by default) bounds crash failover. A crashed owner can
 *   delay delivery by at most one TTL, never wedge the watch forever.
 */
export function leaseTtlMs(intervalMs: number, maxIntervalMs: number): number {
  const wanted = intervalMs * 2 + LEASE_TTL_MARGIN_MS;
  return Math.min(Math.max(wanted, LEASE_TTL_FLOOR_MS), leaseTtlCeilingMs(maxIntervalMs));
}

/**
 * TTL for an owner that is about to idle for `idleMs` — a failure backoff. The
 * lease must outlive the backoff, otherwise another poller takes over a watch
 * whose owner is correctly waiting and issues its own request, amplifying a
 * rate limit. The result is clamped to the same ceiling as a normal lease.
 */
export function leaseTtlForIdleMs(
  idleMs: number,
  intervalMs: number,
  maxIntervalMs: number
): number {
  const wanted = Math.max(0, idleMs) + LEASE_TTL_MARGIN_MS;
  return Math.min(
    leaseTtlCeilingMs(maxIntervalMs),
    Math.max(leaseTtlMs(intervalMs, maxIntervalMs), wanted)
  );
}

/** A random, process-unique owner id. Never derived from a session or a token. */
export function newLeaseOwnerID(): string {
  return `lease_${randomBytes(8).toString("hex")}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseLease(value: unknown): LeaseRecord | undefined {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.key !== "string" ||
    typeof record.owner !== "string" ||
    record.owner.length === 0 ||
    typeof record.expiresAt !== "number" ||
    !Number.isFinite(record.expiresAt)
  ) {
    return undefined;
  }
  return { key: record.key, owner: record.owner, expiresAt: record.expiresAt };
}

/** Path-safe, stable file name for one watch key. */
export function leaseFileFor(key: string): string {
  return `${createHash("sha256").update(key).digest("hex").slice(0, 16)}.json`;
}

/**
 * File-backed lease with an **exclusive-create** claim for a free slot and a
 * **compare-and-swap** for every mutation of an existing lease.
 *
 * `open(path, "wx")` is atomic on a local filesystem: of two processes racing
 * for a free lease exactly one gets the file. Replacing a lease cannot use that
 * primitive, because the old file exists. The CAS is built from two POSIX
 * primitives:
 *
 * 1. write the new claim to a unique temp file;
 * 2. `rename(target, trash)` to take the current file aside atomically;
 * 3. read `trash` and compare it with the exact record this caller observed;
 * 4. `link(temp, target)` to publish the claim. `link` fails with `EEXIST` when
 *    another process won the slot in the meantime, so only one caller succeeds.
 *
 * A file that does not match is put back with `link(trash, target)` (which also
 * fails if a third caller has already claimed the slot). This is what prevents
 * the old read → `unlink` → `wx` race in which the second of two pollers
 * deleted the first one's fresh lease and both claims succeeded. `renew` and
 * `release` use the same discipline, so a renewal cannot clobber a takeover.
 *
 * Known boundary: on a filesystem that does not honour atomic exclusive create,
 * hard links or rename (some network shares), two claims can still both
 * succeed. This lease is therefore a single-writer guard, not a distributed
 * consensus protocol — the docs say so explicitly and no global exactly-once
 * claim is made.
 */
export class LeaseStore {
  private readonly now: () => number;

  constructor(private readonly options: LeaseStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  get dir(): string {
    return this.options.dir;
  }

  private path(key: string): string {
    return join(this.options.dir, leaseFileFor(key));
  }

  /** A unique sibling path; never one of the two lease filenames. */
  private tempPath(key: string, suffix: "claim" | "trash"): string {
    return `${this.path(key)}.${process.pid}.${randomBytes(4).toString("hex")}.${suffix}`;
  }

  /**
   * The current lease, if the file exists and is readable. An unreadable file
   * is reported separately: it may be a claim that is still being written
   * (`open(..., "wx")` creates the file before its JSON lands), so `acquire`
   * must not steal it blindly.
   */
  private async readRaw(
    key: string
  ): Promise<{ readonly lease?: LeaseRecord; readonly unreadable: boolean }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path(key), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { unreadable: false };
      }
      this.options.logger.warn("wake_lease_unreadable", {
        key,
        error: error instanceof Error ? error.message : String(error)
      });
      return { unreadable: true };
    }
    const lease = parseLease(parsed);
    if (!lease || lease.key !== key) {
      this.options.logger.warn("wake_lease_unreadable", { key });
      return { unreadable: true };
    }
    return { lease, unreadable: false };
  }

  /** Read one lease file without logging: used on the CAS trash snapshot. */
  private async readLeaseFile(path: string): Promise<LeaseRecord | undefined> {
    try {
      return parseLease(JSON.parse(await readFile(path, "utf8")));
    } catch {
      return undefined;
    }
  }

  /** The current lease, if the file exists and is readable. */
  async read(key: string): Promise<LeaseRecord | undefined> {
    return (await this.readRaw(key)).lease;
  }

  /**
   * Claim or renew the lease for `key`. Returns `true` only when this owner may
   * deliver. A live lease held by another owner returns `false` — the caller
   * must skip the poll entirely (no fetch, no pending append, no notice).
   */
  async acquire(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const at = this.now();
    const expiresAt = at + ttlMs;
    const { lease: current, unreadable } = await this.readRaw(key);

    if (current) {
      if (current.expiresAt > at && current.owner !== owner) {
        return false;
      }
      if (current.owner === owner) {
        return this.renew(key, owner, ttlMs);
      }
      // Expired: swap only the exact record just read. If another poller took
      // over (or renewed) between the read and the swap, the comparison fails
      // and its fresh lease is restored instead of being deleted.
      return this.compareAndSwap(key, (observed) => sameLease(observed, current), {
        key,
        owner,
        expiresAt
      });
    }

    if (unreadable) {
      // A claim being written is briefly unreadable. Fail closed while the file
      // is fresh (it is a live claimant, not a crash); only a file older than
      // one TTL is treated as corrupt leftovers and reclaimed.
      const metadata = await stat(this.path(key)).catch(() => undefined);
      if (!metadata) {
        return this.createExclusive(key, owner, expiresAt);
      }
      if (at - metadata.mtimeMs <= ttlMs) {
        return false;
      }
      this.options.logger.warn("wake_lease_stale_unreadable", {
        key,
        ageMs: at - metadata.mtimeMs
      });
      return this.reclaimUnreadable(key, owner, expiresAt, ttlMs);
    }

    // Free slot: exclusive create is the atomic claim.
    return this.createExclusive(key, owner, expiresAt);
  }

  /**
   * Extend a lease this owner already holds. Returns `false` when the lease is
   * gone or has been taken over — the caller has lost the watch and must not
   * deliver.
   */
  async renew(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const current = await this.read(key);
    if (!current || current.owner !== owner) {
      return false;
    }
    // Compare on the owner, not the expiry: two renewals from the same owner
    // are both valid, while a takeover by another owner must win.
    return this.compareAndSwap(
      key,
      (observed) => observed.key === key && observed.owner === owner,
      {
        key,
        owner,
        expiresAt: this.now() + ttlMs
      }
    );
  }

  /** Release only a lease this owner still holds; never steal another's. */
  async release(key: string, owner: string): Promise<void> {
    const current = await this.read(key);
    if (!current || current.owner !== owner) {
      return;
    }
    await this.removeIf(key, (observed) => observed.key === key && observed.owner === owner);
  }

  /**
   * Reclaim a stale unreadable file with the same move-aside discipline. The
   * file may have been replaced by a fresh claim while it was being inspected;
   * in that case it is restored and this caller loses.
   */
  private async reclaimUnreadable(
    key: string,
    owner: string,
    expiresAt: number,
    ttlMs: number
  ): Promise<boolean> {
    const trash = await this.moveAside(key);
    if (trash === undefined) {
      // It vanished while we looked: the slot is free again.
      return this.createExclusive(key, owner, expiresAt);
    }
    try {
      const metadata = await stat(trash).catch(() => undefined);
      if (!metadata || this.now() - metadata.mtimeMs <= ttlMs) {
        await this.restore(trash, key);
        return false;
      }
      return await this.createExclusive(key, owner, expiresAt);
    } finally {
      await this.unlinkQuietly(trash);
    }
  }

  /**
   * Replace the lease only if the file still holds a record accepted by
   * `matches`. The temp claim is published with `link`, so a concurrent claim
   * wins the slot rather than being overwritten.
   */
  private async compareAndSwap(
    key: string,
    matches: (observed: LeaseRecord) => boolean,
    next: LeaseRecord
  ): Promise<boolean> {
    const temp = await this.writeClaim(key, next);
    let trash: string | undefined;
    try {
      trash = await this.moveAside(key);
      if (trash === undefined) {
        // The lease vanished between our read and the move: claim the free slot
        // with the same exclusive link.
        return await this.linkClaim(temp, key);
      }
      const observed = await this.readLeaseFile(trash);
      if (!observed || !matches(observed)) {
        // Another poller changed the lease. Put its file back if the slot is
        // still free; if a third caller already claimed it, that claim wins.
        await this.restore(trash, key);
        return false;
      }
      return await this.linkClaim(temp, key);
    } finally {
      if (trash !== undefined) {
        await this.unlinkQuietly(trash);
      }
      await this.unlinkQuietly(temp);
    }
  }

  /** Remove the lease only if the file still holds a record accepted by `matches`. */
  private async removeIf(
    key: string,
    matches: (observed: LeaseRecord) => boolean
  ): Promise<boolean> {
    const trash = await this.moveAside(key);
    if (trash === undefined) {
      return false;
    }
    try {
      const observed = await this.readLeaseFile(trash);
      if (!observed || !matches(observed)) {
        await this.restore(trash, key);
        return false;
      }
      return true;
    } finally {
      await this.unlinkQuietly(trash);
    }
  }

  private async writeClaim(key: string, lease: LeaseRecord): Promise<string> {
    await mkdir(this.options.dir, { recursive: true });
    const temp = this.tempPath(key, "claim");
    await writeFile(temp, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
    return temp;
  }

  /** Publish a claim with `link`; `EEXIST` means another caller won. */
  private async linkClaim(temp: string, key: string): Promise<boolean> {
    try {
      await link(temp, this.path(key));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }
  }

  /** Move the current lease aside atomically; `undefined` when it is gone. */
  private async moveAside(key: string): Promise<string | undefined> {
    const trash = this.tempPath(key, "trash");
    try {
      await rename(this.path(key), trash);
      return trash;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  /** Put a file taken aside back, unless another caller already claimed the slot. */
  private async restore(trash: string, key: string): Promise<void> {
    try {
      await link(trash, this.path(key));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async unlinkQuietly(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async createExclusive(key: string, owner: string, expiresAt: number): Promise<boolean> {
    await mkdir(this.options.dir, { recursive: true });
    let handle: FileHandle;
    try {
      handle = await open(this.path(key), "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }
    try {
      await handle.writeFile(`${JSON.stringify({ key, owner, expiresAt }, null, 2)}\n`);
    } finally {
      await handle.close();
    }
    return true;
  }
}

function sameLease(a: LeaseRecord | undefined, b: LeaseRecord | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.key === b.key &&
    a.owner === b.owner &&
    a.expiresAt === b.expiresAt
  );
}
