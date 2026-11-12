import { describe, expect, it } from "vitest";

import { parseWakeOptions } from "../src/config.js";
import { TransportFailure } from "../src/github.js";
import { pollSource } from "../src/sources.js";
import type { SourceState } from "../src/types.js";
import type { WakeEvent, WakeSourceKind } from "../src/types.js";
import { checksPage, fakeLogger, fakeTransport, runsPage, timelinePage } from "./helpers.js";

const SINCE = "2026-01-01T00:00:00Z";

function context(kind: WakeSourceKind, state: SourceState) {
  const transport = fakeTransport();
  return {
    transport,
    context: {
      target: {
        apiBase: "https://api.github.com",
        kind,
        owner: "acme",
        repo: "widgets",
        number: 7
      },
      state,
      transport,
      options: parseWakeOptions({ maxPages: 3 }),
      logger: fakeLogger(),
      now: () => 5_000
    }
  };
}

function state(over: Partial<SourceState> = {}): SourceState {
  return { cursor: { lastSeenAt: SINCE }, ...over };
}

function reviewEvent(id: string, at = "2026-01-01T00:10:00Z"): WakeEvent {
  return {
    id: `reviewed:${id}`,
    kind: "review",
    author: "bob",
    createdAt: at,
    updatedAt: at,
    url: `https://github.com/acme/widgets/pull/7#pullrequestreview-${id}`,
    body: "LGTM",
    title: "review approved"
  };
}

function checkEvent(id: string, at = "2026-01-01T00:20:00Z"): WakeEvent {
  return {
    id,
    kind: "check",
    author: "GitHub Actions",
    createdAt: at,
    updatedAt: at,
    url: "https://github.com/acme/widgets/runs/1",
    body: "",
    title: "build: completed / failure"
  };
}

