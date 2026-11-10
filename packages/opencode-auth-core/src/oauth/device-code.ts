import type { Logger } from "../logging.js";
import type { TokenSet } from "../types.js";
import { toTokenSet } from "./client.js";
import {
  readResponseBodyPreview as readResponsePreviewShared,
  scrubSecrets
} from "./http-utils.js";
import { writeTerminalPrompt } from "../terminal-prompt.js";
import { generatePkcePair } from "./pkce.js";

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INCREMENT_SECONDS = 5;
const ERROR_BODY_PREVIEW_CHARS = 500;
// Cap on the polling interval itself, not on the number of retries. We never
// hard-stop on transient transport errors — a VPN flap or DNS hiccup mid-flow
// should not abort an in-progress device-code session. The `expires_in`
// deadline bounds the overall wait. The cap keeps the interval from growing
// without bound while we wait for transient conditions to clear.
const MAX_POLL_INTERVAL_SECONDS = 60;
// An IdP-supplied `expires_in` is untrusted input: a hostile or buggy one (1e9)
// would keep a poll loop, and a "waiting" dialog, alive for decades. RFC 8628
// codes live minutes; 30 is generous.
export const MAX_DEVICE_CODE_LIFETIME_SECONDS: number = 30 * 60;

/**
 * Whether `value` is safe to hand to a browser: `https:`, or `http:` only for a
 * loopback host (local IdPs and tests). Anything else (`javascript:`, `file:`,
 * `data:`, plain-http remote hosts) is refused.
 */
export function isSafeVerificationUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  if (url.protocol === "http:") {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  }
  return false;
}

export interface AcquireTokenViaDeviceCodeOptions {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  serverId: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
  /**
   * Send PKCE (`code_challenge` on the device-authorization request,
   * `code_verifier` on the token poll). Defaults to `true`. Set `false` only
   * for non-compliant IdPs that reject the extra parameters.
   */
  pkce?: boolean;
  /**
   * Sleep function used between polls. Overridable for tests.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Clock used to measure elapsed time. Overridable for tests.
   */
  now?: () => number;
  /**
   * Human-readable label for the stderr login prompt (e.g.
   * `"opencode-lightbridge"`). `auth-core` is shared across several plugins
   * (lightbridge, oauth2, repo-auth), so a hardcoded plugin name here would
   * misidentify the caller whenever a different plugin drives the flow.
   * Defaults to the neutral `"opencode"`.
   */
  serviceLabel?: string;
  /**
   * Cancels the whole flow: the device-authorization request, the sleeps and the
   * in-flight token requests. `poll(signal)` takes its own signal as well.
   */
  signal?: AbortSignal;
}

/** What a device-code flow shows the user: where to go and what to type. */
export interface DeviceCodeInfo {
  serverId: string;
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  /** Epoch milliseconds at which the code stops working. */
  expiresAt: number;
  /** Seconds the IdP gave the code to live. */
  expiresIn: number;
}

/**
 * An issued device code that has not been redeemed yet (RFC 8628 §3.2 done,
 * §3.4 pending). `poll` runs the token-endpoint loop until the user approves,
 * the code expires, or `signal` aborts; it is the ONLY thing that can turn the
 * code into tokens and it never persists them — the caller owns storage.
 */
export interface DeviceCodeFlow {
  info: DeviceCodeInfo;
  poll(signal?: AbortSignal): Promise<TokenSet>;
}

/** Thrown by {@link DeviceCodeFlow.poll} when its `signal` aborted. */
export class DeviceCodeAbortedError extends Error {
  constructor() {
    super("device-code sign-in was aborted");
    this.name = "AbortError";
  }
}

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface TokenErrorPayload {
  error?: string;
  error_description?: string;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readResponseBodyPreview(response: Response): Promise<string> {
  return readResponsePreviewShared(response, ERROR_BODY_PREVIEW_CHARS);
}

function parseDeviceAuthorizationResponse(payload: unknown): DeviceAuthorizationResponse {
  if (!payload || typeof payload !== "object") {
    throw new Error("device authorization response is not a JSON object");
  }

  const record = payload as Record<string, unknown>;
  const deviceCode = record.device_code;
  const userCode = record.user_code;
  const verificationUri = record.verification_uri;
  const expiresIn = record.expires_in;

  if (typeof deviceCode !== "string" || deviceCode.length === 0) {
    throw new Error("device authorization response is missing device_code");
  }
  if (typeof userCode !== "string" || userCode.length === 0) {
    throw new Error("device authorization response is missing user_code");
  }
  if (typeof verificationUri !== "string" || verificationUri.length === 0) {
    throw new Error("device authorization response is missing verification_uri");
  }
  if (!isSafeVerificationUrl(verificationUri)) {
    throw new Error("device authorization response has an unsafe verification_uri");
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("device authorization response is missing a valid expires_in");
  }

  // An unsafe `verification_uri_complete` is dropped, not fatal: the plain
  // `verification_uri` (validated above) is the fallback.
  const verificationUriComplete =
    typeof record.verification_uri_complete === "string" &&
    isSafeVerificationUrl(record.verification_uri_complete)
      ? record.verification_uri_complete
      : undefined;

  const interval =
    typeof record.interval === "number" && Number.isFinite(record.interval) && record.interval > 0
      ? Math.ceil(record.interval)
      : undefined;

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: verificationUriComplete,
    expires_in: Math.min(expiresIn, MAX_DEVICE_CODE_LIFETIME_SECONDS),
    interval
  };
}

