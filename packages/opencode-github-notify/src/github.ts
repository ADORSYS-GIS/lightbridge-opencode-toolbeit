import { execFile } from "node:child_process";

import type { AuthConfig } from "./types.js";

export const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Why a fetch failed. Every kind leaves the cursor untouched; only the retry policy and
 * the status reported to the model differ.
 */
export type GitHubErrorKind =
  | "no_token"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "server"
  | "network"
  | "malformed";

export class GitHubError extends Error {
  override readonly name = "GitHubError";
  constructor(
    readonly kind: GitHubErrorKind,
    message: string,
    readonly status?: number,
    /** For `rate_limited`: how long GitHub asked us to wait. */
    readonly retryAfterMs?: number
  ) {
    super(message);
  }
}

/** One issue comment as this plugin uses it, validated off the wire. */
export interface Comment {
  readonly id: number;
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url: string;
  readonly body: string;
}

export type PageResult =
  | { readonly status: "not_modified" }
  | {
      readonly status: "ok";
      readonly comments: readonly Comment[];
      readonly etag?: string;
      readonly lastModified?: string;
      readonly next?: string;
    };

export interface ConditionalHeaders {
  readonly etag?: string;
  readonly lastModified?: string;
}

export type TokenProvider = {
  /** The current token, resolving it on first use. `undefined` when none is available. */
  get(): Promise<string | undefined>;
  /** Forget the cached token (after a 401) so the next `get` re-runs the source. */
  invalidate(): void;
};

export type RunCommand = (command: readonly string[]) => Promise<string>;

const defaultRunCommand: RunCommand = (command) =>
  new Promise((resolve, reject) => {
    const [file, ...args] = command;
    if (!file) {
      reject(new Error("empty token command"));
      return;
    }
    execFile(
      file,
      args,
      { timeout: TOKEN_COMMAND_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          // Only the command name: stderr may echo secrets or config paths.
          reject(new Error(`token command "${file}" failed`));
          return;
        }
        resolve(stdout);
      }
    );
  });

/**
 * Token source over `gh auth token` (default), a user command, or an env var. The token
 * stays in memory only — it is never logged and never written to this plugin's files.
 */
export function createTokenProvider(
  auth: AuthConfig,
  deps: { env?: Record<string, string | undefined>; runCommand?: RunCommand } = {}
): TokenProvider {
  const env = deps.env ?? process.env;
  const runCommand = deps.runCommand ?? defaultRunCommand;
  let cached: Promise<string | undefined> | undefined;

  const resolve = async (): Promise<string | undefined> => {
    if (auth.kind === "env") {
      const value = env[auth.env]?.trim();
      return value ? value : undefined;
    }
    try {
      const value = (await runCommand(auth.command)).trim();
      return value ? value : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    get() {
      cached ??= resolve().then((token) => {
        if (token === undefined) {
          // Do not cache a miss: `gh auth login` may happen while the plugin runs.
          cached = undefined;
        }
        return token;
      });
      return cached;
    },
    invalidate() {
      cached = undefined;
    }
  };
}

/** The `rel="next"` target of an RFC 8288 `Link` header, if any. */
export function parseNextLink(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?([^";]+)"?/.exec(part.trim());
    if (match?.[2]?.split(/\s+/).includes("next")) {
      return match[1];
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one REST issue comment. Throws `malformed` rather than inventing fields. */
export function parseComment(raw: unknown): Comment {
  if (!isRecord(raw)) {
    throw new GitHubError("malformed", "comment is not an object");
  }
  const { id, created_at, updated_at, html_url, body, user } = raw;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) {
    throw new GitHubError("malformed", "comment has no numeric id");
  }
  if (typeof created_at !== "string" || typeof updated_at !== "string") {
    throw new GitHubError("malformed", `comment ${id} has no timestamps`);
  }
  if (typeof html_url !== "string") {
    throw new GitHubError("malformed", `comment ${id} has no html_url`);
  }
  if (body !== null && body !== undefined && typeof body !== "string") {
    throw new GitHubError("malformed", `comment ${id} has a non-string body`);
  }
  // A deleted account surfaces as `user: null` ("ghost"); that is data, not an error.
  const author = isRecord(user) && typeof user.login === "string" ? user.login : "ghost";
  return {
    id,
    author,
    createdAt: created_at,
    updatedAt: updated_at,
    url: html_url,
    body: body ?? ""
  };
}

function retryAfterMs(response: Response, now: number): number | undefined {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter.trim())) {
    return Number(retryAfter) * 1000;
  }
  const reset = response.headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset.trim())) {
    return Math.max(Number(reset) * 1000 - now, 0);
  }
  return undefined;
}

