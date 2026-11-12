import { TokenError, type TokenSource } from "./auth.js";
import type { WakeEvent } from "./types.js";

/**
 * Why a poll failed. Every kind is a *closed* failure: the caller logs it,
 * backs off and leaves the cursor alone. Nothing here is ever treated as "no
 * new comments".
 */
export type TransportFailureKind =
  | "auth"
  | "forbidden"
  | "rate-limit"
  | "network"
  | "malformed"
  | "http";

export class TransportFailure extends Error {
  readonly kind: TransportFailureKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    kind: TransportFailureKind,
    message: string,
    extra: { status?: number; retryAfterMs?: number } = {}
  ) {
    super(message);
    this.name = "TransportFailure";
    this.kind = kind;
    this.status = extra.status;
    this.retryAfterMs = extra.retryAfterMs;
  }
}

export interface CommentPageRequest {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly page: number;
  /** ISO timestamp from the persisted cursor. */
  readonly since?: string;
  /** Only sent when it was earned for this exact `since` value. */
  readonly etag?: string;
}

export interface CommentPage {
  /** A conditional request answered `304`: nothing changed since the cursor. */
  readonly notModified: boolean;
  readonly etag?: string;
  readonly events: readonly WakeEvent[];
  readonly hasNextPage: boolean;
}

/** The seam tests replace with a fake. Read-only by construction: one GET per call. */
export interface GitHubTransport {
  listComments(request: CommentPageRequest): Promise<CommentPage>;
}

export interface GitHubTransportOptions {
  readonly token: TokenSource;
  /** Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Defaults to `https://api.github.com`. */
  readonly apiBase?: string;
  readonly now?: () => number;
  /** Defaults to 100 (GitHub's maximum). */
  readonly perPage?: number;
}

function retryAfterFromHeaders(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) {
      return Math.max(0, at - now);
    }
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds)) {
      return Math.max(0, Math.round(epochSeconds * 1000 - now));
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Map one REST comment onto a `WakeEvent`. Anything structurally unexpected is
 * a `malformed` failure, not a silently dropped comment: a page we cannot read
 * must not advance the cursor.
 */
function toEvent(value: unknown): WakeEvent {
  const record = asRecord(value);
  const id = record?.id;
  if (record === undefined || (typeof id !== "number" && typeof id !== "string")) {
    throw new TransportFailure("malformed", "comment without a usable id");
  }
  const body = record.body;
  const user = asRecord(record.user);
  const createdAt = record.created_at;
  const updatedAt = record.updated_at ?? createdAt;
  const url = record.html_url;
  if (typeof body !== "string" || typeof createdAt !== "string" || typeof updatedAt !== "string") {
    throw new TransportFailure("malformed", `comment ${String(id)} is missing body or timestamps`);
  }
  return {
    id: String(id),
    kind: "comment",
    author: typeof user?.login === "string" ? user.login : "unknown",
    createdAt,
    updatedAt,
    url: typeof url === "string" ? url : "",
    body
  };
}

/**
 * The real transport: one conditional `GET /repos/{owner}/{repo}/issues/{n}/comments`
 * per page. This module contains no other HTTP verb — the plugin cannot post,
 * react, label or merge, even by accident.
 */
export function createGitHubTransport(options: GitHubTransportOptions): GitHubTransport {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const now = options.now ?? Date.now;
  const perPage = options.perPage ?? 100;

  return {
    async listComments(request) {
      let token: string;
      try {
        token = await options.token.resolve();
      } catch (error) {
        // `TokenError` carries the command name only; the token never reaches a message.
        throw new TransportFailure(
          "auth",
          error instanceof TokenError ? error.message : "no GitHub token available"
        );
      }

      const url = new URL(
        `${apiBase}/repos/${encodeURIComponent(request.owner)}/${encodeURIComponent(
          request.repo
        )}/issues/${request.number}/comments`
      );
      url.searchParams.set("per_page", String(perPage));
      url.searchParams.set("page", String(request.page));
      if (request.since) {
        url.searchParams.set("since", request.since);
      }

      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "opencode-session-wake",
        "x-github-api-version": "2022-11-28"
      };
      if (request.etag) {
        headers["if-none-match"] = request.etag;
      }

      let response: Response;
      try {
        response = await fetchImpl(url, { method: "GET", headers });
      } catch (error) {
        throw new TransportFailure(
          "network",
          error instanceof Error ? error.message : "network request failed"
        );
      }

      if (response.status === 304) {
        return { notModified: true, events: [], hasNextPage: false };
      }

      if (response.status === 401) {
        throw new TransportFailure("auth", "GitHub rejected the token (401)", { status: 401 });
      }

      if (response.status === 403 || response.status === 429) {
        const retryAfterMs = retryAfterFromHeaders(response.headers, now());
        const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
        if (response.status === 429 || exhausted || retryAfterMs !== undefined) {
          throw new TransportFailure("rate-limit", "GitHub rate limit reached", {
            status: response.status,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
          });
        }
        throw new TransportFailure("forbidden", "GitHub refused the request (403)", {
          status: 403
        });
      }

      if (response.status !== 200) {
        throw new TransportFailure("http", `GitHub returned ${response.status}`, {
          status: response.status
        });
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new TransportFailure("malformed", "GitHub returned a non-JSON body", { status: 200 });
      }
      if (!Array.isArray(payload)) {
        throw new TransportFailure("malformed", "GitHub returned a non-array body", {
          status: 200
        });
      }

      const events = payload.map(toEvent);
      const etag = response.headers.get("etag") ?? undefined;
      const link = response.headers.get("link") ?? "";
      return {
        notModified: false,
        ...(etag !== undefined ? { etag } : {}),
        events,
        hasNextPage: /rel="next"/.test(link)
      };
    }
  };
}