/**
 * Step 1 of RFC 8628: ask the IdP for a device code and return the not-yet-
 * redeemed flow. Nothing is written to the terminal and nothing is polled until
 * the caller calls `poll`. Throws on a failed request or a malformed response
 * (missing `device_code` / `user_code` / `verification_uri` / `expires_in`).
 */
export async function beginDeviceCodeFlow(
  options: AcquireTokenViaDeviceCodeOptions
): Promise<DeviceCodeFlow> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const { logger, serverId } = options;

  // PKCE for the device flow (RFC 8628 + RFC 7636). Keycloak enforces this when
  // the client's "Proof Key for Code Exchange Code Challenge Method" is set, and
  // rejects the device-authorization request with
  // `invalid_request: Missing parameter: code_challenge_method` otherwise. On by
  // default — providers that don't require PKCE ignore it — and opt-out via the
  // `pkce` server option for non-compliant IdPs. Mirrors the authorization_code
  // flow.
  const usePkce = options.pkce !== false;
  const pkce = usePkce ? generatePkcePair() : undefined;

  const deviceAuthBody = new URLSearchParams({
    client_id: options.clientId,
    scope: options.scopes.join(" ")
  });

  if (pkce) {
    deviceAuthBody.set("code_challenge", pkce.challenge);
    deviceAuthBody.set("code_challenge_method", "S256");
  }

  if (options.clientSecret) {
    deviceAuthBody.set("client_secret", options.clientSecret);
  }

  const deviceAuthController = new AbortController();
  const deviceAuthTimeout = setTimeout(() => deviceAuthController.abort(), options.timeoutMs);
  const abortDeviceAuth = (): void => deviceAuthController.abort();
  if (options.signal?.aborted) {
    abortDeviceAuth();
  }
  options.signal?.addEventListener("abort", abortDeviceAuth, { once: true });

  let deviceAuthResponse: Response;
  try {
    deviceAuthResponse = await fetchImpl(options.deviceAuthorizationEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: deviceAuthBody,
      signal: deviceAuthController.signal
    });
  } finally {
    clearTimeout(deviceAuthTimeout);
    options.signal?.removeEventListener("abort", abortDeviceAuth);
  }

  if (!deviceAuthResponse.ok) {
    const preview = await readResponseBodyPreview(deviceAuthResponse);
    // Log the body separately at error-level so the logger's redaction filter
    // can scrub matching keys (e.g. a verbose provider echoing `client_secret`
    // back in the response). Never embed the body in error.message — callers
    // log error.message verbatim, bypassing the redaction filter.
    logger.error("oauth_device_authorization_failed", {
      serverId,
      status: deviceAuthResponse.status,
      bodyPreview: preview ? scrubSecrets(preview) : undefined
    });
    throw new Error(`device authorization request failed (${deviceAuthResponse.status})`);
  }

  const deviceAuthPayload = (await deviceAuthResponse.json()) as unknown;
  const deviceAuth = parseDeviceAuthorizationResponse(deviceAuthPayload);

  const verificationUri = deviceAuth.verification_uri_complete ?? deviceAuth.verification_uri;
  const deadlineMs = now() + deviceAuth.expires_in * 1000;

  // user_code is an ephemeral, single-use code with no value outside the active
  // flow — that is the spec's intent (RFC 8628). Log it so operators can see the
  // active code and forward it to the user if needed.
  logger.info("oauth_device_code_issued", {
    verificationUri,
    userCode: deviceAuth.user_code,
    expiresIn: deviceAuth.expires_in,
    serverId
  });

  const info: DeviceCodeInfo = {
    serverId,
    verificationUri: deviceAuth.verification_uri,
    verificationUriComplete: deviceAuth.verification_uri_complete,
    userCode: deviceAuth.user_code,
    expiresAt: deadlineMs,
    expiresIn: deviceAuth.expires_in
  };

  const poll = async (signal?: AbortSignal): Promise<TokenSet> => {
    const throwIfAborted = (): void => {
      if (signal?.aborted) {
        throw new DeviceCodeAbortedError();
      }
    };

    let intervalSeconds = deviceAuth.interval ?? DEFAULT_POLL_INTERVAL_SECONDS;
    let consecutiveTransientFailures = 0;

    while (true) {
      throwIfAborted();
      const remainingMs = deadlineMs - now();
      if (remainingMs <= 0) {
        throw new Error("device code expired before authorization completed");
      }

      await sleep(Math.min(intervalSeconds * 1000, remainingMs), signal);
      throwIfAborted();

      const pollBody = new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        device_code: deviceAuth.device_code,
        client_id: options.clientId
      });

      if (pkce) {
        pollBody.set("code_verifier", pkce.verifier);
      }

      if (options.clientSecret) {
        pollBody.set("client_secret", options.clientSecret);
      }

      const pollController = new AbortController();
      const pollTimeout = setTimeout(() => pollController.abort(), options.timeoutMs);
      const onAbort = (): void => pollController.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let pollResponse: Response;
      try {
        pollResponse = await fetchImpl(options.tokenEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json"
          },
          body: pollBody,
          signal: pollController.signal
        });
        // Reset the failure counter on any HTTP response — even a non-2xx one
        // is a sign the network round-trip is working; only thrown exceptions
        // (network errors, timeouts) count as transient failures.
        consecutiveTransientFailures = 0;
      } catch (error) {
        // An abort from the caller is final, not a transient fault.
        throwIfAborted();
        // TypeError from fetch typically means a programming/configuration
        // error (malformed URL, unsupported scheme) that won't resolve on
        // retry. Fail fast on those instead of burning the expires_in window.
        // Everything else (AbortError from timeout, network errors, DNS
        // failures) is treated as transient and triggers backoff per
        // RFC 8628 §3.5.
        if (error instanceof TypeError) {
          logger.error("oauth_device_code_poll_failed", {
            serverId,
            error: error.message
          });
          throw error;
        }
        consecutiveTransientFailures++;
        // Exponential backoff (capped) on transient transport errors. We do
        // NOT hard-stop: VPN flaps, transient DNS/TLS outages, and similar
        // short-lived disruptions are normal during a multi-minute device-code
        // window. The `expires_in` deadline at the top of the loop is the
        // sole termination condition.
        intervalSeconds = Math.min(
          intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS,
          MAX_POLL_INTERVAL_SECONDS
        );
        logger.warn("oauth_device_code_poll_transient_error", {
          serverId,
          error: error instanceof Error ? error.message : String(error),
          consecutiveFailures: consecutiveTransientFailures,
          nextIntervalSeconds: intervalSeconds
        });
        continue;
      } finally {
        clearTimeout(pollTimeout);
        signal?.removeEventListener("abort", onAbort);
      }

      throwIfAborted();

      if (pollResponse.ok) {
        const payload = (await pollResponse.json()) as Record<string, unknown>;
        const token = toTokenSet(payload, { requireRefreshToken: true });

        logger.info("oauth_device_code_success", {
          serverId,
          hasRefreshToken: true
        });

        return token;
      }

      if (pollResponse.status >= 400 && pollResponse.status < 500) {
        let errorPayload: TokenErrorPayload = {};
        const text = await readResponseBodyPreview(pollResponse);
        try {
          if (text.length > 0) {
            errorPayload = JSON.parse(text) as TokenErrorPayload;
          }
        } catch {
          // Body was not valid JSON; keep the raw preview for the error message.
        }

        const errorCode = errorPayload.error;

        if (errorCode === "authorization_pending") {
          continue;
        }

        if (errorCode === "slow_down") {
          intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
          continue;
        }

        if (errorCode === "expired_token") {
          throw new Error("device code expired before user completed authorization");
        }

        if (errorCode === "access_denied") {
          throw new Error("device code authorization denied by user");
        }

        logger.error("oauth_device_code_poll_failed", {
          serverId,
          status: pollResponse.status,
          errorCode: errorCode || undefined,
          // Body preview goes here, not into the thrown error.message — callers
          // log error.message verbatim and would bypass the logger's redaction.
          // scrubSecrets masks token-shaped substrings the field-name-based
          // logger redaction would otherwise miss.
          bodyPreview: text ? scrubSecrets(text) : undefined
        });
        throw new Error(
          `device code token poll failed (${pollResponse.status})${errorCode ? `: ${errorCode}` : ""}`
        );
      }

      // 5xx — surface to caller; do not retry indefinitely on server errors.
      const preview = await readResponseBodyPreview(pollResponse);
      logger.error("oauth_device_code_poll_failed", {
        serverId,
        status: pollResponse.status,
        bodyPreview: preview ? scrubSecrets(preview) : undefined
      });
      throw new Error(`device code token poll failed (${pollResponse.status})`);
    }
  };

  return { info, poll };
}

export async function acquireTokenViaDeviceCode(
  options: AcquireTokenViaDeviceCodeOptions
): Promise<TokenSet> {
  const { logger, serverId } = options;
  const flow = await beginDeviceCodeFlow(options);
  const { info } = flow;
  const verificationUri = info.verificationUriComplete ?? info.verificationUri;

  // Also surface to stderr so terminal users can see the code regardless of log
  // routing. This is the one deliberate carve-out from the suite's no-TUI-output
  // rule (ADR-0014): the login URL/code is required UX, not a diagnostic —
  // hiding it would make a first-time login look like a hang. The write is
  // guarded: under a v2 host stderr is a closed pipe, and a bare write there is
  // an EPIPE the host logs as an unhandled-rejection ERROR.
  const serviceLabel = options.serviceLabel ?? "opencode";
  writeTerminalPrompt(
    `\n[${serviceLabel}] device-code login for ${serverId}:\n  visit: ${verificationUri}\n  code:  ${info.userCode}\n  (expires in ${info.expiresIn}s)\n\n`,
    logger
  );

  return flow.poll();
}
