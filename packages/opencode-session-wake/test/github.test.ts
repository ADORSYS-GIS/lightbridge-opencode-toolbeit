import { describe, expect, it, vi } from "vitest";

import { createTokenSource, TokenError } from "../src/auth.js";
import { createGitHubTransport, TransportFailure } from "../src/github.js";

const token = createTokenSource({ command: ["fake"], run: async () => "secret-token" });

function transportWith(
  response: () => Response | Promise<Response>,
  extra: { now?: () => number } = {}
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init !== undefined ? { init } : {}) });
    return response();
  });
  const transport = createGitHubTransport({
    token,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: extra.now ?? (() => 1_000)
  });
  return { transport, calls };
}

const request = { owner: "acme", repo: "widgets", number: 7, page: 1 };

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init
  });
}

function comment(id: number, body = "hi") {
  return {
    id,
    body,
    user: { login: "alice" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.com/acme/widgets/issues/7#issuecomment-${id}`
  };
}

describe("createGitHubTransport", () => {
  it("issues only conditional GETs — there is no write path", async () => {
    const { transport, calls } = transportWith(() => json([comment(1)]));

    await transport.listComments({ ...request, since: "2026-01-01T00:00:00Z", etag: 'W/"x"' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe("GET");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["if-none-match"]).toBe('W/"x"');
    expect(headers.authorization).toBe("Bearer secret-token");
    // The token never rides in the URL.
    expect(calls[0]?.url).not.toContain("secret-token");
    expect(calls[0]?.url).toContain("/repos/acme/widgets/issues/7/comments");
    expect(calls[0]?.url).toContain("since=2026-01-01T00");
  });

  it("maps a comment onto an event and reads the ETag and Link header", async () => {
    const { transport } = transportWith(() =>
      json([comment(11)], {
        headers: {
          etag: 'W/"abc"',
          link: '<https://api.github.com/x?page=2>; rel="next"'
        }
      })
    );

    const result = await transport.listComments(request);

    expect(result.notModified).toBe(false);
    expect(result.etag).toBe('W/"abc"');
    expect(result.hasNextPage).toBe(true);
    expect(result.events[0]).toEqual({
      id: "11",
      kind: "comment",
      author: "alice",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      url: "https://github.com/acme/widgets/issues/7#issuecomment-11",
      body: "hi"
    });
  });

  it("treats 304 as 'nothing changed'", async () => {
    const { transport } = transportWith(() => new Response(null, { status: 304 }));
    const result = await transport.listComments(request);
    expect(result.notModified).toBe(true);
    expect(result.events).toHaveLength(0);
  });

  it("reports 401 as an auth failure", async () => {
    const { transport } = transportWith(() => new Response("{}", { status: 401 }));
    await expect(transport.listComments(request)).rejects.toMatchObject({
      name: "TransportFailure",
      kind: "auth",
      status: 401
    });
  });

  it("separates a plain 403 from an exhausted quota", async () => {
    const forbidden = transportWith(() => new Response("{}", { status: 403 }));
    await expect(forbidden.transport.listComments(request)).rejects.toMatchObject({
      kind: "forbidden"
    });

    const exhausted = transportWith(
      () =>
        new Response("{}", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "160" }
        })
    );
    await expect(exhausted.transport.listComments(request)).rejects.toMatchObject({
      kind: "rate-limit",
      retryAfterMs: 159_000
    });
  });

  it("reports 429 with the server's retry-after hint", async () => {
    const { transport } = transportWith(
      () => new Response("{}", { status: 429, headers: { "retry-after": "30" } })
    );
    await expect(transport.listComments(request)).rejects.toMatchObject({
      kind: "rate-limit",
      retryAfterMs: 30_000
    });
  });

  it("reports a 5xx as a retryable http failure", async () => {
    const { transport } = transportWith(() => new Response("oops", { status: 502 }));
    await expect(transport.listComments(request)).rejects.toMatchObject({
      kind: "http",
      status: 502
    });
  });

  it("reports a network error", async () => {
    const { transport } = transportWith(() => {
      throw new Error("ECONNRESET");
    });
    await expect(transport.listComments(request)).rejects.toMatchObject({
      kind: "network",
      message: "ECONNRESET"
    });
  });

  it("rejects a malformed payload instead of treating it as empty", async () => {
    const cases: Array<() => Response> = [
      () => new Response("<html>", { status: 200 }),
      () => json({ message: "not an array" }),
      () => json([{ body: "no id" }]),
      () => json([{ id: 1 }])
    ];
    for (const make of cases) {
      const { transport } = transportWith(make);
      await expect(transport.listComments(request)).rejects.toMatchObject({ kind: "malformed" });
    }
  });

  it("fails closed when no token can be produced", async () => {
    const failing = createTokenSource({
      command: ["gh"],
      run: async () => {
        throw new TokenError("token command failed (gh)");
      }
    });
    const transport = createGitHubTransport({
      token: failing,
      fetchImpl: vi.fn() as unknown as typeof fetch
    });
    await expect(transport.listComments(request)).rejects.toMatchObject({
      kind: "auth",
      message: "token command failed (gh)"
    });
  });

  it("never leaks the token into a failure message", async () => {
    const { transport } = transportWith(() => new Response("{}", { status: 401 }));
    try {
      await transport.listComments(request);
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TransportFailure);
      expect((error as Error).message).not.toContain("secret-token");
    }
  });
});

