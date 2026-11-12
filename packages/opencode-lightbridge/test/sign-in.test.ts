import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  InteractiveAuthRequiredError,
  validateAuthConfig,
  type DeviceSignIn,
  type TokenSet
} from "@vymalo/opencode-auth-core/lib";
import type { TokenSource } from "@vymalo/opencode-core-otel";
import { ServerCredentialStore } from "@vymalo/opencode-provider-sync/lib";

import {
  LightbridgeRuntime,
  lightbridgeStateDir,
  rootStateDir,
  type LightbridgeRuntimeLike
} from "../src/plugin.js";
import {
  accountLabel,
  HOST_REFRESH_WINDOW_MS,
  createSignInRegistration,
  createSignInRequiredNotifier,
  signInCommand,
  projectCredential,
  signInPath
} from "../src/sign-in.js";
import { startPlugin } from "./harness.js";
import {
  createRecordingLogger,
  createSilentLogger,
  makeAuth,
  makeJsonResponse
} from "./helpers.js";

const AUTH = makeAuth();
const DEVICE_URL = AUTH.deviceAuthorizationEndpoint as string;
const TOKEN_URL = AUTH.tokenEndpoint as string;
const SERVER_ID = AUTH.id;

function deviceBody(overrides: Record<string, unknown> = {}): Response {
  return makeJsonResponse({
    device_code: "dev-code",
    user_code: "ABCD-EFGH",
    verification_uri: "https://idp.example.com/activate",
    verification_uri_complete: "https://idp.example.com/activate?user_code=ABCD-EFGH",
    expires_in: 600,
    interval: 1,
    ...overrides
  });
}

function approved(): Response {
  return makeJsonResponse({
    access_token: "access-1",
    refresh_token: "SECRET-REFRESH-TOKEN",
    token_type: "Bearer",
    expires_in: 3600
  });
}

function pending(): Response {
  return makeJsonResponse({ error: "authorization_pending" }, 400);
}

interface Net {
  urls: string[];
  fetchImpl: typeof fetch;
}

function makeNet(handlers: {
  device?: () => Response;
  token?: () => Response;
  other?: (url: string) => Response;
}): Net {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === DEVICE_URL) {
      return (handlers.device ?? (() => makeJsonResponse({}, 500)))();
    }
    if (url === TOKEN_URL) {
      return (handlers.token ?? (() => makeJsonResponse({}, 500)))();
    }
    return (handlers.other ?? (() => makeJsonResponse({ data: [] })))(url);
  }) as typeof fetch;
  return { urls, fetchImpl };
}

async function makeRuntime(net: Net) {
  const stateDir = await mkdtemp(join(tmpdir(), "lightbridge-signin-"));
  const runtime = new LightbridgeRuntime(validateAuthConfig(AUTH), undefined, {
    logger: createSilentLogger(),
    stateDir,
    fetchImpl: net.fetchImpl
  });
  return { runtime, stateDir };
}

function readCredential(stateDir: string) {
  return new ServerCredentialStore(rootStateDir(stateDir)).load(SERVER_ID);
}

async function authorize(registration: ReturnType<typeof createSignInRegistration>) {
  const result = await Effect.runPromise(Effect.scoped(registration.authorize({} as never)));
  if (result.mode !== "auto") {
    throw new Error("expected an auto-mode authorization");
  }
  return result;
}

function fakeRuntime(token: TokenSet, overrides: Partial<LightbridgeRuntimeLike> = {}) {
  const session: DeviceSignIn = {
    serverId: SERVER_ID,
    verificationUri: "https://idp.example.com/activate",
    verificationUriComplete: "https://idp.example.com/activate?user_code=ABCD-EFGH",
    userCode: "ABCD-EFGH",
    expiresAt: Date.now() + 600_000,
    expiresIn: 600,
    complete: async () => token
  };
  const runtime: LightbridgeRuntimeLike = {
    getProjectToken: async () => token,
    ensureRootToken: async () => token,
    beginDeviceSignIn: async () => session,
    reset: async () => {},
    ...overrides
  };
  return runtime;
}

