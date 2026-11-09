import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IntegrationIndex,
  SignInNotifier,
  createConnectionSignInReporter,
  type ConnectionStatusPort,
  type SignInNotice,
  type SignInReporter
} from "../src/sign-in-notice.js";
import { createRecordingLogger } from "./helpers.js";

function fakeReporter() {
  const raised: SignInNotice[] = [];
  const cleared: string[] = [];
  const reporter: SignInReporter = {
    needsAuth: (notice) => {
      raised.push(notice);
    },
    clear: (serverId) => {
      cleared.push(serverId);
    }
  };
  return { reporter, raised, cleared };
}

const code = {
  serverId: "acme",
  verificationUri: "https://idp.example/device",
  verificationUriComplete: "https://idp.example/device?user_code=ABCD-1234",
  userCode: "ABCD-1234",
  expiresAt: 600_000
};

describe("SignInNotifier: raise", () => {
  it("needsLogin raises message-only, naming the server and how to start sign-in", async () => {
    const { reporter, raised } = fakeReporter();
    const { logger } = createRecordingLogger();
    const notifier = new SignInNotifier(reporter, logger);

    notifier.needsLogin("acme", "Acme AI");
    await notifier.settled();

    expect(raised).toHaveLength(1);
    expect(raised[0]?.url).toBeUndefined();
    expect(raised[0]?.message).toContain("Acme AI");
    expect(raised[0]?.message).toMatch(/send a message to a model of this provider/i);
  });

  it("deviceCodeIssued raises with the complete URL and the user code in the message", async () => {
    const { reporter, raised } = fakeReporter();
    const notifier = new SignInNotifier(reporter, createRecordingLogger().logger, () => 0);

    notifier.deviceCodeIssued("acme", "Acme AI", code);
    await notifier.settled();

    expect(raised[0]?.url).toBe("https://idp.example/device?user_code=ABCD-1234");
    expect(raised[0]?.message).toContain("ABCD-1234");
    expect(raised[0]?.message).toContain("Acme AI");
    expect(raised[0]?.message).toContain("10 min");
  });

  it("falls back to verification_uri when there is no complete URI", async () => {
    const { reporter, raised } = fakeReporter();
    const notifier = new SignInNotifier(reporter, createRecordingLogger().logger, () => 0);

    notifier.deviceCodeIssued("acme", "Acme AI", { ...code, verificationUriComplete: undefined });
    await notifier.settled();

    expect(raised[0]?.url).toBe("https://idp.example/device");
  });

  it("deviceCodeExpired re-raises message-only: no url, no dead code", async () => {
    const { reporter, raised } = fakeReporter();
    const notifier = new SignInNotifier(reporter, createRecordingLogger().logger, () => 0);

    notifier.deviceCodeIssued("acme", "Acme AI", code);
    notifier.deviceCodeExpired("acme", "Acme AI");
    await notifier.settled();

    expect(raised).toHaveLength(2);
    expect(raised[1]?.url).toBeUndefined();
    expect(raised[1]?.message).not.toContain("ABCD-1234");
    expect(raised[1]?.message).toMatch(/expired/i);
  });

  it("a periodic non-interactive refusal does not overwrite a redeemable device code", async () => {
    const { reporter, raised } = fakeReporter();
    let now = 0;
    const notifier = new SignInNotifier(reporter, createRecordingLogger().logger, () => now);

    notifier.deviceCodeIssued("acme", "Acme AI", code);
    now = 100_000;
    notifier.needsLogin("acme", "Acme AI");
    await notifier.settled();
    expect(raised).toHaveLength(1);

    // Once the code is dead, the refusal may speak again.
    now = 700_000;
    notifier.needsLogin("acme", "Acme AI");
    await notifier.settled();
    expect(raised).toHaveLength(2);
    expect(raised[1]?.url).toBeUndefined();
  });
});

describe("SignInNotifier: clear", () => {
  it("clears a notice it raised when a token is obtained", async () => {
    const { reporter, cleared } = fakeReporter();
    const notifier = new SignInNotifier(reporter, createRecordingLogger().logger);

    notifier.needsLogin("acme", "Acme AI");
    notifier.tokenObtained("acme");
    await notifier.settled();

    expect(cleared).toEqual(["acme"]);
  });

  it("clears once, not on every later successful ensure", async () => {
    const { reporter, cleared } = fakeReporter();
    const notifier = new SignInNotifier(reporter, createRecordingLogger().logger);

    notifier.needsLogin("acme", "Acme AI");
    notifier.tokenObtained("acme");
    notifier.tokenObtained("acme");
    notifier.tokenObtained("acme");
    await notifier.settled();

    expect(cleared).toEqual(["acme"]);
  });

  it("never touches the host when it raised nothing", async () => {
    const { reporter, cleared } = fakeReporter();
    const notifier = new SignInNotifier(reporter, createRecordingLogger().logger);

    notifier.tokenObtained("acme");
    await notifier.settled();

    expect(cleared).toEqual([]);
  });

  it("applies calls in order: a clear is never overtaken by the raise it follows", async () => {
    const order: string[] = [];
    const reporter: SignInReporter = {
      needsAuth: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("raise");
      },
      clear: () => {
        order.push("clear");
      }
    };
    const notifier = new SignInNotifier(reporter, createRecordingLogger().logger);

    notifier.needsLogin("acme", "Acme AI");
    notifier.tokenObtained("acme");
    await notifier.settled();

    expect(order).toEqual(["raise", "clear"]);
  });
});

