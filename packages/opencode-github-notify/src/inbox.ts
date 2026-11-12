import { join } from "node:path";

import { readWatchState, type WatchState } from "./thread.js";
import { fileKey, KeyedMutex, readJson, tryLock, writeJsonAtomic } from "./store.js";
import type { ThreadEvent, WatchConfig } from "./types.js";

export const SESSION_STATE_VERSION = 1;
const SESSION_LOCK_WAIT_MS = 5_000;

/**
 * One session's position in every watch's log. `delivered` is the last seq handed to the
 * model; `notified` is the last seq a notice was queued for (so a notice is sent once per
 * batch, not once per poll).
 */
export interface SessionState {
  readonly version: number;
  readonly sessionID: string;
  delivered: Record<string, number>;
  notified: Record<string, number>;
}

/** A session's cursor file is unreadable. Never reset silently: that would replay or skip. */
export class CursorError extends Error {
  override readonly name = "CursorError";
}

/** The lock is held elsewhere for longer than we wait. Retrying is always safe. */
export class BusyError extends Error {
  override readonly name = "BusyError";
}

export interface InboxDeps {
  readonly stateDir: string;
  readonly watches: readonly WatchConfig[];
  /**
   * When the session began, in epoch ms, if known. A session meeting a watch for the first
   * time starts after every event observed before that instant — so comments that arrived
   * between session start and its first tool call are still delivered, and older history is not.
   */
  readonly sessionStartedAt?: (sessionID: string) => Promise<number | undefined>;
  readonly now?: () => number;
  /** How long to wait for a session lock held by another process. */
  readonly lockWaitMs?: number;
}

export interface WatchBatch {
  readonly watch: string;
  readonly events: readonly ThreadEvent[];
  /** Events evicted by retention before this session read them. Reported, never hidden. */
  readonly missed: number;
  /** Events still waiting after this batch. */
  readonly remaining: number;
  /** The watch has not completed its first poll yet. */
  readonly pendingBaseline: boolean;
  /** When `pendingBaseline`, why: the last poll's failure, if it failed. */
  readonly lastError?: string;
}

export interface WatchStatus {
  readonly watch: string;
  readonly baselined: boolean;
  readonly pending: number;
  readonly lastPoll?: WatchState["lastPoll"];
  readonly lastSuccessAt?: string;
  readonly nextPollAt?: string;
  readonly consecutiveFailures: number;
}

function sessionPath(stateDir: string, sessionID: string): string {
  return join(stateDir, "sessions", `${fileKey(sessionID)}.json`);
}

function sessionLockPath(stateDir: string, sessionID: string): string {
  return join(stateDir, "locks", `session-${fileKey(sessionID)}.lock`);
}

function isSessionState(value: unknown, sessionID: string): value is SessionState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const state = value as Partial<SessionState>;
  return (
    state.version === SESSION_STATE_VERSION &&
    state.sessionID === sessionID &&
    typeof state.delivered === "object" &&
    state.delivered !== null &&
    typeof state.notified === "object" &&
    state.notified !== null
  );
}

/** Where a session's cursor starts on a watch it has not met before. */
export function initialCursor(state: WatchState | undefined, startedAt: number): number {
  if (!state) {
    // Not polled yet: every event it will ever record is newer than this session.
    return 0;
  }
  let cursor = state.evictedThrough;
  for (const event of state.events) {
    if (Date.parse(event.observedAt) <= startedAt) {
      cursor = event.seq;
    }
  }
  return cursor;
}

export interface Inbox {
  /** Hand out up to `limit` undelivered events and advance this session's cursors. */
  next(sessionID: string, limit: number): Promise<WatchBatch[]>;
  /** The last `limit` retained events per watch, regardless of cursors. Read-only. */
  recent(limit: number, watch?: string): Promise<ThreadEvent[]>;
  /** Per-watch health and this session's pending count. Read-only for the log. */
  status(sessionID: string): Promise<WatchStatus[]>;
  /**
   * Per watch, how many events are waiting that this session has neither read nor been
   * notified of. `commit` marks them notified; call it only after the notice was accepted.
   */
  unnotified(sessionID: string): Promise<{
    counts: Record<string, Partial<Record<ThreadEvent["kind"], number>>>;
    total: number;
    commit(): Promise<void>;
  }>;
}

