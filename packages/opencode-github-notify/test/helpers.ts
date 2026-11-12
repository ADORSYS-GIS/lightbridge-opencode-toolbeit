import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

import { createGitHubClient, type GitHubClient, type TokenProvider } from "../src/github.js";
import type { Logger } from "../src/logging.js";
import type { PollDeps } from "../src/thread.js";
import type { WatchConfig } from "../src/types.js";

export const API = "https://api.github.test";
export const WATCH: WatchConfig = { owner: "acme", repo: "plan", number: 7, key: "acme/plan#7" };

export function silentLogger(): Logger & Record<keyof Logger, ReturnType<typeof vi.fn>> {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

export interface FakeComment {
  id: number;
  login: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

type Scripted =
  | { status: number; headers?: Record<string, string>; body?: string }
  | { networkError: string };

/**
 * An in-memory GitHub issue-comments endpoint: pagination via `page`/`per_page` + `Link`,
 * strong ETags over each page's content, 304 on `If-None-Match`, and scripted failures.
 */
export class FakeGitHub {
  comments: FakeComment[] = [];
  perPage = 100;
  requests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  readonly failures: Scripted[] = [];
  private nextId = 1000;
  private clock = Date.parse("2026-11-01T10:00:00Z");

  add(body: string, login: string | null = "alice"): FakeComment {
    const at = new Date((this.clock += 1000)).toISOString();
    const comment = { id: this.nextId++, login, body, created_at: at, updated_at: at };
    this.comments.push(comment);
    return comment;
  }

  edit(id: number, body: string): void {
    const comment = this.comments.find((c) => c.id === id);
    if (!comment) {
      throw new Error(`no comment ${id}`);
    }
    comment.body = body;
    comment.updated_at = new Date((this.clock += 1000)).toISOString();
  }

  remove(id: number): void {
    this.comments = this.comments.filter((c) => c.id !== id);
  }

  fail(...scripted: Scripted[]): void {
    this.failures.push(...scripted);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.requests.push({ url: url.toString(), method: init?.method ?? "GET", headers });

    const scripted = this.failures.shift();
    if (scripted) {
      if ("networkError" in scripted) {
        throw new TypeError(scripted.networkError);
      }
      return new Response(scripted.body ?? "{}", {
        status: scripted.status,
        headers: scripted.headers
      });
    }

    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "30");
    const slice = this.comments.slice((page - 1) * perPage, page * perPage);
    const body = JSON.stringify(
      slice.map((c) => ({
        id: c.id,
        user: c.login === null ? null : { login: c.login },
        body: c.body,
        created_at: c.created_at,
        updated_at: c.updated_at,
        html_url: `https://github.test/acme/plan/issues/7#issuecomment-${c.id}`
      }))
    );
    const lastPage = Math.max(1, Math.ceil(this.comments.length / perPage));
    const etag = `"${createHash("sha1").update(`${body}|${lastPage}`).digest("hex")}"`;
    if (headers["If-None-Match"] === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    const responseHeaders: Record<string, string> = { etag, "content-type": "application/json" };
    if (page < lastPage) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      responseHeaders.link = `<${next.toString()}>; rel="next", <${url.origin}${url.pathname}?page=${lastPage}>; rel="last"`;
    }
    return new Response(body, { status: 200, headers: responseHeaders });
  };
}

export function staticToken(
  value = "tkn"
): TokenProvider & { invalidate: ReturnType<typeof vi.fn> } {
  return { get: async () => value, invalidate: vi.fn() };
}

export function clientFor(fake: FakeGitHub, token: TokenProvider = staticToken()): GitHubClient {
  return createGitHubClient({ apiBaseUrl: API, token, fetch: fake.fetch });
}

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "gh-notify-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A mutable clock, so backoff/not-due logic is deterministic. */
export function fakeClock(start = Date.parse("2026-11-11T12:00:00Z")) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    }
  };
}

export function pollDeps(dir: string, fake: FakeGitHub, over: Partial<PollDeps> = {}): PollDeps {
  return {
    stateDir: dir,
    client: clientFor(fake),
    filter: { mentions: [], markers: [] },
    logger: silentLogger(),
    pollIntervalMs: 60_000,
    maxBackoffMs: 900_000,
    maxLogEvents: 500,
    maxPages: 30,
    ...over
  };
}
