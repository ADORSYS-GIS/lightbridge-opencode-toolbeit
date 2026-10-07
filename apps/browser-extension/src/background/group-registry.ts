import { browser } from "wxt/browser";

import { db } from "../shared/db";
import type { GroupRecord } from "../shared/types";
import type { Executor } from "./executor";

const LOAD_TIMEOUT_MS = 15_000;

function hasTabGroups(): boolean {
  return typeof browser.tabs?.group === "function" && !!browser.tabGroups;
}

/** Wait until a tab finishes loading (or the timeout elapses). */
async function waitForComplete(
  tabId: number,
  timeoutMs = LOAD_TIMEOUT_MS
): Promise<chrome.tabs.Tab> {
  const deadline = Date.now() + timeoutMs;
  let tab = await browser.tabs.get(tabId);
  while (tab.status !== "complete" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    tab = await browser.tabs.get(tabId);
  }
  return tab;
}

export interface TabInfo {
  tabId: number;
  url: string;
  title: string;
}

/**
 * Owns the mapping from a named group to its tabs. On Chromium it creates a real
 * titled tab group; on Firefox (no tabGroups API) it keeps a logical registry
 * only. Mirrors state into IndexedDB so the dashboard can render live.
 */
export class GroupRegistry {
  private readonly groups = new Map<string, GroupRecord>();

  constructor(private readonly executor: Executor) {}

  /**
   * Repopulate the in-memory map from IndexedDB. The MV3 background worker can
   * be suspended (and `rebuild()` makes a fresh registry), so without this an
   * `browser_navigate`/`browser_click` with no explicit tabId would fail with
   * "group has no open tabs" even though the tabs are still open. Prunes tabs
   * that no longer exist.
   */
  async hydrate(): Promise<void> {
    const rows = await db.groups.toArray().catch(() => [] as GroupRecord[]);
    for (const row of rows) {
      const alive: number[] = [];
      for (const id of row.tabIds) {
        try {
          await browser.tabs.get(id);
          alive.push(id);
        } catch {
          /* tab closed while the worker was suspended */
        }
      }
      if (alive.length === 0) {
        await db.groups.delete(row.name).catch(() => {});
        continue;
      }
      this.groups.set(row.name, {
        ...row,
        tabIds: alive,
        activeTabId: alive.includes(row.activeTabId ?? -1) ? row.activeTabId : alive[0]
      });
    }
  }

  private async persist(record: GroupRecord): Promise<void> {
    this.groups.set(record.name, record);
    await db.groups.put(record).catch(() => {});
  }

  private async groupTab(name: string, tabId: number): Promise<number | undefined> {
    if (!hasTabGroups()) {
      return undefined;
    }
    const existing = this.groups.get(name);
    try {
      // Chrome uses -1 (TAB_GROUP_ID_NONE) for "no group" and 0 is a valid id,
      // so test for presence explicitly rather than truthiness — otherwise a
      // group with id 0 would be split into a fresh native group on reuse.
      const groupId = await browser.tabs.group(
        existing?.tabGroupId !== undefined
          ? { tabIds: [tabId], groupId: existing.tabGroupId }
          : { tabIds: [tabId] }
      );
      await browser.tabGroups.update(groupId, { title: name });
      return groupId;
    } catch {
      return existing?.tabGroupId;
    }
  }

  async open(name: string, url?: string, focus = true): Promise<TabInfo> {
    const created = await browser.tabs.create({ url: url ?? "about:blank", active: focus });
    const tabId = created.id;
    if (tabId === undefined) {
      throw new Error("failed to create tab");
    }
    const tabGroupId = await this.groupTab(name, tabId);
    const tab = await waitForComplete(tabId);
    const existing = this.groups.get(name);
    await this.persist({
      name,
      tabIds: existing ? [...new Set([...existing.tabIds, tabId])] : [tabId],
      activeTabId: tabId,
      tabGroupId,
      createdAt: existing?.createdAt ?? Date.now()
    });
    return { tabId, url: tab.url ?? url ?? "about:blank", title: tab.title ?? "" };
  }

  /**
   * Resolve which tab an action targets. An explicit `tabId` must belong to the
   * named group — otherwise a tool call could drive an arbitrary unrelated tab,
   * breaking group isolation.
   */
  resolveTab(name: string, tabId?: number): number {
    const group = this.groups.get(name);
    if (tabId !== undefined) {
      if (!group?.tabIds.includes(tabId)) {
        throw new Error(`tab ${tabId} is not part of group "${name}"`);
      }
      return tabId;
    }
    const resolved = group?.activeTabId ?? group?.tabIds[0];
    if (resolved === undefined) {
      throw new Error(`group "${name}" has no open tabs — call browser_open first`);
    }
    return resolved;
  }

