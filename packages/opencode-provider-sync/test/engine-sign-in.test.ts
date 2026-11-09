import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SignInNotice, SignInReporter } from "@vymalo/opencode-auth-core/lib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerCredentialStore } from "../src/cache.js";
import { ProviderModelSyncEngine } from "../src/engine.js";
import { createServerConfig, createSilentLogger } from "./helpers.js";

const SERVER_ID = "example-ai";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Step = `needsAuth:${string}` | "clear";

function recordingReporter() {
  const steps: Step[] = [];
  const raised: SignInNotice[] = [];
  const cleared: string[] = [];
  const reporter: SignInReporter = {
    needsAuth: (notice) => {
      raised.push(notice);
      steps.push(`needsAuth:${notice.url ? "url" : "message"}`);
    },
    clear: (serverId) => {
      cleared.push(serverId);
      steps.push("clear");
    }
  };
  return { reporter, raised, cleared, steps };
}

interface IdpScript {
  /** Answers for the token endpoint, in order. */
  token?: Array<() => Response>;
}

async function setup(reporter: SignInReporter | undefined, script: IdpScript = {}) {
  const root = await mkdtemp(join(tmpdir(), "engine-sign-in-"));
  const dirs = { cacheDir: join(root, "cache"), stateDir: join(root, "state") };
  const tokenAnswers = [...(script.token ?? [])];
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/device/authorize")) {
      return json({
        device_code: "dev-1",
        user_code: "WDJB-MJHT",
        verification_uri: "https://auth.example.com/device",
        verification_uri_complete: "https://auth.example.com/device?user_code=WDJB-MJHT",
        expires_in: 600,
        interval: 1
      });
    }
    if (url.endsWith("/oauth/token")) {
      const next = tokenAnswers.shift();
      if (!next) {
        throw new Error("unexpected token endpoint call");
      }
      return next();
    }
    if (url.includes("/models")) {
      return json({ data: [{ id: "m1" }] });
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  const engine = new ProviderModelSyncEngine(
    {
      servers: [
        createServerConfig({
          authFlow: "device_code",
          deviceAuthorizationEndpoint: "https://auth.example.com/device/authorize"
        })
      ]
    },
    { ...dirs, logger: createSilentLogger(), fetchImpl, signInReporter: reporter }
  );
  await engine.initialize();
  return { engine, dirs, credentials: new ServerCredentialStore(dirs.stateDir) };
}

const tokenOk =
  (access = "tok") =>
  () =>
    json({ access_token: access, refresh_token: "r", token_type: "Bearer", expires_in: 3600 });

describe("ProviderModelSyncEngine: needs_auth notice (ADR-0021)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("raises message-only where it logs sync_skipped_needs_login", async () => {
    const { reporter, raised } = recordingReporter();
    const { engine } = await setup(reporter);

    await engine.syncServer(SERVER_ID, { interactive: false });
    await engine.signInSettled();

    expect(raised).toHaveLength(1);
    expect(raised[0]?.serverId).toBe(SERVER_ID);
    expect(raised[0]?.url).toBeUndefined();
    expect(raised[0]?.message).toContain("Example AI");
  });

  it("does not raise for an ordinary sync failure", async () => {
    const { reporter, raised } = recordingReporter();
    const { dirs, credentials } = await setup(reporter);
    await credentials.save(
      SERVER_ID,
      {
        accessToken: "a",
        tokenType: "Bearer",
        refreshToken: "r",
        expiresAt: Date.now() + 3_600_000
      },
      Date.now()
    );
    // A valid token, but the model endpoint answers 500: sync_failed, not a login problem.
    const failing = new ProviderModelSyncEngine(
      { servers: [createServerConfig({ authFlow: "device_code" })] },
      {
        ...dirs,
        logger: createSilentLogger(),
        fetchImpl: (async () => json({}, 500)) as unknown as typeof fetch,
        signInReporter: reporter
      }
    );
    await failing.initialize();

    await failing.syncServer(SERVER_ID, { interactive: false });
    await failing.signInSettled();

    expect(raised).toEqual([]);
  });

  it("raises with url and user code the moment a device code is issued, and clears on success", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { reporter, raised, steps } = recordingReporter();
    const { engine } = await setup(reporter, { token: [tokenOk("fresh")] });

    const token = await engine.ensureAccessToken(SERVER_ID);
    await engine.signInSettled();

    expect(token.accessToken).toBe("fresh");
    expect(raised).toHaveLength(1);
    expect(raised[0]?.url).toBe("https://auth.example.com/device?user_code=WDJB-MJHT");
    expect(raised[0]?.message).toContain("WDJB-MJHT");
    expect(raised[0]?.message).toContain("Example AI");
    expect(steps).toEqual(["needsAuth:url", "clear"]);
  });

  it("re-raises message-only, url dropped, when the device code expires", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { reporter, raised, cleared } = recordingReporter();
    const { engine } = await setup(reporter, {
      token: [() => json({ error: "expired_token" }, 400)]
    });

    await expect(engine.ensureAccessToken(SERVER_ID)).rejects.toThrow(/expired/);
    await engine.signInSettled();

    expect(raised.map((notice) => Boolean(notice.url))).toEqual([true, false]);
    expect(raised[1]?.message).not.toContain("WDJB-MJHT");
    expect(cleared).toEqual([]);
  });

  it("clears on a successful refresh", async () => {
    const { reporter, cleared, steps } = recordingReporter();
    const { engine, credentials } = await setup(reporter, { token: [tokenOk("refreshed")] });
    await engine.syncServer(SERVER_ID, { interactive: false });
    await engine.signInSettled();
    expect(steps).toEqual(["needsAuth:message"]);

    await credentials.save(
      SERVER_ID,
      { accessToken: "old", tokenType: "Bearer", refreshToken: "r0", expiresAt: Date.now() - 1000 },
      Date.now()
    );
    const token = await engine.ensureAccessToken(SERVER_ID, { interactive: false });
    await engine.signInSettled();

    expect(token.accessToken).toBe("refreshed");
    expect(cleared).toEqual([SERVER_ID]);
  });

  it("never clears when the token could not be obtained", async () => {
    const { reporter, cleared } = recordingReporter();
    const { engine, credentials } = await setup(reporter, { token: [() => json({}, 500)] });
    await engine.syncServer(SERVER_ID, { interactive: false });
    await credentials.save(
      SERVER_ID,
      { accessToken: "old", tokenType: "Bearer", refreshToken: "r0", expiresAt: Date.now() - 1000 },
      Date.now()
    );

    await expect(engine.ensureAccessToken(SERVER_ID, { interactive: false })).rejects.toThrow();
    await engine.signInSettled();

    expect(cleared).toEqual([]);
  });

  it("a reporter that throws or rejects never fails a sync or a token request", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const broken: SignInReporter = {
      needsAuth: () => {
        throw new Error("host exploded");
      },
      clear: () => Promise.reject(new Error("host exploded"))
    };
    const { engine } = await setup(broken, { token: [tokenOk("fresh")] });

    await expect(engine.syncServer(SERVER_ID, { interactive: false })).resolves.toMatchObject({
      serverId: SERVER_ID
    });
    await expect(engine.ensureAccessToken(SERVER_ID)).resolves.toMatchObject({
      accessToken: "fresh"
    });
    await expect(engine.signInSettled()).resolves.toBeUndefined();
  });
});
