import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { beginDeviceCodeFlow } from "../src/oauth/device-code.js";
import { TokenRuntime } from "../src/token-runtime.js";
import type { TokenSet } from "../src/types.js";
import { createServerConfig, createSilentLogger } from "./helpers.js";

const DEVICE_URL = "https://idp.example.com/device";
const TOKEN_URL = "https://idp.example.com/token";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });

const deviceOk = (overrides: Record<string, unknown> = {}): Response =>
  json({
    device_code: "dev-code",
    user_code: "ABCD-EFGH",
    verification_uri: "https://idp.example.com/activate",
    verification_uri_complete: "https://idp.example.com/activate?user_code=ABCD-EFGH",
    expires_in: 600,
    interval: 1,
    ...overrides
  });

const tokenOk = (): Response =>
  json({
    access_token: "access-1",
    refresh_token: "refresh-1",
    token_type: "Bearer",
    expires_in: 3600
  });

const pending = (): Response => json({ error: "authorization_pending" }, 400);

interface Harness {
  runtime: TokenRuntime;
  stateDir: string;
  fetchUrls: string[];
  setCached: ReturnType<typeof vi.fn<(token: TokenSet) => Promise<void>>>;
}

async function makeHarness(
  device: (init?: RequestInit) => Response | Promise<Response>,
  token: (init?: RequestInit) => Response | Promise<Response>
): Promise<Harness> {
  const stateDir = await mkdtemp(join(tmpdir(), "device-sign-in-"));
  const fetchUrls: string[] = [];
  const setCached = vi.fn(async (_token: TokenSet) => {});
  const runtime = new TokenRuntime(
    "example-ai",
    createServerConfig({
      authFlow: "device_code",
      tokenEndpoint: TOKEN_URL,
      deviceAuthorizationEndpoint: DEVICE_URL,
      pkce: false
    }),
    {
      logger: createSilentLogger(),
      stateDir,
      getCached: async () => undefined,
      setCached,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchUrls.push(url);
        if (url === DEVICE_URL) {
          return device(init);
        }
        if (url === TOKEN_URL) {
          return token(init);
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch
    }
  );
  return { runtime, stateDir, fetchUrls, setCached };
}

describe("TokenRuntime.beginDeviceSignIn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the code to show without polling or storing anything", async () => {
    const h = await makeHarness(deviceOk, tokenOk);

    const session = await h.runtime.beginDeviceSignIn();

    expect(session.userCode).toBe("ABCD-EFGH");
    expect(session.verificationUri).toBe("https://idp.example.com/activate");
    expect(session.verificationUriComplete).toContain("user_code=ABCD-EFGH");
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect(h.fetchUrls).toEqual([DEVICE_URL]);
    expect(h.setCached).not.toHaveBeenCalled();
  });

  it("stores the approved token through the single writer (setCached) exactly once", async () => {
    let polls = 0;
    const h = await makeHarness(deviceOk, () => (++polls < 2 ? pending() : tokenOk()));

    const session = await h.runtime.beginDeviceSignIn();
    const done = session.complete(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5_000);
    const token = await done;

    expect(token.accessToken).toBe("access-1");
    expect(h.setCached).toHaveBeenCalledTimes(1);
    expect(h.setCached).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "refresh-1" })
    );
    // No second writer: the runtime's own file store stayed empty.
    const entries = await readdir(h.stateDir);
    expect(entries.filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("abort while waiting stops polling promptly and stores nothing", async () => {
    // A token endpoint that WOULD succeed: a missing abort check would store it.
    const h = await makeHarness(deviceOk, tokenOk);
    const controller = new AbortController();

    const session = await h.runtime.beginDeviceSignIn();
    const done = session.complete(controller.signal).then(
      () => "resolved",
      (error: Error) => error.name
    );
    controller.abort();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await done).toBe("AbortError");
    expect(h.fetchUrls).toEqual([DEVICE_URL]);
    expect(h.setCached).not.toHaveBeenCalled();
  });

  it("abort during the token request stores nothing even if the IdP approved", async () => {
    const controller = new AbortController();
    const h = await makeHarness(deviceOk, () => {
      controller.abort();
      return tokenOk();
    });

    const session = await h.runtime.beginDeviceSignIn();
    const done = session.complete(controller.signal).then(
      () => "resolved",
      (error: Error) => error.name
    );
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await done).toBe("AbortError");
    expect(h.setCached).not.toHaveBeenCalled();
  });

  it("abort after the IdP approved but before the write stores nothing (checked under the lock)", async () => {
    const controller = new AbortController();
    // The poll loop's own checks have all passed by the time the body is read, so
    // only the check made right before persisting can stop the write.
    const h = await makeHarness(
      deviceOk,
      () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            controller.abort();
            return {
              access_token: "access-1",
              refresh_token: "refresh-1",
              token_type: "Bearer",
              expires_in: 3600
            };
          }
        }) as unknown as Response
    );

    const session = await h.runtime.beginDeviceSignIn();
    const done = session.complete(controller.signal).then(
      () => "resolved",
      (error: Error) => error.name
    );
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await done).toBe("AbortError");
    expect(h.setCached).not.toHaveBeenCalled();
  });

  it("clamps a hostile expires_in to 30 minutes", async () => {
    const h = await makeHarness(() => deviceOk({ expires_in: 1e9 }), tokenOk);

    const session = await h.runtime.beginDeviceSignIn();

    expect(session.expiresIn).toBe(1800);
    expect(session.expiresAt - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  it("drops an unsafe verification_uri_complete and falls back to verification_uri", async () => {
    const h = await makeHarness(
      () => deviceOk({ verification_uri_complete: "javascript:alert(1)" }),
      tokenOk
    );

    const session = await h.runtime.beginDeviceSignIn();

    expect(session.verificationUriComplete).toBeUndefined();
    expect(session.verificationUri).toBe("https://idp.example.com/activate");
  });

  it.each([
    "javascript:alert(1)",
    "http://idp.example.com/activate",
    "file:///etc/passwd",
    "ftp://idp.example.com/activate",
    "not a url"
  ])("fails authorize when verification_uri itself is unsafe (%s)", async (uri) => {
    const h = await makeHarness(
      () => deviceOk({ verification_uri: uri, verification_uri_complete: undefined }),
      tokenOk
    );

    await expect(h.runtime.beginDeviceSignIn()).rejects.toThrow(/unsafe verification_uri/);
    expect(h.setCached).not.toHaveBeenCalled();
  });

  it("allows plain http for a loopback IdP", async () => {
    const h = await makeHarness(
      () => deviceOk({ verification_uri: "http://127.0.0.1:8080/activate" }),
      tokenOk
    );

    const session = await h.runtime.beginDeviceSignIn();

    expect(session.verificationUri).toBe("http://127.0.0.1:8080/activate");
  });

  it("the signal aborts the device-authorization request itself", async () => {
    const controller = new AbortController();
    const h = await makeHarness(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (init?.signal?.aborted) {
            abort();
          }
          init?.signal?.addEventListener("abort", abort);
        }),
      tokenOk
    );

    const begun = h.runtime.beginDeviceSignIn(controller.signal).then(
      () => "resolved",
      (error: Error) => error.name
    );
    controller.abort();

    expect(await begun).toBe("AbortError");
  });

  it("the signal aborts an in-flight token request (not just the next loop turn)", async () => {
    const controller = new AbortController();
    const h = await makeHarness(deviceOk, (init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        );
      });
    });

    const session = await h.runtime.beginDeviceSignIn();
    const done = session.complete(controller.signal).then(
      () => "resolved",
      (error: Error) => error.name
    );
    // Past the 1s poll interval, so the token request is now hanging.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.fetchUrls).toEqual([DEVICE_URL, TOKEN_URL]);
    controller.abort();

    expect(await done).toBe("AbortError");
    expect(h.setCached).not.toHaveBeenCalled();
  });

  it("hands the signal to the sleep between polls", async () => {
    const controller = new AbortController();
    const sleeps: Array<AbortSignal | undefined> = [];
    const responses = [deviceOk, tokenOk];
    let index = 0;
    const flow = await beginDeviceCodeFlow({
      deviceAuthorizationEndpoint: DEVICE_URL,
      tokenEndpoint: TOKEN_URL,
      clientId: "client",
      scopes: ["openid"],
      serverId: "example-ai",
      logger: createSilentLogger(),
      timeoutMs: 1_000,
      pkce: false,
      sleep: async (_ms, signal) => {
        sleeps.push(signal);
      },
      fetchImpl: (async () => responses[index++]?.()) as typeof fetch
    });

    await flow.poll(controller.signal);

    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBe(controller.signal);
  });

  it.each([
    ["device_code", { device_code: undefined }],
    ["user_code", { user_code: undefined }],
    ["verification_uri", { verification_uri: undefined }],
    ["expires_in", { expires_in: "soon" }],
    ["a non-object body", "not-an-object"]
  ])("rejects a device response with a bad %s before anything is polled", async (_name, patch) => {
    const h = await makeHarness(
      () => (typeof patch === "string" ? json(patch) : deviceOk(patch)),
      tokenOk
    );

    await expect(h.runtime.beginDeviceSignIn()).rejects.toThrow(/device authorization response/);
    expect(h.fetchUrls).toEqual([DEVICE_URL]);
    expect(h.setCached).not.toHaveBeenCalled();
  });

  it("fails and stores nothing once expires_in is exhausted (bounded work)", async () => {
    const h = await makeHarness(() => deviceOk({ expires_in: 3, interval: 1 }), pending);

    const session = await h.runtime.beginDeviceSignIn();
    const done = session.complete(new AbortController().signal).then(
      () => "resolved",
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await done).toMatch(/expired/);
    expect(h.setCached).not.toHaveBeenCalled();
    // 1 device request + at most ceil(3s / 1s) polls: the loop cannot run on.
    expect(h.fetchUrls.length).toBeLessThanOrEqual(5);
  });

  it("refuses to begin for a flow that is not device_code", async () => {
    const runtime = new TokenRuntime(
      "example-ai",
      createServerConfig({ authFlow: "authorization_code" }),
      { logger: createSilentLogger(), stateDir: await mkdtemp(join(tmpdir(), "device-sign-in-")) }
    );
    await expect(runtime.beginDeviceSignIn()).rejects.toThrow(/device_code/);
  });
});