describe("sign-in registration — custody (refresh token never leaves our state file)", () => {
  const token: TokenSet = {
    accessToken: "access-1",
    tokenType: "Bearer",
    refreshToken: "SECRET-REFRESH-TOKEN",
    expiresAt: Date.now() + 3_600_000
  };

  it('the callback\'s credential carries refresh: "" and the refresh token appears nowhere', async () => {
    const registration = createSignInRegistration({
      integrationID: SERVER_ID,
      runtime: fakeRuntime(token),
      logger: createSilentLogger(),
      afterSignIn: async () => {}
    });

    const authorization = await authorize(registration);
    const credential = await Effect.runPromise(authorization.callback);

    expect(credential.refresh).toBe("");
    expect(credential.access).toBe("access-1");
    expect(credential.methodID).toBe("device");
    expect(JSON.stringify(credential)).not.toContain("SECRET-REFRESH-TOKEN");
  });

  it('the host-driven refresh handler returns the same projection, refresh: ""', async () => {
    const registration = createSignInRegistration({
      integrationID: SERVER_ID,
      runtime: fakeRuntime(token),
      logger: createSilentLogger(),
      afterSignIn: async () => {}
    });

    const refreshed = await Effect.runPromise(
      registration.refresh?.({ ...projectCredential(token), refresh: "ignored" }) as Effect.Effect<
        ReturnType<typeof projectCredential>
      >
    );

    expect(refreshed.refresh).toBe("");
    expect(JSON.stringify(refreshed)).not.toContain("SECRET-REFRESH-TOKEN");
  });

  it("shows the code and the verification URL the host opens", async () => {
    const registration = createSignInRegistration({
      integrationID: SERVER_ID,
      runtime: fakeRuntime(token),
      logger: createSilentLogger(),
      afterSignIn: async () => {}
    });

    const authorization = await authorize(registration);

    expect(authorization.url).toBe("https://idp.example.com/activate?user_code=ABCD-EFGH");
    expect(authorization.instructions).toContain("ABCD-EFGH");
    expect(registration.method).toMatchObject({ id: "device", type: "oauth", label: "Sign in" });
  });

  it("a failing follow-up (sync / reload) never fails the sign-in", async () => {
    const logger = createRecordingLogger();
    const events = logger.events;
    const registration = createSignInRegistration({
      integrationID: SERVER_ID,
      runtime: fakeRuntime(token),
      logger,
      afterSignIn: async () => {
        throw new Error("reload exploded");
      }
    });

    const credential = await Effect.runPromise((await authorize(registration)).callback);

    expect(credential.access).toBe("access-1");
    expect(events.map((event) => event.event)).toContain("lightbridge_sign_in_followup_failed");
  });

  it("labels the connection from unverified claims, display-only", () => {
    const claims = Buffer.from(JSON.stringify({ email: "ada@example.com" })).toString("base64url");
    expect(accountLabel(`h.${claims}.s`)).toBe("ada@example.com");
    expect(accountLabel("opaque-token")).toBeUndefined();
    expect(accountLabel("a.!!!.c")).toBeUndefined();
  });
});

