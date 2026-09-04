import type { Logger } from "@vymalo/opencode-auth-core/lib";

export interface SchedulerHandle {
  stop(): void;
}

export interface SchedulerOptions {
  intervalMs: number;
  logger: Logger;
  taskName: string;
  run: () => Promise<void>;
}

export function startScheduler(options: SchedulerOptions): SchedulerHandle {
  let failures = 0;
  let stopped = false;
  let timeout: NodeJS.Timeout | undefined;

  const schedule = (delayMs: number): void => {
    timeout = setTimeout(() => {
      void tick();
    }, delayMs);
  };

  const backoffDelay = (): number => {
    const retryWindow = 15_000 * 2 ** Math.max(0, failures - 1);
    return Math.min(options.intervalMs, retryWindow);
  };

  const tick = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    options.logger.trace("oauth2_scheduler_tick", {
      taskName: options.taskName,
      failures
    });

    try {
      await options.run();
      failures = 0;
      schedule(options.intervalMs);
    } catch (error) {
      failures += 1;
      options.logger.warn("sync_schedule_retry", {
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
