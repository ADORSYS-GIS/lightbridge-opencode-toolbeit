import { describe, expect, it, vi } from "vitest";

import {
  classifyFailure,
  createGitHubClient,
  createTokenProvider,
  parseComment,
  parseNextLink
} from "../src/github.js";
import { API, FakeGitHub, staticToken } from "./helpers.js";

describe("parseNextLink", () => {
  it("extracts rel=next and ignores the rest", () => {
    expect(
      parseNextLink('<https://a/x?page=2>; rel="next", <https://a/x?page=5>; rel="last"')
    ).toBe("https://a/x?page=2");
    expect(parseNextLink('<https://a/x?page=1>; rel="prev"')).toBeUndefined();
    expect(parseNextLink(null)).toBeUndefined();
  });
});

describe("parseComment", () => {
  const ok = {
    id: 5,
    user: { login: "bob" },
    body: "hi",
    created_at: "c",
    updated_at: "u",
    html_url: "https://x"
  };

  it("maps a valid comment and a deleted (ghost) author", () => {
    expect(parseComment(ok)).toEqual({
      id: 5,
      author: "bob",
      createdAt: "c",
      updatedAt: "u",
      url: "https://x",
      body: "hi"
    });
    expect(parseComment({ ...ok, user: null, body: null })).toMatchObject({
      author: "ghost",
      body: ""
    });
  });

  it.each([
    ["not an object", 3],
    ["no id", { ...ok, id: "5" }],
    ["no timestamps", { ...ok, updated_at: undefined }],
    ["no url", { ...ok, html_url: 1 }],
    ["bad body", { ...ok, body: 4 }]
  ])("rejects %s as malformed", (_name, raw) => {
    expect(() => parseComment(raw)).toThrow(expect.objectContaining({ kind: "malformed" }));
  });
});

describe("classifyFailure", () => {
  const at = (status: number, headers: Record<string, string> = {}) =>
    classifyFailure(new Response(null, { status, headers }), 1_000_000);

  it("separates rate limits from plain 403s", () => {
    expect(at(403).kind).toBe("forbidden");
    expect(at(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1060" })).toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 60_000
    });
    expect(at(429, { "retry-after": "30" })).toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 30_000
    });
    expect(at(429).retryAfterMs).toBeUndefined();
  });

  it("maps 401, 404, 5xx and the unexpected", () => {
    expect(at(401).kind).toBe("unauthorized");
    expect(at(404).kind).toBe("not_found");
    expect(at(502).kind).toBe("server");
    expect(at(418).message).toMatch(/unexpected/);
  });
});

describe("createTokenProvider", () => {
  it("reads an env var and treats a blank one as absent", async () => {
    const auth = { kind: "env", env: "GH_T" } as const;
    expect(await createTokenProvider(auth, { env: { GH_T: " abc \n" } }).get()).toBe("abc");
    expect(await createTokenProvider(auth, { env: { GH_T: "  " } }).get()).toBeUndefined();
  });

  it("caches a command's token until invalidated", async () => {
    const runCommand = vi.fn().mockResolvedValueOnce("one\n").mockResolvedValueOnce("two\n");
    const provider = createTokenProvider({ kind: "command", command: ["gh"] }, { runCommand });
    expect(await provider.get()).toBe("one");
    expect(await provider.get()).toBe("one");
    provider.invalidate();
    expect(await provider.get()).toBe("two");
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure, so a later `gh auth login` is picked up", async () => {
    const runCommand = vi.fn().mockRejectedValueOnce(new Error("no")).mockResolvedValueOnce("ok");
    const provider = createTokenProvider({ kind: "command", command: ["gh"] }, { runCommand });
    expect(await provider.get()).toBeUndefined();
    expect(await provider.get()).toBe("ok");
  });

  it("runs a real command (no token is logged or stored)", async () => {
    const provider = createTokenProvider({
      kind: "command",
      command: [process.execPath, "-e", "process.stdout.write('real')"]
    });
    expect(await provider.get()).toBe("real");
    const failing = createTokenProvider({
      kind: "command",
      command: [process.execPath, "-e", "process.exit(3)"]
    });
    expect(await failing.get()).toBeUndefined();
  });
});

describe("createGitHubClient", () => {
  it("fails with no_token without calling GitHub", async () => {
    const gh = new FakeGitHub();
    const client = createGitHubClient({
      apiBaseUrl: API,
      token: { get: async () => undefined, invalidate: () => {} },
      fetch: gh.fetch
    });
    await expect(client.fetchPage(client.firstPageUrl("a", "b", 1))).rejects.toMatchObject({
      kind: "no_token"
    });
    expect(gh.requests).toEqual([]);
  });

  it("sends the bearer, API version and a conditional header; never a body", async () => {
    const gh = new FakeGitHub();
    const client = createGitHubClient({
      apiBaseUrl: API,
      token: staticToken("s3cret"),
      fetch: gh.fetch
    });
    await client.fetchPage(client.firstPageUrl("a", "b", 1), { lastModified: "Tue" });
    const [req] = gh.requests;
    expect(req?.method).toBe("GET");
    expect(req?.headers.Authorization).toBe("Bearer s3cret");
    expect(req?.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(req?.headers["If-Modified-Since"]).toBe("Tue");
    expect(req?.url).toBe(`${API}/repos/a/b/issues/1/comments?per_page=100`);
  });

  it("invalidates the token on 401 and retries once", async () => {
    const gh = new FakeGitHub();
    const token = staticToken();
    const client = createGitHubClient({ apiBaseUrl: API, token, fetch: gh.fetch });
    gh.fail({ status: 401 });
    expect((await client.fetchPage(client.firstPageUrl("a", "b", 1))).status).toBe("ok");
    expect(token.invalidate).toHaveBeenCalledOnce();
  });

  it("wraps a thrown fetch as a network error", async () => {
    const client = createGitHubClient({
      apiBaseUrl: API,
      token: staticToken(),
      fetch: async () => {
        throw "boom";
      }
    });
    await expect(client.fetchPage(`${API}/x`)).rejects.toMatchObject({ kind: "network" });
  });
});
