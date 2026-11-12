import { execFile } from "node:child_process";
import { basename } from "node:path";

/** Raised when no token can be produced. Always fail closed: no poll, no cursor move. */
export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

/** Run a command and return stdout. Injected so tests never spawn a process. */
export type TokenCommandRunner = (command: readonly string[]) => Promise<string>;

export interface TokenSource {
  /** Safe to log: the command's name only, never its output. */
  describe(): string;
  /** The bearer token. Cached in memory for `ttlMs`; never written anywhere. */
  resolve(): Promise<string>;
}

export interface TokenSourceOptions {
  /** Defaults to `["gh", "auth", "token"]`. */
  readonly command?: readonly string[];
  /** Defaults to a real `execFile` (no shell, 10s timeout). */
  readonly run?: TokenCommandRunner;
  /** Defaults to 10 minutes — long enough that polling does not spawn `gh` every tick. */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/** `execFile` (not `exec`): the command is an argv array, so no shell ever parses it. */
export function execFileRunner(command: readonly string[], timeoutMs = 10_000): Promise<string> {
  const [file, ...args] = command;
  if (!file) {
    return Promise.reject(new TokenError("empty token command"));
  }
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) {
        // The error message may quote argv but never the token: `gh auth token`
        // writes the token to stdout, which is only read on success.
        reject(new TokenError(`token command failed (${basename(file)})`));
        return;
      }
      const token = stdout.trim();
      if (token.length === 0) {
        reject(new TokenError(`token command produced no output (${basename(file)})`));
        return;
      }
      resolve(token);
    });
  });
}

/**
 * A token obtained from `gh auth token` (or a user-supplied command). The token
 * lives in a closure for at most `ttlMs`; it is never logged, never persisted,
 * and never part of a subscription record.
 */
export function createTokenSource(options: TokenSourceOptions = {}): TokenSource {
  const command = options.command ?? ["gh", "auth", "token"];
  const run = options.run ?? ((argv: readonly string[]) => execFileRunner(argv));
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;
  const name = command[0] ? basename(command[0]) : "token-command";

  let cached: { value: string; expiresAt: number } | undefined;

  return {
    describe: () => name,
    async resolve() {
      const current = now();
      if (cached && cached.expiresAt > current) {
        return cached.value;
      }
      const token = await run(command);
      const trimmed = token.trim();
      if (trimmed.length === 0) {
        throw new TokenError(`token command produced no output (${name})`);
      }
      cached = { value: trimmed, expiresAt: current + ttlMs };
      return trimmed;
    }
  };
}
