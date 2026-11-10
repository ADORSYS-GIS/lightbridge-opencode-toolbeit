import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
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
  createSignInRegistration,
  createSignInRequiredNotifier,
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
    const registration = createSignInRegistration({
      integrationID: SERVER_ID,
      runtime,
      logger: createSilentLogger(),
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
    const registration = createSignInRegistration({
      integrationID: SERVER_ID,
      runtime,
      logger: createSilentLogger(),
      afterSignIn: async () => {}
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
  });
});

describe("hard cutover — nothing but the Connect dialog starts a device flow", () => {
  async function startSignedOut(register: boolean) {
    const net = makeNet({});
    const logger = createRecordingLogger();
    const events = logger.events;
    const stateDir = await mkdtemp(join(tmpdir(), "lightbridge-cutover-state-"));
    const cacheDir = await mkdtemp(join(tmpdir(), "lightbridge-cutover-cache-"));
    let tokenSource: TokenSource | undefined;
    const harness = await startPlugin({
      options: {
        auth: AUTH,
        gateway: { providers: ["gateway"] },
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

  it("signed out: startup, register sync (warmup + scheduled), gateway header and otel never hit the device endpoint", async () => {
    const { net, events, harness, tokenSource } = await startSignedOut(true);
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
    expect(JSON.stringify(notices[0]?.fields)).toContain(signInPath("lightbridge"));
  });

  it("the sign-in notice is latched: one warn, however many callers find no token", () => {
    const logger = createRecordingLogger();
    const events = logger.events;
    const notify = createSignInRequiredNotifier(logger, "Camer Digital");

    notify("gateway");
    notify("otel");
    notify("startup");

    expect(warns(events)).toHaveLength(1);
    expect(JSON.stringify(events[0]?.fields)).toContain(
      "Settings → Providers → Show more providers → Camer Digital → Sign in"
    );
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