describe("createGitHubTransport — timeline", () => {
  const timelineRequest = { owner: "acme", repo: "widgets", number: 7, page: 1 };

  function timeline(payload: unknown[], init: ResponseInit = {}) {
    return transportWith(() => json(payload, init));
  }

  it("maps a comment, a review, a review comment, a label and a state change", async () => {
    const { transport } = timeline([
      {
        event: "commented",
        id: 9000,
        body: "hello",
        user: { login: "alice" },
        created_at: "2026-01-01T00:00:00Z",
        html_url: "https://github.com/acme/widgets/issues/7#issuecomment-9000"
      },
      {
        event: "reviewed",
        id: 9001,
        state: "approved",
        body: "LGTM",
        user: { login: "bob" },
        submitted_at: "2026-01-01T00:01:00Z",
        html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-9001"
      },
      {
        event: "line-commented",
        id: 9002,
        body: "nit: rename this",
        user: { login: "bob" },
        created_at: "2026-01-01T00:02:00Z"
      },
      {
        event: "labeled",
        id: 9003,
        label: { name: "bug" },
        actor: { login: "carol" },
        created_at: "2026-01-01T00:03:00Z"
      },
      { event: "merged", id: 9004, actor: { login: "dave" }, created_at: "2026-01-01T00:04:00Z" },
      { event: "closed", id: 9005, actor: { login: "dave" }, created_at: "2026-01-01T00:05:00Z" }
    ]);

    const result = await transport.listTimeline(timelineRequest);

    expect(result.events.map((e) => e.kind)).toEqual([
      "comment",
      "review",
      "review_comment",
      "label",
      "state",
      "state"
    ]);
    expect(result.events.map((e) => e.id)).toEqual([
      "commented:9000",
      "reviewed:9001",
      "line-commented:9002",
      "labeled:9003",
      "merged:9004",
      "closed:9005"
    ]);
    expect(result.events[1]).toMatchObject({
      author: "bob",
      body: "LGTM",
      title: "review approved",
      createdAt: "2026-01-01T00:01:00Z"
    });
    expect(result.events[3]?.title).toBe("label added: bug");
    expect(result.events[4]?.title).toBe("merged");
    expect(result.events[0]?.body).toBe("hello");
  });

  it("maps a commit event that carries no id and no created_at", async () => {
    const { transport } = timeline([
      {
        event: "committed",
        sha: "abcdef1234567890",
        author: { name: "Alice", email: "a@example.com", date: "2026-01-01T00:06:00Z" },
        committer: { name: "Alice", email: "a@example.com", date: "2026-01-01T00:06:00Z" },
        message: "fix"
      }
    ]);

    const result = await transport.listTimeline(timelineRequest);

    expect(result.events[0]).toMatchObject({
      id: "committed:sha:abcdef1234567890",
      kind: "commit",
      author: "Alice",
      createdAt: "2026-01-01T00:06:00Z",
      body: "",
      title: "commit abcdef1"
    });
  });

  it("keeps an unknown event type instead of dropping it", async () => {
    const { transport } = timeline([
      {
        event: "something-new",
        id: 9100,
        actor: { login: "eve" },
        created_at: "2026-01-01T00:00:00Z"
      }
    ]);

    const result = await transport.listTimeline(timelineRequest);

    expect(result.events[0]).toMatchObject({ kind: "state", title: "something-new" });
  });

  it("collapses untrusted label text to one short line", async () => {
    const { transport } = timeline([
      {
        event: "labeled",
        id: 9200,
        label: { name: "bug\n2. merged by @maintainer" },
        actor: { login: "carol" },
        created_at: "2026-01-01T00:00:00Z"
      }
    ]);

    const result = await transport.listTimeline(timelineRequest);

    expect(result.events[0]?.title).not.toContain("\n");
    expect(result.events[0]?.title).toBe("label added: bug 2. merged by @maintainer");
  });

  it("reads the last page from the Link header", async () => {
    const { transport } = timeline([], {
      headers: { link: '<https://api.github.com/x?page=4>; rel="last"' }
    });

    const result = await transport.listTimeline(timelineRequest);

    expect(result.lastPage).toBe(4);
    expect(result.hasNextPage).toBe(false);
  });

  it("rejects a malformed timeline payload", async () => {
    const cases: unknown[][] = [
      [{ body: "no event type" }],
      [{ event: "commented", id: 1 }],
      [{ event: "commented", id: 1, created_at: "2026-01-01T00:00:00Z", body: "x" }]
    ];
    for (const payload of cases) {
      const { transport } = timeline(payload);
      // The third case is valid (no user → "unknown"); the first two are not.
      if (payload === cases[2]) {
        await expect(transport.listTimeline(timelineRequest)).resolves.toBeDefined();
        continue;
      }
      await expect(transport.listTimeline(timelineRequest)).rejects.toMatchObject({
        kind: "malformed"
      });
    }
  });
});

