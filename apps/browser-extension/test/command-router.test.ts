import { beforeEach, describe, expect, it, vi } from "vitest";

// Action logging persists to IndexedDB (Dexie) — stub it out for node tests.
vi.mock("../src/shared/db", () => ({
  recordAction: vi.fn().mockResolvedValue(undefined),
  recordScreenshot: vi.fn().mockResolvedValue(undefined)
}));

import { CommandRouter } from "../src/background/command-router";
import type { Executor } from "../src/background/executor";
import type { GroupRegistry } from "../src/background/group-registry";
import type { CommandFrame } from "../src/shared/protocol";
import { chromeState, emitMessage } from "./helpers/fake-chrome";

const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeRegistry() {
  return {
    resolveTab: vi.fn((_g: string, tabId?: number) => tabId ?? 1),
    open: vi.fn().mockResolvedValue({ tabId: 1, url: "https://x", title: "X" }),
    navigate: vi.fn().mockResolvedValue({ tabId: 1, url: "https://y" }),
    back: vi.fn().mockResolvedValue({ tabId: 1, url: "https://b" }),
    forward: vi.fn().mockResolvedValue({ tabId: 1, url: "https://f" }),
    reload: vi.fn().mockResolvedValue({ tabId: 1, url: "https://r" }),
    activate: vi.fn().mockResolvedValue({ tabId: 1 }),
    list: vi.fn().mockResolvedValue({ groups: [] }),
    close: vi.fn().mockResolvedValue({ closed: [1] })
  };
}

function fakeExecutor() {
  return {
    kind: "cdp" as const,
    click: vi.fn().mockResolvedValue(undefined),
    doubleClick: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    drag: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    pressKey: vi.fn().mockResolvedValue(undefined),
    upload: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue({ result: null }),
    handleDialog: vi.fn().mockResolvedValue(undefined),
    setViewport: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue({ base64: "AA", width: 10, height: 20 }),
    getConsole: vi.fn().mockResolvedValue([]),
    getNetwork: vi.fn().mockResolvedValue([]),
    releaseAll: vi.fn().mockResolvedValue(undefined)
  };
}

function cmd(action: string, params: Record<string, unknown> = {}, id = "c1"): CommandFrame {
  return { v: 1, type: "command", id, action, group: "g", params } as CommandFrame;
}

let registry: ReturnType<typeof fakeRegistry>;
let executor: ReturnType<typeof fakeExecutor>;
let router: CommandRouter;

beforeEach(() => {
  registry = fakeRegistry();
  executor = fakeExecutor();
  router = new CommandRouter(registry as unknown as GroupRegistry, executor as unknown as Executor);
});

describe("CommandRouter registry-backed actions", () => {
  it("opens a tab in a group", async () => {
    const data = await router.handle(cmd("open", { url: "https://x" }));
    expect(registry.open).toHaveBeenCalledWith("g", "https://x", undefined);
    expect(data).toMatchObject({ url: "https://x" });
  });

  it("navigates, lists, and closes", async () => {
    await router.handle(cmd("navigate", { url: "https://y" }));
    expect(registry.navigate).toHaveBeenCalled();
    expect(await router.handle(cmd("tabs"))).toMatchObject({ groups: [] });
    expect(await router.handle(cmd("close"))).toMatchObject({ closed: [1] });
  });
});

describe("CommandRouter executor-backed actions", () => {
  it("clicks with the resolved tab and button", async () => {
    const data = await router.handle(cmd("click", { ref: "e1", button: "right" }));
    expect(executor.click).toHaveBeenCalledWith(1, expect.objectContaining({ ref: "e1" }), "right");
    expect(data).toEqual({ ok: true });
  });

  it("types text and presses keys", async () => {
    await router.handle(cmd("type", { text: "hi", submit: true }));
    expect(executor.type).toHaveBeenCalledWith(1, "hi", expect.any(Object), true);
    await router.handle(cmd("press_key", { key: "Enter" }));
    expect(executor.pressKey).toHaveBeenCalledWith(1, "Enter");
  });

  it("captures a screenshot", async () => {
    const data = await router.handle(cmd("screenshot", { fullPage: true }));
    expect(executor.screenshot).toHaveBeenCalledWith(1, true);
    expect(data).toMatchObject({ width: 10, height: 20 });
  });

  it("releases control", async () => {
    await router.handle(cmd("release"));
    expect(executor.releaseAll).toHaveBeenCalled();
  });
});

describe("CommandRouter page-action bridges", () => {
  it("reads page text via the injected dispatcher", async () => {
    chromeState.executeResult = { text: "hello world" };
    const data = await router.handle(cmd("get_text"));
    expect(data).toEqual({ text: "hello world" });
  });

  it("returns a snapshot's ref count", async () => {
    chromeState.executeResult = { snapshot: "- button", refs: 4 };
    const data = await router.handle(cmd("snapshot"));
    expect(data).toMatchObject({ refs: 4 });
  });

  it("throws when a get_html target is not found", async () => {
    chromeState.executeResult = { found: false, html: "" };
    await expect(router.handle(cmd("get_html", { selector: "#x" }))).rejects.toThrow(/not found/);
  });
});

describe("CommandRouter misc", () => {
  it("rejects an unknown action", async () => {
    await expect(router.handle(cmd("nope"))).rejects.toThrow(/unknown action/);
  });

  it("lists cookies via the cookies op", async () => {
    const data = await router.handle(cmd("cookies", { op: "list", url: "https://x" }));
    expect(data).toMatchObject({ cookies: [] });
  });
});

describe("CommandRouter cancel registry", () => {
  it("runs a registered teardown exactly once", () => {
    let torn = 0;
    router.registerCanceller("x", () => {
      torn++;
    });
    router.cancel("x");
    router.cancel("x"); // already removed
    expect(torn).toBe(1);
  });

  it("ignores cancel for an unknown id", () => {
    expect(() => router.cancel("ghost")).not.toThrow();
  });

  it("drives request_feedback and resolves on the user's response", async () => {
    const p = router.handle(cmd("request_feedback", { mode: "confirm", timeoutMs: 60_000 }, "f1"));
    await flush();
    emitMessage({
      type: "ocb-feedback-result",
      id: "f1",
      responded: true,
      annotations: [{ kind: "confirm", value: true }]
    });
    await expect(p).resolves.toMatchObject({ responded: true });
  });
});
