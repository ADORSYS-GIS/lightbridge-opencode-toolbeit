import { describe, expect, it } from "vitest";

import { sameProject } from "../src/adoption.js";
import { parseWakeOptions } from "../src/config.js";
import type { GitHubTransport } from "../src/github.js";
import { createPoller } from "../src/poller.js";
import { resolveWakeProject } from "../src/project.js";
import { parseProject } from "../src/state.js";
import { createWakeToolInfos } from "../src/tools.js";
import type { WakeNotice, WakeProject } from "../src/types.js";
import {
  deferred,
  event,
  exec,
  fakeLogger,
  fakeTransport,
  keyOf,
  makeStores,
  page,
  PROJECT_A,
  PROJECT_B,
  record,
  seedWatch,
  tempDir
} from "./helpers.js";

const options = parseWakeOptions({
  intervalMs: 60_000,
  minIntervalMs: 15_000,
  maxIntervalMs: 600_000
});
const NOW = 1_000;

async function harness(
  dir: string,
  project: WakeProject | null = PROJECT_A,
  transportOverride?: GitHubTransport
) {
  const { store, watches } = await makeStores(dir, () => NOW);
  const transport = fakeTransport();
  const logger = fakeLogger();
  const delivered: WakeNotice[] = [];
  const poller = createPoller({
    store,
    watches,
    transport: transportOverride ?? transport,
    deliver: async (notice) => {
      delivered.push(notice);
    },
    logger,
    options,
    now: () => NOW,
    sleep: async () => {}
  });
  const infos = createWakeToolInfos({
    store,
    poller,
    options,
    logger,
    ...(project !== null ? { project } : {}),
    now: () => NOW
  });
  const byName = Object.fromEntries(infos.map((info) => [info.name, info]));
  const tool = (name: string) => {
    const info = byName[name];
    if (!info) {
      throw new Error(`missing tool ${name}`);
    }
    return info;
  };
  return { store, watches, transport, poller, logger, delivered, tool };
}

type Metadata = Record<string, unknown> | undefined;

describe("project identity", () => {
  it("resolves id, directory and canonical from the host location", () => {
    const project = resolveWakeProject({
      directory: "/work/a",
      project: { id: "prj_a", directory: "/work/a", canonical: "/work/a/.git" }
    });
    expect(project).toMatchObject({ id: "prj_a", directory: "/work/a", canonical: "/work/a/.git" });
  });

  it("falls back to the location directory, then to the working directory", () => {
    expect(resolveWakeProject({ directory: "/work/a" })).toMatchObject({
      id: "directory:/work/a",
      directory: "/work/a"
    });
    const cwd = resolveWakeProject({});
    expect(cwd.directory).toBe(process.cwd());
    expect(cwd.id).toBe(`directory:${process.cwd()}`);
  });

  it("matches by id, canonical or directory, but not by the global sentinel", () => {
    expect(sameProject(PROJECT_A, { ...PROJECT_A, directory: "/work/a-worktree" })).toBe(true);
    expect(sameProject(PROJECT_A, PROJECT_B)).toBe(false);
    expect(
      sameProject({ id: "global", directory: "/work/a" }, { id: "global", directory: "/work/b" })
    ).toBe(false);
    expect(
      sameProject({ id: "global", directory: "/work/a" }, { id: "global", directory: "/work/a" })
    ).toBe(true);
  });

  it("treats a malformed stored project as absent (a legacy record)", () => {
    expect(parseProject({ id: "p" })).toBeUndefined();
    expect(parseProject({ id: "", directory: "/work/a" })).toBeUndefined();
    expect(parseProject(null)).toBeUndefined();
    expect(parseProject({ id: "p", directory: "/work/a" })).toEqual({
      id: "p",
      directory: "/work/a"
    });
  });

  it("stores the project identity on a new subscription", async () => {
    const temp = await tempDir();
    try {
      const h = await harness(temp.dir, PROJECT_A);
      const result = await exec(
        h.tool("wake_subscribe"),
        { owner: "acme", repo: "widgets", number: 7 },
        "ses_owner"
      );
      // The subscribe path kicks off a non-awaited first poll; let it settle so
      // it cannot race the assertions or a later controlled poll.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const rec = h.store.list("ses_owner")[0];
      expect(rec?.subscription.project).toEqual(PROJECT_A);
      expect((result.metadata?.subscription as Metadata)?.project).toEqual(PROJECT_A);
    } finally {
      await temp.cleanup();
    }
  });
});

