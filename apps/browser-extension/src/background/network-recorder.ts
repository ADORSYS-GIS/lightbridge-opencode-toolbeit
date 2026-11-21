/**
 * Firefox network recorder built on `webRequest`.
 *
 * The CDP executor gets network events from the DevTools protocol; Firefox has
 * no DevTools attachment, but `webRequest` gives the same essentials (method,
 * URL, type, status code, error) with only the `webRequest` permission and the
 * host access we already have. Entries are kept per tab in a bounded ring so a
 * long-lived tab can't grow memory without limit.
 */
import { browser } from "wxt/browser";

export interface NetEntry {
  method: string;
  url: string;
  status?: number;
  type?: string;
  error?: string;
  ts: number;
}

const MAX_PER_TAB = 300;
const byTab = new Map<number, NetEntry[]>();
const pending = new Map<string, NetEntry>();
let started = false;

function pushEntry(tabId: number, entry: NetEntry): void {
  const list = byTab.get(tabId) ?? [];
  list.push(entry);
  if (list.length > MAX_PER_TAB) {
    list.splice(0, list.length - MAX_PER_TAB);
  }
  byTab.set(tabId, list);
}

/** Start listening once. Safe to call repeatedly. */
export function startNetworkRecorder(): void {
  if (started) {
    return;
  }
  started = true;
  // `webRequest` is missing from the polyfill typings used by this project.
  const webRequest = (browser as unknown as { webRequest?: WebRequestLike }).webRequest;
  if (!webRequest) {
    return;
  }
  const filter = { urls: ["<all_urls>"] };

  webRequest.onBeforeRequest.addListener((details) => {
    if (details.tabId < 0) {
      return;
    }
    const entry: NetEntry = {
      method: details.method,
      url: details.url.slice(0, 2000),
      type: details.type,
      ts: Date.now()
    };
    pending.set(details.requestId, entry);
    pushEntry(details.tabId, entry);
  }, filter);

  webRequest.onCompleted.addListener((details) => {
    const entry = pending.get(details.requestId);
    if (entry) {
      entry.status = details.statusCode;
      pending.delete(details.requestId);
    }
  }, filter);

  webRequest.onErrorOccurred.addListener((details) => {
    const entry = pending.get(details.requestId);
    if (entry) {
      entry.error = details.error;
      pending.delete(details.requestId);
    }
  }, filter);

  browser.tabs.onRemoved.addListener((tabId) => {
    byTab.delete(tabId);
  });
}

interface WebRequestDetails {
  tabId: number;
  requestId: string;
  url: string;
  method: string;
  type: string;
  statusCode?: number;
  error?: string;
}

interface WebRequestEvent {
  addListener: (callback: (details: WebRequestDetails) => void, filter: { urls: string[] }) => void;
}

interface WebRequestLike {
  onBeforeRequest: WebRequestEvent;
  onCompleted: WebRequestEvent;
  onErrorOccurred: WebRequestEvent;
}

export function getNetworkEntries(tabId: number): NetEntry[] {
  return [...(byTab.get(tabId) ?? [])];
}

export function clearNetwork(tabId?: number): void {
  if (typeof tabId === "number") {
    byTab.delete(tabId);
    return;
  }
  byTab.clear();
  pending.clear();
}