describe("pollSource — github.timeline", () => {
  it("reads a single-page timeline and advances the cursor", async () => {
    const { transport, context: ctx } = context("github.timeline", state());
    transport.setTimeline([timelinePage([reviewEvent("1")], { etag: 'W/"t"' })]);

    const result = await pollSource(ctx);

    expect(transport.requests.timeline.map((r) => r.page)).toEqual([1]);
    expect(result.events.map((e) => e.kind)).toEqual(["review"]);
    expect(result.cursor.lastSeenAt).toBe("2026-01-01T00:10:00Z");
    expect(result.cursor.lastEventID).toBe("reviewed:1");
    expect(result.etags).toEqual({
      "/repos/acme/widgets/issues/7/timeline?per_page=100&page=1": 'W/"t"'
    });
  });

  it("walks back from the last page until it reaches the cursor", async () => {
    const { transport, context: ctx } = context(
      "github.timeline",
      state({ cursor: { lastSeenAt: SINCE, lastEventID: "reviewed:1" } })
    );
    transport.setTimeline([
      timelinePage([reviewEvent("old", "2025-12-31T00:00:00Z")], { lastPage: 3 }),
      timelinePage([reviewEvent("2", "2026-01-01T00:20:00Z")]),
      timelinePage([reviewEvent("1", "2026-01-01T00:10:00Z")], { lastPage: 3 })
    ]);

    const result = await pollSource(ctx);

    // page 1 (discovery) then the tail, newest first.
    expect(transport.requests.timeline.map((r) => r.page)).toEqual([1, 3, 2]);
    expect(result.events.map((e) => e.id)).toEqual(["reviewed:1", "reviewed:2"]);
    expect(result.etags).toEqual({});
  });

  it("drops tail events that predate the cursor", async () => {
    const { transport, context: ctx } = context(
      "github.timeline",
      state({ cursor: { lastSeenAt: "2026-01-01T00:15:00Z" } })
    );
    transport.setTimeline([
      timelinePage([
        reviewEvent("1", "2026-01-01T00:10:00Z"),
        reviewEvent("2", "2026-01-01T00:20:00Z")
      ])
    ]);

    const result = await pollSource(ctx);

    expect(result.events.map((e) => e.id)).toEqual(["reviewed:2"]);
    expect(result.cursor.lastSeenAt).toBe("2026-01-01T00:20:00Z");
  });

  it("stops as soon as the tail page contains the cursor event", async () => {
    const { transport, context: ctx } = context(
      "github.timeline",
      state({ cursor: { lastSeenAt: SINCE, lastEventID: "reviewed:1" } })
    );
    transport.setTimeline([
      timelinePage([reviewEvent("old", "2025-12-31T00:00:00Z")], { lastPage: 4 }),
      timelinePage(
        [reviewEvent("1", "2026-01-01T00:10:00Z"), reviewEvent("2", "2026-01-01T00:20:00Z")],
        { lastPage: 4 }
      )
    ]);

    const result = await pollSource(ctx);

    expect(transport.requests.timeline.map((r) => r.page)).toEqual([1, 4]);
    expect(result.events.map((e) => e.id)).toEqual(["reviewed:1", "reviewed:2"]);
  });

  it("fails closed when the tail is deeper than maxPages", async () => {
    const { transport, context: ctx } = context("github.timeline", state());
    // maxPages = 3: page 1 + two tail pages, still not at the cursor.
    transport.setTimeline([
      timelinePage([reviewEvent("old", "2025-12-31T00:00:00Z")], { lastPage: 9 }),
      timelinePage([reviewEvent("9", "2026-01-01T00:50:00Z")]),
      timelinePage([reviewEvent("8", "2026-01-01T00:40:00Z")])
    ]);

    await expect(pollSource(ctx)).rejects.toMatchObject({ kind: "backlog" });
    // Nothing was advanced: the caller keeps the cursor and backs off.
    expect(ctx.state.cursor.lastSeenAt).toBe(SINCE);
  });

  it("treats a 304 as 'nothing changed' and keeps the validators", async () => {
    const existing = {
      "/repos/acme/widgets/issues/7/timeline?per_page=100&page=1": 'W/"t"'
    };
    const { transport, context: ctx } = context("github.timeline", state({ etags: existing }));
    transport.setTimeline([timelinePage([], { notModified: true })]);

    const result = await pollSource(ctx);

    expect(result.notModified).toBe(true);
    expect(result.cursor.lastSeenAt).toBe(SINCE);
    expect(result.etags).toEqual(existing);
  });

  it("does not store a page-1 ETag for a full single page", async () => {
    const { transport, context: ctx } = context("github.timeline", state());
    const full = Array.from({ length: 100 }, (_, index) =>
      reviewEvent(String(index), `2026-01-01T00:${String(index % 60).padStart(2, "0")}:00Z`)
    );
    transport.setTimeline([timelinePage(full, { etag: 'W/"full"' })]);

    const result = await pollSource(ctx);

    expect(result.etags).toEqual({});
  });
});

