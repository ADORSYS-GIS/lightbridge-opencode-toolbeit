import { createHash, randomBytes } from "node:crypto";
import {
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
  const ceiling = Math.max(LEASE_TTL_FLOOR_MS, maxIntervalMs * LEASE_TTL_CEILING_FACTOR);
  return Math.min(Math.max(wanted, LEASE_TTL_FLOOR_MS), ceiling);
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
 * File-backed lease with an **exclusive-create** claim. `open(path, "wx")` is
 * the primitive that makes a claim atomic on a local filesystem: of two
 * processes racing for a free lease exactly one gets the file. An expired lease
 * is removed first; the following `wx` create then has the same guarantee.
 *
 * Known boundary: on a filesystem that does not honour atomic exclusive create
 * (some network shares), two claims can both succeed. This lease is therefore a
 * single-writer guard, not a distributed consensus protocol — the docs say so
 * explicitly and no global exactly-once claim is made.
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
    const { lease: current, unreadable } = await this.readRaw(key);
    if (current && current.expiresAt > at && current.owner !== owner) {
      return false;
    }
    if (current && current.owner === owner) {
      return this.renew(key, owner, ttlMs);
    }
    if (current) {
      // Expired: remove it, then race for the free slot with `wx`.
      await this.removeFile(key);
    } else if (unreadable) {
      // A claim being written is briefly unreadable. Fail closed while the file
      // is fresh (it is a live claimant, not a crash); only a file older than
      // one TTL is treated as corrupt leftovers and removed.
      const metadata = await stat(this.path(key)).catch(() => undefined);
      if (!metadata) {
        return this.createExclusive(key, owner, at + ttlMs);
      }
      if (at - metadata.mtimeMs <= ttlMs) {
        return false;
      }
      this.options.logger.warn("wake_lease_stale_unreadable", {
        key,
        ageMs: at - metadata.mtimeMs
      });
      await this.removeFile(key);
    }
    return this.createExclusive(key, owner, at + ttlMs);
  }

  private async removeFile(key: string): Promise<void> {
    try {
      await unlink(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
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
    await this.writeAtomic(key, {
      key,
      owner,
      expiresAt: this.now() + ttlMs
    });
    return true;
  }

  /** Release only a lease this owner still holds; never steal another's. */
  async release(key: string, owner: string): Promise<void> {
    const current = await this.read(key);
    if (!current || current.owner !== owner) {
      return;
    }
    try {
      await unlink(this.path(key));
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

  /** Atomic per-writer temp + rename (ADR-0005), mode `0o600`. */
  private async writeAtomic(key: string, lease: LeaseRecord): Promise<void> {
    await mkdir(this.options.dir, { recursive: true });
    const path = this.path(key);
    const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
  }
}