describe("wake_list — orphans", () => {
  it("does not show another session's watch unless includeOrphans is set", async () => {
    const temp = await tempDir();
    try {
      const h = await harness(temp.dir, PROJECT_A);
      const rec = record({ sessionID: "ses_old", project: PROJECT_A });
      rec.state.pending.push(event("101"));
      await h.store.put(rec);

      const own = await exec(h.tool("wake_list"), {}, "ses_new");
      expect(own.content).toContain("No thread subscriptions for this session.");
      expect(own.metadata?.orphans).toEqual([]);

      const withOrphans = await exec(h.tool("wake_list"), { includeOrphans: true }, "ses_new");
      expect(withOrphans.content).toContain(rec.subscription.id);
      expect(withOrphans.content).toContain("owner=ses_old orphan=true");
      expect(withOrphans.content).toContain("pending=1");
      expect(withOrphans.content).toContain("wake_adopt");
      expect(withOrphans.metadata?.orphans).toMatchObject([
        {
          id: rec.subscription.id,
          sessionID: "ses_old",
          owner: "ses_old",
          owned: false,
          pending: 1,
          project: PROJECT_A,
          adoption: { scope: "same-project", adoptable: true }
        }
      ]);
    } finally {
      await temp.cleanup();
    }
  });

  it("lists own watches and same-project orphans separately", async () => {
    const temp = await tempDir();
    try {
      const h = await harness(temp.dir, PROJECT_A);
      const own = record({ sessionID: "ses_new", project: PROJECT_A });
      const orphan = record({ sessionID: "ses_old", project: PROJECT_A, number: 8 });
      orphan.state.pending.push(event("201"));
      await h.store.put(own);
      await h.store.put(orphan);

      const listed = await exec(h.tool("wake_list"), { includeOrphans: true }, "ses_new");
      expect(listed.metadata?.subscriptions).toMatchObject([{ id: own.subscription.id }]);
      expect(listed.metadata?.orphans).toMatchObject([
        { id: orphan.subscription.id, pending: 1, adoption: { adoptable: true } }
      ]);
      expect(listed.content).toContain(own.subscription.id);
      expect(listed.content).toContain(orphan.subscription.id);
      expect(listed.content).toContain("orphan=true");
    } finally {
      await temp.cleanup();
    }
  });

  it("never lists a watch from another project", async () => {
    const temp = await tempDir();
    try {
      const h = await harness(temp.dir, PROJECT_A);
      const foreign = record({ sessionID: "ses_old", project: PROJECT_B });
      await h.store.put(foreign);

      const listed = await exec(h.tool("wake_list"), { includeOrphans: true }, "ses_new");
      expect(listed.content).not.toContain(foreign.subscription.id);
      expect(listed.metadata?.orphans).toEqual([]);
      expect(listed.content).toContain("no adoptable watches");
    } finally {
      await temp.cleanup();
    }
  });
});