export function createInbox(deps: InboxDeps): Inbox {
  const now = deps.now ?? Date.now;
  const mutex = new KeyedMutex();

  /** Run `task` holding both the in-process mutex and the cross-process session lock. */
  const withSession = <T>(
    sessionID: string,
    task: (state: SessionState, save: () => Promise<void>) => Promise<T>
  ): Promise<T> =>
    mutex.run(sessionID, async () => {
      const lock = await tryLock(sessionLockPath(deps.stateDir, sessionID), {
        waitMs: deps.lockWaitMs ?? SESSION_LOCK_WAIT_MS
      });
      if (!lock) {
        throw new BusyError("another process is updating this session's cursor; retry");
      }
      try {
        const path = sessionPath(deps.stateDir, sessionID);
        const read = await readJson<unknown>(path);
        let state: SessionState;
        if (read.status === "missing") {
          state = { version: SESSION_STATE_VERSION, sessionID, delivered: {}, notified: {} };
        } else if (read.status === "ok" && isSessionState(read.value, sessionID)) {
          state = read.value;
        } else {
          throw new CursorError(
            `cursor file ${path} is unreadable; delete it to restart this session from now`
          );
        }
        return await task(state, () => writeJsonAtomic(path, state));
      } finally {
        await lock.release();
      }
    });

  const loadWatches = async () =>
    Promise.all(
      deps.watches.map(async (watch) => ({
        watch,
        state: await readWatchState(deps.stateDir, watch)
      }))
    );

  /** Initialise cursors for watches this session has not met. Returns true if any changed. */
  const ensureCursors = async (
    sessionID: string,
    session: SessionState,
    watches: Awaited<ReturnType<typeof loadWatches>>
  ): Promise<boolean> => {
    const missing = watches.filter(({ watch }) => session.delivered[watch.key] === undefined);
    if (missing.length === 0) {
      return false;
    }
    const startedAt = (await deps.sessionStartedAt?.(sessionID).catch(() => undefined)) ?? now();
    for (const { watch, state } of missing) {
      session.delivered[watch.key] = initialCursor(state, startedAt);
    }
    return true;
  };

  return {
    next(sessionID, limit) {
      return withSession(sessionID, async (session, save) => {
        const watches = await loadWatches();
        let dirty = await ensureCursors(sessionID, session, watches);
        let budget = Math.max(1, limit);
        const batches: WatchBatch[] = [];

        for (const { watch, state } of watches) {
          const cursor = session.delivered[watch.key] ?? 0;
          if (!state) {
            batches.push({
              watch: watch.key,
              events: [],
              missed: 0,
              remaining: 0,
              pendingBaseline: true
            });
            continue;
          }
          const missed = Math.max(0, state.evictedThrough - cursor);
          const pending = state.events.filter((event) => event.seq > cursor);
          const events = pending.slice(0, budget);
          budget -= events.length;
          const last = events[events.length - 1]?.seq;
          const advanced = Math.max(cursor, last ?? 0, missed > 0 ? state.evictedThrough : 0);
          if (advanced !== cursor) {
            session.delivered[watch.key] = advanced;
            dirty = true;
          }
          const failed = !state.baselined && state.lastPoll && !state.lastPoll.ok;
          batches.push({
            watch: watch.key,
            events,
            missed,
            remaining: pending.length - events.length,
            pendingBaseline: !state.baselined,
            ...(failed ? { lastError: `${state.lastPoll?.kind}: ${state.lastPoll?.error}` } : {})
          });
        }

        // Commit BEFORE returning: once the model has the events, a crash must not hand
        // them out again. (`recent` is the recovery path if a turn is lost after this.)
        if (dirty) {
          await save();
        }
        return batches;
      });
    },

    async recent(limit, watchKey) {
      const watches = await loadWatches();
      const events: ThreadEvent[] = [];
      for (const { watch, state } of watches) {
        if (watchKey && watch.key.toLowerCase() !== watchKey.toLowerCase()) {
          continue;
        }
        events.push(...(state?.events.slice(-Math.max(1, limit)) ?? []));
      }
      return events
        .sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0))
        .slice(-Math.max(1, limit));
    },

    status(sessionID) {
      return withSession(sessionID, async (session, save) => {
        const watches = await loadWatches();
        if (await ensureCursors(sessionID, session, watches)) {
          await save();
        }
        return watches.map(({ watch, state }) => {
          const cursor = session.delivered[watch.key] ?? 0;
          return {
            watch: watch.key,
            baselined: state?.baselined ?? false,
            pending: state ? state.events.filter((event) => event.seq > cursor).length : 0,
            consecutiveFailures: state?.consecutiveFailures ?? 0,
            ...(state?.lastPoll ? { lastPoll: state.lastPoll } : {}),
            ...(state?.lastSuccessAt ? { lastSuccessAt: state.lastSuccessAt } : {}),
            ...(state?.nextPollAt ? { nextPollAt: new Date(state.nextPollAt).toISOString() } : {})
          };
        });
      });
    },

    async unnotified(sessionID) {
      return withSession(sessionID, async (session, save) => {
        const watches = await loadWatches();
        const initialised = await ensureCursors(sessionID, session, watches);
        const counts: Record<string, Partial<Record<ThreadEvent["kind"], number>>> = {};
        const marks: Record<string, number> = {};
        let total = 0;
        for (const { watch, state } of watches) {
          if (!state) {
            continue;
          }
          const floor = Math.max(
            session.delivered[watch.key] ?? 0,
            session.notified[watch.key] ?? 0
          );
          const fresh = state.events.filter((event) => event.seq > floor);
          if (fresh.length === 0) {
            continue;
          }
          const perKind: Partial<Record<ThreadEvent["kind"], number>> = {};
          for (const event of fresh) {
            perKind[event.kind] = (perKind[event.kind] ?? 0) + 1;
          }
          counts[watch.key] = perKind;
          marks[watch.key] = fresh[fresh.length - 1]?.seq ?? floor;
          total += fresh.length;
        }
        if (initialised) {
          await save();
        }
        return {
          counts,
          total,
          // Re-enters the session lock: the notice is sent between the two critical sections,
          // so a slow host call never holds the lock.
          commit: () =>
            withSession(sessionID, async (fresh, persist) => {
              for (const [key, seq] of Object.entries(marks)) {
                fresh.notified[key] = Math.max(fresh.notified[key] ?? 0, seq);
              }
              await persist();
            })
        };
      });
    }
  };
}
