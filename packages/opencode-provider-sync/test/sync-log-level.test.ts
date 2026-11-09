import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LogFields, Logger, LogLevel } from "@vymalo/opencode-auth-core/lib";
import { describe, expect, it } from "vitest";

import { ServerStateStore } from "../src/cache.js";
import { ProviderModelSyncEngine } from "../src/engine.js";
import { createServerConfig, seedServerState } from "./helpers.js";

interface LogRecord {
  level: LogLevel;
  event: string;
  fields?: LogFields;
}

function createRecordingLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const at =
    (level: LogLevel) =>
    (event: string, fields?: LogFields): void => {
      records.push({ level, event, fields });
    };
  return {
    records,
    logger: {
      trace: at("trace"),
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error")
    }
  };
}

const SERVER_ID = "example-ai";

async function makeEngine(
  logger: Logger,
  fetchImpl: typeof fetch,
  cachedToken: boolean
): Promise<ProviderModelSyncEngine> {
  const root = await mkdtemp(join(tmpdir(), "opencode-provider-sync-loglevel-"));
  const cacheDir = join(root, "cache");
  const stateDir = join(root, "state");
  if (cachedToken) {
    const store = new ServerStateStore(cacheDir, stateDir);
    await store.ensureReady();
    await seedServerState(store, {
      serverId: SERVER_ID,
      updatedAt: Date.now(),
      token: {
        accessToken: "valid",
        tokenType: "Bearer",
        refreshToken: "r",
        expiresAt: Date.now() + 3_600_000
      },
      rawModels: [],
      models: []
    });
  }
  const engine = new ProviderModelSyncEngine(
    { servers: [createServerConfig({ authFlow: "device_code" })] },
    { cacheDir, stateDir, logger, fetchImpl }
  );
  await engine.initialize();
  return engine;
}

describe("syncServer log level by cause (ADR-0014: severity is asserted, not assumed)", () => {
  it("logs the expected 'needs interactive login' refusal at warn, never error", async () => {
    const { logger, records } = createRecordingLogger();
    const engine = await makeEngine(
      logger,
      (async () => {
        throw new Error("no network expected");
      }) as unknown as typeof fetch,
      false
    );

    const snapshot = await engine.syncServer(SERVER_ID, { interactive: false });

    expect(snapshot.models).toEqual([]);
    expect(records.filter((r) => r.level === "error")).toEqual([]);
    expect(records.filter((r) => r.event === "sync_failed")).toEqual([]);
    const skipped = records.filter((r) => r.event === "sync_skipped_needs_login");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.level).toBe("warn");
    expect(skipped[0]?.fields?.serverId).toBe(SERVER_ID);
    expect(String(skipped[0]?.fields?.error)).toContain(SERVER_ID);
  });

  it("still logs a genuine sync failure (5xx from the models endpoint) at error", async () => {
    const { logger, records } = createRecordingLogger();
    const engine = await makeEngine(
      logger,
      (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
      true
    );

    await engine.syncServer(SERVER_ID, { interactive: false });

    const failed = records.filter((r) => r.event === "sync_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.level).toBe("error");
    expect(records.filter((r) => r.event === "sync_skipped_needs_login")).toEqual([]);
  });

  it("still logs a plain Error that merely quotes the old message as error", async () => {
    const { logger, records } = createRecordingLogger();
    const engine = await makeEngine(
      logger,
      (async () => {
        throw new Error('interactive authentication required for server "x" (authFlow=y)');
      }) as unknown as typeof fetch,
      true
    );

    await engine.syncServer(SERVER_ID, { interactive: false });

    expect(records.find((r) => r.event === "sync_failed")?.level).toBe("error");
  });
});