describe("wake_adopt / wake_resume", () => {
  it("adopts one, then all, then resumes the rest", async () => {
    const temp = await tempDir();
    try {
      const h = await harness(temp.dir, PROJECT_A);
      const first = record({ sessionID: "ses_old", project: PROJECT_A });
      first.state.pending.push(event("101"));
      const second = record({ sessionID: "ses_old", project: PROJECT_A, number: 8 });
      second.state.pending.push(event("201"));
      const third = record({ sessionID: "ses_old", project: PROJECT_A, number: 9 });
      const fourth = record({ sessionID: "ses_old", project: PROJECT_A, number: 10 });
      for (const rec of [first, second, third, fourth]) {
        await h.store.put(rec);
      }

      const one = await exec(h.tool("wake_adopt"), { id: first.subscription.id }, "ses_new");
      expect(one.metadata?.adopted).toMatchObject([
        {
          id: first.subscription.id,
          previousSessionID: "ses_old",
          pending: 1,
          scope: "same-project",
          changed: true
        }
      ]);
      expect(h.store.get(first.subscription.id)?.subscription.sessionID).toBe("ses_new");
      expect(h.store.get(second.subscription.id)?.subscription.sessionID).toBe("ses_old");

      const all = await exec(h.tool("wake_adopt"), { all: true }, "ses_new");
      expect(all.metadata?.adopted).toHaveLength(3);
      expect(h.store.get(second.subscription.id)?.subscription.sessionID).toBe("ses_new");
      expect(h.store.get(third.subscription.id)?.subscription.sessionID).toBe("ses_new");
      expect(h.store.get(fourth.subscription.id)?.subscription.sessionID).toBe("ses_new");

      const fifth = record({ sessionID: "ses_old", project: PROJECT_A, number: 11 });
      await h.store.put(fifth);
      const resumed = await exec(h.tool("wake_resume"), {}, "ses_new");
      expect(resumed.metadata?.adopted).toMatchObject([
        { id: fifth.subscription.id, previousSessionID: "ses_old", scope: "same-project" }
      ]);
      expect(h.store.get(fifth.subscription.id)?.subscription.sessionID).toBe("ses_new");

      // A second resume is a no-op: ownership already moved.
      const again = await exec(h.tool("wake_resume"), {}, "ses_new");
      expect(again.metadata?.adopted).toEqual([]);
      expect(again.content).toContain("No orphaned watches");
    } finally {
      await temp.cleanup();
    }
  });

  it("refuses cross-project adoption and leaves the owner alone", async () => {
    const temp = await tempDir();
    try {
      const h = await harness(temp.dir, PROJECT_A);
      const foreign = record({ sessionID: "ses_old", project: PROJECT_B });
      foreign.state.pending.push(event("101"));
      await h.store.put(foreign);

      await expect(
        exec(h.tool("wake_adopt"), { id: foreign.subscription.id }, "ses_new")
      ).rejects.toThrow("not found for this session");
      expect(h.store.get(foreign.subscription.id)?.subscription.sessionID).toBe("ses_old");
      expect(h.store.get(foreign.subscription.id)?.state.pending).toHaveLength(1);

      const all = await exec(h.tool("wake_adopt"), { all: true }, "ses_new");
      expect(all.metadata?.adopted).toEqual([]);
      expect(h.store.get(foreign.subscription.id)?.subscription.sessionID).toBe("ses_old");
    } finally {
      await temp.cleanup();
    }
  });

  it("fails closed when the caller has no project identity", async () => {
    const temp = await tempDir();
    try {
      const h = await harness(temp.dir, null);
      const withProject = record({ sessionID: "ses_old", project: PROJECT_A });
      const legacy = record({ sessionID: "ses_old" });
      await h.store.put(withProject);
      await h.store.put(legacy);

      await expect(
        exec(h.tool("wake_adopt"), { id: withProject.subscription.id }, "ses_new")
      ).rejects.toThrow("not found for this session");
      await expect(
        exec(h.tool("wake_adopt"), { id: legacy.subscription.id }, "ses_new")
      ).rejects.toThrow("not found for this session");

      const all = await exec(h.tool("wake_adopt"), { all: true }, "ses_new");
      expect(all.metadata?.adopted).toEqual([]);
      const listed = await exec(h.tool("wake_list"), { includeOrphans: true }, "ses_new");
      expect(listed.metadata?.orphans).toEqual([]);
      const resumed = await exec(h.tool("wake_resume"), {}, "ses_new");
      expect(resumed.metadata?.adopted).toEqual([]);
      expect(h.store.get(withProject.subscription.id)?.subscription.sessionID).toBe("ses_old");
      expect(h.store.get(legacy.subscription.id)?.subscription.sessionID).toBe("ses_old");
    } finally {
      await temp.cleanup();
    }
  });

  it("computes skipped before moving ownership", async () => {
    const temp = await tempDir();
    try {
      const h = await harness(temp.dir, PROJECT_A);
      const first = record({ sessionID: "ses_old", project: PROJECT_A });
      const second = record({ sessionID: "ses_old", project: PROJECT_A, number: 8 });
      const foreign = record({ sessionID: "ses_old", project: PROJECT_B, number: 9 });
      for (const rec of [first, second, foreign]) {
        await h.store.put(rec);
      }

      const all = await exec(h.tool("wake_adopt"), { all: true }, "ses_new");
      expect(all.metadata?.adopted).toHaveLength(2);
      expect(all.metadata?.skipped).toBe(1);
      expect(h.store.get(first.subscription.id)?.subscription.sessionID).toBe("ses_new");
      expect(h.store.get(second.subscription.id)?.subscription.sessionID).toBe("ses_new");
      expect(h.store.get(foreign.subscription.id)?.subscription.sessionID).toBe("ses_old");
    } finally {
      await temp.cleanup();
    }
  });

  it("does not let the old session unsubscribe after adoption", async () => {
    const temp = await tempDir();
    try {
      const h = await harness(temp.dir, PROJECT_A);
      const rec = record({ sessionID: "ses_old", project: PROJECT_A });
      await h.store.put(rec);

      await exec(h.tool("wake_adopt"), { id: rec.subscription.id }, "ses_new");
      await expect(
        exec(h.tool("wake_unsubscribe"), { id: rec.subscription.id }, "ses_old")
      ).rejects.toThrow("not found for this session");
      expect(h.store.get(rec.subscription.id)?.subscription.sessionID).toBe("ses_new");
    } finally {
      await temp.cleanup();
    }
  });

  it("adopts a legacy record (no project identity) within the state root", async () => {
    const temp = await tempDir();
    try {
      const h = await harness(temp.dir, PROJECT_A);
      const legacy = record({ sessionID: "ses_old" });
      legacy.state.pending.push(event("101"));
      await h.store.put(legacy);

      const listed = await exec(h.tool("wake_list"), { includeOrphans: true }, "ses_new");
      expect(listed.metadata?.orphans).toMatchObject([
        {
          id: legacy.subscription.id,
          project: null,
          adoption: { scope: "legacy-same-state-root", adoptable: true }
        }
      ]);
      expect(listed.content).toContain("project=unknown (legacy)");

      const adopted = await exec(h.tool("wake_adopt"), { id: legacy.subscription.id }, "ses_new");
      expect(adopted.metadata?.adopted).toMatchObject([
        { scope: "legacy-same-state-root", pending: 1, changed: true }
      ]);
      expect(h.store.get(legacy.subscription.id)?.subscription.sessionID).toBe("ses_new");
      // The pre-upgrade record is legacy only until adopted; adoption stamps
      // the adopting instance's identity, so another project cannot take it.
      expect(h.store.get(legacy.subscription.id)?.subscription.project).toEqual(PROJECT_A);
      const foreignTools = createWakeToolInfos({
        store: h.store,
        poller: h.poller,
        options,
        logger: h.logger,
        project: PROJECT_B,
        now: () => NOW
      });
      const foreignAdopt = foreignTools.find((info) => info.name === "wake_adopt");
      if (!foreignAdopt) {
        throw new Error("wake_adopt was not registered");
      }
      await expect(exec(foreignAdopt, { id: legacy.subscription.id }, "ses_other")).rejects.toThrow(
        "not found for this session"
      );
      expect(h.store.get(legacy.subscription.id)?.subscription.sessionID).toBe("ses_new");

      const drained = await exec(h.tool("wake_next"), {}, "ses_new");
      expect(drained.metadata?.count).toBe(1);
    } finally {
      await temp.cleanup();
    }
  });

  it("rejects ambiguous or malformed adoption arguments", async () => {
    const temp = await tempDir();
    try {
      const h = await harness(temp.dir, PROJECT_A);
      await expect(exec(h.tool("wake_adopt"), {}, "ses_new")).rejects.toThrow(
        "pass a subscription"
      );
      await expect(
        exec(h.tool("wake_adopt"), { id: "wake_0123456789abcdef", all: true }, "ses_new")
      ).rejects.toThrow("not both");
      await expect(exec(h.tool("wake_adopt"), { id: "../../x" }, "ses_new")).rejects.toThrow(
        "not a valid subscription id"
      );
      await expect(exec(h.tool("wake_list"), { includeOrphans: "yes" }, "ses_new")).rejects.toThrow(
        "boolean"
      );
    } finally {
      await temp.cleanup();
    }
  });
});

