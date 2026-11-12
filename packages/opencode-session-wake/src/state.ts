import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { initialLoopState } from "./loop.js";
import type { Logger } from "./logging.js";
import {
  WAKE_SOURCE_KINDS,
  type LoopState,
  type SubscriberState,
  type SubscriptionRecord,
  type WakeCursor,
  type WakeEvent,
  type WakeEventKind,
  type WakeProject,
  type WakeSourceKind,
  type WakeSubscription,
  type WatchRecord,
  type WatchState,
  type WatchTarget
} from "./types.js";

/** Ids this plugin generates; also the only ids it will accept back from a tool call. */
const ID_PATTERN = /^wake_[a-f0-9]{16}$/;

export function newSubscriptionID(): string {
  return `wake_${randomBytes(8).toString("hex")}`;
}

export function isSubscriptionID(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/**
 * The fetch identity of a watch: two sessions watching the same target share
 * one fetcher, one cursor and one ETag map. Owner/repo are lower-cased because
 * GitHub treats them case-insensitively — `Acme/Widgets` and `acme/widgets` must
 * not become two pollers.
 *
 * The first five segments are the original format, kept byte-identical so
 * existing watch files are still found. `github.actions` has no number (the
 * segment stays empty) and appends its workflow/branch filters, because two
 * watches on different workflows are different targets. The filter values are
 * percent-encoded so a name containing `|` (or the `branch:` prefix) cannot
 * forge a segment and collide with another target's key.
 */
export function watchKey(target: WatchTarget): string {
  const parts = [
    target.apiBase,
    target.kind,
    target.owner.toLowerCase(),
    target.repo.toLowerCase(),
    target.number === undefined ? "" : String(target.number)
  ];
  if (target.workflow !== undefined) {
    parts.push(`workflow:${encodeURIComponent(target.workflow)}`);
  }
  if (target.branch !== undefined) {
    parts.push(`branch:${encodeURIComponent(target.branch)}`);
  }
  return parts.join("|");
}

/** Path-safe, stable file name for a watch key. */
export function watchFileFor(key: string): string {
  return `${createHash("sha256").update(key).digest("hex").slice(0, 16)}.json`;
}

/** Fresh delivery state for a subscriber: nothing pending, no loop history. */
export function initialSubscriberState(): SubscriberState {
  return { pending: [], seen: [], loop: initialLoopState() };
}

/**
 * Fresh fetch state for a watch: cursor at "now" so no backlog is dumped, and
 * an immediate first poll.
 */
export function initialWatchState(now: number, subscribers: string[] = []): WatchState {
  return {
    cursor: { lastSeenAt: new Date(now).toISOString() },
    seen: [],
    consecutiveFailures: 0,
    nextPollAt: now,
    subscribers: [...subscribers],
    lastTouchedAt: now
  };
}

/** State read from a pre-registry subscription file, used to seed its watch. */
export interface LegacyWatchSeed {
  readonly target: Omit<WatchTarget, "apiBase">;
  readonly cursor: WakeCursor;
  readonly etags?: Record<string, string>;
  readonly seen: string[];
  readonly consecutiveFailures: number;
  readonly lastError?: string;
  readonly lastPollAt?: string;
  readonly nextPollAt: number;
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
  "check",
  "run"
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

/**
 * The target shape a source actually needs. The three thread sources require an
 * issue/PR number and take no filters; `github.actions` takes the opposite. A
 * mismatch is corrupt state, not a watch to poll: accepting it would leave a
 * watch that fails every tick (`malformed`) with no way to recover.
 */
function hasSourceShape(
  kind: WakeSourceKind,
  target: { number?: unknown; workflow?: unknown; branch?: unknown }
): boolean {
  const stringOrAbsent = (value: unknown): boolean =>
    value === undefined || typeof value === "string";
  if (!stringOrAbsent(target.workflow) || !stringOrAbsent(target.branch)) {
    return false;
  }
  if (kind === "github.actions") {
    return target.number === undefined;
  }
  return (
    typeof target.number === "number" &&
    target.workflow === undefined &&
    target.branch === undefined
  );
}

/**
 * Parse the optional project identity. A malformed value is treated as absent
 * (a legacy record) rather than making the whole subscription unreadable: the
 * cursor and unread events matter more than the identity, and a record with an
 * unknown project is still adoptable only within this state root.
 */
export function parseProject(value: unknown): WakeProject | undefined {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string" || record.id.length === 0) {
    return undefined;
  }
  if (typeof record.directory !== "string" || record.directory.length === 0) {
    return undefined;
  }
  return {
    id: record.id,
    directory: record.directory,
    ...(typeof record.canonical === "string" && record.canonical.length > 0
      ? { canonical: record.canonical }
      : {})
  };
}

function isSubscription(value: unknown): value is WakeSubscription {
  const record = asRecord(value);
  return (
    record !== undefined &&
    isSubscriptionID(record.id) &&
    typeof record.sessionID === "string" &&
    record.sessionID.length > 0 &&
    // A malformed `project` block must not discard the record: `load` drops
    // only the identity below, keeping the pending events readable.
    WAKE_SOURCE_KINDS.includes(record.kind as WakeSourceKind) &&
    typeof record.owner === "string" &&
    typeof record.repo === "string" &&
    hasSourceShape(record.kind as WakeSourceKind, record) &&
    Array.isArray(record.mentions) &&
    record.mentions.every((mention) => typeof mention === "string") &&
    (record.ignoreAuthors === undefined ||
      (Array.isArray(record.ignoreAuthors) &&
        record.ignoreAuthors.every((author) => typeof author === "string"))) &&
    typeof record.intervalMs === "number" &&
    typeof record.createdAt === "string"
  );
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseLoop(value: unknown): LoopState {
  const record = asRecord(value);
  if (!record) {
    return initialLoopState();
  }
  const wakes = Array.isArray(record.wakes)
    ? record.wakes.filter((at): at is number => typeof at === "number" && Number.isFinite(at))
    : [];
  return {
    wakes,
    suppressed: typeof record.suppressed === "number" ? record.suppressed : 0,
    loopSuspected: record.loopSuspected === true,
    ...(typeof record.cooldownUntil === "number" ? { cooldownUntil: record.cooldownUntil } : {})
  };
}

function parseSubscriberState(value: unknown): SubscriberState {
  const record = asRecord(value);
  if (!record) {
    return initialSubscriberState();
  }
  return {
    pending: Array.isArray(record.pending) ? record.pending.filter(isEvent) : [],
    seen: stringList(record.seen),
    ...(typeof record.lastError === "string" ? { lastError: record.lastError } : {}),
    loop: parseLoop(record.loop)
  };
}

function parseCursor(value: unknown, fallback: string): WakeCursor {
  const record = asRecord(value);
  return {
    lastSeenAt: typeof record?.lastSeenAt === "string" ? record.lastSeenAt : fallback,
    ...(typeof record?.lastEventID === "string" ? { lastEventID: record.lastEventID } : {}),
    ...(typeof record?.headSHA === "string" ? { headSHA: record.headSHA } : {}),
    ...(typeof record?.runFloor === "string" ? { runFloor: record.runFloor } : {})
  };
}

function parseEtags(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const etags: Record<string, string> = {};
  for (const [url, tag] of Object.entries(record)) {
    if (typeof tag === "string") {
      etags[url] = tag;
    }
  }
  return Object.keys(etags).length > 0 ? etags : undefined;
}

function parseWatchState(value: unknown, now: number): WatchState {
  const record = asRecord(value);
  const base = initialWatchState(now);
  if (!record) {
    return base;
  }
  const etags = parseEtags(record.etags);
  return {
    cursor: parseCursor(record.cursor, base.cursor.lastSeenAt),
    ...(etags !== undefined ? { etags } : {}),
    seen: stringList(record.seen),
    consecutiveFailures:
      typeof record.consecutiveFailures === "number" ? record.consecutiveFailures : 0,
    ...(typeof record.lastError === "string" ? { lastError: record.lastError } : {}),
    ...(typeof record.lastPollAt === "string" ? { lastPollAt: record.lastPollAt } : {}),
    nextPollAt: typeof record.nextPollAt === "number" ? record.nextPollAt : now,
    subscribers: stringList(record.subscribers),
    lastTouchedAt: typeof record.lastTouchedAt === "number" ? record.lastTouchedAt : now
  };
}

/** Atomic per-writer temp + rename (ADR-0005), mode `0o600`. */
async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export interface StoreOptions {
  readonly dir: string;
  readonly logger: Logger;
  /** Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * One JSON file per **subscriber** under the STATE root. The subscriber owns the
 * session, its filters and its private unread/loop state — never the cursor.
 */
export class SubscriptionStore {
  private readonly records = new Map<string, SubscriptionRecord>();
  private seeds: LegacyWatchSeed[] = [];
  private readonly now: () => number;
  private loaded = false;
  /**
   * Per-subscription write chains. Adoption and a poller that is finishing a
   * fetch must never interleave a whole-record write: the poller writes only
   * `state` through `updateState`, and every write for one id is serialized so
   * the subscription (owner, filters) is always the current one.
   */
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(private readonly options: StoreOptions) {
    this.now = options.now ?? Date.now;
  }

  get dir(): string {
    return this.options.dir;
  }

  private path(id: string): string {
    return join(this.options.dir, `${id}.json`);
  }

  private async serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChains.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(
      () => current,
      () => current
    );
    this.writeChains.set(id, chain);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.writeChains.get(id) === chain) {
        this.writeChains.delete(id);
      }
    }
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    let entries: string[];
    try {
      entries = await readdir(this.options.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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
        const { project: rawProject, ...subscriptionFields } = record.subscription;
        const project = parseProject(rawProject);
        const subscription: WakeSubscription = {
          ...subscriptionFields,
          ignoreAuthors: stringList(record.subscription.ignoreAuthors),
          ...(project !== undefined ? { project } : {})
        };
        this.records.set(id, {
          subscription,
          state: parseSubscriberState(record.state)
        });

        // Pre-registry records carried the cursor themselves. Keep the delivery
        // state, and hand the fetch state to the registry so the watch resumes
        // from the same cursor instead of re-delivering history.
        const legacy = asRecord(record.state);
        if (legacy && asRecord(legacy.cursor)) {
          this.seeds.push({
            target: {
              kind: subscription.kind,
              owner: subscription.owner,
              repo: subscription.repo,
              ...(subscription.number !== undefined ? { number: subscription.number } : {}),
              ...(subscription.workflow !== undefined ? { workflow: subscription.workflow } : {}),
              ...(subscription.branch !== undefined ? { branch: subscription.branch } : {})
            },
            cursor: parseCursor(legacy.cursor, new Date(this.now()).toISOString()),
            ...(parseEtags(legacy.etags) ? { etags: parseEtags(legacy.etags) } : {}),
            seen: stringList(legacy.seen),
            consecutiveFailures:
              typeof legacy.consecutiveFailures === "number" ? legacy.consecutiveFailures : 0,
            ...(typeof legacy.lastError === "string" ? { lastError: legacy.lastError } : {}),
            ...(typeof legacy.lastPollAt === "string" ? { lastPollAt: legacy.lastPollAt } : {}),
            nextPollAt: typeof legacy.nextPollAt === "number" ? legacy.nextPollAt : this.now()
          });
        }
      } catch (error) {
        this.options.logger.warn("wake_subscription_unreadable", {
          id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  /** Fetch state found in pre-registry files; consumed once by the registry. */
  legacySeeds(): LegacyWatchSeed[] {
    return this.seeds;
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

  listByKey(key: string, apiBase: string): SubscriptionRecord[] {
    return this.list().filter((record) => watchKey(targetOf(record.subscription, apiBase)) === key);
  }

  get(id: string): SubscriptionRecord | undefined {
    return this.records.get(id);
  }

  async put(record: SubscriptionRecord): Promise<void> {
    const id = record.subscription.id;
    await this.serialized(id, async () => {
      await mkdir(this.options.dir, { recursive: true });
      await writeAtomic(this.path(id), record);
      this.records.set(id, record);
    });
  }

  /**
   * Persist only the private delivery state of an **existing** subscription,
   * keeping whatever subscription the store currently holds. A poller that
   * captured a record before a network fetch must use this, never `put`: an
   * adoption may have replaced the record in the meantime, and writing the
   * captured subscription would silently move ownership back.
   *
   * Returns the record that was written, or `undefined` when the subscription
   * was removed while the fetch was in flight (it is never re-created).
   */
  async updateState(id: string, state: SubscriberState): Promise<SubscriptionRecord | undefined> {
    return this.serialized(id, async () => {
      const current = this.records.get(id);
      if (!current) {
        return undefined;
      }
      const next: SubscriptionRecord = { subscription: current.subscription, state };
      await mkdir(this.options.dir, { recursive: true });
      await writeAtomic(this.path(id), next);
      this.records.set(id, next);
      return next;
    });
  }

  /**
   * Atomically check the owner, take up to `limit` pending events and persist
   * the reduced queue. `wake_next` uses this so an adoption cannot interleave
   * between the ownership check and the write and leave the new owner without
   * events the old owner already read.
   */
  async takePending(
    id: string,
    sessionID: string,
    limit: number
  ): Promise<{ subscription: WakeSubscription; events: WakeEvent[] } | undefined> {
    return this.serialized(id, async () => {
      const current = this.records.get(id);
      if (!current || current.subscription.sessionID !== sessionID) {
        return undefined;
      }
      const events = current.state.pending.splice(0, limit);
      if (events.length > 0) {
        await mkdir(this.options.dir, { recursive: true });
        await writeAtomic(this.path(id), current);
        this.records.set(id, current);
      }
      return { subscription: current.subscription, events };
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.serialized(id, async () => {
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
    });
  }
}

/** The watch target a subscription belongs to, under the current `apiBase`. */
export function targetOf(subscription: WakeSubscription, apiBase: string): WatchTarget {
  return {
    apiBase,
    kind: subscription.kind,
    owner: subscription.owner,
    repo: subscription.repo,
    ...(subscription.number !== undefined ? { number: subscription.number } : {}),
    ...(subscription.workflow !== undefined ? { workflow: subscription.workflow } : {}),
    ...(subscription.branch !== undefined ? { branch: subscription.branch } : {})
  };
}

/**
 * Human-readable target for a notice or a log line. Thread sources keep the
 * `owner/repo#number` shape they have always had; `github.actions` names the
 * repository plus its filters, because a bare `#` would be meaningless there.
 */
export function targetLabel(target: {
  readonly owner: string;
  readonly repo: string;
  readonly number?: number;
  readonly workflow?: string;
  readonly branch?: string;
}): string {
  const repo = `${target.owner}/${target.repo}`;
  if (target.number !== undefined) {
    return `${repo}#${target.number}`;
  }
  const filters = [
    ...(target.workflow !== undefined ? [`workflow=${target.workflow}`] : []),
    ...(target.branch !== undefined ? [`branch=${target.branch}`] : [])
  ];
  return filters.length > 0 ? `${repo} actions (${filters.join(", ")})` : `${repo} actions`;
}

/** The label of the watch a subscription belongs to. */
export function subscriptionLabel(subscription: WakeSubscription): string {
  return targetLabel(subscription);
}

/**
 * One JSON file per **watch key**: the shared cursor, ETags, dedupe ring and
 * backoff that every subscriber of that target reads through.
 */
export class WatchStore {
  private readonly records = new Map<string, WatchRecord>();
  private readonly now: () => number;
  private loaded = false;

  constructor(private readonly options: StoreOptions) {
    this.now = options.now ?? Date.now;
  }

  get dir(): string {
    return this.options.dir;
  }

  private path(key: string): string {
    return join(this.options.dir, watchFileFor(key));
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    let entries: string[];
    try {
      entries = await readdir(this.options.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(await readFile(join(this.options.dir, entry), "utf8"));
        const record = asRecord(parsed);
        const target = asRecord(record?.target);
        if (
          !record ||
          typeof record.key !== "string" ||
          !target ||
          typeof target.apiBase !== "string" ||
          !WAKE_SOURCE_KINDS.includes(target.kind as WakeSourceKind) ||
          typeof target.owner !== "string" ||
          typeof target.repo !== "string" ||
          !hasSourceShape(target.kind as WakeSourceKind, target)
        ) {
          this.options.logger.warn("wake_watch_unreadable", { file: entry });
          continue;
        }
        const key = record.key;
        this.records.set(key, {
          key,
          target: {
            apiBase: target.apiBase,
            kind: target.kind as WakeSourceKind,
            owner: target.owner,
            repo: target.repo,
            ...(typeof target.number === "number" ? { number: target.number } : {}),
            ...(typeof target.workflow === "string" ? { workflow: target.workflow } : {}),
            ...(typeof target.branch === "string" ? { branch: target.branch } : {})
          },
          state: parseWatchState(record.state, this.now())
        });
      } catch (error) {
        this.options.logger.warn("wake_watch_unreadable", {
          file: entry,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  get(key: string): WatchRecord | undefined {
    return this.records.get(key);
  }

  list(): WatchRecord[] {
    return [...this.records.values()];
  }

  async put(record: WatchRecord): Promise<void> {
    await mkdir(this.options.dir, { recursive: true });
    await writeAtomic(this.path(record.key), record);
    this.records.set(record.key, record);
  }

  async remove(key: string): Promise<boolean> {
    if (!this.records.delete(key)) {
      return false;
    }
    try {
      await unlink(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return true;
  }
}
