import { describe, expect, it } from "vitest";

import { parseWakeOptions } from "../src/config.js";
import { TransportFailure } from "../src/github.js";
import { pollSource } from "../src/sources.js";
import type { SourceState } from "../src/types.js";
import type { WakeEvent, WakeSourceKind } from "../src/types.js";
import { checksPage, fakeLogger, fakeTransport, timelinePage } from "./helpers.js";

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