describe("adoption preserves delivery and shared-fetcher state", () => {
  it("keeps pending, seen, loop state, cursor, ETags and the refcount", async () => {
    const temp = await tempDir();
    try {
      const h = await harness(temp.dir, PROJECT_A);
      const rec = record({ sessionID: "ses_old", project: PROJECT_A });
      rec.state.pending.push(event("101"), event("102"));
      rec.state.seen.push("101", "102");
      rec.state.lastError = "deliver: session gone";
      rec.state.loop = {
        wakes: [900],
        suppressed: 2,
        loopSuspected: true,
        cooldownUntil: 5_000
      };
      await h.store.put(rec);
      const watch = await seedWatch(h.watches, rec, {
        cursor: { lastSeenAt: "2026-01-01T00:00:00Z", lastEventID: "102" },
        etags: { "/repos/acme/widgets/issues/7/comments?page=1": 'W/"x"' },
        seen: ["101", "102"],
        consecutiveFailures: 2,
        lastError: "network: ECONNRESET",
        subscribers: [rec.subscription.id]
      });
      const key = keyOf(rec);

      const before = structuredClone({
        pending: h.store.get(rec.subscription.id)?.state.pending,
        seen: h.store.get(rec.subscription.id)?.state.seen,
        loop: h.store.get(rec.subscription.id)?.state.loop,
        lastError: h.store.get(rec.subscription.id)?.state.lastError
      });

      const adopted = await exec(h.tool("wake_adopt"), { id: rec.subscription.id }, "ses_new");
      expect(adopted.metadata?.adopted).toMatchObject([{ pending: 2 }]);

      const loaded = h.store.get(rec.subscription.id);
      expect(loaded?.subscription.sessionID).toBe("ses_new");
      expect(loaded?.subscription.id).toBe(rec.subscription.id);
      expect(loaded?.subscription.kind).toBe(rec.subscription.kind);
      expect({
        pending: loaded?.state.pending,
        seen: loaded?.state.seen,
        loop: loaded?.state.loop,
        lastError: loaded?.state.lastError
      }).toEqual(before);

      const afterWatch = h.watches.get(key);
      expect(afterWatch).toBe(watch);
      expect(afterWatch?.state.cursor).toEqual({
        lastSeenAt: "2026-01-01T00:00:00Z",
        lastEventID: "102"
      });
      expect(afterWatch?.state.etags).toEqual({
        "/repos/acme/widgets/issues/7/comments?page=1": 'W/"x"'
      });
      expect(afterWatch?.state.seen).toEqual(["101", "102"]);
      expect(afterWatch?.state.subscribers).toEqual([rec.subscription.id]);

      // The new session can read the unread events that were already pending.
      const drained = await exec(h.tool("wake_next"), {}, "ses_new");
      expect(drained.metadata?.count).toBe(2);
      const old = await exec(h.tool("wake_next"), {}, "ses_old");
      expect(old.content).toContain("No thread subscriptions for this session.");
    } finally {
      await temp.cleanup();
    }
  });

  it("does not revert an adoption that lands during an in-flight poll", async () => {
    const temp = await tempDir();
    try {
      const base = fakeTransport();
      base.setComments([page([event("101")])]);
      const gate = deferred<void>();
      const started = deferred<void>();
      const transport: GitHubTransport = {
        ...base,
        async listComments(request) {
          started.resolve(undefined);
          await gate.promise;
          return base.listComments(request);
        }
      };
      const h = await harness(temp.dir, PROJECT_A, transport);
      const rec = record({ sessionID: "ses_old", project: PROJECT_A });
      await h.store.put(rec);
      const key = keyOf(rec);
      await seedWatch(h.watches, rec, { subscribers: [rec.subscription.id] });

      // Start the poll and hold it inside the network fetch. Adoption lands
      // while the poller still holds the pre-fetch subscriber snapshot.
      const poll = h.poller.tickKey(key);
      await started.promise;
      const adopted = await exec(h.tool("wake_adopt"), { id: rec.subscription.id }, "ses_new");
      expect(adopted.metadata?.adopted).toMatchObject([
        { previousSessionID: "ses_old", changed: true }
      ]);
      gate.resolve(undefined);
      await poll;

      // The durable owner is the new session, the event is readable there, and
      // no notice went to the old session.
      expect(h.store.get(rec.subscription.id)?.subscription.sessionID).toBe("ses_new");
      expect(h.store.get(rec.subscription.id)?.state.pending).toHaveLength(1);
      expect(h.delivered).toHaveLength(1);
      expect(h.delivered[0]?.sessionID).toBe("ses_new");
      expect(h.delivered.some((notice) => notice.sessionID === "ses_old")).toBe(false);
      const drained = await exec(h.tool("wake_next"), {}, "ses_new");
      expect(drained.metadata?.count).toBe(1);
      expect(drained.content).toContain("id: 101");
    } finally {
      await temp.cleanup();
    }
  });

  it("keeps a shared fetcher intact for the other subscriber", async () => {
    const temp = await tempDir();
    try {
      const h = await harness(temp.dir, PROJECT_A);
      const mine = record({ sessionID: "ses_old_a", project: PROJECT_A });
      const other = record({ sessionID: "ses_old_b", project: PROJECT_A });
      await h.store.put(mine);
      await h.store.put(other);
      const watch = await seedWatch(h.watches, mine, {
        cursor: { lastSeenAt: "2026-01-01T00:00:00Z" },
        etags: { "/repos/acme/widgets/issues/7/comments?page=1": 'W/"x"' },
        subscribers: [mine.subscription.id, other.subscription.id]
      });
      const key = keyOf(mine);

      await exec(h.tool("wake_adopt"), { id: mine.subscription.id }, "ses_new");
      expect(h.watches.get(key)?.state.subscribers).toEqual([
        mine.subscription.id,
        other.subscription.id
      ]);
      expect(h.watches.get(key)?.state.cursor).toEqual(watch.state.cursor);
      expect(h.watches.get(key)?.state.etags).toEqual(watch.state.etags);

      h.transport.setComments([page([event("201")])]);
      const outcome = await h.poller.tickKey(key);
      expect(outcome).toMatchObject({ status: "delivered", newEvents: 1, delivered: 2 });
      expect(h.delivered.map((notice) => notice.sessionID).sort()).toEqual([
        "ses_new",
        "ses_old_b"
      ]);
      expect(h.store.get(mine.subscription.id)?.state.pending).toHaveLength(1);
      expect(h.store.get(other.subscription.id)?.state.pending).toHaveLength(1);

      // Re-reading the same page is deduped by the shared seen ring: no second
      // wake, no second pending copy.
      const again = await h.poller.tickKey(key);
      expect(again).toMatchObject({ status: "no-change", newEvents: 0, delivered: 0 });
      expect(h.delivered).toHaveLength(2);
      expect(h.store.get(mine.subscription.id)?.state.pending).toHaveLength(1);
    } finally {
      await temp.cleanup();
    }
  });
});

