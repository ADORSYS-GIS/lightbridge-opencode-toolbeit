import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetTerminalPromptLatch, writeTerminalPrompt } from "../src/terminal-prompt.js";
import { createRecordingLogger } from "./helpers.js";

/**
 * A stand-in for a closed stderr pipe. Like Node's, a failed write reports
 * through the callback and THEN emits 'error' on a later tick; an 'error' with
 * no listener is what the host logs as `ERROR "unhandled rejection"`.
 */
class DeadPipe extends EventEmitter {
  unhandled = 0;
  written: string[] = [];
  destroyed = false;
  writable = true;

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.written.push(chunk);
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    process.nextTick(() => {
      callback?.(error);
      process.nextTick(() => {
        if (this.listenerCount("error") === 0) {
          this.unhandled += 1;
        } else {
          this.emit("error", error);
        }
      });
    });
    return false;
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

describe("writeTerminalPrompt", () => {
  beforeEach(() => resetTerminalPromptLatch());

  it("swallows an EPIPE 'error' event: nothing is left unhandled", async () => {
    const { logger } = createRecordingLogger();
    const pipe = new DeadPipe();

    writeTerminalPrompt("login prompt", logger, pipe);
    await tick();

    expect(pipe.unhandled).toBe(0);
    // The listener is not leaked once the write has settled.
    expect(pipe.listenerCount("error")).toBe(0);
  });

  it("logs the failure once at debug, however many prompts fail", async () => {
    const { logger, events } = createRecordingLogger();
    const pipe = new DeadPipe();

    writeTerminalPrompt("one", logger, pipe);
    writeTerminalPrompt("two", logger, pipe);
    await tick();

    const skipped = events.filter((event) => event.event === "terminal_prompt_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.level).toBe("debug");
    expect(events.some((event) => event.level === "error")).toBe(false);
  });

  it("skips a destroyed stream without writing", () => {
    const { logger, events } = createRecordingLogger();
    const pipe = new DeadPipe();
    pipe.destroyed = true;

    writeTerminalPrompt("prompt", logger, pipe);

    expect(pipe.written).toEqual([]);
    expect(events.map((event) => event.event)).toContain("terminal_prompt_skipped");
  });

  it("never throws when write itself throws", () => {
    const { logger } = createRecordingLogger();
    const pipe = new DeadPipe();
    vi.spyOn(pipe, "write").mockImplementation(() => {
      throw new Error("synchronous EPIPE");
    });

    expect(() => writeTerminalPrompt("prompt", logger, pipe)).not.toThrow();
    expect(pipe.listenerCount("error")).toBe(0);
  });

  it("still writes the prompt to a live stream (ADR-0014 carve-out kept)", () => {
    const { logger } = createRecordingLogger();
    const live = new (class extends EventEmitter {
      written: string[] = [];
      write(chunk: string, callback?: (error?: Error | null) => void): boolean {
        this.written.push(chunk);
        callback?.(null);
        return true;
      }
    })();

    writeTerminalPrompt("visit: https://idp.example/device", logger, live);

    expect(live.written).toEqual(["visit: https://idp.example/device"]);
  });
});
