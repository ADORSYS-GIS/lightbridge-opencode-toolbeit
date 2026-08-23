/**
 * A resource attribute whose value only becomes known after the plugin has
 * already started — OpenCode reports the host version and the git branch as
 * *events*, not as plugin input, but an OTel `Resource` is fixed at provider
 * construction.
 *
 * The OTel resource API accepts promise-valued attributes and exporters await
 * them before the first export, so a deferred value is the supported way to
 * bridge that gap. The timeout is not optional: a promise that never settles
 * would block every export forever, so an attribute that has not arrived in
 * time resolves to `undefined` and is dropped from the resource.
 */
export interface DeferredAttribute {
  /** Hand this to `resourceFromAttributes`. */
  readonly value: Promise<string | undefined>;
  /** Settle it with the real value. Later calls are ignored. */
  settle(value: string | undefined): void;
  /** Give up and settle as absent. Idempotent. */
  abandon(): void;
}

export const DEFAULT_DEFERRED_TIMEOUT_MS = 2_000;

export function deferredAttribute(
  timeoutMs: number = DEFAULT_DEFERRED_TIMEOUT_MS,
  schedule: typeof setTimeout = setTimeout
): DeferredAttribute {
  let resolve: (value: string | undefined) => void = () => {};
  let settled = false;
  const value = new Promise<string | undefined>((r) => {
    resolve = r;
  });

  const finish = (next: string | undefined): void => {
    if (settled) {
      return;
    }
    settled = true;
    resolve(next);
  };

  const timer = schedule(() => finish(undefined), timeoutMs);
  // Never hold a short CLI invocation open just to wait for an attribute.
  (timer as { unref?: () => void }).unref?.();

  return {
    value,
    settle: (next) => {
      if (next !== undefined && next !== "") {
        finish(next);
      }
    },
    abandon: () => finish(undefined)
  };
}
