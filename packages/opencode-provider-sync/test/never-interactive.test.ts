import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isInteractiveAuthRequiredError } from "@vymalo/opencode-auth-core/lib";
import { describe, expect, it } from "vitest";

import { ProviderModelSyncEngine } from "../src/engine.js";
import { createServerConfig, createSilentLogger } from "./helpers.js";

const DEVICE_URL = "https://auth.example.com/device";
const SERVER_ID = "example-ai";

async function makeEngine(neverInteractive: boolean) {
  const root = await mkdtemp(join(tmpdir(), "opencode-provider-sync-never-interactive-"));
  const urls: string[] = [];
  // A device endpoint that fails fast: a flow that starts is recorded, not awaited.
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  const engine = new ProviderModelSyncEngine(
    {
      servers: [
        createServerConfig({
          authFlow: "device_code",
          deviceAuthorizationEndpoint: DEVICE_URL,
          pkce: false
        })
      ]
    },
    {
      cacheDir: join(root, "cache"),
      stateDir: join(root, "state"),
      logger: createSilentLogger(),
      fetchImpl,
      neverInteractive
    }
  );
  await engine.initialize();
  return { engine, urls };
}

describe("ProviderModelSyncEngine neverInteractive", () => {
  it("control: without the option an interactive call does start a device flow", async () => {
    const { engine, urls } = await makeEngine(false);

    await engine.syncServer(SERVER_ID, { interactive: true });

    expect(urls).toContain(DEVICE_URL);
  });

  it("ensureAccessToken refuses, even when asked to be interactive", async () => {
    const { engine, urls } = await makeEngine(true);

    for (const options of [undefined, { interactive: true }]) {
      const error = await engine.ensureAccessToken(SERVER_ID, options).catch((e: unknown) => e);
      expect(isInteractiveAuthRequiredError(error)).toBe(true);
    }
    expect(urls).toEqual([]);
  });

  it("syncServer() with no options (what the scheduler calls) never starts a flow", async () => {
    const { engine, urls } = await makeEngine(true);

    await engine.syncServer(SERVER_ID);
    await engine.syncServer(SERVER_ID, { interactive: true });

    expect(urls).toEqual([]);
  });

  it("warmup never starts a flow, even when start() is told to be interactive", async () => {
    const { engine, urls } = await makeEngine(true);

    await engine.start({ warmup: true, interactive: true });
    engine.stop();

    expect(urls).toEqual([]);
  });
});
