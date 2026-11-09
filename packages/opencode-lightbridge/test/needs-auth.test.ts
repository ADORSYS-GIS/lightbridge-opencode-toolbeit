import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ServerCredentialStore } from "@vymalo/opencode-provider-sync/lib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rootStateDir } from "../src/plugin.js";
import { type Harness, startPlugin, type StartOptions } from "./harness.js";
import { createSilentLogger, makeAuth, makeJsonResponse, stateRootFor } from "./helpers.js";

const PROVIDER_ID = "lightbridge-gateway";
const REGISTER = { baseURL: "https://gateway.example.com/v1" };
const open: Harness[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

/** An IdP/gateway double: device authorization, token endpoint script, /models. */
function idp(tokenAnswers: Array<() => Response> = []) {
  const answers = [...tokenAnswers];
  return (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/auth/device")) {
      return makeJsonResponse({
        device_code: "dev-1",
        user_code: "WDJB-MJHT",
        verification_uri: "https://authz.example.com/device",
        verification_uri_complete: "https://authz.example.com/device?user_code=WDJB-MJHT",
        expires_in: 600,
        interval: 1
      });
    }
    if (url.endsWith("/openid-connect/token")) {
      const next = answers.shift();
      if (!next) {
        throw new Error("unexpected token call");
      }
      return next();
    }
    if (url.includes("/models")) {
      return makeJsonResponse({ data: [{ id: "glm-5" }] });
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
}

async function start(extra: Partial<StartOptions> & { fetchImpl?: typeof fetch } = {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), "lightbridge-needs-auth-"));
  const stateRoot = stateRootFor(cacheDir);
  const harness = await startPlugin({
    ...extra,
    factory: {
      logger: createSilentLogger(),
      cacheDir,
      stateDir: stateRoot,
      fetchImpl: extra.fetchImpl ?? idp(),
      registerProcessHandlers: false,
      ...extra.factory
    }
  });
  open.push(harness);
  return { harness, stateRoot };
}

const registerOptions = (id = PROVIDER_ID) => ({
  auth: makeAuth({ id }),
  register: REGISTER
});

describe("needs_auth notice through ctx.integration (ADR-0021)", () => {
  it("register: a refused non-interactive warmup reports message-only on the stamped integration", async () => {
    const { harness } = await start({
      options: registerOptions(),
      sources: [{ id: PROVIDER_ID, integrationID: "gw.example.com" } as never]
    });

    harness.runTransform();
    await harness.settle();

    await vi.waitFor(() => expect(harness.statusCalls).toHaveLength(1));
    expect(harness.statusCalls[0]).toMatchObject({
      integrationID: "gw.example.com",
      status: { status: "needs_auth" }
    });
    expect(harness.statusCalls[0]?.status?.url).toBeUndefined();
    expect(harness.statusCalls[0]?.status?.message).toContain(PROVIDER_ID);
  });

  it("gateway: a device code reports url + code on the root runtime, and success clears it", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { harness } = await start({
      options: {
        auth: makeAuth({ id: "idp" }),
        gateway: { providers: ["gateway"] }
      },
      sources: [{ id: "gateway", integrationID: "gw.example.com" } as never],
      fetchImpl: idp([
        () =>
          makeJsonResponse({
            access_token: "tok",
            refresh_token: "r",
            token_type: "Bearer",
            expires_in: 3600
          })
      ])
    });
    harness.runTransform();

    const event = {
      model: { id: "m", providerID: "gateway" },
      headers: {} as Record<string, string>
    };
    await harness.call("session.model.request", event);

    expect(event.headers.Authorization).toBe("Bearer tok");
    await vi.waitFor(() => expect(harness.statusCalls).toHaveLength(2));
    expect(harness.statusCalls[0]?.integrationID).toBe("gw.example.com");
    expect(harness.statusCalls[0]?.status?.url).toBe(
      "https://authz.example.com/device?user_code=WDJB-MJHT"
    );
    expect(harness.statusCalls[0]?.status?.message).toContain("WDJB-MJHT");
    expect(harness.statusCalls[1]?.status).toBeUndefined();
  });

  it("shares one notifier: a login through the gateway runtime clears the register engine's notice", async () => {
    const { harness, stateRoot } = await start({
      options: { ...registerOptions(), gateway: { providers: [PROVIDER_ID] } },
      sources: [{ id: PROVIDER_ID, integrationID: "gw.example.com" } as never]
    });
    harness.runTransform();
    await harness.settle();
    await vi.waitFor(() => expect(harness.statusCalls).toHaveLength(1));

    await new ServerCredentialStore(rootStateDir(stateRoot)).save(
      PROVIDER_ID,
      {
        accessToken: "seeded",
        tokenType: "Bearer",
        refreshToken: "r",
        expiresAt: Date.now() + 3_600_000
      },
      Date.now()
    );
    await harness.call("session.model.request", {
      model: { id: "m", providerID: PROVIDER_ID },
      headers: {}
    });

    await vi.waitFor(() => expect(harness.statusCalls).toHaveLength(2));
    expect(harness.statusCalls[1]?.status).toBeUndefined();
  });

  it("no integration: no notice, nothing thrown, the request still gets its bearer", async () => {
    const { harness, stateRoot } = await start({
      options: { auth: makeAuth({ id: "idp" }), gateway: { providers: ["gateway"] } },
      sources: [{ id: "gateway" }]
    });
    await new ServerCredentialStore(rootStateDir(stateRoot)).save(
      "idp",
      {
        accessToken: "seeded",
        tokenType: "Bearer",
        refreshToken: "r",
        expiresAt: Date.now() + 3_600_000
      },
      Date.now()
    );
    harness.runTransform();

    const event = {
      model: { id: "m", providerID: "gateway" },
      headers: {} as Record<string, string>
    };
    await harness.call("session.model.request", event);

    expect(event.headers.Authorization).toBe("Bearer seeded");
    expect(harness.statusCalls).toEqual([]);
  });

  it("a connection.status that dies never fails the request", async () => {
    const { harness, stateRoot } = await start({
      options: { auth: makeAuth({ id: "idp" }), gateway: { providers: ["gateway"] } },
      integration: { statusFails: true },
      sources: [{ id: "gateway", integrationID: "gw.example.com" } as never]
    });
    await new ServerCredentialStore(rootStateDir(stateRoot)).save(
      "idp",
      {
        accessToken: "seeded",
        tokenType: "Bearer",
        refreshToken: "r",
        expiresAt: Date.now() + 3_600_000
      },
      Date.now()
    );
    harness.runTransform();

    const event = {
      model: { id: "m", providerID: "gateway" },
      headers: {} as Record<string, string>
    };
    await harness.call("session.model.request", event);

    expect(event.headers.Authorization).toBe("Bearer seeded");
  });
});
