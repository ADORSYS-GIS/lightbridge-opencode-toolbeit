/**
 * Firefox promise-namespace simulation (issue #63).
 *
 * On Firefox the `chrome.*` namespace is callback-only: its methods return
 * `undefined` and deliver the result via a callback, so `await chrome.x()`
 * (the pre-fix pattern) resolved to `undefined` and every follow-up member
 * access (`created.id`, `tab.windowId`, `[injection]`) threw — the extension
 * was inert there. The `browser.*` namespace is the promise-based one.
 *
 * These tests install exactly that split before importing a module under test:
 *   - `globalThis.chrome`  → a callback-only fake whose methods return nothing;
 *   - `globalThis.browser` → a promise fake with `runtime.id` set.
 *
 * `wxt/browser` resolves to `globalThis.browser` when `runtime.id` is present
 * (see `@wxt-dev/browser`), so the awaited calls under test must round-trip
 * through the promise fake. Against the pre-fix code (which awaited `chrome.*`)
 * every scenario fails — that is the point: they pin the regression.
 *
 * Coverage: messaging, tab creation + activation (tabs/windows), script
 * injection, screenshots, cookies, the action badge, and the side-panel
 * fallback. The regex guard covers the same call sites structurally; these
 * exercise them through a Firefox-shaped namespace split.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFakeChrome } from "./helpers/fake-chrome";

// Dexie-backed persistence — stub the tables so node tests need no IndexedDB.
// vi.hoisted so the mocks exist when the hoisted vi.mock factory runs.
const dbMocks = vi.hoisted(() => ({
  groups: { toArray: vi.fn(), put: vi.fn(), delete: vi.fn() },
  recordAction: vi.fn(),
  recordScreenshot: vi.fn()
}));
vi.mock("../src/shared/db", () => ({
  db: { groups: dbMocks.groups },
  recordAction: dbMocks.recordAction,
  recordScreenshot: dbMocks.recordScreenshot
}));

import type { Executor } from "../src/background/executor";
import type { CommandFrame } from "../src/shared/protocol";

/** Result the promise-fake's `scripting.executeScript` resolves with. */
let scriptResult: unknown;

/** A Firefox-shaped `browser.*`: every method returns a Promise. */
const promiseBrowser = {
  runtime: {
    id: "firefox-promise-apis@test",
    sendMessage: vi.fn(async () => ({ status: "connected" })),
    getURL: (path: string) => `moz-extension://fake/${path}`
  },
  tabs: {
    create: vi.fn(async ({ url, active = true }: { url?: string; active?: boolean }) => ({
      id: 7,
      windowId: 1,
      status: "complete",
      active,
      url: url ?? "about:blank",
      title: "X"
    })),
    get: vi.fn(async (tabId: number) => ({
      id: tabId,
      windowId: 1,
      status: "complete",
      active: true,
      url: "https://x",
      title: "X"
    })),
    update: vi.fn(async () => ({})),
    // Intentionally no `group`/`tabGroups` — Firefox lacks the tabGroups API.
    captureVisibleTab: vi.fn(async () => "data:image/png;base64,AAAA")
  },
  windows: {
    update: vi.fn(async () => ({ id: 1 }))
  },
  scripting: {
    executeScript: vi.fn(async () => [{ result: scriptResult }])
  },
  cookies: {
    set: vi.fn(async (details: Record<string, unknown>) => details),
    remove: vi.fn(async () => ({})),
    getAll: vi.fn(async () => [{ name: "sid", value: "1" }])
  },
  action: {
    setBadgeBackgroundColor: vi.fn(async () => undefined),
    setBadgeText: vi.fn(async () => undefined)
  },
  sidebarAction: {
    setPanel: vi.fn(async () => undefined)
  }
};

/** A Firefox-shaped `chrome.*`: methods return nothing (callback delivery). */
function makeCallbackChrome(): Record<string, unknown> {
  return {
    runtime: {
      id: "firefox-promise-apis@test",
      sendMessage: () => undefined,
      getURL: (path: string) => `moz-extension://fake/${path}`,
      onMessage: {
        addListener: () => undefined,
        removeListener: () => undefined
      }
    },
    tabs: {
      create: () => undefined,
      get: () => undefined,
      update: () => undefined,
      captureVisibleTab: () => undefined
    },
    windows: {
      update: () => undefined
    },
    scripting: {
      executeScript: () => undefined
    },
    cookies: {
      set: () => undefined,
      remove: () => undefined,
      getAll: () => undefined
    },
    action: {
      setBadgeBackgroundColor: () => undefined,
      setBadgeText: () => undefined
    },
    sidebarAction: {
      setPanel: () => undefined
    }
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  scriptResult = 42;
  dbMocks.groups.toArray.mockResolvedValue([]);
  dbMocks.groups.put.mockResolvedValue(undefined);
  dbMocks.groups.delete.mockResolvedValue(undefined);
  dbMocks.recordAction.mockResolvedValue(undefined);
  dbMocks.recordScreenshot.mockResolvedValue(undefined);
  // Override the promise-fake chrome from test/helpers/setup.ts with the
  // callback-only Firefox shape, and install the promise `browser.*` namespace.
  (globalThis as Record<string, unknown>).chrome = makeCallbackChrome();
  (globalThis as Record<string, unknown>).browser = promiseBrowser;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).browser;
  installFakeChrome();
});

