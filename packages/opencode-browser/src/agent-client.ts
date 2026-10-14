import type { AgentEndpoint } from "./broker.js";
import type { Logger } from "./logging.js";
import {
  type BrowserAction,
  type CommandFrame,
  decodeFrame,
  encodeFrame,
  helloFrame,
  nextId,
  PROTOCOL_VERSION
} from "./protocol.js";

/** Minimal socket the agent-client drives — provided per runtime by the endpoint. */
export interface AgentSocket {
  send(data: string): void;
  close(): void;
}
export interface AgentSocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(): void;
}
export type AgentSocketFactory = (url: string, handlers: AgentSocketHandlers) => AgentSocket;

export interface AgentClientOptions {
  url: string;
  token: string;
  label?: string;
  timeoutMs: number;
  /** Ceiling for the guest handshake; `connect()` rejects after it. Default 5000. */
  connectTimeoutMs?: number;
}

/**
 * Grace added to the guest's local per-command timer over the requested
 * deadline. The host broker enforces the real timeout and can tell the executor
 * to tear down (a `cancel` frame); the guest's timer is only a backstop for a
 * silently unresponsive broker, so it must fire *after* the broker's, never
 * before — otherwise the guest rejects locally while the executor keeps running.
 */
const AGENT_TIMEOUT_GRACE_MS = 5_000;

/**
 * Default ceiling for the guest handshake (socket open -> broker `ready`).
 * A broker port can stay bound by a dead process (on Windows a listen socket is
 * inherited by child processes), so the TCP/WebSocket open succeeds but no
 * `ready` frame ever arrives. Without a ceiling `connect()` never settles.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export interface AgentClientDeps {
  logger: Logger;
  createSocket: AgentSocketFactory;
  /** Called when the connection drops (host gone) — the endpoint re-elects. */
  onClose?: () => void;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  detachAbort: (() => void) | null;
}

export class AgentClientError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "AgentClientError";
    this.code = code;
  }
}

/**
 * Connects to a running broker as an `agent` and brokers request/response for the
 * host adapter's tools (the guest path). One connection attempt + lifecycle; the
 * endpoint orchestrates re-election/reconnect via `onClose`.
 */
export class AgentClient implements AgentEndpoint {
  private socket: AgentSocket | null = null;
  private ready = false;
  private closed = false;
  private readonly pending = new Map<string, Pending>();
  private readyWaiters: Array<() => void> = [];

  constructor(
    private readonly opts: AgentClientOptions,
    private readonly deps: AgentClientDeps
  ) {}

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const connectTimeoutMs = this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      const connectTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        this.deps.logger.debug("browser_guest_connect_timeout", {
          url: this.opts.url,
          timeoutMs: connectTimeoutMs
        });
        const socket = this.socket;
        this.socket = null;
        try {
          socket?.close();
        } catch {
          // already closed
        }
        reject(new AgentClientError("bridge connect timed out", "connect_failed"));
      }, connectTimeoutMs);
      this.socket = this.deps.createSocket(this.opts.url, {
        onOpen: () => {
          this.socket?.send(
            encodeFrame(helloFrame(this.opts.token, { role: "agent", client: this.opts.label }))
          );
          // Resolve only once the broker replies `ready`.
        },
        onMessage: (data) => {
          const frame = decodeFrame(data);
          if (!frame) {
            return;
          }
          if (frame.type === "ready") {
            this.ready = true;
            this.deps.logger.trace("browser_guest_ready", { label: this.opts.label });
            for (const w of this.readyWaiters.splice(0)) {
              w();
            }
            if (!settled) {
              settled = true;
              clearTimeout(connectTimer);
              resolve();
            }
          } else if (frame.type === "result") {
            this.handleResult(frame);
          }
        },
        onClose: () => {
          this.ready = false;
          this.rejectAllPending(new AgentClientError("disconnected from bridge", "disconnected"));
          this.socket = null;
          if (!settled) {
            settled = true;
            clearTimeout(connectTimer);
            reject(new AgentClientError("bridge connection closed before ready", "connect_failed"));
          }
          if (!this.closed) {
            this.deps.onClose?.();
          }
        }
      });
    });
  }

  stop(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
    this.rejectAllPending(new AgentClientError("agent stopped", "stopped"));
  }

  release(): void {
    // Best-effort: ask the broker to release this agent's browsers.
    void this.send("release", "", {}).catch(() => {});
  }

  async send(
    action: BrowserAction,
    group: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    target?: string,
    timeoutMs?: number
  ): Promise<unknown> {
    if (signal?.aborted) {
      throw new AgentClientError("aborted", "aborted");
    }
    await this.waitReady(signal);
    const socket = this.socket;
    if (!socket) {
      throw new AgentClientError("not connected to the bridge", "disconnected");
    }
    const id = nextId();
    const frame: CommandFrame = {
      v: PROTOCOL_VERSION,
      type: "command",
      id,
      action,
      group,
      params,
      target,
      // Forward the override so the host broker applies (and clamps) it.
      timeoutMs
    };
    this.deps.logger.trace("browser_guest_command_send", { id, action, group, target });
    // Backstop only — let the broker's deadline fire first (it can cancel the
    // executor); fall back to the global timeout when no override is given.
    const requested = timeoutMs !== undefined ? timeoutMs : this.opts.timeoutMs;
    const localTimeout = requested > 0 ? requested + AGENT_TIMEOUT_GRACE_MS : 0;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        localTimeout > 0
          ? setTimeout(
              () =>
                this.settleReject(
                  id,
                  new AgentClientError(`command '${action}' timed out`, "timeout")
                ),
              localTimeout
            )
          : null;
      let detachAbort: (() => void) | null = null;
      if (signal) {
        const onAbort = () => this.settleReject(id, new AgentClientError("aborted", "aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(id, { resolve, reject, timer, detachAbort });
      try {
        socket.send(encodeFrame(frame));
      } catch (err) {
        this.settleReject(
          id,
          new AgentClientError(
            `failed to send '${action}': ${err instanceof Error ? err.message : String(err)}`,
            "send_failed"
          )
        );
      }
    });
  }

  private waitReady(signal?: AbortSignal): Promise<void> {
    if (this.ready) {
      return Promise.resolve();
    }
    if (this.closed || !this.socket) {
      return Promise.reject(new AgentClientError("not connected to the bridge", "disconnected"));
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new AgentClientError("aborted", "aborted"));
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.readyWaiters.push(() => {
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        resolve();
      });
    });
  }

  private handleResult(frame: {
    id: string;
    ok: boolean;
    data?: unknown;
    error?: { message: string; code?: string };
  }): void {
    const p = this.pending.get(frame.id);
    if (!p) {
      return;
    }
    this.deps.logger.trace("browser_guest_result_received", { id: frame.id, ok: frame.ok });
    this.clearPending(frame.id);
    if (frame.ok) {
      p.resolve(frame.data);
    } else {
      p.reject(new AgentClientError(frame.error?.message ?? "bridge error", frame.error?.code));
    }
  }

  private clearPending(id: string): void {
    const p = this.pending.get(id);
    if (!p) {
      return;
    }
    if (p.timer) {
      clearTimeout(p.timer);
    }
    p.detachAbort?.();
    this.pending.delete(id);
  }

  private settleReject(id: string, err: Error): void {
    const p = this.pending.get(id);
    if (!p) {
      return;
    }
    this.clearPending(id);
    p.reject(err);
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      if (p.timer) {
        clearTimeout(p.timer);
      }
      p.detachAbort?.();
      this.pending.delete(id);
      p.reject(err);
    }
  }
}
