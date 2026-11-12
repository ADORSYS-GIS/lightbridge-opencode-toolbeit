import type { AuthConfig, NotifyMode, ResolvedOptions, WatchConfig } from "./types.js";

export const DEFAULT_POLL_INTERVAL_SECONDS = 60;
/** Polling faster than this burns quota for no benefit; GitHub itself caches for ~60s. */
export const MIN_POLL_INTERVAL_SECONDS = 15;
export const DEFAULT_MAX_BACKOFF_SECONDS = 900;
export const DEFAULT_API_BASE_URL = "https://api.github.com";
export const DEFAULT_MAX_LOG_EVENTS = 500;
export const DEFAULT_MAX_PAGES = 30;
export const DEFAULT_BATCH_SIZE = 20;
export const DEFAULT_TOKEN_COMMAND: readonly string[] = ["gh", "auth", "token"];
export const DEFAULT_NOTIFY: NotifyMode = "queue";

/** A configuration problem. The plugin logs it and stays inert rather than guessing. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const NAME = /^[A-Za-z0-9_.-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new ConfigError(`${field} must be an array of non-empty strings`);
  }
  return value as string[];
}

function positiveInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${field} must be a positive integer`);
  }
  return value;
}

function makeWatch(owner: string, repo: string, number: number): WatchConfig {
  if (!NAME.test(owner) || !NAME.test(repo)) {
    throw new ConfigError(`invalid repository "${owner}/${repo}"`);
  }
  if (!Number.isInteger(number) || number <= 0) {
    throw new ConfigError(`invalid thread number ${String(number)} for ${owner}/${repo}`);
  }
  return { owner, repo, number, key: `${owner}/${repo}#${number}` };
}

/** Parse `owner/repo#123`. */
export function parseWatchRef(ref: string): WatchConfig {
  const match = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(ref.trim());
  if (!match) {
    throw new ConfigError(`watch "${ref}" must look like owner/repo#123`);
  }
  return makeWatch(match[1] as string, match[2] as string, Number(match[3]));
}

function parseWatches(options: Record<string, unknown>): WatchConfig[] {
  const watches: WatchConfig[] = [];

  for (const ref of stringList(options.watches, "watches")) {
    watches.push(parseWatchRef(ref));
  }

  if (options.repo !== undefined || options.threads !== undefined) {
    if (typeof options.repo !== "string") {
      throw new ConfigError('repo must be a string like "owner/repo" when threads is set');
    }
    const [owner, repo, extra] = options.repo.split("/");
    if (!owner || !repo || extra !== undefined) {
      throw new ConfigError(`repo "${options.repo}" must look like owner/repo`);
    }
    const threads = options.threads;
    if (!Array.isArray(threads) || threads.length === 0) {
      throw new ConfigError("threads must be a non-empty array of issue/PR numbers");
    }
    for (const thread of threads) {
      watches.push(makeWatch(owner, repo, typeof thread === "number" ? thread : Number.NaN));
    }
  }

  // Deduplicate: two spellings of one thread must share one log and one cursor.
  const seen = new Map<string, WatchConfig>();
  for (const watch of watches) {
    seen.set(watch.key.toLowerCase(), watch);
  }
  return [...seen.values()];
}

function parseAuth(value: unknown): AuthConfig {
  if (value === undefined) {
    return { kind: "command", command: DEFAULT_TOKEN_COMMAND };
  }
  if (!isRecord(value)) {
    throw new ConfigError("auth must be an object");
  }
  if (value.env !== undefined) {
    if (typeof value.env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.env)) {
      throw new ConfigError("auth.env must be an environment variable name");
    }
    return { kind: "env", env: value.env };
  }
  const command = stringList(value.command, "auth.command");
  if (command.length === 0) {
    throw new ConfigError("auth needs either env or a non-empty command");
  }
  return { kind: "command", command };
}

function parseNotify(value: unknown): NotifyMode {
  if (value === undefined) {
    return DEFAULT_NOTIFY;
  }
  if (value === false) {
    return "off";
  }
  if (value === "off" || value === "queue" || value === "wake") {
    return value;
  }
  throw new ConfigError('notify must be "off", "queue" or "wake"');
}

function parseApiBaseUrl(value: unknown): string {
  if (value === undefined) {
    return DEFAULT_API_BASE_URL;
  }
  if (typeof value !== "string") {
    throw new ConfigError("apiBaseUrl must be a string");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`apiBaseUrl "${value}" is not a URL`);
  }
  // The token is sent to this origin; refuse to send it in clear text off-host.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ConfigError("apiBaseUrl must be https (http is accepted for loopback only)");
  }
  return value.replace(/\/+$/, "");
}

/**
 * Resolve the plugin's `options` (the `{ package, options }` entry in `plugins`). Throws
 * {@link ConfigError} on anything malformed: a half-understood watch list would claim
 * coverage the plugin does not have.
 */
export function resolveOptions(raw: unknown): ResolvedOptions {
  const options = isRecord(raw) ? raw : {};
  const filter = isRecord(options.filter) ? options.filter : {};
  if (options.filter !== undefined && !isRecord(options.filter)) {
    throw new ConfigError("filter must be an object");
  }

  const pollSeconds = Math.max(
    positiveInt(options.pollIntervalSeconds, "pollIntervalSeconds", DEFAULT_POLL_INTERVAL_SECONDS),
    MIN_POLL_INTERVAL_SECONDS
  );
  const backoffSeconds = Math.max(
    positiveInt(options.maxBackoffSeconds, "maxBackoffSeconds", DEFAULT_MAX_BACKOFF_SECONDS),
    pollSeconds
  );

  return {
    enabled: options.enabled !== false,
    watches: parseWatches(options),
    pollIntervalMs: pollSeconds * 1000,
    maxBackoffMs: backoffSeconds * 1000,
    filter: {
      mentions: stringList(filter.mentions, "filter.mentions").map((handle) =>
        handle.replace(/^@/, "")
      ),
      markers: stringList(filter.markers, "filter.markers")
    },
    auth: parseAuth(options.auth),
    notify: parseNotify(options.notify),
    apiBaseUrl: parseApiBaseUrl(options.apiBaseUrl),
    maxLogEvents: positiveInt(options.maxLogEvents, "maxLogEvents", DEFAULT_MAX_LOG_EVENTS),
    maxPages: positiveInt(options.maxPages, "maxPages", DEFAULT_MAX_PAGES),
    batchSize: positiveInt(options.batchSize, "batchSize", DEFAULT_BATCH_SIZE),
    ...(typeof options.stateDir === "string" ? { stateDir: options.stateDir } : {})
  };
}
