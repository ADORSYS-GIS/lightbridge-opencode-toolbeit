import type { Credential, Integration, Plugin } from "@opencode/plugin/effect";
import type { TokenSet } from "@vymalo/opencode-auth-core/lib";
import { Effect } from "effect";

import type { Logger } from "./logging.js";
import type { LightbridgeRuntimeLike } from "./plugin.js";

type IntegrationEditor = Parameters<Parameters<Plugin.Context["integration"]["transform"]>[0]>[0];

/** The host's oauth-method registration shape (the package does not export it by name). */
export type IntegrationOAuthMethodRegistration = Extract<
  Parameters<IntegrationEditor["method"]["update"]>[0],
  { method: { type: "oauth" } }
>;

/** Id of the one sign-in method lightbridge registers on its integration (ADR-0023). */
export const SIGN_IN_METHOD_ID = "device";

/** Label of the button the host renders for that method. */
export const SIGN_IN_METHOD_LABEL = "Sign in";

/** Fallback lifetime for a token the IdP gave no `expires_in` for. */
const FALLBACK_LIFETIME_MS = 60 * 60 * 1000;

const MAX_LABEL_CHARS = 80;

/** The exact path a user follows to sign in, for the `lightbridge_sign_in_required` hint. */
export function signInPath(name: string): string {
  return `Settings → Providers → Show more providers → ${name} → Sign in`;
}

/**
 * Display-only account label (email / username) read from the access token's
 * claims. Deliberately UNVERIFIED: nothing security-relevant ever reads it, it
 * only decorates the host's connection row. Opaque (non-JWT) tokens and any
 * decoding problem yield `undefined`.
 */
export function accountLabel(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !parts[1]) {
    return undefined;
  }
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    for (const key of ["email", "preferred_username"]) {
      const value = claims[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim().slice(0, MAX_LABEL_CHARS);
      }
    }
  } catch {
    // Not a decodable JWT: no label.
  }
  return undefined;
}

/**
 * The host-side projection of our token: a "connected" marker plus the current
 * access token. CUSTODY RULE (ADR-0023): `refresh` is ALWAYS `""` — the refresh
 * token never leaves lightbridge's own state file, so a host credential-store
 * leak or a host-driven refresh cannot replay (and thereby rotate away) it.
 */
export function projectCredential(token: TokenSet, now: number = Date.now()): Credential.OAuth {
  const label = accountLabel(token.accessToken);
  return {
    type: "oauth",
    methodID: SIGN_IN_METHOD_ID as Integration.MethodID,
    access: token.accessToken,
    refresh: "",
    expires: Math.floor(token.expiresAt ?? now + FALLBACK_LIFETIME_MS),
    ...(label ? { metadata: { label } } : {})
  };
}

export interface SignInDependencies {
  integrationID: string;
  runtime: LightbridgeRuntimeLike;
  logger: Logger;
  /**
   * Runs after a successful sign-in (kick the model sync, reload the host's
   * providers). Best effort: it must not throw, and a failure never fails the
   * sign-in itself — this wrapper additionally swallows anything that escapes.
   */
  afterSignIn: () => Promise<void>;
}

/**
 * The oauth method registration behind the host's "Connect" dialog (ADR-0023).
 * `authorize` requests a device code and hands the host the URL + code to show;
 * `callback` awaits the user's approval (interruptible: the host closing the
 * dialog interrupts it, which aborts the polling) and returns the projection.
 */
export function createSignInRegistration(
  deps: SignInDependencies
): IntegrationOAuthMethodRegistration {
  const { integrationID, runtime, logger } = deps;
  return {
    integrationID,
    method: { id: SIGN_IN_METHOD_ID, type: "oauth", label: SIGN_IN_METHOD_LABEL },
    authorize: () =>
      Effect.tryPromise({
        try: () => runtime.beginDeviceSignIn(),
        catch: (error) => error
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => logger.error("lightbridge_sign_in_begin_failed", errorFields(error)))
        ),
        Effect.map((session) => ({
          url: session.verificationUriComplete ?? session.verificationUri,
          instructions: `Confirm the code ${session.userCode} on the page that opens, then approve the request.`,
          expiresAt: session.expiresAt,
          mode: "auto" as const,
          callback: Effect.tryPromise({
            try: (signal: AbortSignal) => session.complete(signal),
            catch: (error) => error
          }).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => logger.warn("lightbridge_sign_in_failed", errorFields(error)))
            ),
            Effect.tap(() =>
              Effect.promise(async () => {
                try {
                  await deps.afterSignIn();
                } catch (error) {
                  logger.warn("lightbridge_sign_in_followup_failed", errorFields(error));
                }
              })
            ),
            Effect.map((token) => {
              logger.info("lightbridge_sign_in_completed", { integrationID });
              return projectCredential(token);
            })
          )
        }))
      ),
    // The host calls this only within 5 minutes of `expires`. Whatever it holds is
    // ignored (it has no refresh token): the truth is our own runtime, refreshed
    // non-interactively. A revoked/cleared root fails here — it never starts a flow.
    refresh: () =>
      Effect.tryPromise({
        try: () => runtime.ensureRootToken(),
        catch: (error) => error
      }).pipe(Effect.map((token) => projectCredential(token))),
    label: (credential) => {
      const label = credential.metadata?.label;
      return typeof label === "string" ? label : undefined;
    }
  };
}

function errorFields(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}

/**
 * Emit `lightbridge_sign_in_required` at most once per plugin instance, naming
 * the exact path to sign in. Every non-interactive caller that finds no usable
 * token (startup check, gateway header, OTEL token source, the register sync)
 * reports through this one latch.
 */
export function createSignInRequiredNotifier(
  logger: Logger,
  name: string
): (source: string) => void {
  let notified = false;
  return (source) => {
    if (notified) {
      return;
    }
    notified = true;
    logger.warn("lightbridge_sign_in_required", {
      source,
      message: `lightbridge is not signed in: open ${signInPath(name)}`
    });
  };
}