describe("Firefox promise namespace (issue #63)", () => {
  it("sendToBackground awaits browser.runtime.sendMessage and gets the status", async () => {
    const { sendToBackground } = await import("../src/lib/messaging");
    await expect(sendToBackground({ type: "get_status" })).resolves.toEqual({
      status: "connected"
    });
  });

  it("GroupRegistry.open creates the tab through the promise namespace and reads its id", async () => {
    const { GroupRegistry } = await import("../src/background/group-registry");
    const exec = { release: vi.fn().mockResolvedValue(undefined) } as unknown as Executor;
    const registry = new GroupRegistry(exec);
    const info = await registry.open("g", "https://x", false);
    expect(info).toEqual({ tabId: 7, url: "https://x", title: "X" });
    expect(dbMocks.groups.put).toHaveBeenCalledWith(
      expect.objectContaining({ name: "g", tabIds: [7], activeTabId: 7 })
    );
  });

  it("GroupRegistry.activate focuses the window through the promise namespace", async () => {
    const { GroupRegistry } = await import("../src/background/group-registry");
    const exec = { release: vi.fn().mockResolvedValue(undefined) } as unknown as Executor;
    const registry = new GroupRegistry(exec);
    await registry.open("g", "https://x", false);

    await registry.activate("g", 7);

    expect(promiseBrowser.tabs.update).toHaveBeenCalledWith(7, { active: true });
    expect(promiseBrowser.windows.update).toHaveBeenCalledWith(1, { focused: true });
  });

  it("runInPage resolves the injected func's result via the promise namespace", async () => {
    const { runInPage } = await import("../src/background/page-actions");
    await expect(runInPage(7, () => 42, [])).resolves.toBe(42);
  });

  it("ContentExecutor.screenshot captures the tab via the promise namespace", async () => {
    scriptResult = { w: 1280, h: 720 };
    const { ContentExecutor } = await import("../src/background/content-executor");
    const executor = new ContentExecutor();
    const shot = await executor.screenshot(7, false);
    expect(shot.base64).toBe("AAAA");
    expect(shot.width).toBe(1280);
    expect(shot.height).toBe(720);
  });

  it("CommandRouter.cookies reads through the promise namespace", async () => {
    const { CommandRouter } = await import("../src/background/command-router");
    const router = new CommandRouter({} as never, {} as never);
    const frame: CommandFrame = {
      v: 1,
      type: "command",
      id: "cmd-cookies",
      action: "cookies",
      group: "g",
      params: { op: "get", url: "https://x", name: "sid" }
    };

    const data = await router.handle(frame);

    expect(promiseBrowser.cookies.getAll).toHaveBeenCalledWith({
      url: "https://x",
      name: "sid"
    });
    expect((data as { cookies: unknown[] }).cookies).toHaveLength(1);
  });

  it("startFeedback raises the badge through the promise namespace", async () => {
    const { startFeedback } = await import("../src/background/feedback");
    const handle = startFeedback(7, "feedback-1", { mode: "confirm", timeoutMs: 1_000 });

    await vi.waitFor(() => {
      expect(promiseBrowser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
        color: "#3b82f6"
      });
      expect(promiseBrowser.action.setBadgeText).toHaveBeenCalledWith({ text: "?" });
    });
    handle.cancel();
  });

  it("openSidePanelFallback installs the sidebar through the promise namespace", async () => {
    const { openSidePanelFallback, clearFeedbackSession } = await import(
      "../src/background/feedback-side-panel"
    );

    await expect(openSidePanelFallback(7, "feedback-2", { mode: "confirm" })).resolves.toBe(true);
    expect(promiseBrowser.sidebarAction.setPanel).toHaveBeenCalledWith({
      panel: "moz-extension://fake//sidepanel.html"
    });
    clearFeedbackSession("feedback-2");
  });
});
