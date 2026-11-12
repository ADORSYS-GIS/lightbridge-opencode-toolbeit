import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "./logging.js";
import {
  WAKE_SOURCE_KINDS,
  type SubscriptionRecord,
  type SubscriptionState,
  type WakeEvent,
  type WakeEventKind,
  type WakeSourceKind,
  type WakeSubscription
} from "./types.js";

/** Ids this plugin generates; also the only ids it will accept back from a tool call. */
const ID_PATTERN = /^wake_[a-f0-9]{16}$/;

export function newSubscriptionID(): string {
  return `wake_${randomBytes(8).toString("hex")}`;
}

export function isSubscriptionID(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** Fresh state for a new watch: nothing pending, cursor at "now" so no backlog is dumped. */
export function initialState(now: number): SubscriptionState {
  return {
    cursor: { lastSeenAt: new Date(now).toISOString() },
    pending: [],
    seen: [],
    consecutiveFailures: 0,
    nextPollAt: now
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const EVENT_KINDS: readonly WakeEventKind[] = [
  "comment",
  "review",
  "review_comment",
  "review_request",
  "state",
  "label",
  "assignee",
  "commit",
  "check"
];

function isEvent(value: unknown): value is WakeEvent {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.id === "string" &&
    EVENT_KINDS.includes(record.kind as WakeEventKind) &&
    typeof record.author === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    typeof record.url === "string" &&
    typeof record.body === "string" &&
    (record.title === undefined || typeof record.title === "string")
  );
}

function isSubscription(value: unknown): value is WakeSubscription {
  const record = asRecord(value);
  return (
    record !== undefined &&
    isSubscriptionID(record.id) &&
    typeof record.sessionID === "string" &&
    record.sessionID.length > 0 &&
    WAKE_SOURCE_KINDS.includes(record.kind as WakeSourceKind) &&
    typeof record.owner === "string" &&
    typeof record.repo === "string" &&
    typeof record.number === "number" &&
    Array.isArray(record.mentions) &&
    record.mentions.every((mention) => typeof mention === "string") &&
    typeof record.intervalMs === "number" &&
    typeof record.createdAt === "string"
  );
}

/**
 * Rebuild state from whatever is on disk. A corrupt field falls back rather
 * than throwing: a hand-edited cursor must not take the poller down, but a
 * corrupt *subscription* is dropped (we cannot guess what it watched).
 */
function parseState(value: unknown, now: number): SubscriptionState {
  const base = initialState(now);
  const record = asRecord(value);
  if (!record) {
    return base;
  }
  const cursor = asRecord(record.cursor);
  const pending = Array.isArray(record.pending) ? record.pending.filter(isEvent) : [];
  const seen = Array.isArray(record.seen)
    ? record.seen.filter((id): id is string => typeof id === "string")
    : [];
  const etags = asRecord(record.etags);
  const validEtags: Record<string, string> = {};
  for (const [url, value] of Object.entries(etags ?? {})) {
    if (typeof value === "string") {
      validEtags[url] = value;
    }
  }

  return {
    cursor: {
      lastSeenAt:
        typeof cursor?.lastSeenAt === "string" ? cursor.lastSeenAt : base.cursor.lastSeenAt,
      ...(typeof cursor?.lastEventID === "string" ? { lastEventID: cursor.lastEventID } : {}),
      ...(typeof cursor?.headSHA === "string" ? { headSHA: cursor.headSHA } : {})
    },
    ...(Object.keys(validEtags).length > 0 ? { etags: validEtags } : {}),
    pending,
    seen,
    consecutiveFailures:
      typeof record.consecutiveFailures === "number" ? record.consecutiveFailures : 0,
    ...(typeof record.lastError === "string" ? { lastError: record.lastError } : {}),
    ...(typeof record.lastPollAt === "string" ? { lastPollAt: record.lastPollAt } : {}),
    nextPollAt: typeof record.nextPollAt === "number" ? record.nextPollAt : now
  };
}

export interface SubscriptionStoreOptions {
  readonly dir: string;
  readonly logger: Logger;
  /** Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * One JSON file per subscription under the STATE root, written atomically
 * (per-writer temp + rename, ADR-0005) with `0o600` — a thread watch is not a
 * secret, but the directory also holds nothing the user would want world
 * readable, and the mode keeps a future field from leaking by accident.
 *
 * The in-memory map is the read path; every mutation is flushed before it is
 * reported as done, so a crash cannot lose a cursor the caller believes is
 * advanced.
 */
export class SubscriptionStore {
  private readonly records = new Map<string, SubscriptionRecord>();
  private readonly now: () => number;
  private loaded = false;

  constructor(private readonly options: SubscriptionStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  get dir(): string {
    return this.options.dir;
  }

  private path(id: string): string {
    return join(this.options.dir, `${id}.json`);
  }

  /** Read every subscription file. Called once by the plugin, and by `wake_list` after a restart. */
  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    let entries: string[];
    try {
      entries = await readdir(this.options.dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const id = entry.slice(0, -".json".length);
      if (!isSubscriptionID(id)) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(await readFile(this.path(id), "utf8"));
        const record = asRecord(parsed);
        if (!record || !isSubscription(record.subscription)) {
          this.options.logger.warn("wake_subscription_unreadable", { id });
          continue;
        }
        this.records.set(id, {
          subscription: record.subscription,
          state: parseState(record.state, this.now())
        });
      } catch (error) {
        this.options.logger.warn("wake_subscription_unreadable", {
          id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  list(sessionID?: string): SubscriptionRecord[] {
    const all = [...this.records.values()];
    const filtered =
      sessionID === undefined
        ? all
        : all.filter((record) => record.subscription.sessionID === sessionID);
    return filtered.sort((a, b) =>
      a.subscription.createdAt.localeCompare(b.subscription.createdAt)
    );
  }

  get(id: string): SubscriptionRecord | undefined {
    return this.records.get(id);
  }

  async put(record: SubscriptionRecord): Promise<void> {
    await mkdir(this.options.dir, { recursive: true });
    const target = this.path(record.subscription.id);
    const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, target);
    this.records.set(record.subscription.id, record);
  }

  async remove(id: string): Promise<boolean> {
    if (!this.records.delete(id)) {
      return false;
    }
    try {
      await unlink(this.path(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return true;
  }
}
