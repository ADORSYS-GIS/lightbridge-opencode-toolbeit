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
