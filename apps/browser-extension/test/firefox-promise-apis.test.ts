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
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFakeChrome } from "./helpers/fake-chrome";

// Dexie-backed persistence — stub the table so node tests need no IndexedDB.
// vi.hoisted so the table exists when the hoisted vi.mock factory runs.
const groupsTable = vi.hoisted(() => ({
  toArray: vi.fn(),
  put: vi.fn(),
  delete: vi.fn()
}));
vi.mock("../src/shared/db", () => ({ db: { groups: groupsTable } }));

import type { Executor } from "../src/background/executor";

/** Result the promise-fake's `scripting.executeScript` resolves with. */
let scriptResult: unknown;

/** A Firefox-shaped `browser.*`: every method returns a Promise. */
const promiseBrowser: Record<string, unknown> = {
  runtime: {
    id: "firefox-promise-apis@test",
    sendMessage: async () => ({ status: "connected" }),
    getURL: (path: string) => `moz-extension://fake/${path}`
  },
  tabs: {
    create: async ({ url, active = true }: { url?: string; active?: boolean }) => ({
      id: 7,
      windowId: 1,
      status: "complete",
      active,
      url: url ?? "about:blank",
      title: "X"
    }),
    get: async (tabId: number) => ({
      id: tabId,
      windowId: 1,
      status: "complete",
      active: true,
      url: "https://x",
      title: "X"
    }),
    // Intentionally no `group`/`tabGroups` — Firefox lacks the tabGroups API.
    captureVisibleTab: async () => "data:image/png;base64,AAAA"
  },
  scripting: {
    executeScript: async () => [{ result: scriptResult }]
  }
};

/** A Firefox-shaped `chrome.*`: methods return nothing (callback delivery). */
function makeCallbackChrome(): Record<string, unknown> {
  return {
    runtime: {
      id: "firefox-promise-apis@test",
      sendMessage: () => undefined,
      getURL: (path: string) => `moz-extension://fake/${path}`
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
    }
  };
}

beforeEach(() => {
  vi.resetModules();
  scriptResult = 42;
  groupsTable.toArray.mockResolvedValue([]);
  groupsTable.put.mockResolvedValue(undefined);
  groupsTable.delete.mockResolvedValue(undefined);
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
    expect(groupsTable.put).toHaveBeenCalledWith(
      expect.objectContaining({ name: "g", tabIds: [7], activeTabId: 7 })
    );
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
});