  async navigate(name: string, url: string, tabId?: number): Promise<TabInfo> {
    const target = this.resolveTab(name, tabId);
    await browser.tabs.update(target, { url });
    const tab = await waitForComplete(target);
    const group = this.groups.get(name);
    if (group) {
      await this.persist({ ...group, activeTabId: target });
    }
    return { tabId: target, url: tab.url ?? url, title: tab.title ?? "" };
  }

  private async afterNav(name: string, target: number): Promise<TabInfo> {
    const tab = await waitForComplete(target);
    const group = this.groups.get(name);
    if (group) {
      await this.persist({ ...group, activeTabId: target });
    }
    return { tabId: target, url: tab.url ?? "", title: tab.title ?? "" };
  }

  async back(name: string, tabId?: number): Promise<TabInfo> {
    const target = this.resolveTab(name, tabId);
    await browser.tabs.goBack(target);
    return this.afterNav(name, target);
  }

  async forward(name: string, tabId?: number): Promise<TabInfo> {
    const target = this.resolveTab(name, tabId);
    await browser.tabs.goForward(target);
    return this.afterNav(name, target);
  }

  async reload(name: string, tabId?: number): Promise<TabInfo> {
    const target = this.resolveTab(name, tabId);
    await browser.tabs.reload(target);
    return this.afterNav(name, target);
  }

  async activate(name: string, tabId?: number): Promise<TabInfo> {
    const target = this.resolveTab(name, tabId);
    await browser.tabs.update(target, { active: true });
    const tab = await browser.tabs.get(target);
    if (tab.windowId !== undefined) {
      await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    const group = this.groups.get(name);
    if (group) {
      await this.persist({ ...group, activeTabId: target });
    }
    return { tabId: target, url: tab.url ?? "", title: tab.title ?? "" };
  }

  async list(name?: string): Promise<{ groups: Array<GroupRecord & { tabs: TabInfo[] }> }> {
    const wanted = name ? [this.groups.get(name)].filter(Boolean) : [...this.groups.values()];
    const groups = await Promise.all(
      (wanted as GroupRecord[]).map(async (group) => {
        const tabs: TabInfo[] = [];
        for (const tabId of group.tabIds) {
          try {
            const tab = await browser.tabs.get(tabId);
            tabs.push({ tabId, url: tab.url ?? "", title: tab.title ?? "" });
          } catch {
            /* tab gone; pruned on next close/removal event */
          }
        }
        return { ...group, tabs };
      })
    );
    return { groups };
  }

  async close(name: string, tabId?: number): Promise<{ closed: number[] }> {
    const group = this.groups.get(name);
    if (!group) {
      return { closed: [] };
    }
    // An explicit tabId must belong to the group — otherwise browser_close
    // could remove an unrelated user tab (same isolation guard as resolveTab).
    if (tabId !== undefined && !group.tabIds.includes(tabId)) {
      throw new Error(`tab ${tabId} is not part of group "${name}"`);
    }
    const toClose = tabId !== undefined ? [tabId] : [...group.tabIds];
    for (const id of toClose) {
      await this.executor.release(id).catch(() => {});
      await browser.tabs.remove(id).catch(() => {});
    }
    const remaining = group.tabIds.filter((id) => !toClose.includes(id));
    if (remaining.length === 0) {
      this.groups.delete(name);
      await db.groups.delete(name).catch(() => {});
    } else {
      await this.persist({
        ...group,
        tabIds: remaining,
        activeTabId: remaining.includes(group.activeTabId ?? -1) ? group.activeTabId : remaining[0]
      });
    }
    return { closed: toClose };
  }

  /** Drop a tab that was closed out-of-band (user closed it). */
  async forget(tabId: number): Promise<string | null> {
    for (const group of this.groups.values()) {
      if (!group.tabIds.includes(tabId)) {
        continue;
      }
      await this.executor.release(tabId).catch(() => {});
      const remaining = group.tabIds.filter((id) => id !== tabId);
      if (remaining.length === 0) {
        this.groups.delete(group.name);
        await db.groups.delete(group.name).catch(() => {});
      } else {
        await this.persist({
          ...group,
          tabIds: remaining,
          activeTabId: group.activeTabId === tabId ? remaining[0] : group.activeTabId
        });
      }
      return group.name;
    }
    return null;
  }
}
