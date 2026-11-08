import { type AgentSocketFactory, AgentClient } from "./agent-client.js";
import { type AgentEndpoint, Broker } from "./broker.js";
import type { Logger } from "./logging.js";
import type { BrowserAction } from "./protocol.js";
import { type BridgeTransport, isAddrInUse } from "./transport.js";

export type EndpointMode = "host" | "guest" | "electing";

export interface EndpointOptions {
  host: string;
  port: number;
  token: string;
  executor?: "auto" | "cdp" | "content";
  timeoutMs: number;
  /** Ceiling for a per-command timeout override (host mode). */
  maxCommandMs?: number;
  /** Descriptor sent in the agent hello (guest mode). */
  label?: string;
  /** Delay before retrying election after a drop. */
  reelectMs?: number;
  /** Ceiling for the guest handshake (open -> `ready`); default 5000. Forwarded to `AgentClient`. */
  connectTimeoutMs?: number;
  /**
   * Fired whenever this endpoint becomes the host — on the initial election AND
   * on any later failover re-election. Use it for host-only side effects like
   * advertising the bridge token, so they recur on every host transition rather
   * than only once at startup.
   */
  onHost?: () => void;
  /**
   * Re-read the shared bridge token (host mode). The broker calls this on a
   * failed handshake so a rotated token in `bridge.json` reaches a long-lived
   * host without a restart — see `BrokerDeps.reloadToken`.
   */
  reloadToken?: () => string | undefined;
}

export interface EndpointDeps {
  logger: Logger;
  /** Server transport for host mode (Bun.serve / Node ws). */
  createServerTransport: () => BridgeTransport;
  /** Client socket factory for guest mode. */
  createAgentSocket: AgentSocketFactory;
  /** ws URL to dial as a guest; defaults to ws://host:port. */
  url?: string;
}

export interface Endpoint {
  send(
    action: BrowserAction,
    group: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    target?: string,
    timeoutMs?: number
  ): Promise<unknown>;
  release(): void;
  shutdown(): void;
  mode(): EndpointMode;
  /** The broker, when this endpoint is the host (else null) — for tests/extras. */
  broker(): Broker | null;
}

/**
 * Unifies host and guest: tries to **bind** the port (election) — on success it
 * hosts the broker and drives it via an in-process agent; on `EADDRINUSE` it
 * connects to the existing broker as a guest agent. Re-elects on drop. Tools
 * call `send()` and never know which mode they're in.
 */
export async function createEndpoint(opts: EndpointOptions, deps: EndpointDeps): Promise<Endpoint> {
  const url = deps.url ?? `ws://${opts.host}:${opts.port}`;
  const reelectMs = opts.reelectMs ?? 500;

  let mode: EndpointMode = "electing";
  let broker: Broker | null = null;
  let agentClient: AgentClient | null = null;
  let current: AgentEndpoint | null = null;
  let closed = false;
  let reelectTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReelect = (): void => {
    broker = null;
    agentClient = null;
    current = null;
    mode = "electing";
    if (closed || reelectTimer) {
      return;
    }
    reelectTimer = setTimeout(() => {
      reelectTimer = null;
      void elect();
    }, reelectMs);
  };

  async function elect(): Promise<void> {
    if (closed) {
      return;
    }
    mode = "electing";
    deps.logger.trace("browser_election_start", { host: opts.host, port: opts.port });

    // 1) Try to host (win the bind). Everything is inside the try so a transport
    // that throws at construction (or a Broker that fails to start) degrades to
    // guest instead of crashing the plugin load.
    let candidate: Broker | null = null;
    try {
      deps.logger.trace("browser_bind_attempt", { host: opts.host, port: opts.port });
      const transport = deps.createServerTransport();
      candidate = new Broker(
        {
          host: opts.host,
          port: opts.port,
          token: opts.token,
          executor: opts.executor,
          timeoutMs: opts.timeoutMs,
          maxCommandMs: opts.maxCommandMs
        },
        { logger: deps.logger, transport, reloadToken: opts.reloadToken }
      );
      await candidate.start();
      broker = candidate;
      current = candidate.createLocalAgent();
      mode = "host";
      deps.logger.trace("browser_bind_won", { host: opts.host, port: opts.port });
      deps.logger.info("browser_endpoint_mode", { mode: "host" });
      // Isolate the side-effect callback: a throw here must NOT reach the outer
      // catch, which would stop the freshly-started broker and degrade to guest.
      try {
        opts.onHost?.();
      } catch (onHostErr) {
        deps.logger.error("browser_endpoint_onhost_error", {
          message: onHostErr instanceof Error ? onHostErr.message : String(onHostErr)
        });
      }
      return;
    } catch (err) {
      try {
        candidate?.stop();
      } catch {
        /* never bound */
      }
      deps.logger.trace("browser_bind_lost", { addrInUse: isAddrInUse(err) });
      if (!isAddrInUse(err)) {
        deps.logger.warn("browser_endpoint_bind_error", {
          message: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // 2) Someone else hosts — join as a guest.
    deps.logger.trace("browser_guest_connect_attempt", { url });
    const client = new AgentClient(
      {
        url,
        token: opts.token,
        label: opts.label,
        timeoutMs: opts.timeoutMs,
        connectTimeoutMs: opts.connectTimeoutMs
      },
      {
        logger: deps.logger,
        createSocket: deps.createAgentSocket,
        onClose: () => {
          if (!closed) {
            scheduleReelect();
          }
        }
      }
    );
    try {
      await client.connect();
      agentClient = client;
      current = client;
      mode = "guest";
      // Guest election is routine and happens once per plugin load (every
      // session) — keep it at debug so it doesn't dominate the log stream.
      deps.logger.debug("browser_endpoint_mode", { mode: "guest" });
    } catch {
      scheduleReelect();
    }
  }

  await elect();

  return {
    send: (action, group, params, signal, target, timeoutMs) =>
      current
        ? current.send(action, group, params, signal, target, timeoutMs)
        : Promise.reject(new Error("bridge is re-electing — retry shortly")),
    release: () => current?.release(),
    shutdown: () => {
      closed = true;
      if (reelectTimer) {
        clearTimeout(reelectTimer);
        reelectTimer = null;
      }
      try {
        broker?.stop();
      } catch {
        /* ignore */
      }
      try {
        agentClient?.stop();
      } catch {
        /* ignore */
      }
    },
    mode: () => mode,
    broker: () => broker
  };
}
