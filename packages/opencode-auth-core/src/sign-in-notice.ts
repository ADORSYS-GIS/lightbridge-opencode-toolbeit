import type { DeviceCodeInfo } from "./oauth/device-code.js";
import type { Logger } from "./logging.js";

/**
 * Plain-TS seam for "tell the user a sign-in is needed" (ADR-0021).
 *
 * `auth-core` and the sync engine never import the plugin API. They talk to a
 * `SignInReporter`; each plugin adapter supplies one that reaches the host's
 * `ctx.integration.connection.status` (see {@link createConnectionSignInReporter}).
 */
export interface SignInNotice {
  readonly serverId: string;
  /** Names the server; includes the user code while a device-code flow is in flight. */
  readonly message: string;
  /** The verification URL while a device-code flow is in flight; otherwise omitted. */
  readonly url?: string;
}

export interface SignInReporter {
  needsAuth(notice: SignInNotice): Promise<void> | void;
  clear(serverId: string): Promise<void> | void;
}

/** Upper bound on one reporter call, so a hung host effect cannot wedge later notices. */
const REPORTER_TIMEOUT_MS = 5_000;

/**
 * Drives a {@link SignInReporter} from login events. It is the one place that
 * decides WHEN a notice is raised or cleared, and it guarantees the notice
 * stays best-effort: a reporter that throws, rejects or hangs is logged at
 * `debug` and never reaches the caller (ADR-0021).
 *
 * Calls are serialised in arrival order, so a `clear` can never be overtaken by
 * the `needsAuth` it follows.
 */
export class SignInNotifier {
  private chain: Promise<void> = Promise.resolve();
  private readonly raised = new Set<string>();
  /** serverId -> epoch ms until which a device code issued for it is redeemable. */
  private readonly flows = new Map<string, number>();

  constructor(
    private readonly reporter: SignInReporter | undefined,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now
  ) {}

  /** Resolves once every queued reporter call has finished (tests, shutdown). */
  settled(): Promise<void> {
    return this.chain;
  }

  /**
   * Sign-in is needed and nothing is in flight (a non-interactive caller was
   * refused). Message-only. Skipped while a device code is still redeemable:
   * a periodic sync must not overwrite the notice that carries the code.
   */
  needsLogin(serverId: string, name: string): void {
    if (this.flowInFlight(serverId)) {
      return;
    }
    this.raise({
      serverId,
      message: `Sign-in required for ${name}. Send a message to a model of this provider to start sign-in.`
    });
  }

  deviceCodeIssued(serverId: string, name: string, info: DeviceCodeInfo): void {
    this.flows.set(serverId, info.expiresAt);
    const minutes = Math.max(1, Math.round((info.expiresAt - this.now()) / 60_000));
    this.raise({
      serverId,
      message: `Sign in to ${name}: open the link and enter code ${info.userCode} (expires in ${minutes} min).`,
      url: info.verificationUriComplete ?? info.verificationUri
    });
  }

  /** The code is dead: re-raise message-only so the notice never points at a dead URL. */
  deviceCodeExpired(serverId: string, name: string): void {
    this.flows.delete(serverId);
    this.raise({
      serverId,
      message: `The sign-in code for ${name} expired. Send a message to a model of this provider to start sign-in again.`
    });
  }

  /** A token was obtained or refreshed: clear a notice THIS notifier raised. */
  tokenObtained(serverId: string): void {
    this.flows.delete(serverId);
    if (!this.reporter || !this.raised.delete(serverId)) {
      return;
    }
    const reporter = this.reporter;
    this.enqueue("clear", serverId, () => reporter.clear(serverId));
  }

  /** The three auth-core hooks for one server, ready for `TokenRuntimeOptions`. */
  hooksFor(
    serverId: string,
    name: string
  ): {
    onDeviceCode: (info: DeviceCodeInfo) => void;
    onDeviceCodeExpired: () => void;
    onTokenObtained: () => void;
  } {
    return {
      onDeviceCode: (info) => this.deviceCodeIssued(serverId, name, info),
      onDeviceCodeExpired: () => this.deviceCodeExpired(serverId, name),
      onTokenObtained: () => this.tokenObtained(serverId)
    };
  }

  private flowInFlight(serverId: string): boolean {
    const expiresAt = this.flows.get(serverId);
    return expiresAt !== undefined && this.now() < expiresAt;
  }

  private raise(notice: SignInNotice): void {
    if (!this.reporter) {
      return;
    }
    this.raised.add(notice.serverId);
    const reporter = this.reporter;
    this.enqueue("needs_auth", notice.serverId, () => reporter.needsAuth(notice));
  }

