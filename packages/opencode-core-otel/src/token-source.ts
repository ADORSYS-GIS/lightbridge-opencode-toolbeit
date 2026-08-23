import { execFile } from "node:child_process";

import type { Logger } from "./logging.js";

/** Refresh this far before the token's own expiry, so an export never races it. */
export const EXPIRY_SKEW_MS = 30_000;

/** Used when the token carries no readable `exp`. Below Keycloak's 300s default. */
export const DEFAULT_REFRESH_MS = 240_000;

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Injectable command runner, so tests never spawn a process. */
export type CommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number
) => Promise<RunResult>;

export interface TokenSourceOptions {
  /** Argv of the credential helper, e.g. `["governance-auth", "token"]`. */
  command: string[];
  /** Header to carry the token. Default `Authorization`. */
  header?: string;
  /** Value prefix. Default `Bearer `. */
  prefix?: string;
  /** Fallback cadence when the token has no readable `exp`. */
  refreshMs?: number;
  /** How long the helper may take before it is killed. Default 10s. */
  timeoutMs?: number;
  logger: Logger;
  now?: () => number;
  run?: CommandRunner;
}

export interface TokenSource {
  /**
   * A `HeadersFactory` for the OTLP exporters — called before every export.
   * Never throws: the exporters explicitly require that.
   */
  headers(): Promise<Record<string, string>>;
  /** Drop the cached token so the next call re-runs the helper. */
  invalidate(): void;
}

const defaultRunner: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code as number)
            : error
              ? 1
              : 0;
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code });
      }
    );
  });

/**
 * Read a JWT's `exp` without verifying it. We are not authenticating anything —
 * we only want to know when to ask the helper for a new token, and the issuer's
 * signature is the collector's business, not ours.
 */
export function readJwtExpiry(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof decoded.exp === "number" && Number.isFinite(decoded.exp)
      ? decoded.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A credential helper as a header source: run a command, take its stdout as the
 * access token, cache it until shortly before it expires.
 *
 * Matches the contract `governance-auth token` documents (ADR-0010 in
 * `lightbridge-governance`): **stdout is the token and nothing else**, everything
 * else goes to stderr, and a failure is a non-zero exit with empty stdout rather
 * than a stale value.
 *
 * Failure behaviour is deliberately asymmetric. A helper that fails while the
 * cached token is *still valid* changes nothing — the cached token is current,
 * not stale, and dropping it would lose data for no reason. A helper that fails
 * with no valid token left emits **no auth header at all**, so the export fails
 * closed at the collector rather than being retried forever with a dead
 * credential. Either way the failure is logged; the token never is.
 */
export function createTokenSource(options: TokenSourceOptions): TokenSource {
  const {
    command,
    header = "Authorization",
    prefix = "Bearer ",
    refreshMs = DEFAULT_REFRESH_MS,
    timeoutMs = 10_000,
    logger,
    now = Date.now,
    run = defaultRunner
  } = options;

  const [executable, ...args] = command;
  let token: string | undefined;
  let validUntil = 0;
  /** Shared so concurrent exports spawn one helper process, not three. */
  let inFlight: Promise<void> | undefined;

  const refresh = async (): Promise<void> => {
    const started = now();
    let result: RunResult;
    try {
      result = await run(executable, args, timeoutMs);
    } catch (error) {
      logger.warn("otel_token_command_failed", {
        command: executable,
        reason: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    const value = result.stdout.trim();
    if (result.code !== 0 || value === "") {
      // Never log stdout/stderr contents — stderr of a credential helper can
      // echo the request, and stdout *is* the secret.
      logger.warn("otel_token_command_failed", {
        command: executable,
        exitCode: result.code,
        emptyStdout: value === "",
        stderrLength: result.stderr.length,
        durationMs: now() - started
      });
      return;
    }

    token = value;
    const expiry = readJwtExpiry(value);
    validUntil = expiry ? expiry - EXPIRY_SKEW_MS : now() + refreshMs;
    logger.debug("otel_token_refreshed", {
      command: executable,
      // Absolute time, not the token: enough to debug an expiry problem.
      validUntil: new Date(validUntil).toISOString(),
      source: expiry ? "jwt_exp" : "refresh_interval",
      durationMs: now() - started
    });
  };

  return {
    async headers() {
      if (!token || now() >= validUntil) {
        inFlight ??= refresh().finally(() => {
          inFlight = undefined;
        });
        await inFlight;
      }

      if (!token) {
        return {};
      }
      if (now() >= validUntil) {
        // Refresh failed and what we hold has aged out. Fail closed rather than
        // present a credential the collector will reject anyway.
        logger.warn("otel_token_expired", { command: executable });
        token = undefined;
        return {};
      }
      return { [header]: `${prefix}${token}` };
    },
    invalidate() {
      token = undefined;
      validUntil = 0;
    }
  };
}
