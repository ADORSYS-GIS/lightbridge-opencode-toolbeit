import type { Logger } from "./logging.js";

/** The slice of `process.stderr` the prompt writer needs; injectable for tests. */
export interface PromptStream {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  once(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  readonly destroyed?: boolean;
  readonly writable?: boolean;
}

let skipLogged = false;

/** Reset the log-once latch. Test seam only. */
export function resetTerminalPromptLatch(): void {
  skipLogged = false;
}

/**
 * Write a login prompt to the terminal (stderr) without ever letting a dead
 * stream escape.
 *
 * ADR-0014 keeps this prompt on stderr for terminal users. But a v2 host runs
 * its server with stderr as a closed pipe, and a bare `process.stderr.write`
 * there emits an `EPIPE` 'error' event with no listener, which the host reports
 * as `ERROR "unhandled rejection"` at the instant the prompt is written. The
 * prompt is best-effort: this swallows the failure, logs it ONCE at `debug`,
 * and never throws.
 *
 * A short-lived 'error' listener is attached for the write. Node reports a
 * failed write twice: through the callback, then as an 'error' event on a later
 * tick. The listener must therefore outlive the callback (removed on
 * `setImmediate`), or the event arrives with nobody listening.
 */
export function writeTerminalPrompt(
  text: string,
  logger: Logger,
  stream: PromptStream = process.stderr
): void {
  const skip = (reason: string): void => {
    if (skipLogged) {
      return;
    }
    skipLogged = true;
    logger.debug("terminal_prompt_skipped", { reason });
  };

  if (stream.destroyed === true || stream.writable === false) {
    skip("stream_closed");
    return;
  }

  const onError = (error: Error): void => skip(error?.message ?? "write_error");
  try {
    stream.once("error", onError);
    stream.write(text, (error) => {
      if (error) {
        skip(error.message);
      }
      setImmediate(() => {
        stream.off("error", onError);
      });
    });
  } catch (error) {
    stream.off("error", onError);
    skip(error instanceof Error ? error.message : String(error));
  }
}
