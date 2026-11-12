import { join } from "node:path";
import { homedir } from "node:os";

import type { Logger } from "./logging.js";
/** Everything the plugin needs to run, resolved once at registration time. */
export interface WakeOptions {
  /** Poll interval for one subscription, before backoff. */
  readonly intervalMs: number;
  /** Hard floor: a caller may not subscribe with a tighter interval. */
  readonly minIntervalMs: number;
  /** Hard ceiling: also the backoff cap. */
  readonly maxIntervalMs: number;
  /** How many unread events one subscription may hold before the oldest are dropped. */
  readonly maxPending: number;
  /** How many comment ids are remembered for dedupe. */
  readonly seenLimit: number;
  /** Pagination guard for a single poll. GitHub serves 100 comments per page. */
  readonly maxPages: number;
  readonly apiBase: string;
  /** `gh auth token` by default; a user-supplied command replaces it. */
  readonly tokenCommand: readonly string[];
  /** Override the state root (tests, or a caller that keeps its own state). */
  readonly stateDir?: string;
}

export const DEFAULT_INTERVAL_MS = 60_000;
export const DEFAULT_MIN_INTERVAL_MS = 15_000;
export const DEFAULT_MAX_INTERVAL_MS = 3_600_000;
export const DEFAULT_MAX_PENDING = 100;
export const DEFAULT_SEEN_LIMIT = 500;
export const DEFAULT_MAX_PAGES = 10;
export const DEFAULT_API_BASE = "https://api.github.com";
export const DEFAULT_TOKEN_COMMAND: readonly string[] = ["gh", "auth", "token"];
export const STATE_NAMESPACE = "opencode-session-wake";

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/**
 * The platform's durable STATE root (never created here, just resolved).
 * Mirrors `@vymalo/opencode-auth-core`'s rule (ADR-0022) so this plugin's state
 * sits beside the suite's credentials instead of in a cache dir the OS purges:
 * macOS `~/Library/Application Support`, Windows `%LOCALAPPDATA%`, Linux
 * `$XDG_STATE_HOME` (absolute only) else `~/.local/state`.
 */
export function resolveStateRoot(
  environment: {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    home?: string;
  } = {}
): string {
  const platform = environment.platform ?? process.platform;
  const env = environment.env ?? process.env;
  const home = environment.home ?? homedir();
  const absolute = (value: string | undefined): string | undefined => {
    if (!value) {
      return undefined;
    }
    return (platform === "win32" ? /^[A-Za-z]:[\\/]/ : /^\//).test(value) ? value : undefined;
  };

  if (platform === "win32") {
    return absolute(env.LOCALAPPDATA) ?? join(home, "AppData", "Local");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support");
  }
  return absolute(env.XDG_STATE_HOME) ?? join(home, ".local", "state");
}

/** `<stateRoot>/opencode-session-wake/subscriptions`. */
export function resolveWakeStateDir(stateRoot: string = resolveStateRoot()): string {
  return join(stateRoot, STATE_NAMESPACE, "subscriptions");
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const out = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return out.length > 0 ? out : undefined;
}

/**
 * Parse this plugin's `options` block. Unknown keys are ignored; a malformed
 * value falls back to its default rather than failing plugin startup — a bad
 * poll interval must not stop the host from booting.
 */
export function parseWakeOptions(raw: Record<string, unknown> = {}): WakeOptions {
  const minIntervalMs = positiveInt(raw.minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  const maxIntervalMs = Math.max(
    minIntervalMs,
    positiveInt(raw.maxIntervalMs, DEFAULT_MAX_INTERVAL_MS)
  );
  const intervalMs = Math.min(
    maxIntervalMs,
    Math.max(minIntervalMs, positiveInt(raw.intervalMs, DEFAULT_INTERVAL_MS))
  );
  const tokenCommand = stringArray(raw.tokenCommand) ?? DEFAULT_TOKEN_COMMAND;

  return {
    intervalMs,
    minIntervalMs,
    maxIntervalMs,
    maxPending: positiveInt(raw.maxPending, DEFAULT_MAX_PENDING),
    seenLimit: positiveInt(raw.seenLimit, DEFAULT_SEEN_LIMIT),
    maxPages: positiveInt(raw.maxPages, DEFAULT_MAX_PAGES),
    apiBase:
      typeof raw.apiBase === "string" && raw.apiBase.length > 0
        ? raw.apiBase.replace(/\/+$/, "")
        : DEFAULT_API_BASE,
    tokenCommand,
    ...(typeof raw.stateDir === "string" && raw.stateDir.length > 0
      ? { stateDir: raw.stateDir }
      : {})
  };
}

/** Narrow a raw tool argument to the poll interval a caller may request. */
export function clampInterval(requested: unknown, options: WakeOptions, logger?: Logger): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return options.intervalMs;
  }
  const requestedMs = Math.floor(requested * 1000);
  const clamped = Math.min(options.maxIntervalMs, Math.max(options.minIntervalMs, requestedMs));
  if (clamped !== requestedMs) {
    logger?.warn("wake_interval_clamped", {
      requestedMs,
      clampedMs: clamped,
      minIntervalMs: options.minIntervalMs,
      maxIntervalMs: options.maxIntervalMs
    });
  }
  return clamped;
}
