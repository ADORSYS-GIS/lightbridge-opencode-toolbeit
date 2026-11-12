import { join } from "node:path";

import { Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

import { createSessionWakePlugin, PLUGIN_ID } from "../src/opencode.js";
import { SubscriptionStore } from "../src/state.js";
import type { WakeEvent } from "../src/types.js";
import {
  exec,
  fakeLogger,
  fakeTransport,
  makeStore,
  page,
  PROJECT_A,
  record,
  tempDir,
  waitFor
} from "./helpers.js";

interface RegisteredTool {
  name: string;
  execute?: (input: unknown, context: never) => Effect.Effect<unknown, unknown>;
}

/**
 * A stand-in for the host's plugin context: only the four members this plugin
 * touches (`options`, `tool.transform`, `session.synthetic`, and the scope that
 * `Plugin.define` supplies) exist, and `synthetic` records every call so the
 * wake seam can be asserted without a live host.
 */
function fakeContext(options: Record<string, unknown> = {}) {
  const tools: RegisteredTool[] = [];
  const synthetic = vi.fn((input: { sessionID: string; text: string }) =>
    Effect.succeed({
      type: "synthetic" as const,
      id: "msg_1",
      sessionID: input.sessionID,
      payload: { text: input.text },
      delivery: "queue" as const,
      time: { created: new Date(0) }
    })
  );
  const context = {
    options,
    location: {
      directory: PROJECT_A.directory,
      project: {
        id: PROJECT_A.id,
        directory: PROJECT_A.directory,
        canonical: PROJECT_A.canonical
      }
    },
    tool: {
      transform: (fn: (editor: { add: (tool: RegisteredTool) => void }) => void) =>
        Effect.sync(() => {
          fn({ add: (tool) => tools.push(tool) });
        })
    },
    session: { synthetic }
  };
  return { context, tools, synthetic };
}

describe("createSessionWakePlugin", () => {
  it("has a stable id", () => {
    expect(PLUGIN_ID).toBe("vymalo.session-wake");
    expect(createSessionWakePlugin().id).toBe(PLUGIN_ID);
  });

  it("registers the wake_* tools", async () => {
    const temp = await tempDir();
    try {
      const { context, tools } = fakeContext({ stateDir: temp.dir });
      const plugin = createSessionWakePlugin({ logger: fakeLogger(), transport: fakeTransport() });
      const fiber = Effect.runFork(Effect.scoped(plugin.effect(context as never)));
      await waitFor(() => tools.length > 0);
      await Effect.runPromise(Fiber.interrupt(fiber));

      expect(tools.map((tool) => tool.name)).toEqual([
        "wake_subscribe",
        "wake_unsubscribe",
        "wake_list",
        "wake_adopt",
        "wake_resume",
        "wake_next"
      ]);
    } finally {
      await temp.cleanup();
    }
  });

  it("records the host project identity on a new subscription", async () => {
    const temp = await tempDir();
    try {
      const { context, tools } = fakeContext({ stateDir: temp.dir });
      const plugin = createSessionWakePlugin({ logger: fakeLogger(), transport: fakeTransport() });
      const fiber = Effect.runFork(Effect.scoped(plugin.effect(context as never)));
      await waitFor(() => tools.length > 0);

      const subscribe = tools.find((tool) => tool.name === "wake_subscribe");
      if (!subscribe?.execute) {
        throw new Error("wake_subscribe was not registered");
      }
      await exec(
        { execute: subscribe.execute },
        { owner: "acme", repo: "widgets", number: 7 },
        "ses_owner"
      );
      await Effect.runPromise(Fiber.interrupt(fiber));

      const store = new SubscriptionStore({
        dir: join(temp.dir, "subscriptions"),
        logger: fakeLogger()
      });
      await store.load();
      expect(store.list("ses_owner")[0]?.subscription.project).toEqual(PROJECT_A);
    } finally {
      await temp.cleanup();
    }
  });

  it("wakes the owning session through ctx.session.synthetic with resume:true", async () => {
    const temp = await tempDir();
    try {
      const store = await makeStore(temp.dir);
      const rec = record({ sessionID: "ses_owner" });
      rec.state.nextPollAt = 0;
      await store.put(rec);

      const transport = fakeTransport();
      transport.setComments([page([{ ...commentEvent("101"), body: "hi" }])]);
      const { context, synthetic } = fakeContext({ stateDir: temp.dir });
      const plugin = createSessionWakePlugin({ logger: fakeLogger(), transport });

      const fiber = Effect.runFork(Effect.scoped(plugin.effect(context as never)));
      await waitFor(() => synthetic.mock.calls.length > 0);
      await Effect.runPromise(Fiber.interrupt(fiber));

      const input = synthetic.mock.calls[0]?.[0] as unknown as {
        sessionID: string;
        text: string;
        resume: boolean;
        delivery: string;
        metadata: Record<string, unknown>;
      };
      expect(input.sessionID).toBe("ses_owner");
      expect(input.resume).toBe(true);
      expect(input.delivery).toBe("queue");
      expect(input.text).toContain("untrusted");
      expect(input.text).not.toContain("hi");
      expect(input.metadata).toMatchObject({ source: PLUGIN_ID, untrusted: true, count: 1 });
    } finally {
      await temp.cleanup();
    }
  });

  it("does not wake a session that is not the subscription owner", async () => {
    const temp = await tempDir();
    try {
      const store = await makeStore(temp.dir);
      const rec = record({ sessionID: "ses_owner" });
      rec.state.nextPollAt = 0;
      await store.put(rec);

      const transport = fakeTransport();
      transport.setComments([page([commentEvent("101")])]);
      const { context, synthetic } = fakeContext({ stateDir: temp.dir });
      const plugin = createSessionWakePlugin({ logger: fakeLogger(), transport });
      const fiber = Effect.runFork(Effect.scoped(plugin.effect(context as never)));
      await waitFor(() => synthetic.mock.calls.length > 0);
      await Effect.runPromise(Fiber.interrupt(fiber));

      const sessions = synthetic.mock.calls.map(
        (call) => (call[0] as unknown as { sessionID: string }).sessionID
      );
      expect(new Set(sessions)).toEqual(new Set(["ses_owner"]));
    } finally {
      await temp.cleanup();
    }
  });

  it("registers nothing and starts no poller when disabled", async () => {
    const temp = await tempDir();
    try {
      const store = await makeStore(temp.dir);
      const rec = record();
      rec.state.nextPollAt = 0;
      await store.put(rec);

      const { context, tools, synthetic } = fakeContext({
        stateDir: temp.dir,
        enabled: false
      });
      const transport = fakeTransport();
      transport.setComments([page([commentEvent("101")])]);
      const plugin = createSessionWakePlugin({ logger: fakeLogger(), transport });
      const fiber = Effect.runFork(Effect.scoped(plugin.effect(context as never)));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await Effect.runPromise(Fiber.interrupt(fiber));

      expect(tools).toEqual([]);
      expect(synthetic).not.toHaveBeenCalled();
    } finally {
      await temp.cleanup();
    }
  });

  it("persists subscriptions under the configured state dir", async () => {
    const temp = await tempDir();
    try {
      const { context } = fakeContext({ stateDir: temp.dir });
      const plugin = createSessionWakePlugin({ logger: fakeLogger(), transport: fakeTransport() });
      const fiber = Effect.runFork(Effect.scoped(plugin.effect(context as never)));
      await new Promise((resolve) => setTimeout(resolve, 30));
      await Effect.runPromise(Fiber.interrupt(fiber));

      const store = new SubscriptionStore({ dir: temp.dir, logger: fakeLogger() });
      await expect(store.load()).resolves.toBeUndefined();
    } finally {
      await temp.cleanup();
    }
  });
});

function commentEvent(id: string): WakeEvent {
  return {
    id,
    kind: "comment",
    author: "alice",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    url: `https://github.com/acme/widgets/issues/7#issuecomment-${id}`,
    body: "hi"
  };
}
