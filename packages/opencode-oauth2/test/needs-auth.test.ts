import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type Harness, OAUTH_BLOCK, requestEvent, seedCache, startPlugin } from "./harness.js";

const open: Harness[] = [];
async function start(...args: Parameters<typeof startPlugin>): Promise<Harness> {
  const harness = await startPlugin(...args);
  open.push(harness);
  return harness;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

const cacheDir = () => mkdtemp(join(tmpdir(), "oauth2-needs-auth-"));

/** A managed provider as the host would hand it over, with `integrationID` stamped. */
const provider = (extra: Record<string, unknown> = {}) => [
  {
    id: "example-ai",
    name: "Example AI",
    settings: { baseURL: "https://api.example.com/v1", oauth2: { ...OAUTH_BLOCK } },
    ...extra
  }
];

async function warm(harness: Harness): Promise<void> {
  harness.runTransform();
  await harness.settle();
  await harness.signInSettled();
}

describe("needs_auth notice through ctx.integration (ADR-0021)", () => {
  it("reports a missing sign-in on the connection of the integration the host stamped", async () => {
    const harness = await start({
      cacheDir: await cacheDir(),
      sources: provider({ integrationID: "ai.example.com" })
    });

    await warm(harness);

    expect(harness.statusCalls).toHaveLength(1);
    expect(harness.statusCalls[0]).toMatchObject({
      integrationID: "ai.example.com",
      connection: { type: "env", name: "conn-of-ai.example.com" },
      status: { status: "needs_auth" }
    });
    expect(harness.statusCalls[0]?.status?.message).toContain("Example AI");
    expect(harness.statusCalls[0]?.status?.url).toBeUndefined();
  });

  it("falls back to an integration whose id equals the provider id", async () => {
    const harness = await start({
      cacheDir: await cacheDir(),
      integration: { integrations: ["example-ai"] },
      sources: provider()
    });

    await warm(harness);

    expect(harness.statusCalls.map((call) => call.integrationID)).toEqual(["example-ai"]);
  });

  it("clears the notice on the next successful token acquisition", async () => {
    const dir = await cacheDir();
    const harness = await start({
      cacheDir: dir,
      sources: provider({ integrationID: "ai.example.com" })
    });
    await warm(harness);
    expect(harness.statusCalls).toHaveLength(1);

    await seedCache(dir);
    await harness.call("model.request", requestEvent("example-ai"));
    await harness.signInSettled();

    expect(harness.statusCalls).toHaveLength(2);
    expect(harness.statusCalls[1]).toMatchObject({
      integrationID: "ai.example.com",
      status: undefined
    });
  });

  it("no integration: no notice, nothing thrown, and the request path is untouched", async () => {
    const dir = await cacheDir();
    await seedCache(dir);
    const harness = await start({ cacheDir: dir, sources: provider() });

    await warm(harness);
    const event = requestEvent("example-ai");
    await harness.call("model.request", event);

    expect(harness.statusCalls).toEqual([]);
    expect(event.headers.Authorization).toBe("Bearer cached-access");
  });

  it("no integration and no token: still no notice and nothing thrown", async () => {
    const harness = await start({ cacheDir: await cacheDir(), sources: provider() });

    await expect(warm(harness)).resolves.toBeUndefined();

    expect(harness.statusCalls).toEqual([]);
  });

  it("an integration with no active connection is skipped", async () => {
    const harness = await start({
      cacheDir: await cacheDir(),
      integration: { active: () => undefined },
      sources: provider({ integrationID: "ai.example.com" })
    });

    await warm(harness);

    expect(harness.statusCalls).toEqual([]);
  });

  it("a connection.status that dies never fails the warmup or a request", async () => {
    const dir = await cacheDir();
    await seedCache(dir);
    const harness = await start({
      cacheDir: dir,
      integration: { statusFails: true },
      sources: provider({ integrationID: "ai.example.com" })
    });

    await expect(warm(harness)).resolves.toBeUndefined();
    const event = requestEvent("example-ai");
    await harness.call("model.request", event);

    expect(event.headers.Authorization).toBe("Bearer cached-access");
  });

  it("a connection.status that dies on the needs-login path leaves the sync result intact", async () => {
    const harness = await start({
      cacheDir: await cacheDir(),
      integration: { statusFails: true },
      sources: provider({ integrationID: "ai.example.com" })
    });

    await expect(warm(harness)).resolves.toBeUndefined();
    expect(harness.handle.runtime()?.getServerModels("example-ai")).toEqual([]);
  });
});
