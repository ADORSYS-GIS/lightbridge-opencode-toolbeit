/**
 * Promise-safe access to extension API namespaces (issue #63).
 *
 * Chromium's `chrome.*` methods return promises, but Firefox's `chrome.*` is
 * callback-style — promises only exist on the `browser.*` namespace. Awaiting
 * a callback-style call resolves to `undefined`, so on Firefox
 * `await chrome.tabs.create(...)` yields `undefined`: the tab still opens (the
 * call itself fires) but the follow-up `.id` access throws
 * `can't access property "id" of undefined` and the tab is never tracked.
 * The same fault affects every other awaited tab/scripting/window/cookie call.
 *
 * These helpers return whichever namespace actually returns promises, so the
 * same `await` call sites work in both browsers. Pure event registration
 * (`runtime.onMessage`, `tabs.onRemoved`, ...) is unaffected and keeps using
 * `chrome` directly, as does anything already guarded by feature detection
 * (`tabs.group`/`tabGroups`, `debugger`).
 */

type ChromeHost = typeof chrome;

interface PromiseNamespaces {
  tabs: ChromeHost["tabs"];
  scripting: ChromeHost["scripting"];
  windows: ChromeHost["windows"];
  cookies: ChromeHost["cookies"];
}

/** One known promise-returning method per namespace, used as a probe. */
const PROBE_METHOD: Record<keyof PromiseNamespaces, string> = {
  tabs: "create",
  scripting: "executeScript",
  windows: "update",
  cookies: "getAll"
};

function promised<K extends keyof PromiseNamespaces>(key: K): PromiseNamespaces[K] {
  // `browser` is Firefox-only (Chromium defines no such global), and its
  // methods are promise-based there — exactly what the call sites need.
  const namespaces = (globalThis as unknown as { browser?: Partial<PromiseNamespaces> }).browser;
  const candidate = namespaces?.[key] as Record<string, unknown> | undefined;
  if (candidate && typeof candidate[PROBE_METHOD[key]] === "function") {
    return candidate as PromiseNamespaces[K];
  }
  return chrome[key];
}

/** Promise-based tabs API in both Chromium and Firefox. */
export function tabsApi(): ChromeHost["tabs"] {
  return promised("tabs");
}

/** Promise-based scripting API in both browsers. */
export function scriptingApi(): ChromeHost["scripting"] {
  return promised("scripting");
}

/** Promise-based windows API in both browsers. */
export function windowsApi(): ChromeHost["windows"] {
  return promised("windows");
}

/** Promise-based cookies API in both browsers. */
export function cookiesApi(): ChromeHost["cookies"] {
  return promised("cookies");
}