describe("restart simulation", () => {
  it("lets a new session list, adopt and drain the old session's watch", async () => {
    const temp = await tempDir();
    try {
      // Before the restart: session `ses_old` owns a watch and has one unread
      // event, delivered but never read.
      const first = await harness(temp.dir, PROJECT_A);
      const rec = record({ sessionID: "ses_old", project: PROJECT_A });
      await first.store.put(rec);
      const key = keyOf(rec);
      await seedWatch(first.watches, rec, {
        cursor: { lastSeenAt: "2026-01-01T00:00:00Z" },
        subscribers: [rec.subscription.id]
      });
      first.transport.setComments([page([event("101")], { etag: 'W/"thread-1"' })]);
      const firstPoll = await first.poller.tickKey(key);
      expect(firstPoll).toMatchObject({ status: "delivered", newEvents: 1, delivered: 1 });
      expect(first.delivered[0]?.sessionID).toBe("ses_old");
      expect(first.store.get(rec.subscription.id)?.state.pending).toHaveLength(1);
      const cursorBefore = first.watches.get(key)?.state.cursor;
      const etagsBefore = first.watches.get(key)?.state.etags;

      // Restart: the old poller is gone, so it releases its watch lease. (A
      // crash cannot release; that case waits for lease expiry.)
      await first.poller.stop();

      // New stores/poller over the same state directory, new session.
      const second = await harness(temp.dir, PROJECT_A);
      await second.poller.start();
      await second.poller.stop();

      const own = await exec(second.tool("wake_list"), {}, "ses_new");
      expect(own.content).toContain("No thread subscriptions for this session.");
      const listed = await exec(second.tool("wake_list"), { includeOrphans: true }, "ses_new");
      expect(listed.content).toContain(`owner=ses_old orphan=true`);
      expect(listed.content).toContain("pending=1");
      expect(listed.metadata?.orphans).toMatchObject([
        { id: rec.subscription.id, sessionID: "ses_old", pending: 1, adoption: { adoptable: true } }
      ]);

      const adopted = await exec(second.tool("wake_resume"), {}, "ses_new");
      expect(adopted.metadata?.adopted).toMatchObject([
        { id: rec.subscription.id, previousSessionID: "ses_old", pending: 1, changed: true }
      ]);
      expect(second.store.get(rec.subscription.id)?.subscription.sessionID).toBe("ses_new");
      expect(second.store.get(rec.subscription.id)?.state.pending).toHaveLength(1);

      // The shared fetcher state survived the restart and the adoption.
      expect(second.watches.get(key)?.state.cursor).toEqual(cursorBefore);
      expect(second.watches.get(key)?.state.etags).toEqual(etagsBefore);
      expect(second.watches.get(key)?.state.subscribers).toEqual([rec.subscription.id]);

      // The old owner cannot read the pending event; the new owner can.
      const oldRead = await exec(second.tool("wake_next"), {}, "ses_old");
      expect(oldRead.content).toContain("No thread subscriptions for this session.");
      const newRead = await exec(second.tool("wake_next"), {}, "ses_new");
      expect(newRead.metadata?.count).toBe(1);
      expect(newRead.content).toContain("id: 101");

      // A future poll delivers only the genuinely new event, to the new owner,
      // and the already-read event is not delivered again.
      const deliveredBefore = second.delivered.length;
      second.transport.setComments([page([event("101"), event("102")])]);
      const future = await second.poller.tickKey(key);
      expect(future).toMatchObject({ status: "delivered", newEvents: 1, delivered: 1 });
      const futureNotices = second.delivered.slice(deliveredBefore);
      expect(futureNotices).toHaveLength(1);
      expect(futureNotices[0]?.sessionID).toBe("ses_new");
      expect(futureNotices[0]?.count).toBe(1);

      const drained = await exec(second.tool("wake_next"), {}, "ses_new");
      expect(drained.metadata?.count).toBe(1);
      expect(drained.content).toContain("id: 102");
      expect(drained.content).not.toContain("id: 101");
    } finally {
      await temp.cleanup();
    }
  });
});