/** Map a non-2xx/304 response to a typed error. Exported for tests. */
export function classifyFailure(response: Response, now: number = Date.now()): GitHubError {
  const { status } = response;
  if (status === 401) {
    return new GitHubError("unauthorized", "GitHub rejected the token (401)", status);
  }
  // GitHub signals primary and secondary rate limits with 403 or 429.
  const limited =
    status === 429 ||
    (status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after")));
  if (limited) {
    return new GitHubError(
      "rate_limited",
      `GitHub rate limit (${status})`,
      status,
      retryAfterMs(response, now)
    );
  }
  if (status === 403) {
    return new GitHubError("forbidden", "token lacks access to this thread (403)", status);
  }
  if (status === 404) {
    // GitHub answers 404, not 403, for a private repository the token cannot see.
    return new GitHubError(
      "not_found",
      "thread not found, or private and not visible to this token (404)",
      status
    );
  }
  if (status >= 500) {
    return new GitHubError("server", `GitHub server error (${status})`, status);
  }
  return new GitHubError("server", `unexpected GitHub response (${status})`, status);
}

export interface GitHubClientDeps {
  readonly apiBaseUrl: string;
  readonly token: TokenProvider;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly userAgent?: string;
}

export interface GitHubClient {
  /** The first page URL of a thread's comment listing. */
  firstPageUrl(owner: string, repo: string, number: number): string;
  /** Fetch one page, conditionally. Throws {@link GitHubError}. */
  fetchPage(url: string, conditional?: ConditionalHeaders): Promise<PageResult>;
}

/**
 * Read-only REST client for issue comments (`GET /repos/{o}/{r}/issues/{n}/comments` —
 * which also carries a pull request's conversation). It issues GET requests only; there
 * is deliberately no code path in this package that writes to GitHub.
 */
export function createGitHubClient(deps: GitHubClientDeps): GitHubClient {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const origin = new URL(deps.apiBaseUrl).origin;

  const request = async (url: string, conditional: ConditionalHeaders | undefined) => {
    const token = await deps.token.get();
    if (!token) {
      throw new GitHubError("no_token", "no GitHub token (run `gh auth login` or configure auth)");
    }
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": deps.userAgent ?? "vymalo-opencode-github-notify"
    };
    if (conditional?.etag) {
      headers["If-None-Match"] = conditional.etag;
    } else if (conditional?.lastModified) {
      headers["If-Modified-Since"] = conditional.lastModified;
    }
    try {
      return await doFetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      throw new GitHubError(
        "network",
        `network error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  return {
    firstPageUrl(owner, repo, number) {
      return `${deps.apiBaseUrl}/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`;
    },

    async fetchPage(url, conditional) {
      // Pagination URLs come from GitHub's Link header; never follow one off-origin with
      // our token attached.
      if (new URL(url).origin !== origin) {
        throw new GitHubError("malformed", "pagination link points to another origin");
      }

      let response = await request(url, conditional);
      if (response.status === 401) {
        // One retry with a freshly resolved token (e.g. `gh` rotated it).
        deps.token.invalidate();
        response = await request(url, conditional);
      }
      if (response.status === 304) {
        return { status: "not_modified" };
      }
      if (response.status !== 200) {
        throw classifyFailure(response, now());
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new GitHubError("malformed", "response body is not JSON", response.status);
      }
      if (!Array.isArray(payload)) {
        throw new GitHubError("malformed", "expected an array of comments", response.status);
      }

      const etag = response.headers.get("etag") ?? undefined;
      const lastModified = response.headers.get("last-modified") ?? undefined;
      const next = parseNextLink(response.headers.get("link"));
      return {
        status: "ok",
        comments: payload.map(parseComment),
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
        ...(next ? { next } : {})
      };
    }
  };
}
