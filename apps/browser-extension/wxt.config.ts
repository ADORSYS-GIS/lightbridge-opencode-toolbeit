import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

// WXT builds a Chromium MV3 and a Firefox build from this single config.
// `debugger` and `tabGroups` are Chromium-only APIs — the CDP executor and
// named-group support degrade gracefully on Firefox (content-script executor +
// a logical group registry), so we drop those permissions from the Firefox
// manifest to avoid load-time warnings.
export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  // Clean release-artifact names: opencode-browser-extension-<version>-<target>.zip
  zip: { name: "opencode-browser-extension" },
  // Explicit imports everywhere (no magic auto-imports) — clearer for readers
  // and avoids tsc surprises. `#imports` still resolves defineBackground/etc.
  imports: false,
  manifest: ({ browser }) => {
    const isFirefox = browser === "firefox";
    // `sidePanel` is the Chromium permission for the feedback side panel; on
    // Firefox the sidepanel entrypoint maps to `sidebar_action` (no permission).
    const chromiumOnly = isFirefox ? [] : ["debugger", "tabGroups", "sidePanel"];
    return {
      name: "OpenCode Browser",
      description:
        "Lets an OpenCode agent drive this browser through the @vymalo/opencode-browser plugin's localhost bridge.",
      // Keep this list exactly as wide as the code actually uses — the Chrome Web
      // Store rejects "future proof" permissions (it rejected `storage`, which we
      // never called: all persistence is Dexie/IndexedDB, which needs no
      // permission). `activeTab` is likewise redundant next to the `<all_urls>`
      // host access the agent genuinely needs. Before adding one back, point at
      // the call site.
      permissions: ["tabs", "scripting", "cookies", ...chromiumOnly],
      host_permissions: ["<all_urls>"],
      // Firefox (AMO) only: a stable add-on id (so it isn't auto-assigned on
      // first upload) and Mozilla's now-required data-consent declaration. The
      // extension collects no user data — settings/history stay on-device and
      // the only network flow is to the user's own localhost bridge — so we
      // declare "none". https://mzl.la/firefox-builtin-data-consent
      ...(isFirefox
        ? {
            browser_specific_settings: {
              gecko: {
                id: "opencode-browser@vymalo.com",
                data_collection_permissions: { required: ["none"] }
              }
            }
          }
        : {})
    };
  },
  vite: () => ({
    plugins: [tailwindcss()]
  })
});
