import { beforeEach, describe, expect, it, vi } from "vitest";

// Dexie-backed persistence — stub the table so node tests need no IndexedDB.
// vi.hoisted so the table exists when the hoisted vi.mock factory runs.
const groupsTable = vi.hoisted(() => ({
  toArray: vi.fn(),
  put: vi.fn(),
  delete: vi.fn()
}));
vi.mock("../src/shared/db", () => ({ db: { groups: groupsTable } }));

import { GroupRegistry } from "../src/background/group-registry";
import type { Executor } from "../src/background/executor";
import { chromeState } from "./helpers/fake-chrome";

function fakeExecutor() {
  return { release: vi.fn().mockResolvedValue(undefined) } as unknown as Executor;
}

let registry: GroupRegistry;
beforeEach(() => {
  groupsTable.toArray.mockResolvedValue([]);
  groupsTable.put.mockResolvedValue(undefined);
  groupsTable.delete.mockResolvedValue(undefined);
  registry = new GroupRegistry(fakeExecutor());
});

describe("GroupRegistry.resolveTab", () => {
  it("throws for a group with no tabs", () => {
    expect(() => registry.resolveTab("ghost")).toThrow(/no open tabs/);
  });

  it("after open, resolves the active tab and rejects foreign tab ids", async () => {
    const info = await registry.open("g", "https://x");
    expect(info).toMatchObject({ url: "https://x" });
    expect(registry.resolveTab("g")).toBe(info.tabId);
    expect(registry.resolveTab("g", info.tabId)).toBe(info.tabId);
    expect(() => registry.resolveTab("g", 999)).toThrow(/not part of group/);
  });
});

describe("GroupRegistry lifecycle", () => {
  it("opens a tab and persists the group", async () => {
    const info = await registry.open("research", "https://x");
    expect(info.tabId).toBeGreaterThan(0);
    expect(groupsTable.put).toHaveBeenCalledWith(
      expect.objectContaining({ name: "research", tabIds: [info.tabId], activeTabId: info.tabId })
    );
  });

  it("navigates the active tab", async () => {
    const opened = await registry.open("g", "https://x");
    const nav = await registry.navigate("g", "https://y");
    expect(nav.tabId).toBe(opened.tabId);
  });

  it("lists groups with their tabs", async () => {
    await registry.open("g", "https://x");
    const { groups } = await registry.list();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ name: "g" });
    expect(groups[0]?.tabs.length).toBe(1);
  });

  it("closes the group's tabs and releases the executor", async () => {
    const exec = fakeExecutor();
    const reg = new GroupRegistry(exec);
    const opened = await reg.open("g", "https://x");
    const { closed } = await reg.close("g");
    expect(closed).toEqual([opened.tabId]);
    expect(chromeState.removedTabs).toContain(opened.tabId);
    expect(exec.release).toHaveBeenCalledWith(opened.tabId);
    expect(() => reg.resolveTab("g")).toThrow(/no open tabs/); // group dropped
  });

  it("forget() drops a user-closed tab from its group", async () => {
    const opened = await registry.open("g", "https://x");
    const name = await registry.forget(opened.tabId);
    expect(name).toBe("g");
    expect(await registry.forget(opened.tabId)).toBeNull(); // already gone
  });

  it("rejects closing a foreign tab id", async () => {
    await registry.open("g", "https://x");
    await expect(registry.close("g", 999)).rejects.toThrow(/not part of group/);
  });
});

describe("GroupRegistry.hydrate", () => {
  it("repopulates groups from the db and keeps live tabs", async () => {
    groupsTable.toArray.mockResolvedValue([
      { name: "g", tabIds: [101], activeTabId: 101, createdAt: 1 }
    ]);
    const reg = new GroupRegistry(fakeExecutor());
    await reg.hydrate();
    expect(reg.resolveTab("g")).toBe(101);
  });
});