  private enqueue(kind: string, serverId: string, call: () => Promise<void> | void): void {
    this.chain = this.chain.then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(call),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("sign-in reporter timed out")),
              REPORTER_TIMEOUT_MS
            );
          })
        ]);
      } catch (error) {
        // Never the notice text: it can carry the device user code.
        this.logger.debug("sign_in_notice_failed", {
          kind,
          serverId,
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    });
  }
}

/** The `Connection.Status` shape the host accepts (`@opencode/schema` `connection.d.ts`). */
export interface ConnectionNeedsAuthStatus {
  readonly status: "needs_auth";
  readonly message: string;
  readonly url?: string;
}

/**
 * What a plugin adapter must provide to reach the host. Every member is plain
 * Promise-based TS; the adapter wraps `ctx.integration` Effects with
 * `runInHost` (captured host context) on its side of the seam.
 */
export interface ConnectionStatusPort<Connection> {
  /** The host `integrationID` for a managed provider/server id, if one is known. */
  resolveIntegrationID(serverId: string): string | undefined;
  /** Extra fields for the one-time `debug` line explaining a missing integration. */
  diagnostics?(): Record<string, unknown>;
  /** `ctx.integration.connection.active(integrationID)`. */
  activeConnection(integrationID: string): Promise<Connection | undefined>;
  /** `ctx.integration.connection.status({ integrationID, connection, status })`. */
  setStatus(input: {
    integrationID: string;
    connection: Connection;
    status: ConnectionNeedsAuthStatus | undefined;
  }): Promise<void>;
}

/**
 * Reporter that annotates the host connection. "No integration means no
 * notice" (ADR-0021): when the id, the integration or its active connection is
 * missing, it logs ONCE per (server, reason) at `debug` and returns. Failures
 * of the port itself propagate to {@link SignInNotifier}, which contains them.
 */
export function createConnectionSignInReporter<Connection>(
  port: ConnectionStatusPort<Connection>,
  logger: Logger
): SignInReporter {
  const logged = new Set<string>();
  const skip = (serverId: string, reason: string, fields: Record<string, unknown> = {}): void => {
    const key = `${serverId}:${reason}`;
    if (logged.has(key)) {
      return;
    }
    logged.add(key);
    logger.debug("sign_in_notice_skipped", { serverId, reason, ...fields });
  };

  const locate = async (
    serverId: string
  ): Promise<{ integrationID: string; connection: Connection } | undefined> => {
    const integrationID = port.resolveIntegrationID(serverId);
    if (!integrationID) {
      skip(serverId, "no_integration", port.diagnostics?.() ?? {});
      return undefined;
    }
    const connection = await port.activeConnection(integrationID);
    if (connection === undefined) {
      skip(serverId, "no_connection", { integrationID });
      return undefined;
    }
    return { integrationID, connection };
  };

  return {
    async needsAuth(notice) {
      const found = await locate(notice.serverId);
      if (!found) {
        return;
      }
      await port.setStatus({
        ...found,
        status: {
          status: "needs_auth",
          message: notice.message,
          ...(notice.url ? { url: notice.url } : {})
        }
      });
    },
    async clear(serverId) {
      const found = await locate(serverId);
      if (!found) {
        return;
      }
      await port.setStatus({ ...found, status: undefined });
    }
  };
}

/**
 * Maps a managed provider/server id to the host's `integrationID`.
 *
 * Source of truth is the host-populated `Provider.Info.integrationID` seen in a
 * `provider.transform`; the integration list seen in an `integration.transform`
 * is the fallback for an integration whose id equals the server id. `alias`
 * ids let a plugin whose runtime id differs from the provider id (lightbridge's
 * `auth.id` vs. its gateway providers) borrow a sibling provider's integration.
 */
export class IntegrationIndex {
  private readonly byProvider = new Map<string, string>();
  private integrations = new Set<string>();

  noteProvider(providerId: string, integrationID: string | undefined): void {
    if (integrationID) {
      this.byProvider.set(providerId, integrationID);
    } else {
      this.byProvider.delete(providerId);
    }
  }

  noteIntegrations(ids: Iterable<string>): void {
    this.integrations = new Set(ids);
  }

  resolve(serverId: string, aliases: readonly string[] = []): string | undefined {
    for (const candidate of [serverId, ...aliases]) {
      const id = this.byProvider.get(candidate);
      if (id) {
        return id;
      }
    }
    return this.integrations.has(serverId) ? serverId : undefined;
  }

  /** For the `debug` line explaining why nothing matched. */
  knownIntegrationIds(): string[] {
    return [...this.integrations];
  }
}
