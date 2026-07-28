import type { Logger } from "./logging.js";

export interface SchedulerHandle {
  stop(): void;
}

export interface SchedulerOptions {
  intervalMs: number;
  logger: Logger;
  taskName: string;
  run: () => Promise<void>;
}

/**
 * Runs `options.run` on a fixed interval, forever, until `stop()` is called.
 * The first run fires after one interval — not immediately — since callers
 * are expected to have already done an initial run synchronously (e.g. the
 * `config` hook's own on-demand cache check). A failure backs off (capped at
 * `intervalMs`) instead of hammering a down endpoint, then resumes the normal
 * cadence once a run succeeds.
 *
 * The underlying timer is `unref()`'d so it never keeps a short-lived process
 * (a one-shot CLI invocation) alive on its own — it only fires if the process
 * is still running for some other reason when the interval elapses.
 */
export function startScheduler(options: SchedulerOptions): SchedulerHandle {
  let failures = 0;
  let stopped = false;
  let timeout: NodeJS.Timeout | undefined;

  const schedule = (delayMs: number): void => {
    timeout = setTimeout(() => {
      void tick();
    }, delayMs);
    timeout.unref?.();
  };

  const backoffDelay = (): number => {
    const retryWindow = 15_000 * 2 ** Math.max(0, failures - 1);
    return Math.min(options.intervalMs, retryWindow);
  };

  const tick = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    options.logger.trace("models_info_scheduler_tick", {
      taskName: options.taskName,
      failures
    });

    try {
      await options.run();
      failures = 0;
      schedule(options.intervalMs);
    } catch (error) {
      failures += 1;
      options.logger.warn("models_info_scheduler_retry", {
        taskName: options.taskName,
        failures,
        delayMs: backoffDelay(),
        error: error instanceof Error ? error.message : String(error)
      });
      schedule(backoffDelay());
    }
  };

  schedule(options.intervalMs);

  return {
    stop() {
      stopped = true;
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  };
}