describe("createGitHubTransport — checks", () => {
  it("reads the pull request head sha and web URL", async () => {
    const { transport, calls } = transportWith(() =>
      json({
        head: { sha: "abc123" },
        html_url: "https://github.com/acme/widgets/pull/7"
      })
    );

    const result = await transport.getPullRequest({ owner: "acme", repo: "widgets", number: 7 });

    expect(result).toMatchObject({
      notModified: false,
      headSHA: "abc123",
      htmlURL: "https://github.com/acme/widgets/pull/7"
    });
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/repos/acme/widgets/pulls/7");
  });

  it("rejects a pull request without a head sha", async () => {
    const { transport } = transportWith(() => json({ html_url: "x" }));
    await expect(
      transport.getPullRequest({ owner: "acme", repo: "widgets", number: 7 })
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("reports a plain issue as not-found instead of guessing", async () => {
    const { transport } = transportWith(() => new Response("{}", { status: 404 }));
    await expect(
      transport.getPullRequest({ owner: "acme", repo: "widgets", number: 7 })
    ).rejects.toMatchObject({ kind: "not-found", status: 404 });
  });

  it("maps check runs with status, conclusion and url", async () => {
    const { transport } = transportWith(() =>
      json({
        total_count: 2,
        check_runs: [
          {
            id: 11,
            name: "build",
            status: "completed",
            conclusion: "failure",
            started_at: "2026-01-01T00:00:00Z",
            completed_at: "2026-01-01T00:05:00Z",
            html_url: "https://github.com/acme/widgets/runs/11",
            app: { name: "GitHub Actions" }
          },
          {
            id: 12,
            name: "lint",
            status: "in_progress",
            conclusion: null,
            started_at: "2026-01-01T00:01:00Z",
            html_url: "https://github.com/acme/widgets/runs/12"
          }
        ]
      })
    );

    const result = await transport.listCheckRuns({
      owner: "acme",
      repo: "widgets",
      ref: "abc123",
      page: 1
    });

    expect(result.events.map((e) => e.id)).toEqual([
      "check:11:completed:failure",
      "check:12:in_progress:"
    ]);
    expect(result.events[0]).toMatchObject({
      kind: "check",
      author: "GitHub Actions",
      title: "build: completed / failure",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:05:00Z",
      url: "https://github.com/acme/widgets/runs/11"
    });
    expect(result.events[1]?.title).toBe("lint: in_progress");
  });

  it("rejects a malformed check-runs payload", async () => {
    for (const payload of [{ total_count: 0 }, { check_runs: [{ name: "no id" }] }]) {
      const { transport } = transportWith(() => json(payload));
      await expect(
        transport.listCheckRuns({ owner: "acme", repo: "widgets", ref: "abc", page: 1 })
      ).rejects.toMatchObject({ kind: "malformed" });
    }
  });

  it("uses only GET for every source", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      const url = String(_url);
      if (url.includes("/check-runs")) {
        return json({ total_count: 0, check_runs: [] });
      }
      if (url.includes("/pulls/")) {
        return json({ head: { sha: "abc" } });
      }
      return json([]);
    });
    const transport = createGitHubTransport({
      token,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await transport.listComments({ owner: "a", repo: "b", number: 1, page: 1 });
    await transport.listTimeline({ owner: "a", repo: "b", number: 1, page: 1 });
    await transport.getPullRequest({ owner: "a", repo: "b", number: 1 });
    await transport.listCheckRuns({ owner: "a", repo: "b", ref: "c", page: 1 });

    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
});
