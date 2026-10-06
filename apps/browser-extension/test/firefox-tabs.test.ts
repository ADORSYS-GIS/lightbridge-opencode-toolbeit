import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dexie-backed persistence — stub the table so node tests need no IndexedDB.
const groupsTable = vi.hoisted(() => ({
  toArray: vi.fn(),
  put: vi.fn(),
  delete: vi.fn()
}));
vi.mock("../src/shared/db", () => ({ db: { groups: groupsTable } }));

import { GroupRegistry } from "../src/background/group-registry";
import type { Executor } from "../src/background/executor";

function fakeExecutor() {
  return { release: vi.fn().mockResolvedValue(undefined) } as unknown as Executor;
}

/**
 * Simulates Firefox (issue #63): `chrome.*` is callback-style (returns
 * `undefined` when awaited) while promise-based APIs live on `browser.*`.
 * Before the fix, `GroupRegistry.open()` threw
 * `can't access property "id" of undefined` here even though the tab opened.
 */
const firefoxTabs = {
  create: vi.fn(async ({ url }: { url?: string }) => ({
    id: 7,
    windowId: 1,
    status: "complete",
    url: url ?? "about:blank",
    title: ""
  })),
  get: vi.fn(async (tabId: number) => ({
    id: tabId,
    windowId: 1,
    status: "complete",
    url: "https://x",
    title: "X"
  })),
  update: vi.fn(async (tabId: number) => ({ id: tabId, windowId: 1 })),
  remove: vi.fn(async () => undefined),
  goBack: vi.fn(async () => undefined),
  goForward: vi.fn(async () => undefined),
  reload: vi.fn(async () => undefined)
};

const firefoxExtras = {
  scripting: { executeScript: vi.fn(async () => [{ result: null }]) },
  windows: { update: vi.fn(async () => undefined) },
  cookies: { getAll: vi.fn(async () => []) }
};

// Callback-style chrome.tabs: fires (side effect) but returns undefined,
// exactly like Firefox's `chrome.*` namespace.
const callbackTabs = {
  create: vi.fn(() => undefined),
  get: vi.fn(() => undefined),
  update: vi.fn(() => undefined),
  remove: vi.fn(() => undefined),
  goBack: vi.fn(() => undefined),
  goForward: vi.fn(() => undefined),
  reload: vi.fn(() => undefined)
};

let savedChromeTabs: unknown;
let registry: GroupRegistry;

beforeEach(() => {
  groupsTable.toArray.mockResolvedValue([]);
  groupsTable.put.mockResolvedValue(undefined);
  groupsTable.delete.mockResolvedValue(undefined);
  savedChromeTabs = (globalThis as unknown as { chrome: { tabs: unknown } }).chrome.tabs;
  (globalThis as unknown as { chrome: { tabs: unknown } }).chrome.tabs = callbackTabs;
  (globalThis as unknown as { browser?: unknown }).browser = {
    tabs: firefoxTabs,
    ...firefoxExtras
  };
  registry = new GroupRegistry(fakeExecutor());
});

afterEach(() => {
  (globalThis as unknown as { chrome: { tabs: unknown } }).chrome.tabs = savedChromeTabs;
  delete (globalThis as unknown as { browser?: unknown }).browser;
});

describe("Firefox promise-namespace routing (issue #63)", () => {
  it("open() tracks the tab via browser.tabs when chrome.tabs returns undefined", async () => {
    const info = await registry.open("g", "https://x");
    expect(firefoxTabs.create).toHaveBeenCalledWith({ url: "https://x", active: true });
    expect(info.tabId).toBe(7);
    expect(registry.resolveTab("g")).toBe(7);
  });

  it("falls back to chrome.tabs when browser.* is absent (Chromium)", async () => {
    delete (globalThis as unknown as { browser?: unknown }).browser;
    const chromeCreate = vi.fn(async () => ({ id: 9, windowId: 1, status: "complete" }));
    const chromeGet = vi.fn(async (tabId: number) => ({
      id: tabId,
      windowId: 1,
      status: "complete"
    }));
    Object.assign(
      (globalThis as unknown as { chrome: { tabs: Record<string, unknown> } }).chrome.tabs,
      {
        create: chromeCreate,
        get: chromeGet
      }
    );
    const info = await registry.open("g", "https://x");
    expect(chromeCreate).toHaveBeenCalled();
    expect(info.tabId).toBe(9);
  });
});
