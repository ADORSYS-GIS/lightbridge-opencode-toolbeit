import { describe, expect, it } from "vitest";
import config from "../wxt.config.js";

/**
 * The Chrome Web Store rejects a manifest that declares a permission the code
 * never calls — it rejected 0.14.0 over `storage`, which we never used (all
 * persistence is Dexie/IndexedDB). These assertions pin the list so a
 * re-addition has to be deliberate; each entry below names its call site.
 */

const manifestFor = (browser: string) => {
  const { manifest } = config;
  if (typeof manifest !== "function") throw new Error("manifest is not a factory");
  return manifest({
    browser,
    manifestVersion: browser === "firefox" ? 2 : 3,
    mode: "production",
    command: "build"
  } as never) as {
    permissions: string[];
    host_permissions?: string[];
  };
};

describe("manifest permissions", () => {
  it("requests only what the Chromium code path calls", () => {
    expect(manifestFor("chrome").permissions).toEqual([
      "tabs", // command-router / group-registry: chrome.tabs.*
      "scripting", // page-actions + feedback-overlay: chrome.scripting.executeScript
      "cookies", // command-router: the `cookies` command
      "debugger", // cdp.ts: the CDP executor
      "tabGroups", // group-registry: real titled tab groups
      "sidePanel" // feedback-side-panel: the overlay-blocked fallback
    ]);
  });

  it("drops the Chromium-only permissions on Firefox", () => {
    expect(manifestFor("firefox").permissions).toEqual(["tabs", "scripting", "cookies"]);
  });

  it.each(["chrome", "firefox"])("declares no unused permission on %s", (browser) => {
    // `storage` is the one the store rejected; `activeTab` would only ever be a
    // subset of the `<all_urls>` host access the agent already needs.
    expect(manifestFor(browser).permissions).not.toContain("storage");
    expect(manifestFor(browser).permissions).not.toContain("activeTab");
    expect(manifestFor(browser).host_permissions).toEqual(["<all_urls>"]);
  });
});