describe("pollSource — github.checks", () => {
  it("records the baseline on the first poll without reporting a change", async () => {
    const { transport, context: ctx } = context("github.checks", state());
    transport.setPull({
      notModified: false,
      headSHA: "aaa",
      htmlURL: "https://github.com/acme/widgets/pull/7"
    });
    transport.setChecks([checksPage([checkEvent("check:1:completed:success")], { etag: 'W/"c"' })]);

    const result = await pollSource(ctx);

    expect(result.baseline).toBe(true);
    expect(result.events.map((e) => e.id)).toEqual(["check:1:completed:success"]);
    expect(result.cursor.headSHA).toBe("aaa");
  });

  it("reports a new head commit plus the new head's check runs", async () => {
    const { transport, context: ctx } = context(
      "github.checks",
      state({ cursor: { lastSeenAt: SINCE, headSHA: "aaa" } })
    );
    transport.setPull({
      notModified: false,
      headSHA: "bbb",
      htmlURL: "https://github.com/acme/widgets/pull/7"
    });
    transport.setChecks([checksPage([checkEvent("check:2:completed:failure")])]);

    const result = await pollSource(ctx);

    expect(result.baseline).toBeFalsy();
    expect(result.events.map((e) => e.kind)).toEqual(["commit", "check"]);
    expect(result.events[0]?.id).toBe("commit:bbb");
    expect(result.events[0]?.title).toBe("new head commit bbb");
    expect(result.events[0]?.url).toBe("https://github.com/acme/widgets/pull/7");
    expect(result.events[1]?.title).toContain("failure");
    expect(result.cursor.headSHA).toBe("bbb");
  });

  it("keeps the head sha when the pull request object is unchanged", async () => {
    const { transport, context: ctx } = context(
      "github.checks",
      state({ cursor: { lastSeenAt: SINCE, headSHA: "aaa" } })
    );
    transport.setPull({ notModified: true, headSHA: "" });
    transport.setChecks([checksPage([checkEvent("check:1:completed:failure")])]);

    const result = await pollSource(ctx);

    expect(transport.requests.checks[0]?.ref).toBe("aaa");
    expect(result.notModified).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.cursor.headSHA).toBe("aaa");
  });

  it("is 'not modified' only when both the PR and its checks are unchanged", async () => {
    const existing = {
      "/repos/acme/widgets/pulls/7": 'W/"p"',
      "/repos/acme/widgets/commits/aaa/check-runs?per_page=100&page=1": 'W/"c"'
    };
    const { transport, context: ctx } = context(
      "github.checks",
      state({ cursor: { lastSeenAt: SINCE, headSHA: "aaa" }, etags: existing })
    );
    transport.setPull({ notModified: true, headSHA: "" });
    transport.setChecks([checksPage([], { notModified: true })]);

    const result = await pollSource(ctx);

    expect(result.notModified).toBe(true);
    expect(result.etags).toEqual(existing);
    expect(transport.requests.pull[0]?.etag).toBe('W/"p"');
    expect(transport.requests.checks[0]?.etag).toBe('W/"c"');
  });

  it("stores the pull validator and a single-page checks validator", async () => {
    const { transport, context: ctx } = context("github.checks", state());
    transport.setPull({
      notModified: false,
      headSHA: "aaa",
      etag: 'W/"p"',
      htmlURL: "https://github.com/acme/widgets/pull/7"
    });
    transport.setChecks([checksPage([checkEvent("check:1:completed:success")], { etag: 'W/"c"' })]);

    const result = await pollSource(ctx);

    expect(result.etags).toEqual({
      "/repos/acme/widgets/pulls/7": 'W/"p"',
      "/repos/acme/widgets/commits/aaa/check-runs?per_page=100&page=1": 'W/"c"'
    });
  });

  it("does not store a checks ETag when the runs span pages", async () => {
    const { transport, context: ctx } = context("github.checks", state());
    transport.setPull({ notModified: false, headSHA: "aaa", etag: 'W/"p"' });
    transport.setChecks([
      checksPage([checkEvent("check:1:completed:success")], { hasNextPage: true, etag: 'W/"c"' }),
      checksPage([checkEvent("check:2:completed:success")])
    ]);

    const result = await pollSource(ctx);

    expect(transport.requests.checks.map((r) => r.page)).toEqual([1, 2]);
    expect(result.etags).toEqual({ "/repos/acme/widgets/pulls/7": 'W/"p"' });
  });

  it("fails closed when the number is not a pull request", async () => {
    const { transport, context: ctx } = context("github.checks", state());
    transport.fail(
      new TransportFailure("not-found", "GitHub returned 404 (not found or no access)", {
        status: 404
      })
    );

    await expect(pollSource(ctx)).rejects.toMatchObject({ kind: "not-found" });
    expect(ctx.state.cursor.lastSeenAt).toBe(SINCE);
  });

  it("fails closed when the token cannot read checks", async () => {
    const { transport, context: ctx } = context("github.checks", state());
    transport.fail(
      new TransportFailure("forbidden", "GitHub refused the request (403)", { status: 403 })
    );

    await expect(pollSource(ctx)).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("fails closed when the pull request has no head sha", async () => {
    const { transport, context: ctx } = context("github.checks", state());
    transport.setPull({ notModified: false, headSHA: "" });

    await expect(pollSource(ctx)).rejects.toMatchObject({ kind: "malformed" });
  });
});

function runEvent(
  runID: string,
  status: string,
  conclusion: string | null,
  createdAt: string,
  updatedAt: string
): WakeEvent {
  return {
    id: `run:${runID}:${status}:${conclusion ?? ""}:${updatedAt}`,
    kind: "run",
    author: "alice",
    createdAt,
    updatedAt,
    url: `https://github.com/acme/widgets/actions/runs/${runID}`,
    body: "",
    title: `CI: ${status}${conclusion ? ` / ${conclusion}` : ""}`
  };
}

const ACTIONS_NOW = "2026-01-01T01:00:00.000Z";

function actionsContext(
  state: SourceState,
  over: { workflow?: string; branch?: string; maxPages?: number } = {}
) {
  const transport = fakeTransport();
  return {
    transport,
    context: {
      target: {
        apiBase: "https://api.github.com",
        kind: "github.actions" as const,
        owner: "acme",
        repo: "widgets",
        ...(over.workflow !== undefined ? { workflow: over.workflow } : {}),
        ...(over.branch !== undefined ? { branch: over.branch } : {})
      },
      state,
      transport,
      options: parseWakeOptions({ maxPages: over.maxPages ?? 3 }),
      logger: fakeLogger(),
      now: () => Date.parse(ACTIONS_NOW)
    }
  };
}

function actionsState(over: Partial<SourceState["cursor"]> = {}, etags?: Record<string, string>) {
  return {
    cursor: { lastSeenAt: SINCE, ...over },
    ...(etags !== undefined ? { etags } : {})
  } satisfies SourceState;
}

describe("pollSource — github.actions", () => {
  it("records the first poll as a baseline and anchors the window floor", async () => {
    const { transport, context: ctx } = actionsContext(actionsState());
    transport.setRuns([
      runsPage(
        [
          runEvent("2", "in_progress", null, "2026-01-01T00:20:00Z", "2026-01-01T00:20:10Z"),
          runEvent("1", "completed", "success", "2026-01-01T00:10:00Z", "2026-01-01T00:15:00Z")
        ],
        { etag: 'W/"r"' }
      )
    ]);

    const result = await pollSource(ctx);

    expect(result.baseline).toBe(true);
    expect(result.events).toHaveLength(2);
    expect(result.cursor.runFloor).toBe("2026-01-01T00:10:00Z");
    expect(result.cursor.lastSeenAt).toBe("2026-01-01T00:20:10Z");
    expect(result.etags).toEqual({
      "/repos/acme/widgets/actions/runs?per_page=100&page=1": 'W/"r"'
    });
  });

  it("still anchors a floor when the repository has no runs yet", async () => {
    const { transport, context: ctx } = actionsContext(actionsState());
    transport.setRuns([runsPage([])]);

    const result = await pollSource(ctx);

    expect(result.baseline).toBe(true);
    expect(result.events).toHaveLength(0);
    expect(result.cursor.runFloor).toBe(ACTIONS_NOW);
  });

  it("reports a new run after the baseline and drops events older than the cursor", async () => {
    const { transport, context: ctx } = actionsContext(
      actionsState({ lastSeenAt: "2026-01-01T00:20:10Z", runFloor: "2026-01-01T00:10:00Z" })
    );
    transport.setRuns([
      runsPage([
        runEvent("3", "queued", null, "2026-01-01T00:25:00Z", "2026-01-01T00:25:00Z"),
        runEvent("2", "in_progress", null, "2026-01-01T00:20:00Z", "2026-01-01T00:20:10Z"),
        runEvent("1", "completed", "success", "2026-01-01T00:10:00Z", "2026-01-01T00:15:00Z")
      ])
    ]);

    const result = await pollSource(ctx);

    expect(result.baseline).toBeFalsy();
    // The unchanged boundary run may be re-observed (same timestamp); the shared
    // `seen` ring dedupes it. Anything strictly older is never returned.
    expect(result.events.map((event) => event.id)).toEqual([
      "run:3:queued::2026-01-01T00:25:00Z",
      "run:2:in_progress::2026-01-01T00:20:10Z"
    ]);
    expect(result.cursor.lastSeenAt).toBe("2026-01-01T00:25:00Z");
    expect(result.cursor.runFloor).toBe("2026-01-01T00:10:00Z");
  });

  it("turns queued → in_progress → success into three distinct events", async () => {
    const baselineState = actionsState();
    const first = actionsContext(baselineState);
    first.transport.setRuns([
      runsPage([runEvent("9", "queued", null, "2026-01-01T00:20:00Z", "2026-01-01T00:20:00Z")])
    ]);
    const baseline = await pollSource(first.context);
    expect(baseline.baseline).toBe(true);

    const second = actionsContext({
      cursor: baseline.cursor,
      etags: baseline.etags
    });
    second.transport.setRuns([
      runsPage([runEvent("9", "in_progress", null, "2026-01-01T00:20:00Z", "2026-01-01T00:21:00Z")])
    ]);
    const running = await pollSource(second.context);

    const third = actionsContext({ cursor: running.cursor, etags: running.etags });
    third.transport.setRuns([
      runsPage([
        runEvent("9", "completed", "success", "2026-01-01T00:20:00Z", "2026-01-01T00:22:00Z")
      ])
    ]);
    const done = await pollSource(third.context);

    const ids = [...running.events, ...done.events].map((event) => event.id);
    expect(ids).toEqual([
      "run:9:in_progress::2026-01-01T00:21:00Z",
      "run:9:completed:success:2026-01-01T00:22:00Z"
    ]);
    expect(new Set(ids).size).toBe(2);
  });

  it("reports failure and cancelled conclusions", async () => {
    for (const conclusion of ["failure", "cancelled", "skipped"]) {
      const { transport, context: ctx } = actionsContext(
        actionsState({ lastSeenAt: "2026-01-01T00:20:00Z", runFloor: "2026-01-01T00:20:00Z" })
      );
      transport.setRuns([
        runsPage([
          runEvent("5", "completed", conclusion, "2026-01-01T00:20:00Z", "2026-01-01T00:30:00Z")
        ])
      ]);

      const result = await pollSource(ctx);

      expect(result.events).toHaveLength(1);
      expect(result.events[0]?.title).toContain(conclusion);
      expect(result.events[0]?.id).toContain(`completed:${conclusion}:`);
    }
  });

  it("reports a rerun of the same run id as a new fingerprint", async () => {
    const { transport, context: ctx } = actionsContext(
      actionsState({
        lastSeenAt: "2026-01-01T00:30:00Z",
        lastEventID: "run:7:completed:failure:2026-01-01T00:30:00Z",
        runFloor: "2026-01-01T00:10:00Z"
      })
    );
    transport.setRuns([
      runsPage([runEvent("7", "in_progress", null, "2026-01-01T00:10:00Z", "2026-01-01T00:40:00Z")])
    ]);

    const result = await pollSource(ctx);

    expect(result.events.map((event) => event.id)).toEqual([
      "run:7:in_progress::2026-01-01T00:40:00Z"
    ]);
  });

  it("pages until the page's oldest run reaches the window floor", async () => {
    const { transport, context: ctx } = actionsContext(
      actionsState({ lastSeenAt: "2026-01-01T00:05:00Z", runFloor: "2026-01-01T00:00:00Z" })
    );
    transport.setRuns([
      runsPage(
        [runEvent("3", "completed", "success", "2026-01-01T00:30:00Z", "2026-01-01T00:30:00Z")],
        { hasNextPage: true, etag: 'W/"p1"' }
      ),
      runsPage([
        runEvent("2", "completed", "success", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z")
      ])
    ]);

    const result = await pollSource(ctx);

    expect(transport.requests.runs.map((request) => request.page)).toEqual([1, 2]);
    expect(result.events.map((event) => event.id)).toEqual([
      "run:3:completed:success:2026-01-01T00:30:00Z",
      "run:2:completed:success:2026-01-01T00:05:00Z"
    ]);
    // Two pages: no page-1 validator is reusable for the next poll.
    expect(result.etags).toEqual({});
  });

  it("fails closed as backlog when new runs push the floor past maxPages", async () => {
    const { transport, context: ctx } = actionsContext(
      actionsState({ runFloor: "2026-01-01T00:00:00Z" }),
      { maxPages: 2 }
    );
    transport.setRuns([
      runsPage([runEvent("4", "queued", null, "2026-01-01T00:40:00Z", "2026-01-01T00:40:00Z")], {
        hasNextPage: true
      }),
      runsPage([runEvent("3", "queued", null, "2026-01-01T00:30:00Z", "2026-01-01T00:30:00Z")], {
        hasNextPage: true
      })
    ]);

    await expect(pollSource(ctx)).rejects.toMatchObject({ kind: "backlog" });
    expect(ctx.state.cursor.lastSeenAt).toBe(SINCE);
    expect(ctx.state.cursor.runFloor).toBe("2026-01-01T00:00:00Z");
  });

  it("does not fail closed on a baseline deeper than maxPages", async () => {
    const { transport, context: ctx } = actionsContext(actionsState(), { maxPages: 2 });
    transport.setRuns([
      runsPage([runEvent("4", "queued", null, "2026-01-01T00:40:00Z", "2026-01-01T00:40:00Z")], {
        hasNextPage: true
      }),
      runsPage([runEvent("3", "queued", null, "2026-01-01T00:30:00Z", "2026-01-01T00:30:00Z")], {
        hasNextPage: true
      })
    ]);

    const result = await pollSource(ctx);

    expect(result.baseline).toBe(true);
    expect(result.cursor.runFloor).toBe("2026-01-01T00:30:00Z");
  });

  it("treats a 304 as 'nothing changed' and keeps the validators", async () => {
    const etags = { "/repos/acme/widgets/actions/runs?per_page=100&page=1": 'W/"r"' };
    const { transport, context: ctx } = actionsContext(
      actionsState({ lastSeenAt: "2026-01-01T00:20:00Z", runFloor: "2026-01-01T00:00:00Z" }, etags)
    );
    transport.setRuns([runsPage([], { notModified: true })]);

    const result = await pollSource(ctx);

    expect(result.notModified).toBe(true);
    expect(result.cursor.lastSeenAt).toBe("2026-01-01T00:20:00Z");
    expect(result.etags).toEqual(etags);
    expect(transport.requests.runs[0]?.etag).toBe('W/"r"');
  });

  it("passes the workflow and branch filters and keys the ETag by them", async () => {
    const { transport, context: ctx } = actionsContext(actionsState(), {
      workflow: "ci.yml",
      branch: "main"
    });
    transport.setRuns([runsPage([], { etag: 'W/"f"' })]);

    const result = await pollSource(ctx);

    expect(transport.requests.runs[0]).toMatchObject({
      workflow: "ci.yml",
      branch: "main",
      page: 1
    });
    expect(result.etags).toEqual({
      "/repos/acme/widgets/actions/workflows/ci.yml/runs?per_page=100&page=1&branch=main": 'W/"f"'
    });
  });

  it("fails closed when the token cannot read actions", async () => {
    const { transport, context: ctx } = actionsContext(actionsState());
    transport.fail(
      new TransportFailure("forbidden", "GitHub refused the request (403)", { status: 403 })
    );

    await expect(pollSource(ctx)).rejects.toMatchObject({ kind: "forbidden" });
    expect(ctx.state.cursor.runFloor).toBeUndefined();
  });

  it("fails closed on a malformed run payload", async () => {
    const { transport, context: ctx } = actionsContext(actionsState());
    transport.fail(new TransportFailure("malformed", "workflow run without a usable id"));

    await expect(pollSource(ctx)).rejects.toMatchObject({ kind: "malformed" });
  });
});