describe("SignInNotifier: best-effort", () => {
  afterEach(() => vi.useRealTimers());

  it("a reporter that throws is contained and logged at debug, without the notice text", async () => {
    const { logger, events } = createRecordingLogger();
    const reporter: SignInReporter = {
      needsAuth: () => {
        throw new Error("host exploded");
      },
      clear: () => {
        throw new Error("host exploded");
      }
    };
    const notifier = new SignInNotifier(reporter, logger, () => 0);

    notifier.deviceCodeIssued("acme", "Acme AI", code);
    notifier.tokenObtained("acme");
    await expect(notifier.settled()).resolves.toBeUndefined();

    const failures = events.filter((event) => event.event === "sign_in_notice_failed");
    expect(failures).toHaveLength(2);
    expect(failures.every((event) => event.level === "debug")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("ABCD-1234");
  });

  it("a reporter that rejects is contained", async () => {
    const reporter: SignInReporter = {
      needsAuth: () => Promise.reject(new Error("nope")),
      clear: () => Promise.reject(new Error("nope"))
    };
    const notifier = new SignInNotifier(reporter, createRecordingLogger().logger);

    notifier.needsLogin("acme", "Acme AI");
    await expect(notifier.settled()).resolves.toBeUndefined();
  });

  it("a hung reporter times out and does not wedge later notices", async () => {
    vi.useFakeTimers();
    const raised: string[] = [];
    let first = true;
    const reporter: SignInReporter = {
      needsAuth: (notice) => {
        if (first) {
          first = false;
          return new Promise<void>(() => {});
        }
        raised.push(notice.serverId);
      },
      clear: () => {}
    };
    const notifier = new SignInNotifier(reporter, createRecordingLogger().logger);

    notifier.needsLogin("a", "A");
    notifier.needsLogin("b", "B");
    await vi.advanceTimersByTimeAsync(6_000);
    await notifier.settled();

    expect(raised).toEqual(["b"]);
  });

  it("with no reporter every call is a silent no-op", async () => {
    const notifier = new SignInNotifier(undefined, createRecordingLogger().logger);

    notifier.needsLogin("acme", "Acme AI");
    notifier.deviceCodeIssued("acme", "Acme AI", code);
    notifier.tokenObtained("acme");
    await expect(notifier.settled()).resolves.toBeUndefined();
  });
});

describe("createConnectionSignInReporter", () => {
  function port(overrides: Partial<ConnectionStatusPort<{ id: string }>> = {}) {
    const calls: Array<{ integrationID: string; status: unknown }> = [];
    const value: ConnectionStatusPort<{ id: string }> = {
      resolveIntegrationID: () => "integ-1",
      activeConnection: async () => ({ id: "conn-1" }),
      setStatus: async ({ integrationID, status }) => {
        calls.push({ integrationID, status });
      },
      ...overrides
    };
    return { value, calls };
  }

  it("sets needs_auth on the active connection, with url only when given", async () => {
    const { value, calls } = port();
    const reporter = createConnectionSignInReporter(value, createRecordingLogger().logger);

    await reporter.needsAuth({ serverId: "acme", message: "m" });
    await reporter.needsAuth({ serverId: "acme", message: "m2", url: "https://x" });

    expect(calls).toEqual([
      { integrationID: "integ-1", status: { status: "needs_auth", message: "m" } },
      {
        integrationID: "integ-1",
        status: { status: "needs_auth", message: "m2", url: "https://x" }
      }
    ]);
  });

  it("clears with status undefined", async () => {
    const { value, calls } = port();
    const reporter = createConnectionSignInReporter(value, createRecordingLogger().logger);

    await reporter.clear("acme");

    expect(calls).toEqual([{ integrationID: "integ-1", status: undefined }]);
  });

  it("no integration: skipped, nothing thrown, logged once at debug", async () => {
    const { value, calls } = port({ resolveIntegrationID: () => undefined });
    const { logger, events } = createRecordingLogger();
    const reporter = createConnectionSignInReporter(value, logger);

    await reporter.needsAuth({ serverId: "acme", message: "m" });
    await reporter.needsAuth({ serverId: "acme", message: "m" });
    await reporter.clear("acme");

    expect(calls).toEqual([]);
    const skipped = events.filter((event) => event.event === "sign_in_notice_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ level: "debug", fields: { reason: "no_integration" } });
  });

  it("no active connection: skipped, nothing thrown", async () => {
    const { value, calls } = port({ activeConnection: async () => undefined });
    const { logger, events } = createRecordingLogger();
    const reporter = createConnectionSignInReporter(value, logger);

    await expect(reporter.needsAuth({ serverId: "acme", message: "m" })).resolves.toBeUndefined();

    expect(calls).toEqual([]);
    expect(events.find((event) => event.event === "sign_in_notice_skipped")?.fields).toMatchObject({
      reason: "no_connection"
    });
  });
});

describe("IntegrationIndex", () => {
  it("prefers the id the host stamped on the provider", () => {
    const index = new IntegrationIndex();
    index.noteProvider("camer-digital", "ai.camer.digital");
    index.noteIntegrations(["camer-digital"]);

    expect(index.resolve("camer-digital")).toBe("ai.camer.digital");
  });

  it("falls back to an integration whose id equals the server id", () => {
    const index = new IntegrationIndex();
    index.noteIntegrations(["acme"]);

    expect(index.resolve("acme")).toBe("acme");
    expect(index.resolve("other")).toBeUndefined();
  });

  it("borrows a sibling provider's integration through aliases", () => {
    const index = new IntegrationIndex();
    index.noteProvider("gw", "integ-gw");

    expect(index.resolve("auth-id", ["gw"])).toBe("integ-gw");
    expect(index.resolve("auth-id")).toBeUndefined();
  });

  it("forgets a provider that lost its integration", () => {
    const index = new IntegrationIndex();
    index.noteProvider("p", "i");
    index.noteProvider("p", undefined);

    expect(index.resolve("p")).toBeUndefined();
  });
});