describe("sign-in registration — against the real runtime", () => {
  it("stores the approved token ONLY in the shared credential file and projects a marker", async () => {
    let polls = 0;
    const net = makeNet({
      device: () => deviceBody(),
      token: () => (++polls < 2 ? pending() : approved())
    });
    const { runtime, stateDir } = await makeRuntime(net);
    const registration = createSignInRegistration({
      integrationID: SERVER_ID,
      runtime,
      logger: createSilentLogger(),
      afterSignIn: async () => {}
    });

    const credential = await Effect.runPromise((await authorize(registration)).callback);

    expect(credential.refresh).toBe("");
    const stored = await readCredential(stateDir);
    expect(stored?.token.refreshToken).toBe("SECRET-REFRESH-TOKEN");
    expect(stored?.token.accessToken).toBe("access-1");
    // The exchange store (the only other credential directory) was not written.
    const { readdir } = await import("node:fs/promises");
    const exchangeFiles = await readdir(lightbridgeStateDir(stateDir)).catch(() => []);
    expect(exchangeFiles.filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("interrupting the callback aborts the polling and stores nothing", async () => {
    // The IdP WOULD approve on the first poll: a missing abort stores a token.
    const net = makeNet({ device: () => deviceBody({ interval: 1 }), token: approved });
    const { runtime, stateDir } = await makeRuntime(net);
    const logger = createRecordingLogger();
    const registration = createSignInRegistration({
      integrationID: SERVER_ID,
      runtime,
      logger,
      afterSignIn: async () => {}
    });
    const authorization = await authorize(registration);

    const controller = new AbortController();
    const running = Effect.runPromiseExit(authorization.callback, { signal: controller.signal });
    controller.abort();
    const exit = await running;
    // Outlive the 1s poll interval: a leaked poller would hit the token endpoint now.
    await new Promise((resolve) => setTimeout(resolve, 1_300));

    expect(exit._tag).toBe("Failure");
    expect(net.urls).toEqual([DEVICE_URL]);
    expect(await readCredential(stateDir)).toBeUndefined();
    expect(logger.events.map((e) => e.event)).toContain("lightbridge_sign_in_cancelled");
  });

  it("a malformed device response fails authorize cleanly, polling nothing", async () => {
    const net = makeNet({ device: () => deviceBody({ user_code: undefined }) });
    const { runtime, stateDir } = await makeRuntime(net);
    const logger = createRecordingLogger();
    const events = logger.events;
    const registration = createSignInRegistration({
      integrationID: SERVER_ID,
      runtime,
      logger,
      afterSignIn: async () => {}
    });

    await expect(authorize(registration)).rejects.toThrow(/user_code/);

    expect(net.urls).toEqual([DEVICE_URL]);
    expect(await readCredential(stateDir)).toBeUndefined();
    expect(events.map((event) => event.event)).toContain("lightbridge_sign_in_begin_failed");
  });

  it("an exhausted expires_in fails the callback and stores nothing", async () => {
    const net = makeNet({
      device: () => deviceBody({ expires_in: 1, interval: 1 }),
      token: pending
    });
    const { runtime, stateDir } = await makeRuntime(net);
    const registration = createSignInRegistration({
      integrationID: SERVER_ID,
      runtime,
      logger: createSilentLogger(),
      afterSignIn: async () => {}
    });
    const authorization = await authorize(registration);

    await expect(Effect.runPromise(authorization.callback)).rejects.toThrow(/expired/);

    expect(await readCredential(stateDir)).toBeUndefined();
    expect(net.urls.length).toBeLessThanOrEqual(3);
  });

  it("the host refresh after the root was revoked fails and never starts a device flow", async () => {
    const net = makeNet({
      // The IdP revokes the chain: a refresh is refused with invalid_grant.
      token: () => makeJsonResponse({ error: "invalid_grant" }, 400),
      device: () => deviceBody()
    });
    const { runtime, stateDir } = await makeRuntime(net);
    const store = new ServerCredentialStore(rootStateDir(stateDir));
    await store.ensureReady();
    await store.save(
      SERVER_ID,
      {
        accessToken: "old",
        tokenType: "Bearer",
        refreshToken: "revoked-refresh",
        expiresAt: Date.now() - 1_000
      },
      Date.now()
    );
    const required: string[] = [];
    const registration = createSignInRegistration({
      integrationID: SERVER_ID,
      runtime,
      logger: createSilentLogger(),
      afterSignIn: async () => {},
      onSignInRequired: (source) => required.push(source)
    });
    const stale = projectCredential({ accessToken: "old", tokenType: "Bearer" });

    await expect(
      Effect.runPromise(registration.refresh?.(stale) as Effect.Effect<unknown>)
    ).rejects.toThrow();
    // Cleared by the 400, so the second attempt needs no network at all.
    const requestsAfterFirst = net.urls.length;
    await expect(
      Effect.runPromise(registration.refresh?.(stale) as Effect.Effect<unknown>)
    ).rejects.toThrow();

    expect(net.urls).not.toContain(DEVICE_URL);
    expect(net.urls.length).toBe(requestsAfterFirst);
    expect(required).toEqual(["refresh", "refresh"]);
  });
});

describe("sign-in registration — hardening", () => {
  const token: TokenSet = {
    accessToken: "access-1",
    tokenType: "Bearer",
    refreshToken: "SECRET-REFRESH-TOKEN",
    expiresAt: Date.now() + 3_600_000
  };

  it("expires is epoch milliseconds, not seconds", () => {
    const credential = projectCredential(token);

    expect(credential.expires).toBe(token.expiresAt);
    expect(credential.expires).toBeGreaterThan(1e12);
  });

  it("the projection is returned BEFORE the detached follow-up finishes", async () => {
    let release: () => void = () => {};
    let started = false;
    const registration = createSignInRegistration({
      integrationID: SERVER_ID,
      runtime: fakeRuntime(token),
      logger: createSilentLogger(),
      afterSignIn: () =>
        new Promise<void>((resolve) => {
          started = true;
          release = resolve;
        })
    });

    const credential = await Effect.runPromise((await authorize(registration)).callback);

    expect(credential.access).toBe("access-1");
    expect(started).toBe(true);
    release();
  });

  it("re-arms the sign-in notice on success", async () => {
    const onSignedIn = vi.fn();
    const registration = createSignInRegistration({
      integrationID: SERVER_ID,
      runtime: fakeRuntime(token),
      logger: createSilentLogger(),
      afterSignIn: async () => {},
      onSignedIn
    });

    await Effect.runPromise((await authorize(registration)).callback);

    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it("hands authorize's own abort signal to beginDeviceSignIn", async () => {
    let seen: AbortSignal | undefined;
    const registration = createSignInRegistration({
      integrationID: SERVER_ID,
      runtime: fakeRuntime(token, {
        beginDeviceSignIn: (signal?: AbortSignal) =>
          new Promise<DeviceSignIn>((_resolve, reject) => {
            seen = signal;
            signal?.addEventListener("abort", () => reject(new Error("aborted")));
          })
      }),
      logger: createSilentLogger(),
      afterSignIn: async () => {}
    });

    const controller = new AbortController();
    const running = Effect.runPromiseExit(Effect.scoped(registration.authorize({} as never)), {
      signal: controller.signal
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const exit = await running;

    expect(exit._tag).toBe("Failure");
    expect(seen).toBeDefined();
    expect(seen?.aborted).toBe(true);
  });

  it("never hands the host an unsafe URL: falls back, or fails authorize", async () => {
    const fallback = await makeRuntime(
      makeNet({ device: () => deviceBody({ verification_uri_complete: "javascript:alert(1)" }) })
    );
    const ok = await authorize(
      createSignInRegistration({
        integrationID: SERVER_ID,
        runtime: fallback.runtime,
        logger: createSilentLogger(),
        afterSignIn: async () => {}
      })
    );
    expect(ok.url).toBe("https://idp.example.com/activate");

    for (const uri of ["javascript:alert(1)", "http://idp.example.com/activate"]) {
      const bad = await makeRuntime(
        makeNet({ device: () => deviceBody({ verification_uri: uri }) })
      );
      await expect(
        authorize(
          createSignInRegistration({
            integrationID: SERVER_ID,
            runtime: bad.runtime,
            logger: createSilentLogger(),
            afterSignIn: async () => {}
          })
        )
      ).rejects.toThrow(/unsafe verification_uri/);
    }
  });

  it("clamps the expiry shown to the host to 30 minutes", async () => {
    const { runtime } = await makeRuntime(
      makeNet({ device: () => deviceBody({ expires_in: 1e9 }) })
    );

    const authorization = await authorize(
      createSignInRegistration({
        integrationID: SERVER_ID,
        runtime,
        logger: createSilentLogger(),
        afterSignIn: async () => {}
      })
    );

    expect((authorization.expiresAt ?? 0) - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  describe("host refresh handler", () => {
    async function seeded(minutesLeft: number, tokenHandler: () => Response) {
      const net = makeNet({ token: tokenHandler });
      const { runtime, stateDir } = await makeRuntime(net);
      const store = new ServerCredentialStore(rootStateDir(stateDir));
      await store.ensureReady();
      await store.save(
        SERVER_ID,
        {
          accessToken: "old",
          tokenType: "Bearer",
          refreshToken: "r1",
          expiresAt: Date.now() + minutesLeft * 60_000
        },
        Date.now()
      );
      const logger = createRecordingLogger();
      const registration = createSignInRegistration({
        integrationID: SERVER_ID,
        runtime,
        logger,
        afterSignIn: async () => {}
      });
      const refresh = () =>
        Effect.runPromise(
          registration.refresh?.(
            projectCredential({ accessToken: "old", tokenType: "Bearer" })
          ) as Effect.Effect<ReturnType<typeof projectCredential>>
        );
      return { net, stateDir, store, logger, refresh };
    }

    const refreshedBody = () =>
      makeJsonResponse({
        access_token: "refreshed",
        refresh_token: "r2",
        token_type: "Bearer",
        expires_in: 3600
      });

    it("inside the host's 5-minute window it forces a real refresh through the single writer", async () => {
      // 3 minutes left: valid under our 30s skew, but inside the host's window.
      const h = await seeded(3, refreshedBody);

      const credential = await h.refresh();

      expect(credential.access).toBe("refreshed");
      expect(credential.refresh).toBe("");
      expect((await h.store.load(SERVER_ID))?.token.refreshToken).toBe("r2");
      expect(h.net.urls).toEqual([TOKEN_URL]);
    });

    it("outside the window it serves the stored token with no network", async () => {
      const h = await seeded(HOST_REFRESH_WINDOW_MS / 60_000 + 5, refreshedBody);

      const credential = await h.refresh();

      expect(credential.access).toBe("old");
      expect(h.net.urls).toEqual([]);
    });

    it("logs when the forced refresh did not produce a fresh token", async () => {
      const h = await seeded(3, () => makeJsonResponse({ error: "server_error" }, 500));

      await h.refresh();

      expect(h.logger.events.map((e) => e.event)).toContain("lightbridge_sign_in_refresh_failed");
    });
  });
});

describe("hard cutover — nothing but the Connect dialog starts a device flow", () => {
  async function startSignedOut(register: boolean, exchange: boolean) {
    const net = makeNet({});
    const logger = createRecordingLogger();
    const events = logger.events;
    const stateDir = await mkdtemp(join(tmpdir(), "lightbridge-cutover-state-"));
    const cacheDir = await mkdtemp(join(tmpdir(), "lightbridge-cutover-cache-"));
    let tokenSource: TokenSource | undefined;
    const harness = await startPlugin({
      options: {
        auth: AUTH,
        gateway: { providers: ["gateway"], exchange },
        otel: { endpoint: "http://localhost:4318" },
        ...(register
          ? { register: { baseURL: "https://gw.example.com/v1", syncIntervalMinutes: 0.002 } }
          : {})
      },
      sources: register ? [{ id: SERVER_ID }] : [],
      factory: {
        logger,
        fetchImpl: net.fetchImpl,
        stateDir,
        cacheDir,
        deferredTimeoutMs: 5,
        exporters: {
          trace: (_config, source) => {
            tokenSource = source;
            return new InMemorySpanExporter();
          },
          log: () => new InMemoryLogRecordExporter(),
          metric: () => undefined
        }
      }
    });
    return { net, events, harness, tokenSource: () => tokenSource };
  }

  const warns = (events: Array<{ level: string; event: string }>) =>
    events.filter((e) => e.level === "warn" && e.event === "lightbridge_sign_in_required");
  const seenSources = (events: Array<{ event: string; fields?: unknown }>) =>
    new Set(
      events
        .filter((e) => e.event === "lightbridge_sign_in_required_seen")
        .map((e) => (e.fields as { source: string }).source)
    );

  it.each([false, true])(
    "signed out (gateway.exchange=%s): startup, register sync (warmup + scheduled), gateway header and otel never hit the device endpoint",
    async (exchange) => {
      const { net, events, harness, tokenSource } = await startSignedOut(true, exchange);
      harness.runTransform();
      await harness.settle();

      // gateway header: fails closed, no device flow
      await expect(
        harness.call("session.model.request", {
          model: { id: "m", providerID: "gateway" },
          headers: {}
        })
      ).rejects.toThrow();
      // otel export credential: degrades to "skip the export"
      await expect(tokenSource()?.headers()).resolves.toBeUndefined();
      // let the register engine's scheduled sync (~120ms) fire a few times
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(net.urls).not.toContain(DEVICE_URL);
      expect(net.urls).toEqual([]);
      const notices = warns(events);
      expect(notices).toHaveLength(1);
      expect(String((notices[0]?.fields as { message?: string } | undefined)?.message)).toContain(
        signInPath("lightbridge")
      );
      // The command carries the integration id wired from `auth.id`.
      expect((notices[0]?.fields as { command?: string } | undefined)?.command).toBe(
        `opencode auth login ${SERVER_ID}`
      );
      // Every non-interactive caller reported through the one latch.
      expect(seenSources(events)).toEqual(new Set(["startup", "register", "gateway", "otel"]));
    }
  );

  it("the sign-in notice is latched, and re-arms on reset", () => {
    const logger = createRecordingLogger();
    const events = logger.events;
    const notice = createSignInRequiredNotifier(logger, "Camer Digital", "camer-digital");

    notice.notify("gateway");
    notice.notify("otel");
    notice.notify("startup");
    expect(warns(events)).toHaveLength(1);
    expect(
      String(
        (
          events.find((e) => e.event === "lightbridge_sign_in_required")?.fields as
            | { message?: string }
            | undefined
        )?.message
      )
    ).toContain(
      'Settings → Providers → Show more providers → (Integrations dialog) search "Camer Digital" → Sign in'
    );

    notice.reset();
    notice.notify("gateway");
    expect(warns(events)).toHaveLength(2);
  });

  it("the sign-in warning names the terminal command with the real id, not the display name", () => {
    const logger = createRecordingLogger();
    createSignInRequiredNotifier(logger, "Camer Digital", "camer-digital").notify("startup");
    const fields = logger.events.find((e) => e.event === "lightbridge_sign_in_required")
      ?.fields as { message: string; command: string };
    expect(fields.command).toBe("opencode auth login camer-digital");
    expect(fields.message).toBe(
      'lightbridge is not signed in: open Settings → Providers → Show more providers → (Integrations dialog) search "Camer Digital" → Sign in, or in a terminal run `opencode auth login camer-digital`'
    );
  });

  it("signInCommand leaves plain ids bare", () => {
    expect(signInCommand("camer-digital")).toBe("opencode auth login camer-digital");
    expect(signInCommand("corp_1.eu@prod")).toBe("opencode auth login corp_1.eu@prod");
  });

  it.each([
    ["my corp", "'my corp'"],
    ["it's", "'it'\\''s'"],
    ["a'b'c", "'a'\\''b'\\''c'"],
    ['a"b$c', "'a\"b$c'"],
    ["a$(x)", "'a$(x)'"],
    ["a$HOME", "'a$HOME'"],
    ["a`b", "'a`b'"],
    ["a;b", "'a;b'"],
    ["-x", "'-x'"],
    [".hidden", "'.hidden'"],
    ["caf\u00e9", "'caf\u00e9'"],
    ["https://idp.example/realm", "'https://idp.example/realm'"]
  ])("signInCommand single-quotes %j, which is not a plain word", (id, quoted) => {
    expect(signInCommand(id)).toBe(`opencode auth login ${quoted}`);
  });

  async function startWithFake(runtime: LightbridgeRuntimeLike, auth: Record<string, unknown>) {
    const logger = createRecordingLogger();
    const harness = await startPlugin({
      options: { auth, gateway: { providers: ["gateway"] } },
      factory: { logger, runtimeFactory: () => runtime }
    });
    await expect(
      harness.call("session.model.request", {
        model: { id: "m", providerID: "gateway" },
        headers: {}
      })
    ).rejects.toThrow();
    return logger.events;
  }

  it("a generic outage (not the interactive-auth class) raises no sign-in notice", async () => {
    const events = await startWithFake(
      fakeRuntime(
        { accessToken: "x", tokenType: "Bearer" },
        {
          getProjectToken: async () => {
            throw new Error("ECONNRESET");
          },
          ensureRootToken: async () => {
            throw new Error("ECONNRESET");
          }
        }
      ),
      AUTH
    );

    expect(warns(events)).toHaveLength(0);
    // ...and an outage is still loud: the request failure keeps its warn.
    expect(
      events.some((e) => e.level === "warn" && e.event === "lightbridge_gateway_no_bearer")
    ).toBe(true);
  });

  it("no notice when the sign-in method is not registered (machine flow)", async () => {
    const needs = new InteractiveAuthRequiredError("lightbridge", "client_credentials");
    const events = await startWithFake(
      fakeRuntime(
        { accessToken: "x", tokenType: "Bearer" },
        {
          getProjectToken: async () => {
            throw needs;
          }
        }
      ),
      makeAuth({ authFlow: "client_credentials", clientSecret: "s" })
    );

    expect(warns(events)).toHaveLength(0);
  });

  it("the wired warning shows the register name in the UI path but auth.id in the command", async () => {
    const needs = new InteractiveAuthRequiredError("lightbridge", "device_code");
    const logger = createRecordingLogger();
    const harness = await startPlugin({
      options: {
        auth: AUTH,
        gateway: { providers: ["gateway"] },
        register: { baseURL: "https://gw.example.com/v1", name: "Camer Digital" }
      },
      factory: {
        logger,
        runtimeFactory: () =>
          fakeRuntime(
            { accessToken: "x", tokenType: "Bearer" },
            {
              getProjectToken: async () => {
                throw needs;
              }
            }
          )
      }
    });
    await expect(
      harness.call("session.model.request", {
        model: { id: "m", providerID: "gateway" },
        headers: {}
      })
    ).rejects.toThrow();

    const fields = warns(logger.events)[0]?.fields as { command: string; message: string };
    expect(fields.command).toBe(`opencode auth login ${SERVER_ID}`);
    expect(fields.message).toContain('search "Camer Digital"');
    expect(fields.message).toContain(`\`opencode auth login ${SERVER_ID}\``);
  });

  it("re-arms after a sign-in: signed in, later revoked, warns again", async () => {
    const net = makeNet({ device: () => deviceBody({ interval: 1 }), token: approved });
    const logger = createRecordingLogger();
    const stateDir = await mkdtemp(join(tmpdir(), "lightbridge-rearm-"));
    const harness = await startPlugin({
      options: { auth: AUTH, gateway: { providers: ["gateway"] } },
      factory: { logger, fetchImpl: net.fetchImpl, stateDir }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(warns(logger.events)).toHaveLength(1);

    const registration = harness.integrations().methods[0] as ReturnType<
      typeof createSignInRegistration
    >;
    await Effect.runPromise((await authorize(registration)).callback);
    // Revoked later: the credential file disappears.
    await new ServerCredentialStore(rootStateDir(stateDir)).remove(SERVER_ID);
    await expect(
      harness.call("session.model.request", {
        model: { id: "m", providerID: "gateway" },
        headers: {}
      })
    ).rejects.toThrow();

    expect(warns(logger.events)).toHaveLength(2);
  });
});

describe("host disconnect signs lightbridge out (ADR-0023)", () => {
  async function startSeeded(seed: boolean, gateway = false) {
    const net = makeNet({});
    const logger = createRecordingLogger();
    const stateDir = await mkdtemp(join(tmpdir(), "lightbridge-disconnect-"));
    const store = new ServerCredentialStore(rootStateDir(stateDir));
    if (seed) {
      await store.ensureReady();
      await store.save(
        SERVER_ID,
        {
          accessToken: "valid",
          tokenType: "Bearer",
          refreshToken: "keep-me",
          expiresAt: Date.now() + 3_600_000
        },
        Date.now()
      );
    }
    const harness = await startPlugin({
      options: { auth: AUTH, ...(gateway ? { gateway: { providers: ["gateway"] } } : {}) },
      factory: { logger, fetchImpl: net.fetchImpl, stateDir }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { harness, store, logger, net };
  }

  it("startup with a token but no host connection keeps working: nothing is reset", async () => {
    const { harness, store, logger } = await startSeeded(true);

    await harness.emit({ type: "credential.updated" });
    await harness.emit({ type: "integration.updated" });

    expect((await store.load(SERVER_ID))?.token.refreshToken).toBe("keep-me");
    expect(logger.events.map((e) => e.event)).not.toContain("lightbridge_signed_out_by_host");
    expect(harness.reloads()).toBe(0);
  });

  it("a connection seen present and then gone resets the runtime, clears the file, re-arms the notice", async () => {
    const { harness, store, logger } = await startSeeded(true);

    harness.setConnection(true);
    await harness.emit({ type: "credential.updated" });
    expect((await store.load(SERVER_ID))?.token.refreshToken).toBe("keep-me");

    harness.setConnection(false);
    await harness.emit({ type: "credential.updated" });
    await harness.emit({ type: "credential.updated" });

    expect(await store.load(SERVER_ID)).toBeUndefined();
    const names = logger.events.map((e) => e.event);
    expect(names.filter((n) => n === "lightbridge_signed_out_by_host")).toHaveLength(1);
    const notice = logger.events.filter(
      (e) => e.level === "warn" && e.event === "lightbridge_sign_in_required"
    );
    expect(notice).toHaveLength(1);
    expect((notice[0]?.fields as { source?: string } | undefined)?.source).toBe("disconnect");
    expect(harness.reloads()).toBeGreaterThan(0);
  });

  it("a disconnect re-arms a notice that had already fired", async () => {
    const { harness, store, logger } = await startSeeded(true, true);
    const warnCount = () =>
      logger.events.filter((e) => e.level === "warn" && e.event === "lightbridge_sign_in_required")
        .length;
    // Revoked behind our back: the next gateway call finds nothing and latches the notice.
    await store.remove(SERVER_ID);
    await expect(
      harness.call("session.model.request", {
        model: { id: "m", providerID: "gateway" },
        headers: {}
      })
    ).rejects.toThrow();

    expect(warnCount()).toBe(1);
    harness.setConnection(true);
    await harness.emit({ type: "credential.updated" });
    harness.setConnection(false);
    await harness.emit({ type: "credential.updated" });

    expect(warnCount()).toBe(2);
  });

  it("with a register module the engine is dropped so its in-memory token cannot outlive the disconnect", async () => {
    const net = makeNet({});
    const logger = createRecordingLogger();
    const stateDir = await mkdtemp(join(tmpdir(), "lightbridge-disconnect-reg-"));
    const cacheDir = await mkdtemp(join(tmpdir(), "lightbridge-disconnect-regc-"));
    const store = new ServerCredentialStore(rootStateDir(stateDir));
    await store.ensureReady();
    await store.save(
      SERVER_ID,
      {
        accessToken: "valid",
        tokenType: "Bearer",
        refreshToken: "r",
        expiresAt: Date.now() + 3_600_000
      },
      Date.now()
    );
    const harness = await startPlugin({
      options: { auth: AUTH, register: { baseURL: "https://gw.example.com/v1" } },
      sources: [{ id: SERVER_ID }],
      factory: { logger, fetchImpl: net.fetchImpl, stateDir, cacheDir }
    });
    harness.runTransform();
    await harness.settle();
    const before = harness.engine();
    expect(before).toBeDefined();
    const stopped = vi.spyOn(before as NonNullable<typeof before>, "stop");
    expect(harness.provider(SERVER_ID)?.provider.headers).toMatchObject({
      Authorization: "Bearer valid"
    });

    harness.setConnection(true);
    await harness.emit({ type: "credential.updated" });
    harness.setConnection(false);
    await harness.emit({ type: "credential.updated" });
    await harness.settle();

    expect(harness.engine()).toBeDefined();
    expect(stopped).toHaveBeenCalled();
    expect(harness.engine()).not.toBe(before);
    expect(harness.provider(SERVER_ID)?.provider.headers?.Authorization).toBeUndefined();
  });
});

describe("integration registration", () => {
  it("is registered under auth.id with the register name — never under a URL-shaped id", async () => {
    const harness = await startPlugin({
      options: {
        auth: AUTH,
        register: { baseURL: "https://gw.example.com/v1", name: "Camer Digital" }
      },
      factory: {
        fetchImpl: makeNet({}).fetchImpl,
        stateDir: await mkdtemp(join(tmpdir(), "lightbridge-reg-state-")),
        cacheDir: await mkdtemp(join(tmpdir(), "lightbridge-reg-cache-"))
      }
    });

    const { names, methods } = harness.integrations();

    expect([...names.keys()]).toEqual([SERVER_ID]);
    expect(names.get(SERVER_ID)).toBe("Camer Digital");
    expect([...names.keys()].some((id) => id.includes("://"))).toBe(false);
    expect(methods).toHaveLength(1);
    expect(methods[0]).toMatchObject({
      integrationID: SERVER_ID,
      method: { id: "device", type: "oauth", label: "Sign in" }
    });
  });

  it("registers nothing for a flow that has no device code (machine flow)", async () => {
    const harness = await startPlugin({
      options: { auth: makeAuth({ authFlow: "client_credentials", clientSecret: "s" }) }
    });
    expect(harness.integrations().methods).toEqual([]);
  });
});
