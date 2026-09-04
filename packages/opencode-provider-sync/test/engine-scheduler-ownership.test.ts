import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProviderModelSyncEngine } from "../src/engine.js";
import { createServerConfig, createSilentLogger } from "./helpers.js";

interface RecordedEvent {
  level: string;
  event: string;
  fields?: Record<string, unknown>;
}

function createRecordingLogger() {
  const events: RecordedEvent[] = [];
  const log = (level: string) => (event: string, fields?: Record<string, unknown>) => {
    events.push({ level, event, fields });
  };
  return {
    events,
    trace: log("trace"),
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error")
  };
}

function createFetch(callCounter: { count: number }): typeof fetch {
  return (async (input: unknown) => {
    callCounter.count += 1;
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (url.includes("/oauth/token")) {
      return new Response(
        JSON.stringify({
          access_token: `token-${callCounter.count}`,
          token_type: "Bearer",
          expires_in: 3600
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ data: [{ id: "glm-5" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
}

async function tempCacheDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `provider-sync-ownership-${name}-`));
}

describe("ProviderModelSyncEngine — scheduler ownership guard (ADR-0017 requirement 4b)", () => {
  it("a second engine instance targeting the SAME cache file skips its own warmup+scheduler", async () => {
    const cacheDir = await tempCacheDir("collision");
    const server = createServerConfig({ authFlow: "client_credentials", clientSecret: "s3cr3t" });

    const counter = { count: 0 };
    const engineA = new ProviderModelSyncEngine(
      { servers: [server] },
      { cacheDir, logger: createSilentLogger(), fetchImpl: createFetch(counter) }
    );
    await engineA.start({ warmup: true });
    const callsAfterA = counter.count;
    expect(callsAfterA).toBeGreaterThan(0);

    const loggerB = createRecordingLogger();
    const engineB = new ProviderModelSyncEngine(
      { servers: [server] },
      { cacheDir, logger: loggerB, fetchImpl: createFetch(counter) }
    );
    await engineB.start({ warmup: true });

    // B made NO network calls of its own — it deferred entirely to A, which
    // already owns this exact cache file's scheduler for this server id.
    expect(counter.count).toBe(callsAfterA);
    expect(
      loggerB.events.some(
        (e) => e.level === "debug" && e.event === "sync_scheduler_ownership_skipped"
      )
    ).toBe(true);

    // B still serves reads from the shared cache (safe, on-demand).
    expect(engineB.getCachedToken(server.id)?.accessToken).toBeDefined();

    engineA.stop();
    engineB.stop();
  });

  it("releases ownership on stop() so a later engine instance can claim it", async () => {
    const cacheDir = await tempCacheDir("release");
    const server = createServerConfig({ authFlow: "client_credentials", clientSecret: "s3cr3t" });
    const counter = { count: 0 };

    const engineA = new ProviderModelSyncEngine(
      { servers: [server] },
      { cacheDir, logger: createSilentLogger(), fetchImpl: createFetch(counter) }
    );
    await engineA.start({ warmup: true });
    engineA.stop();

    const loggerC = createRecordingLogger();
    const engineC = new ProviderModelSyncEngine(
      { servers: [server] },
      { cacheDir, logger: loggerC, fetchImpl: createFetch(counter) }
    );
    const callsBeforeC = counter.count;
    await engineC.start({ warmup: true });

    expect(counter.count).toBeGreaterThan(callsBeforeC);
    expect(loggerC.events.some((e) => e.event === "sync_scheduler_ownership_skipped")).toBe(false);

    engineC.stop();
  });

  it("two engines for DIFFERENT cache directories never contend, even with the same server id", async () => {
    const cacheDirA = await tempCacheDir("dirA");
    const cacheDirB = await tempCacheDir("dirB");
    const server = createServerConfig({ authFlow: "client_credentials", clientSecret: "s3cr3t" });
    const counter = { count: 0 };

    const engineA = new ProviderModelSyncEngine(
      { servers: [server] },
      { cacheDir: cacheDirA, logger: createSilentLogger(), fetchImpl: createFetch(counter) }
    );
    const loggerB = createRecordingLogger();
    const engineB = new ProviderModelSyncEngine(
      { servers: [server] },
      { cacheDir: cacheDirB, logger: loggerB, fetchImpl: createFetch(counter) }
    );

    await engineA.start({ warmup: true });
    const callsAfterA = counter.count;
    await engineB.start({ warmup: true });

    expect(counter.count).toBeGreaterThan(callsAfterA);
    expect(loggerB.events.some((e) => e.event === "sync_scheduler_ownership_skipped")).toBe(false);

    engineA.stop();
    engineB.stop();
  });
});
